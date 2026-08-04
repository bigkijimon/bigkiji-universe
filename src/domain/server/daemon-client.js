'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

function daemonSpawnEnv(baseEnv, workspace, parentPid, versions = process.versions, dataRoot = '') {
  const env = { ...baseEnv, BIGKIJI_DAEMON_PARENT: String(parentPid), BIGKIJI_WORKSPACE: workspace };
  // The daemon and the app MUST agree on the data root or they silently read and
  // write different directories.
  if (dataRoot) env.BIGKIJI_DATA_ROOT = dataRoot;
  if (versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

class DaemonClient extends EventEmitter {
  constructor({ appRoot, host = '127.0.0.1', port = 8777, token = '', workspace = process.cwd(), dataRoot = '' } = {}) {
    super(); this.appRoot = path.resolve(appRoot || path.resolve(__dirname, '..', '..', '..'));
    this.host = host; this.port = Number(port || 8777); this.token = token || this.loadToken(); this.workspace = path.resolve(workspace);
    this.dataRoot = dataRoot; this.controller = null; this.connected = false; this.childPid = null;
  }
  get base() { return `http://${this.host}:${this.port}`; }
  /**
   * An appendable fd for the daemon's stdout and stderr, or null if the log
   * directory cannot be opened — losing the log is bad, refusing to start the
   * daemon over it would be worse.
   * @returns {number|null}
   */
  openLog() {
    try {
      const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
      const data = resolveDataRoot({ userData: defaultUserData() });
      const logs = dataLayout(data.dataRoot, data.overrides).logsRoot;
      fs.mkdirSync(logs, { recursive: true });
      return fs.openSync(path.join(logs, 'daemon.log'), 'a');
    } catch (_) { return null; }
  }
  loadToken() {
    const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
    const data = resolveDataRoot({ userData: defaultUserData() });
    const candidates = [dataLayout(data.dataRoot, data.overrides).remoteConfigFile,
      path.join(os.homedir(), '.bigkiji', 'remote.json')]; // pre-2.5 fallback: reach a daemon that has not migrated yet
    for (const file of candidates) {
      try { const token = JSON.parse(fs.readFileSync(file, 'utf8')).token; if (token) return token; } catch (_) {}
    }
    return '';
  }
  async health(timeoutMs = 650) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { const response = await fetch(`${this.base}/health`, { signal: ctrl.signal }); return response.ok ? response.json() : null; }
    catch (_) { return null; } finally { clearTimeout(timer); }
  }
  /**
   * Say so when the surface and the engine are not the same build.
   *
   * A 1.0.0 GUI packaged the previous afternoon talked to a 2.5.0 daemon running
   * from source, for a whole morning, silently: whichever process reached port
   * 8777 first won, and nothing anywhere compared the two. Every bug the owner
   * reported had already been fixed in the half that was not on screen. This does
   * not refuse the connection — an engine that answers is better than none — it
   * refuses to let the mismatch stay invisible.
   * @returns {{ours: string, theirs: string}|null}
   */
  versionGap(health) {
    const theirs = String(health?.appVersion || '');
    const ours = String(require('../../../package.json').version || '');
    if (!theirs || !ours || theirs === ours) return null;
    const gap = { ours, theirs };
    this.emit('version-mismatch', gap);
    return gap;
  }
  async ensure({ timeoutMs = 8000 } = {}) {
    const current = await this.health();
    if (current?.ok) { this.connected = true; this.token = this.loadToken(); return { ...current, started: false, versionGap: this.versionGap(current) }; }
    const entry = path.join(this.appRoot, 'src', 'domain', 'server', 'daemon.js');
    // Inside Electron, process.execPath points at Electron.app rather than a
    // standalone Node binary. ELECTRON_RUN_AS_NODE keeps the daemon headless
    // and prevents an orphaned duplicate Electron application process.
    const childEnv = daemonSpawnEnv(process.env, this.workspace, process.pid, process.versions, this.dataRoot);
    // The daemon writes its crashes to stderr. With stdio ignored, every one of
    // them went to /dev/null: five separate crashes shipped, and the only symptom
    // anywhere was "did not become ready on port 8777". A detached process is
    // exactly the one that most needs somewhere to write.
    const log = this.openLog();
    const child = spawn(process.execPath, [entry], { cwd: this.appRoot, detached: true,
      stdio: log === null ? 'ignore' : ['ignore', log, log], env: childEnv });
    if (log !== null) { try { fs.closeSync(log); } catch (_) {} }
    this.childPid = child.pid; child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = await this.health(500); if (state?.ok) { this.connected = true; this.token = this.loadToken(); return { ...state, started: true, versionGap: this.versionGap(state) }; }
    }
    throw new Error('BigKiji Core Engine did not become ready on port 8777');
  }
  headers(extra = {}) { return { authorization: `Bearer ${this.token}`, ...extra }; }
  async get(route) {
    const response = await fetch(`${this.base}${route}`, { headers: this.headers() });
    if (!response.ok) throw new Error(`Daemon HTTP ${response.status} on ${route}`); return response.json();
  }
  async post(route, body = {}) {
    const response = await fetch(`${this.base}${route}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    if (!response.ok) { const detail = await response.text(); throw new Error(`Daemon HTTP ${response.status}: ${detail.slice(0, 240)}`); }
    return response.json();
  }
  state() { return this.get('/api/state'); }
  turn(text, options = {}) { return this.post('/api/turn', { text, ...options }); }
  prompt(text, options = {}) { return this.post('/api/prompt', { text, ...options }); }
  approve(run) { const value = typeof run === 'string' ? { id: run } : run; return this.post('/api/run/approve', value); }
  syncCredentials(values, { replace = false } = {}) { return this.post('/api/security/credentials', { values, replace }); }
  configureConversation(config) { return this.post('/api/conversation/config', config); }
  abort(id) { return this.post('/api/run/abort', { id }); }
  async reload() {
    const state = await this.state();
    return this.post('/api/reload', { policyHash: state.security?.policyHash || '', ownerConfirmed: true });
  }
  publish(channel, payload) { return this.post('/api/publish', { channel, payload }); }
  piPrompt(text, options = {}) { return this.post('/api/pi/prompt', { text, ...options }); }
  piModel(model) { return this.post('/api/pi/model', { model }); }
  piCompact() { return this.post('/api/pi/compact', {}); }
  piStop() { return this.post('/api/pi/stop', {}); }
  piStatus() { return this.get('/api/pi/status'); }
  // The route's own default is 40 and there are already more sessions than that on disk,
  // so the console's history drawer would have silently shown a prefix and called it the
  // history. 200 is SessionStore.list()'s own hard cap, so this asks for everything it is
  // willing to give rather than inventing a new ceiling.
  sessions(limit = 200) { return this.get(`/api/sessions?limit=${Number(limit) || 200}`); }
  session(id) { return this.get(`/api/session?id=${encodeURIComponent(id)}`); }
  ideas(limit = 40) { return this.get(`/api/ideas?limit=${encodeURIComponent(limit)}`); }
  idea(id) { return this.get(`/api/idea?id=${encodeURIComponent(id)}`); }
  enhanceIdea(id, draftHash) { return this.post('/api/idea/enhance', { id, draftHash }); }
  approveIdeaEnhancement(spec) { return this.post('/api/idea/enhance/approve', spec); }
  planIdea(id, draftHash) { return this.post('/api/idea/plan', { id, draftHash }); }
  promoteIdea(id, draftHash) { return this.post('/api/idea/promote', { id, draftHash, ownerConfirmed: true }); }
  archiveIdea(id, draftHash) { return this.post('/api/idea/archive', { id, draftHash, ownerConfirmed: true }); }
  connect() {
    this.closed = false;
    if (this.controller) return; this.controller = new AbortController();
    const controller = this.controller;
    this._socket(controller.signal).catch(() => this._stream(controller.signal))
      // Both transports failing has to release the controller. Leaving it set made
      // connect() return at the guard forever, so a daemon that was slow to bind or a
      // token that was stale at launch wedged the client with no way back — and the
      // retry below only fires for a connection that had already opened.
      .then(() => this._ended(controller, null), (error) => this._ended(controller, error));
  }
  // Reaching here means the transport is finished, however it finished. An SSE stream
  // that ends normally used to leave `connected === true` with a dead reader, and
  // main.js gates roughly fifteen IPC handlers on that flag.
  _ended(controller, error) {
    if (this.controller !== controller) return; // a newer attempt already owns the field
    this.controller = null; this.connected = false;
    if (error) this.emit('disconnect', error);
    if (this.closed || controller.signal.aborted || this.retryTimer) return;
    // Backoff, because this now also covers the daemon simply not being up yet. A flat
    // 2 s would open a socket every two seconds forever against a port nobody is on.
    this.attempts = (this.attempts || 0) + 1;
    const delay = Math.min(30000, 2000 * (2 ** (this.attempts - 1)));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.closed) this.connect(); }, delay);
    this.retryTimer.unref?.();
  }
  // `closed` is separate from `controller` because reconnection clears the controller
  // on its way out. Without it a disconnect during shutdown is undone two seconds later
  // by a retry that was already in flight, and the app never exits.
  disconnect() {
    this.closed = true; this.attempts = 0;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.controller?.abort(); this.controller = null; this.connected = false;
  }
  async _stream(signal) {
    const response = await fetch(`${this.base}/api/events`, { headers: this.headers(), signal });
    if (!response.ok) throw new Error(`Daemon event stream HTTP ${response.status}`);
    this.connected = true; this.emit('connect');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let event = 'message'; let data = '';
    while (!signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data) { try { this.emit('event', { event, data: JSON.parse(data) }); } catch (_) {} }
          event = 'message'; data = ''; continue;
        }
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
    }
  }
  _socket(signal) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${this.port}/ws?t=${encodeURIComponent(this.token)}`);
      let opened = false;
      const abort = () => { try { socket.close(); } catch (_) {} resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('open', () => { opened = true; this.attempts = 0; this.connected = true; this.emit('connect', { transport: 'websocket' }); });
      socket.on('message', (raw) => { try { const message = JSON.parse(String(raw)); this.emit('event', message); } catch (_) {} });
      socket.once('error', (error) => { if (!opened) reject(error); });
      // Resolving hands the outcome to _ended(), which is the single place that clears
      // the controller and schedules the retry. Two retry paths meant two timers.
      socket.once('close', () => {
        signal.removeEventListener('abort', abort);
        this.connected = false;
        resolve();
      });
    });
  }
}

module.exports = { DaemonClient, daemonSpawnEnv };
