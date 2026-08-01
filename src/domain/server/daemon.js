#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { TaskRunner } = require('../pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../pi-agent/core-execution-coordinator');
const { ModelStatusStore } = require('../hud/model-status-store');
const knowledge = require('../pi-agent/pi-knowledge-orchestrator');
const { SessionStore } = require('./session-store');
const { MobileDeviceStore } = require('./mobile-device-store');
const { writeSystemMemory } = require('../pi-core/system-memory');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { PROVIDER_SECRET } = require('../pi-core/security/security-policy');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_ROOT = path.join(os.homedir(), '.bigkiji');
const CONFIG_FILE = path.join(STATE_ROOT, 'remote.json');
const PID_FILE = path.join(STATE_ROOT, 'daemon.pid');

const EVENT_CHANNEL = Object.freeze({
  task: 'task:event', tasklog: 'task:log', run: 'run:event', models: 'model:status:update',
  commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event',
  stats: 'pi:stats', bus: 'bus:event', preview: 'preview:status', fleet: 'pi:fleet', inventory: 'inventory:update', security: 'security:status',
});

const INVENTORY_EXCLUDE = /(?:^|\/)(?:node_modules|\.git|\.obsidian|graphify-out|dist|recordings|\.next)(?:\/|$)/;

function loadConfig() {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (value?.token) return { enabled: true, bind: '127.0.0.1', port: 8777, ...value };
  } catch (_) {}
  const value = { enabled: true, bind: '127.0.0.1', port: 8777, token: crypto.randomBytes(24).toString('hex') };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

