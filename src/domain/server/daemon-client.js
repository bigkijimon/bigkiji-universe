'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class DaemonClient extends EventEmitter {
  constructor({ appRoot, host = '127.0.0.1', port = 8777, token = '', workspace = process.cwd() } = {}) {
    super(); this.appRoot = path.resolve(appRoot || path.resolve(__dirname, '..', '..', '..'));
    this.host = host; this.port = Number(port || 8777); this.token = token || this.loadToken(); this.workspace = path.resolve(workspace);
    this.controller = null; this.connected = false; this.childPid = null;
  }
  get base() { return `http://${this.host}:${this.port}`; }
  loadToken() {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bigkiji', 'remote.json'), 'utf8')).token || ''; } catch (_) { return ''; }
  }
  async health(timeoutMs = 650) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try { const response = await fetch(`${this.base}/health`, { signal: ctrl.signal }); return response.ok ? response.json() : null; }
    catch (_) { return null; } finally { clearTimeout(timer); }
  }
  async ensure({ timeoutMs = 8000 } = {}) {
    const current = await this.health();
    if (current?.ok) { this.connected = true; this.token = this.loadToken(); return { ...current, started: false }; }
    const entry = path.join(this.appRoot, 'src', 'domain', 'server', 'daemon.js');
    const child = spawn(process.execPath, [entry], { cwd: this.appRoot, detached: true, stdio: 'ignore',
      env: { ...process.env, BIGKIJI_DAEMON_PARENT: String(process.pid), BIGKIJI_WORKSPACE: this.workspace } });
    this.childPid = child.pid; child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 160));
      const state = await this.health(500); if (state?.ok) { this.connected = true; this.token = this.loadToken(); return { ...state, started: true }; }
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
  prompt(text, options = {}) { return this.post('/api/prompt', { text, ...options }); }
  approve(run) { const value = typeof run === 'string' ? { id: run } : run; return this.post('/api/run/approve', value); }
  syncCredentials(values, { replace = false } = {}) { return this.post('/api/security/credentials', { values, replace }); }
  abort(id) { return this.post('/api/run/abort', { id }); }
  async reload() {
    const state = await this.state();
    return this.post('/api/reload', { policyHash: state.security?.policyHash || '', ownerConfirmed: true });
  }
  publish(channel, payload) { return this.post('/api/publish', { channel, payload }); }
  sessions() { return this.get('/api/sessions'); }
  session(id) { return this.get(`/api/session?id=${encodeURIComponent(id)}`); }
  connect() {
    if (this.controller) return; this.controller = new AbortController();
    this._socket(this.controller.signal).catch(() => this._stream(this.controller.signal))
      .catch((error) => { this.connected = false; this.emit('disconnect', error); });
  }
  disconnect() { this.controller?.abort(); this.controller = null; this.connected = false; }
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
      socket.once('open', () => { opened = true; this.connected = true; this.emit('connect', { transport: 'websocket' }); });
      socket.on('message', (raw) => { try { const message = JSON.parse(String(raw)); this.emit('event', message); } catch (_) {} });
      socket.once('error', (error) => { if (!opened) reject(error); });
      socket.once('close', () => { signal.removeEventListener('abort', abort); this.connected = false; if (opened && !signal.aborted) reject(new Error('Daemon WebSocket closed')); else resolve(); });
    });
  }
}

module.exports = { DaemonClient };