async function readJson(req, max = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

class DaemonEngine extends EventEmitter {
  constructor({ appRoot = APP_ROOT, stateRoot = STATE_ROOT, workspace = process.env.BIGKIJI_WORKSPACE || process.cwd() } = {}) {
    super();
    this.appRoot = path.resolve(appRoot); this.stateRoot = path.resolve(stateRoot); this.workspace = path.resolve(workspace);
    this.startedAt = Date.now(); this.sessions = new SessionStore({ root: path.join(this.stateRoot, 'sessions') });
    this.runner = new TaskRunner({ cwd: this.workspace, vaultRoot: this.workspace, maxParallel: 3 });
    this.secrets = new Map();
    for (const [provider, variable] of Object.entries(PROVIDER_SECRET)) {
      const value = process.env[variable];
      if (value) this.secrets.set(provider === 'claude-code' ? 'claude' : provider, String(value));
    }
    this.runner.setSecretProvider((provider) => this.secrets.get(provider === 'claude-code' ? 'claude' : provider) || '');
    this.models = new ModelStatusStore({ knowledge }); this.runSessions = new Map(); this.activeSessionId = '';
    const initialPolicy = this.runner.policy.resolve(this.workspace);
    this.securityState = { mode: 'strict-direct', status: 'ENFORCED', webSearch: 'broker-only', environment: 'minimal',
      blocked: 0, manifests: 0, recent: [], policyHash: initialPolicy.security?.policyHash || '',
      credentials: Object.fromEntries(['claude', 'codex', 'gemini', 'glm'].map((provider) => [provider, this.secrets.has(provider)])) };
    this.inventory = { root: this.workspace, files: [], folders: [], scannedAt: 0, truncated: false };
    this.coordinator = new CoreExecutionCoordinator({ taskRunner: this.runner, settingsProvider: () => ({
      routing: { executionMode: 'plan', maxAgents: 3, sessionLeader: 'auto', facilitationComplete: true },
      quality: { gate: 'strict', maxRepairCycles: 2 },
    }) });
    setImmediate(() => { try { writeSystemMemory({ appRoot: this.appRoot }); } catch (error) {
      this.publish('commentary', { source: 'PiAgent Engine', status: 'WARN', text: `System memory indexing failed: ${String(error.message).slice(0, 160)}` });
    } });
    this.runner.qwenGuardrails.on('health', (health) => this.models.ingestQwenHealth(health));
    this.runner.qwenGuardrails.on('reset', (reset) => this.publish('commentary', { source: 'Local Qwen', status: 'RESET', text: `KV cache reset: ${reset.reason}` }));
    this.runner.on('task', (task) => {
      this.models.ingestTask(task); this.publish('task', task);
      const sessionId = task.metadata?.runId && this.runSessions.get(task.metadata.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'task', status: task.status, task });
    });
    this.runner.on('log', (entry) => {
      this.publish('tasklog', entry);
      const task = this.runner.get(entry.taskId); const sessionId = task?.metadata?.runId && this.runSessions.get(task.metadata.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'log', provider: entry.provider, text: String(entry.text || '').slice(0, 8000) });
    });
    this.runner.on('security', (event) => {
      if (event.decision === 'DENY') this.securityState.blocked += 1;
      if (event.decision === 'MANIFEST') { this.securityState.manifests += 1; this.securityState.policyHash = event.disclosure?.policyHash || this.securityState.policyHash; }
      this.securityState.recent = [{ decision: event.decision, provider: event.provider, reason: event.reason || '',
        taskId: event.taskId, at: event.at }, ...this.securityState.recent].slice(0, 12);
      this.publish('security', this.securityState);
    });
    this.coordinator.on('run', (run) => this.onRun(run));
    this.models.on('update', (snapshot) => { this.publish('models', snapshot); this.publish('fleet', snapshot); });
    setImmediate(() => this.refreshInventory().catch(() => {}));
    this.inventoryTimer = setInterval(() => this.refreshInventory().catch(() => {}), 300000);
    this.inventoryTimer.unref();
  }

  publish(event, data) { this.emit('event', { event, channel: EVENT_CHANNEL[event] || event, data, ts: Date.now() }); }

  setCredentials(values = {}, { replace = false } = {}) {
    for (const provider of ['claude', 'codex', 'gemini', 'glm']) {
      if (!replace && !Object.prototype.hasOwnProperty.call(values, provider)) continue;
      const value = typeof values[provider] === 'string' ? values[provider].trim() : '';
      if (value) this.secrets.set(provider, value);
      else this.secrets.delete(provider);
    }
    this.securityState.credentials = Object.fromEntries(['claude', 'codex', 'gemini', 'glm']
      .map((provider) => [provider, this.secrets.has(provider)]));
    this.publish('security', this.securityState);
    return { ok: true, credentials: this.securityState.credentials };
  }

  onRun(run) {
    this.models.ingestRun(run); const sessionId = this.runSessions.get(run.id) || this.activeSessionId;
    if (sessionId) {
      this.runSessions.set(run.id, sessionId);
      this.sessions.append(sessionId, { type: 'run', status: run.status, run });
    }
    const phase = ['PLANNING', 'AWAITING_APPROVAL'].includes(run.status) ? (run.status === 'AWAITING_APPROVAL' ? 'AWAITING_OWNER_DIRECTIVE' : 'PREFLIGHT')
      : ['EXECUTING', 'DISPATCHING', 'REPAIRING'].includes(run.status) ? 'EXECUTE' : 'VERIFY';
    this.publish('phase', { sessionId, runId: run.id, phase, status: run.status, progress: phase === 'PREFLIGHT' ? 20 : phase === 'EXECUTE' ? 62 : 92 });
    this.publish('run', run);
    if (sessionId) this.publish('session', this.sessions.read(sessionId));
  }

  prompt(text, { mode = 'plan', sessionId = '' } = {}) {
    const inspected = redactPayload(String(text || '').trim());
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_PROMPT');
    const clean = inspected.text; if (!clean) throw new Error('Prompt is empty');
    const session = sessionId ? this.sessions.read(sessionId) : this.sessions.create(clean, { workspace: this.workspace });
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.activeSessionId = session.id;
    this.sessions.append(session.id, { type: 'owner', status: 'PREFLIGHT', text: clean });
    this.publish('session', this.sessions.read(session.id));
    this.publish('phase', { sessionId: session.id, phase: 'PREFLIGHT', status: 'PRUNING', progress: 8 });
    this.publish('commentary', { source: 'PiAgent Engine', status: 'PRUNING', text: 'Inspecting sandbox memory and selecting only the required models.' });
    const run = this.coordinator.submit({ prompt: clean, promptSpec: { goal: clean, acceptance: [], decisions: [] }, cwd: this.workspace,
      mode: mode === 'auto' ? 'auto' : 'plan' });
    this.runSessions.set(run.id, session.id);
    this.sessions.append(session.id, { type: 'run', status: run.status, run });
    this.publish('run', run);
    if (run.status === 'AWAITING_APPROVAL') {
      this.publish('phase', { sessionId: session.id, runId: run.id, phase: 'AWAITING_OWNER_DIRECTIVE', status: run.status, progress: 25 });
      this.publish('commentary', { source: 'BigKiji', status: 'SYNC', text: 'The change plan is ready. Accept, edit, reject, or send a custom directive.' });
    }
    return { accepted: true, sessionId: session.id, run };
  }

  directive({ action, runId, text, revision, planHash, disclosureHash, idempotencyKey }) {
    const run = this.coordinator.get(String(runId || '')); if (!run) throw new Error('Unknown run');
    const sessionId = this.runSessions.get(run.id); const normalized = String(action || '').toLowerCase();
    const inspected = redactPayload(String(text || ''));
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_DIRECTIVE');
    this.sessions.append(sessionId, { type: 'directive', action: normalized, text: inspected.text });
    if (normalized === 'accept') return this.coordinator.approve(run.id, { revision, planHash, disclosureHash, idempotencyKey });
    if (normalized === 'reject' || normalized === 'cancel') return this.coordinator.abort(run.id);
    if (normalized === 'edit' || normalized === 'custom') {
      this.coordinator.abort(run.id);
      return this.prompt(inspected.text, { mode: 'plan', sessionId });
    }
    throw new Error('Directive must be accept, edit, reject, or custom');
  }

  reload({ policyHash = '', ownerConfirmed = false } = {}) {
    if (!ownerConfirmed) throw new Error('OWNER_CONFIRMATION_REQUIRED');
    if (!policyHash || policyHash !== this.securityState.policyHash) throw new Error('STALE_SECURITY_POLICY');
    const roots = [path.join(this.appRoot, 'src', 'extensions'), path.join(this.appRoot, 'src', 'hooks')];
    let cleared = 0;
    for (const key of Object.keys(require.cache)) if (roots.some((root) => key.startsWith(`${root}${path.sep}`))) { delete require.cache[key]; cleared++; }
    const result = { ok: true, cleared, roots, at: new Date().toISOString() };
    this.publish('commentary', { source: 'PiAgent Engine', status: 'SYNC', text: `Reloaded ${cleared} generated hooks.` });
    return result;
  }

  async refreshInventory({ limit = 700, maxDepth = 5 } = {}) {
    const files = []; const folders = new Set(); const root = this.workspace;
    const walk = async (directory, depth) => {
      if (files.length >= limit || depth > maxDepth) return;
      let entries; try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (_) { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= limit) break;
        if (entry.name.startsWith('.')) continue;
        const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replace(/\\/g, '/');
        if (!relative || INVENTORY_EXCLUDE.test(relative)) continue;
        if (entry.isDirectory()) { folders.add(relative); await walk(absolute, depth + 1); continue; }
        if (!entry.isFile()) continue;
        try { const stat = await fs.promises.stat(absolute); files.push({ path: relative, folder: path.posix.dirname(relative), size: stat.size, updatedAt: stat.mtimeMs }); } catch (_) {}
      }
    };
    await walk(root, 0);
    this.inventory = { root, files, folders: [...folders], scannedAt: Date.now(), truncated: files.length >= limit };
    this.publish('inventory', this.inventory);
    return this.inventory;
  }

  state() {
    return { source: 'bigkiji-daemon', version: 2, pid: process.pid, startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt,
      workspace: this.workspace, activeSessionId: this.activeSessionId, sessions: this.sessions.list(24), runs: this.coordinator.snapshot(),
      tasks: this.runner.snapshot(), models: this.models.snapshot(), inventory: this.inventory, security: this.securityState,
      phase: this.coordinator.snapshot().at(-1)?.status || 'IDLE' };
  }
  shutdown() { clearInterval(this.inventoryTimer); this.runner.shutdown(); }
}

function startDaemon({ engine = new DaemonEngine(), config = loadConfig() } = {}) {
  const clients = new Set(); let seq = 0;
  const mobileDevices = new MobileDeviceStore({ root: engine.stateRoot });
  const sockets = new Set(); const wss = new WebSocketServer({ noServer: true });
  const staticFiles = {
    '/': ['src/components/UI/remote/mobile.html', 'text/html; charset=utf-8'],
    '/manifest.webmanifest': ['src/components/UI/remote/manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['src/components/UI/remote/sw.js', 'text/javascript'],
    '/icon-192.png': ['src/components/UI/remote/icon-192.png', 'image/png'],
    '/icon-512.png': ['src/components/UI/remote/icon-512.png', 'image/png'],
    '/vendor/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript'],
    '/vendor/three.core.js': ['node_modules/three/build/three.core.js', 'text/javascript'],
    '/favicon.ico': ['src/components/UI/remote/icon-192.png', 'image/png'],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, source: 'bigkiji-daemon', version: 2, pid: process.pid, uptimeMs: Date.now() - engine.startedAt });
    const jar = cookies(req); const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const masterToken = bearer || url.searchParams.get('t') || jar.bk_t || ''; const isMaster = masterToken === config.token;
    const mobileDevice = jar.bk_mobile ? mobileDevices.authenticate(jar.bk_mobile) : null;
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const pairingCode = url.searchParams.get('pair') || '';
      if (url.pathname === '/' && !isMaster && !mobileDevice && !mobileDevices.validPairing(pairingCode)) return json(res, 401, { error: 'Open a current pairing QR from BigKiji Universe.' });
      const [relative, type] = staticFiles[url.pathname]; const file = path.join(engine.appRoot, relative);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'asset not found' });
      const headers = { 'content-type': type, 'cache-control': url.pathname === '/' ? 'no-cache' : 'public, max-age=86400' };
      res.writeHead(200, headers); fs.createReadStream(file).pipe(res); return;
    }
    try {
      if (req.method === 'POST' && url.pathname === '/api/mobile/pair') {
        const body = await readJson(req); const paired = mobileDevices.pair(body.code, { name: body.name, platform: body.platform });
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'set-cookie': `bk_mobile=${paired.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000` });
        res.end(JSON.stringify({ paired: true, csrf: paired.csrf, device: paired.device })); return;
      }
      if (!isMaster && !mobileDevice) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname.startsWith('/api/mobile/') && url.pathname !== '/api/mobile/me' && !isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
      if (mobileDevice && req.method !== 'GET') {
        const origin = String(req.headers.origin || ''); const host = String(req.headers.host || '');
        if (origin && new URL(origin).host !== host) return json(res, 403, { error: 'origin mismatch' });
        if (!mobileDevices.verifyCsrf(mobileDevice, req.headers['x-bigkiji-csrf'])) return json(res, 403, { error: 'csrf check failed' });
      }
      if (req.method === 'POST' && url.pathname === '/api/mobile/pairing') return json(res, 201, mobileDevices.createPairing());
      if (req.method === 'POST' && url.pathname === '/api/security/credentials') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req, 64 * 1024);
        return json(res, 200, engine.setCredentials(body.values || body, { replace: body.replace === true }));
      }
      if (req.method === 'GET' && url.pathname === '/api/mobile/devices') return json(res, 200, { devices: mobileDevices.list() });
      if (req.method === 'GET' && url.pathname === '/api/mobile/me') return json(res, 200, { device: mobileDevice ? mobileDevices.public(mobileDevice) : null, master: isMaster });
      if (req.method === 'POST' && url.pathname === '/api/mobile/devices/revoke') { const body = await readJson(req); return json(res, 200, mobileDevices.revoke(String(body.id || ''))); }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.state());
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { sessions: engine.sessions.list(Number(url.searchParams.get('limit') || 40)) });
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const session = engine.sessions.read(url.searchParams.get('id')); return json(res, session ? 200 : 404, session || { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(engine.state())}\n\n`); clients.add(res);
        req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        const body = await readJson(req);
        return json(res, 202, engine.prompt(body.text, { mode: body.mode, sessionId: body.sessionId }));
      }
      if (req.method === 'POST' && url.pathname === '/api/directive') {
        const body = await readJson(req); const run = engine.coordinator.get(String(body.runId || ''));
        if (mobileDevice && (!run || Number(body.revision) !== run.revision || String(body.planHash || '') !== run.planHash
          || String(body.disclosureHash || '') !== run.disclosureHash)) return json(res, 409, { error: 'plan or disclosure changed', run });
        return json(res, 200, engine.directive(body));
      }
      if (req.method === 'POST' && url.pathname === '/api/run/approve') {
        const body = await readJson(req); const run = engine.coordinator.get(String(body.id || ''));
        if (!run || Number(body.revision) !== run.revision || String(body.planHash || '') !== run.planHash
          || String(body.disclosureHash || '') !== run.disclosureHash) return json(res, 409, { error: 'plan or disclosure changed', run });
        return json(res, 200, engine.directive({ action: 'accept', runId: body.id, revision: body.revision, planHash: body.planHash,
          disclosureHash: body.disclosureHash, idempotencyKey: body.idempotencyKey }));
      }
      if (req.method === 'POST' && url.pathname === '/api/run/abort') { const body = await readJson(req); return json(res, 200, engine.directive({ action: 'reject', runId: body.id })); }
      if (req.method === 'POST' && url.pathname === '/api/abort') {
        const latest = engine.coordinator.snapshot().filter((run) => !['COMPLETED', 'FAILED'].includes(run.status)).at(-1);
        return json(res, 202, latest ? engine.coordinator.abort(latest.id) : { accepted: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/reload') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req);
        return json(res, 200, engine.reload(body));
      }
      if (req.method === 'POST' && url.pathname === '/api/publish') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req); const event = Object.keys(EVENT_CHANNEL).find((key) => EVENT_CHANNEL[key] === body.channel) || body.event;
        if (!EVENT_CHANNEL[event]) return json(res, 400, { error: 'unsupported channel' });
        engine.publish(event, body.payload); return json(res, 202, { accepted: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) { return json(res, 500, { error: String(error.message || error).slice(0, 500) }); }
  });

  engine.on('event', ({ event, data }) => {
    seq++;
    for (const client of clients) if (!client.writableEnded) client.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const message = JSON.stringify({ event, data, seq });
    for (const socket of sockets) if (socket.readyState === 1) socket.send(message);
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('t') !== config.token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket) => {
    sockets.add(socket); socket.send(JSON.stringify({ event: 'state', data: engine.state(), seq }));
    socket.on('close', () => sockets.delete(socket));
  });
  const ping = setInterval(() => { for (const client of clients) if (!client.writableEnded) client.write(': ping\n\n'); }, 15000); ping.unref();
  server.listen(config.port, config.bind, () => {
    const pidFile = engine.stateRoot === STATE_ROOT ? PID_FILE : path.join(engine.stateRoot, 'daemon.pid');
    fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    if (process.send) process.send({ type: 'ready', port: config.port });
    else console.log(`[BIGKIJI DAEMON READY] http://${config.bind}:${config.port}`);
  });
  server.on('error', (error) => { console.error(`[BIGKIJI DAEMON ERROR] ${error.message}`); process.exitCode = 1; });
  const close = () => { clearInterval(ping); for (const socket of sockets) socket.close(); wss.close(); engine.shutdown(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { server, engine, config, mobileDevices, close };
}

if (require.main === module) startDaemon();

module.exports = { DaemonEngine, startDaemon, loadConfig, EVENT_CHANNEL, APP_ROOT, STATE_ROOT };
