#!/usr/bin/env node
'use strict';

// The daemon is spawned detached by whichever surface got there first, so it
// inherits that process's environment — and the CLI, unlike Electron, never
// loaded .env. Loading it here makes the answer the same either way. dotenv does
// not overwrite a variable that is already set, so an explicit export still wins.
try {
  const nodePath = require('path');
  const appRoot = nodePath.resolve(__dirname, '..', '..', '..');
  const { resolveDataRoot, defaultUserData } = require('../../core/data-root');
  const { loadEnvFiles } = require('../../core/env-file');
  let root = '';
  try { root = resolveDataRoot({ userData: defaultUserData() }).dataRoot; } catch (_) {}
  loadEnvFiles({ dataRoot: root, appRoot });
} catch (_) { /* optional */ }

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { TaskRunner } = require('../pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../pi-agent/core-execution-coordinator');
const { CircuitBreaker } = require('../pi-agent/circuit-breaker');
const { warmModel } = require('../pi-agent/model-router');
const { readiness, survey } = require('../pi-agent/provider-readiness');
const { detectAndProbeAll } = require('../pi-agent/tool-registry');
const { FastFacilitatorRouter, questionText } = require('../pi-agent/fast-api-router');
const { ModelStatusStore } = require('../hud/model-status-store');
const { FleetMetricsStore } = require('../../core/fleet-metrics-store');
const knowledge = require('../pi-agent/pi-knowledge-orchestrator');
const { SessionStore } = require('./session-store');
const { MobileDeviceStore } = require('./mobile-device-store');
const { writeSystemMemory } = require('../pi-core/system-memory');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { PROVIDER_SECRET } = require('../pi-core/security/security-policy');
const { ConversationEngine, normalizeKeepAlive } = require('../pi-core/conversation-engine');
const { isStatusQuestion, statusReport } = require('../pi-core/status-answer');
const { reflectionPrompt, normalizeReflection } = require('../pi-agent/critique');
const { IdeaDraftStore } = require('../pi-core/idea-draft-store');
const stt = require('./speech-to-text');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
// The daemon is a separate process from Electron, so it resolves the data root the
// same way the app does. BIGKIJI_DATA_ROOT is exported by main.js before spawn; when
// the daemon is started standalone it falls back to the pointer / the default.
const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
const DATA = resolveDataRoot({ userData: defaultUserData() });
const LAYOUT = dataLayout(DATA.dataRoot, DATA.overrides);
const STATE_ROOT = LAYOUT.stateRoot;
const CONFIG_FILE = LAYOUT.remoteConfigFile;
const PID_FILE = LAYOUT.daemonPidFile;
const APP_VERSION = require('../../../package.json').version;
// whisper/recordings locations for the mobile voice route
const { createPathConfig } = require('../../core/path-config');
const PATHS = createPathConfig({ appRoot: APP_ROOT });

// The modes the coordinator understands. 'plan' and 'ask' both wait for the owner before
// anything writes; only 'auto' releases without asking.
const MODES = Object.freeze(['plan', 'ask', 'auto', 'manual', 'demo']);
// What the owner types when they want the fleet to settle the open decisions itself.
// The front desk's stage two already exists for this: told the owner has answered, it
// is forbidden from asking again and must choose safe reasonable defaults.
const HANDS_OFF_ANSWER = 'おまかせ。安全で一般的な既定を選んで進めて。';

/** True for a request that came from this machine's own loopback interface. */
function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The mode a request is allowed to run in.
 *
 * Loopback — the CLI and the Electron window, running as the owner on the owner's
 * machine — gets what it asked for. Anything else gets 'plan' and waits for a human,
 * because the daemon listens on 0.0.0.0 and a token on the LAN must not be able to buy
 * unattended writes. Requesting a mode is not the same as being allowed one.
 */
function effectiveMode(req, requested) {
  const wanted = String(requested || '');
  if (!MODES.includes(wanted)) return 'plan';
  return isLoopback(req) ? wanted : 'plan';
}

// A run that has finished is history, not a phase.
//
// `phase` is what the CLI footer's status word and phase vector are drawn from, and it
// was `snapshot().at(-1)?.status` — the status of the newest run, finished or not. So a
// fresh REPL, before the owner had asked for anything, opened reading
//
//     ⣛  failed  —          phase vector  ○1 preflight  ○2 execute  ○3 verify    0%
//
// because the last run of some earlier session had failed. Measured in a real pty on
// 2026-08-05, and visible in the owner's own screenshot the same day; `/runs` on the
// same screen correctly said `0 waiting`, so the footer and the command disagreed.
//
// The current phase is the newest run that can still move. AWAITING_APPROVAL counts —
// it is waiting on the owner, which is very much a current state — and the terminal ones
// do not. With nothing live, the honest word is IDLE, the same rule as `—` ≠ 0 in the
// work card: an absent phase is not a failed one.
/**
 * A spec field as a list, whatever the model returned it as.
 *
 * `"constraints": "none"` is a reasonable thing for a small model to emit against a
 * schema that asks for an array, and specText() in fast-api-router already learned
 * this the expensive way — it used to throw on exactly that, and the caller turned
 * the throw into a bare "Fast route unavailable" that named no cause.
 */
function asList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  return [value].filter(Boolean).map(String);
}
/**
 * A value that can be written to the session log.
 *
 * A task carries live handles, an abort timer among them, and on 2026-08-05 one went
 * into JSON.stringify and threw "Converting circular structure to JSON" out of
 * shutdown() — from inside an EventEmitter callback, where nothing could catch it, so
 * the process died rather than the append failing. publicRun() already strips a
 * Timeout for exactly this reason. A session file is a transcript, not a heap dump.
 */
function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  // A timer handle: has ref/unref and a circular place in the timers list.
  if (typeof value.ref === 'function' && typeof value.unref === 'function') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const safe = jsonSafe(entry, seen);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

/** How long an unanswered front-desk question stays the meaning of the next thing typed. */
const FACILITATION_WINDOW_MS = 15 * 60 * 1000;
const TERMINAL_RUN = Object.freeze(['COMPLETED', 'FAILED', 'EXPIRED', 'SECURITY_BLOCKED']);
function currentPhase(runs) {
  const live = (Array.isArray(runs) ? runs : []).filter((run) => !TERMINAL_RUN.includes(run?.status));
  return live.at(-1)?.status || 'IDLE';
}

const EVENT_CHANNEL = Object.freeze({
  task: 'task:event', tasklog: 'task:log', step: 'task:step', run: 'run:event', models: 'model:status:update',
  commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event',
  stats: 'pi:stats', bus: 'bus:event', preview: 'preview:status', fleet: 'pi:fleet', inventory: 'inventory:update', security: 'security:status',
  conversation: 'conversation:update', idea: 'idea:update', knowledge: 'knowledge:status', checkpoint: 'run:checkpoint', report: 'run:report', tools: 'tools:status',
  review: 'run:review', reflection: 'run:reflection',
});

// npm narrating its own work while Pi boots. Everything here is progress or an
// advertisement; a real failure says `Error`, `not found`, `EACCES` or similar and
// is deliberately not matched.
const PI_STDERR_NOISE = /^(?:added \d+ packages|removed \d+ packages|changed \d+ packages|up to date|audited \d+ packages|\d+ packages? (?:are|is) looking for funding|run `npm fund` for details|found 0 vulnerabilities|npm notice|npm warn deprecated|Changelog: https|To update run: npm)/i;

const INVENTORY_EXCLUDE = /(?:^|\/)(?:node_modules|\.git|\.obsidian|graphify-out|dist|recordings|\.next)(?:\/|$)/;
// The content type comes from this map, never from the request or from sniffing, so a
// file cannot be served as something it is not. An extension that is absent here is a
// 415 rather than a download — the media root holds generated output, and anything in
// it that is not an image, a video or a sound is not something the phone should fetch.
// pipe() does not forward source errors, and this process exits on an uncaught
// exception — so a file that vanishes between statSync and open (a generation pipeline
// replacing its own output while the phone is fetching it) took the whole engine down.
// An aborted range request, which is what a phone does on every seek, also has to close
// the descriptor or they accumulate one per seek.
function sendFile(res, file, options = {}) {
  const stream = fs.createReadStream(file, options);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); stream.destroy(); });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const ASSET_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
});

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

async function readBuffer(req, max = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  constructor({ appRoot = APP_ROOT, stateRoot = STATE_ROOT, layout = LAYOUT, workspace = process.env.BIGKIJI_WORKSPACE || process.cwd(),
    conversationEngine = null, ideaStore = null, knowledgeStore = knowledge, facilitator = null } = {}) {
    super();
    this.appRoot = path.resolve(appRoot); this.stateRoot = path.resolve(stateRoot); this.workspace = path.resolve(workspace);
    // Tests inject a throwaway stateRoot; production uses the resolved data layout,
    // where sessions/ideas are siblings of state/ rather than children of it.
    this.customState = path.resolve(stateRoot) !== path.resolve(STATE_ROOT);
    const rootFor = (key, name) => (this.customState ? path.join(this.stateRoot, name) : layout[key]);
    this.startedAt = Date.now(); this.sessions = new SessionStore({ root: rootFor('sessionsRoot', 'sessions') });
    // How many jobs run at once. The owner sets it; 3 was a literal nobody could
    // reach. Local tasks are additionally serialised inside the runner, because they
    // all share one GPU — see canStart().
    this.runner = new TaskRunner({ cwd: this.workspace, vaultRoot: this.workspace,
      maxParallel: Math.max(1, Math.min(8, Number(this.ownerSettings()?.routing?.maxParallel) || 3)) });
    this.conversation = conversationEngine || new ConversationEngine();
    // The front desk that turns a one-line request into a spec worth executing.
    //
    // It existed and worked — measured 2026-08-05, 17 characters in, a 945-character
    // decision-complete spec out in 5.7s on a local model that costs nothing — and it
    // was reachable from nowhere. `fast-api-router` was required by main.js alone, and
    // main.js only calls it when the daemon is *not* connected, which on a running
    // machine is never. So every request arrived here as `goal: <the owner's one line>`
    // with empty constraints, steps and acceptance, and the specialists were asked to
    // build from it. This is that router, on the path both surfaces actually use.
    this.facilitator = facilitator || new FastFacilitatorRouter();
    this.facilitatorPending = null;
    this.ideas = ideaStore || new IdeaDraftStore({ root: rootFor('ideasRoot', 'ideas'), workspace: this.workspace });
    this.ideaEnhancements = new Map();
    this.knowledge = knowledgeStore;
    this.conversationConfig = { autoIdeas: true, cloudEnhancementApproval: 'always' };
    this.secrets = new Map();
    for (const [provider, variable] of Object.entries(PROVIDER_SECRET)) {
      const value = process.env[variable];
      if (value) this.secrets.set(provider === 'claude-code' ? 'claude' : provider, String(value));
    }
    this.runner.setSecretProvider((provider) => this.secrets.get(provider === 'claude-code' ? 'claude' : provider) || '');
    this.models = new ModelStatusStore({ knowledge }); this.piFleet = new FleetMetricsStore({}); this.runSessions = new Map(); this.turnQueue = new Map(); this.activeSessionId = '';
    const initialPolicy = this.runner.policy.resolve(this.workspace);
    this.securityState = { mode: 'strict-direct', status: 'ENFORCED', webSearch: 'broker-only', environment: 'minimal',
      blocked: 0, manifests: 0, recent: [], policyHash: initialPolicy.security?.policyHash || '',
      credentials: Object.fromEntries(['claude', 'codex', 'gemini', 'glm'].map((provider) => [provider, this.secrets.has(provider)])) };
    this.inventory = { root: this.workspace, files: [], folders: [], scannedAt: 0, truncated: false };
    // The breaker keeps its cooldowns on disk. A quota is spent for hours, sometimes
    // a week; holding that in memory alone meant every daemon restart walked back
    // into the same wall, and this daemon restarts often.
    this.breaker = new CircuitBreaker({ file: path.join(this.stateRoot, 'circuit-breaker.json') });
    this.coordinator = new CoreExecutionCoordinator({ taskRunner: this.runner, settingsProvider: () => this.ownerSettings(), breaker: this.breaker,
    // Can this provider actually start — not "did the owner paste an API key".
    //
    // The old test asked the second question and answered no for every paid
    // provider, permanently. Claude Code and Codex authenticate with their own
    // CLI login and have no key to paste; Gemini's CLI reads GOOGLE_API_KEY as
    // readily as GEMINI_API_KEY; and the owner's keys lived in .env, which the
    // settings store never sees. So there were four usable providers, a
    // coordinator that believed it had none, and every plan quietly routed to
    // the local model. Nothing errored. It just did less. See
    // provider-readiness.js, which also explains why a provider is not ready.
    available: (provider) => readiness(provider, { secret: (id) => this.secrets.get(id) || '' }).ready });
    this.refreshAvailability();
    setImmediate(() => { try { writeSystemMemory({ appRoot: this.appRoot }); } catch (error) {
      this.publish('commentary', { source: 'PiAgent Engine', status: 'WARN', text: `System memory indexing failed: ${String(error.message).slice(0, 160)}` });
    } });
    this.runner.qwenGuardrails.on('health', (health) => this.models.ingestQwenHealth(health));
    this.runner.qwenGuardrails.on('reset', (reset) => this.publish('commentary', { source: 'Local Qwen', status: 'RESET', text: `KV cache reset: ${reset.reason}` }));
    this.runner.on('task', (task) => {
      this.models.ingestTask(task); this.piFleet.ingestTask(task); this.publish('task', task);
      const sessionId = task.metadata?.runId && this.runSessions.get(task.metadata.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'task', status: task.status, task: jsonSafe(task) });
      if (task.metadata?.kind === 'idea-enhancement' && ['completed', 'failed', 'blocked'].includes(task.status)) this.finishIdeaEnhancement(task);
    });
    this.runner.on('log', (entry) => {
      this.publish('tasklog', entry);
      const task = this.runner.get(entry.taskId); const sessionId = task?.metadata?.runId && this.runSessions.get(task.metadata.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'log', provider: entry.provider, text: String(entry.text || '').slice(0, 8000) });
    });
    // Structured work steps, alongside the raw log rather than instead of it. Appending
    // them to the session JSONL as well is what lets a past session be reopened later with
    // its timeline intact, instead of only the flattened log text.
    this.runner.on('step', (step) => {
      this.publish('step', step);
      const task = this.runner.get(step.taskId); const sessionId = task?.metadata?.runId && this.runSessions.get(task.metadata.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'step', ...step });
    });
    this.runner.on('security', (event) => {
      if (event.decision === 'DENY') this.securityState.blocked += 1;
      if (event.decision === 'MANIFEST') { this.securityState.manifests += 1; this.securityState.policyHash = event.disclosure?.policyHash || this.securityState.policyHash; }
      this.securityState.recent = [{ decision: event.decision, provider: event.provider, reason: event.reason || '',
        taskId: event.taskId, at: event.at }, ...this.securityState.recent].slice(0, 12);
      this.publish('security', this.securityState);
    });
    this.coordinator.on('run', (run) => { this.piFleet.ingestRun(run); this.onRun(run); });
    // The thirty-minute checkpoint. It is a report, not a kill — the owner asked for
    // 「期限で区切って途中経過を出す」, so the run continues and says where it is.
    // The critique loop's second half: the agent answers BigKiji's findings.
    //
    // Fire and forget, and deliberately so. A reflection that fails must not touch
    // the result it is about — the work is done and reported either way. It only
    // runs when there is something to answer, so a clean run costs nothing.
    this.coordinator.on('review', (review) => {
      this.publish('review', review);
      if (review.quiet) return;
      this.reflect(review).catch(() => {});
    });
    // Step ⑥: one report when the work is finished, rather than N answers the owner
    // has to reconcile themselves.
    this.coordinator.on('report', (report) => {
      this.publish('report', report);
      // The run is finished; the index entry that mapped it to a session is not
      // needed after the report has been filed. runSessions had no delete at all.
      setTimeout(() => this.runSessions.delete(report.runId), 60000).unref?.();
      const sessionId = this.runSessions.get(report.runId);
      if (sessionId) this.sessions.append(sessionId, { type: 'report', ...report });
      knowledge.recordEvent(report.runId, { type: 'run-report', status: report.status, provider: 'bigkiji',
        evidence: `${report.completed}/${report.total} completed${report.tokens ? ` · ${report.tokens} tok` : ''}` });
    });
    this.coordinator.on('checkpoint', (report) => {
      const sessionId = this.runSessions.get(report.runId);
      const late = report.overdueMinutes ? ` (${report.budgetMinutes + report.overdueMinutes} min elapsed)` : '';
      this.publish('commentary', { source: 'BigKiji', status: 'CHECKPOINT',
        text: `${report.completed.length}/${report.completed.length + report.stillRunning.length} done${late}`
          + (report.stillRunning.length ? ` — still running: ${report.stillRunning.join(', ')}` : '')
          + ' — continue or /abort' });
      this.publish('checkpoint', report);
      if (sessionId) this.sessions.append(sessionId, { type: 'checkpoint', ...report });
    });
    this.models.on('update', (snapshot) => this.publish('models', snapshot));
    this.piFleet.on('update', (snapshot) => this.publish('fleet', snapshot));
    setImmediate(() => this.refreshInventory().catch(() => {}));
    setImmediate(() => this.refreshTools().catch(() => {}));
    this.inventoryTimer = setInterval(() => this.refreshInventory().catch((err) => {
      // `engine` is a parameter of startDaemon(), not a name in class scope: the only
      // path that reported an inventory failure threw a ReferenceError instead.
      this.publish('error', { source: 'daemon', error: `Inventory refresh failed: ${String(err.message).slice(0, 100)}` });
    }), 300000);
    this.inventoryTimer.unref();
    // The same slow cadence: these are HTTP probes against local services, and the
    // answer changes when the owner starts ComfyUI, not fifteen times a second.
    this.toolTimer = setInterval(() => this.refreshTools().catch(() => {}), 300000);
    this.toolTimer.unref();
  }

  publish(event, data) { this.emit('event', { event, channel: EVENT_CHANNEL[event] || event, data, ts: Date.now() }); }

  // The coordinator used to be handed a hardcoded literal, so every routing control in
  // Settings — maxAgents, the session leader, and the deliberation switch added in
  // V2.5 — moved a value that nothing downstream read. The daemon does not own settings
  // and must not write them; it reads the same file the store writes atomically, cached
  // on mtime so a per-run read costs one stat.
  ownerSettings() {
    const file = path.join(PATHS.userData, 'settings.json');
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
    if (!this._settings || this._settingsAt !== mtime) {
      let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      this._settingsAt = mtime;
      this._settings = {
        // executionMode stays pinned to 'plan' — but read what it now defends.
        //
        // This is the *fallback* the coordinator uses when a submission names no valid
        // mode, so pinning it here never stopped a caller that named one; it only ever
        // held because _turn() flattened everything to 'plan' before this was consulted.
        // The real boundary is effectiveMode() in the HTTP layer, which honours a mode
        // only for loopback requests. This stays as the safe default underneath it.
        routing: { ...(saved.routing || {}), executionMode: 'plan', facilitationComplete: true },
        quality: { gate: 'strict', maxRepairCycles: 2, ...(saved.quality || {}) },
      };
    }
    return this._settings;
  }

  sessionSeed(sessionId) {
    const session = sessionId && this.sessions.read(sessionId); if (!session) return [];
    return (session.events || []).filter((entry) => entry.type === 'conversation' && entry.text)
      .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'owner', text: entry.text })).slice(-16);
  }

  /**
   * One conversation turn at a time per session.
   *
   * Nine turns arriving inside 31ms is not nine conversations: Ollama serves
   * them one at a time, so eight of them sat in its queue until the 8s stall
   * timeout fired and came back degraded. Queuing here makes the wait honest,
   * and it also keeps the session transcript in the order the owner typed —
   * appends used to land in completion order. Turns with no session id queue
   * together too, because that is the burst that would otherwise open one
   * session per line.
   * @returns {Promise<object>}
   */
  turn(text, options = {}) {
    const key = options.sessionId || 'new';
    const result = (this.turnQueue.get(key) || Promise.resolve()).then(() => this._turn(text, options));
    // The queue holds a rejection-proof handle: one failed turn must not cancel
    // the turns behind it, and it must not become an unhandled rejection here
    // while the caller still gets the real error.
    const guarded = result.catch(() => {});
    this.turnQueue.set(key, guarded);
    guarded.then(() => { if (this.turnQueue.get(key) === guarded) this.turnQueue.delete(key); });
    return result;
  }

  // The default is 'plan', and it matters more than it looks.
  //
  // It was 'auto', which was safe only because the body of this method threw the mode
  // away and submitted 'plan' regardless. With the mode honoured, that default would
  // hand every caller who omitted the field a run that starts writing without asking.
  // The safe value is the one that waits.
  async _turn(text, { sessionId = '', mode = 'plan' } = {}) {
    const inspected = redactPayload(String(text || '').trim());
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_PROMPT');
    const clean = inspected.text; if (!clean) throw new Error('Conversation text is empty');
    const session = sessionId ? this.sessions.read(sessionId) : this.sessions.create(clean, { workspace: this.workspace, mode: 'conversation' });
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const seed = this.sessionSeed(session.id);
    this.activeSessionId = session.id;
    this.sessions.append(session.id, { type: 'conversation', role: 'owner', status: 'CONVERSATION', text: clean });
    this.publish('session', this.sessions.read(session.id));
    this.publish('conversation', { kind: 'turn_start', sessionId: session.id, model: this.conversation.model, text: clean.slice(0, 120), receivedAt: Date.now() });
    this.publish('pi', { kind: 'turn_start', model: this.conversation.model, text: clean.slice(0, 120) });
    // "Is it actually working?" is answered by the coordinator, not by a model.
    //
    // See status-answer.js for the measurements. In short: the model is handed the true
    // numbers and still reports progress that does not exist, and prompting it harder
    // trades the fabrication for a self-contradiction. This is the one class of question
    // where a wrong answer is worse than no answer, and it is also the one class we can
    // answer exactly — so it never reaches the model at all.
    if (isStatusQuestion(clean)) return this._statusTurn(session, clean);
    // The owner answering the question the front desk asked last turn.
    //
    // Bound to the session that was asked and to a window, because "what did you mean
    // by that" cannot be allowed to swallow an unrelated request typed an hour later.
    // A status question is already intercepted above, so asking how things are going
    // while a question is open still answers the status question.
    const asked = this.facilitatorPending;
    if (asked && asked.sessionId === session.id && Date.now() - asked.at < FACILITATION_WINDOW_MS) {
      return await this._answerTurn(session, clean, mode);
    }
    if (asked) { this.facilitatorPending = null; this.facilitator.reset(); }
    const result = await this.conversation.turn({ text: clean, sessionId: session.id, seed, facts: this.facts(),
      onDelta: (delta) => this.publish('pi', { kind: 'delta', text: delta, model: this.conversation.model }) });
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: result.kind, text: result.reply,
      turnId: result.turnId, provider: result.provider, latencyMs: result.latencyMs });
    let draft = null; let run = null;
    if (result.kind === 'TASK' || (result.kind === 'IDEA' && this.conversationConfig.autoIdeas)) {
      draft = this.ideas.create({ ...result, sessionId: session.id, turnId: result.turnId, sourceExcerpt: clean, provider: result.provider,
        ideas: result.ideas.length ? result.ideas : (result.kind === 'IDEA' ? [result.summary || clean] : []) });
      this.sessions.append(session.id, { type: 'idea', status: 'draft', ideaId: draft.id, draftHash: draft.draftHash, title: draft.title });
      this.publish('idea', { action: 'created', draft });
      this.knowledge.rememberIdea?.(draft, 'draft');
      this.publish('knowledge', { status: 'DRAFTED', ideaId: draft.id, draftHash: draft.draftHash, localOnly: true });
    }
    // What the specialists are actually given.
    //
    // This block used to be the whole of it: `goal` was the owner's line verbatim and
    // the other three fields were whatever the conversation model happened to attach.
    // Measured on 2026-08-05 with 「3djsのゲームを作ってください。」 — summary "",
    // requirements [], todos [], decisions [], and one question. A leader and a UI
    // specialist were then dispatched against that, which is why plans came back
    // asking the same question instead of building. The front desk writes the spec
    // now; the conversation model's fields remain the fallback for when it cannot.
    let facilitation = null;
    if (result.kind === 'TASK') {
      facilitation = await this._facilitate(clean);
      // Hands-off: the fleet decides rather than the owner. Same two-stage front desk,
      // with the answer supplied here instead of waited for, so the decisions are made
      // once and written into the spec rather than left open for a specialist to guess
      // at mid-run — which is the failure this whole path exists to stop.
      if (facilitation?.status === 'needs_clarification' && mode === 'demo') {
        this.publish('commentary', { source: 'Front desk', status: 'PLANNING',
          text: `Deciding ${facilitation.questions.length} open question${facilitation.questions.length === 1 ? '' : 's'} without the owner — hands-off mode.` });
        const decided = facilitation.questions;
        facilitation = await this._facilitate(HANDS_OFF_ANSWER);
        // What was decided without asking. Hands-off is not the same as unaccountable:
        // the owner sees one instruction go in and a finished thing come out, so the
        // decisions made on their behalf have to be on the plan they review at the end,
        // named, rather than inferred from the result.
        if (facilitation) facilitation.decidedWithoutOwner = decided;
      }
      if (facilitation?.status === 'needs_clarification') {
        // No run yet. A missing decision is cheaper to ask about than to guess at,
        // and a plan built on a guess is what the owner has been rejecting.
        this.facilitatorPending = { sessionId: session.id, questions: facilitation.questions, at: Date.now() };
      }
    }
    if (result.kind === 'TASK' && facilitation?.status !== 'needs_clarification') {
      const written = facilitation?.promptSpec || null;
      const goal = written?.goal || result.summary || clean;
      const promptSpec = written
        ? { goal, constraints: asList(written.constraints), steps: asList(written.steps),
          acceptance: asList(written.acceptance), questions: [],
          decidedWithoutOwner: facilitation?.decidedWithoutOwner || [], ideaId: draft?.id }
        : { goal, constraints: result.requirements || [], steps: result.todos || [],
          acceptance: result.decisions || [], questions: result.openQuestions || [], ideaId: draft?.id };
      // The mode reaches the coordinator now.
      //
      // This read `mode === 'manual' ? 'manual' : 'plan'`, which flattened every mode
      // the CLI could send into 'plan' — so `/mode auto-edit` changed the prompt colour
      // and nothing else, and the coordinator ignored the field anyway. Both halves are
      // fixed; the value arriving here has already been narrowed to 'plan' for anything
      // that is not a loopback request (see effectiveMode in the HTTP layer), which is
      // what keeps a phone on the LAN from asking for auto-edit.
      run = this.coordinator.submit({ prompt: clean, promptSpec, planHash: facilitation?.planHash || null, cwd: this.workspace, mode });
      // submit() emits 'run' synchronously, so onRun has already appended this run
      // to the session and published it. Doing it again here printed the same run
      // twice in the transcript and wrote it twice into the session file.
      this.runSessions.set(run.id, session.id);
    }
    const questions = facilitation?.status === 'needs_clarification' ? facilitation.questions : [];
    // The questions travel in the reply as well as in their own field. Every surface
    // renders `reply`; only the CLI knows what to do with `questions`, and a question
    // the owner cannot see is the same as one that was never asked.
    const reply = questions.length ? `${result.reply}\n\n${questionText(questions)}` : result.reply;
    const output = { accepted: true, kind: result.kind, reply, sessionId: session.id, turnId: result.turnId,
      provider: result.provider, model: result.model, latencyMs: result.latencyMs, degraded: result.degraded, draft, run,
      questions, awaitingAnswer: questions.length > 0, requiresApproval: !!run || false };
    this.publish('conversation', { kind: 'turn_complete', ...output });
    this.publish('stats', { turn: { input: result.context?.estimatedTokens || 0, output: Math.max(1, Math.ceil(result.reply.length / 4)) },
      ms: result.latencyMs, provider: result.provider, model: result.model });
    this.publish('session', this.sessions.read(session.id));
    return output;
  }

  /**
   * The front desk, with its failure made harmless.
   *
   * `facilitate()` already falls back to a deterministic spec when no local model
   * answers, so the only thing left to guard is the call itself — an unreachable
   * Ollama must not take the turn down with it. A null here means "carry on with the
   * conversation model's fields", which is exactly the behaviour that shipped before.
   */
  async _facilitate(ownerText) {
    try {
      return await this.facilitator.facilitate(ownerText, {
        onStart: (provider) => this.publish('commentary', { source: 'Front desk', status: 'PLANNING',
          text: `Writing a decision-complete spec with ${provider}.` }),
      });
    } catch (error) {
      this.publish('commentary', { source: 'Front desk', status: 'DEGRADED',
        text: `Spec writing unavailable (${String(error.message).slice(0, 120)}) — using the conversation model's own fields.` });
      return null;
    }
  }

  /**
   * The turn that carries the answer to an open question.
   *
   * The conversation model is skipped deliberately. It classified this request one
   * turn ago and re-running it would spend a second local generation to re-derive
   * what we already hold, on a screen the owner has already told us looks frozen.
   * The reply is the spec, which is both the useful answer and the visible proof
   * that the expansion ran at all.
   */
  async _answerTurn(session, text, mode) {
    const started = Date.now();
    this.facilitatorPending = null;
    const spec = await this._facilitate(text);
    const turnId = `turn-${started.toString(36)}-spec`;
    if (!spec?.promptSpec) {
      this.facilitator.reset();
      const reply = 'The spec could not be written from that answer. Say it once more, or start again with the request in full.';
      this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'CHAT', text: reply, turnId, provider: 'front-desk' });
      const failed = { accepted: true, kind: 'CHAT', reply, sessionId: session.id, turnId, provider: 'front-desk',
        model: 'facilitator', latencyMs: Date.now() - started, degraded: true, draft: null, run: null,
        questions: [], awaitingAnswer: false, requiresApproval: false };
      this.publish('conversation', { kind: 'turn_complete', ...failed });
      this.publish('session', this.sessions.read(session.id));
      return failed;
    }
    const written = spec.promptSpec;
    const promptSpec = { goal: written.goal || text, constraints: asList(written.constraints), steps: asList(written.steps),
      acceptance: asList(written.acceptance), questions: [] };
    const run = this.coordinator.submit({ prompt: `${written.goal || text}\n\nOwner answers: ${text}`,
      promptSpec, planHash: spec.planHash || null, cwd: this.workspace, mode });
    this.runSessions.set(run.id, session.id);
    const reply = spec.promptSpecText || written.goal || text;
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'TASK', text: reply,
      turnId, provider: spec.provider, latencyMs: spec.latencyMs });
    const output = { accepted: true, kind: 'TASK', reply, sessionId: session.id, turnId, provider: spec.provider,
      model: 'facilitator', latencyMs: Date.now() - started, degraded: !!spec.fallbackReason, draft: null, run,
      questions: [], awaitingAnswer: false, requiresApproval: true };
    this.publish('conversation', { kind: 'turn_complete', ...output });
    this.publish('session', this.sessions.read(session.id));
    return output;
  }

  /**
   * Answering the `⚠ unanswered` a plan is already carrying.
   *
   * The plan the owner is looking at was built without the missing decision, so the
   * honest move is to rebuild it rather than to start it and hope. The run is aborted
   * and resubmitted with a spec that contains the answer — the same shape as the
   * `edit` directive, which has always replaced a plan rather than patching one.
   */
  async answerRun({ runId, text }) {
    const run = this.coordinator.get(String(runId || '')); if (!run) throw new Error('Unknown run');
    const inspected = redactPayload(String(text || ''));
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_DIRECTIVE');
    const said = inspected.text.trim(); if (!said) throw new Error('An answer is required');
    const questions = Array.isArray(run.promptSpec?.questions) ? run.promptSpec.questions : asList(run.promptSpec?.questions);
    if (!questions.length) throw new Error('This plan has no unanswered question');
    const sessionId = this.runSessions.get(run.id);
    if (sessionId) this.sessions.append(sessionId, { type: 'directive', action: 'answer', text: said });
    const asked = run.promptSpec?.goal || run.promptPreview || '';
    const spec = await this.facilitator.answer(asked, questions, said);
    const written = spec?.promptSpec;
    if (!written) throw new Error('The spec could not be written from that answer');
    this.coordinator.abort(run.id);
    const next = this.coordinator.submit({ prompt: `${asked}\n\nOwner answers: ${said}`,
      promptSpec: { goal: written.goal || asked, constraints: asList(written.constraints), steps: asList(written.steps),
        acceptance: asList(written.acceptance), questions: [] },
      planHash: spec.planHash || null, cwd: this.workspace, mode: run.mode || 'plan' });
    if (sessionId) this.runSessions.set(next.id, sessionId);
    return { answered: run.id, run: next, spec: spec.promptSpecText || '', provider: spec.provider };
  }

  /**
   * A status question, answered from the coordinator's snapshot.
   *
   * Same shape, same session append, same events as a model-served turn, so nothing
   * downstream needs to know the difference — except `provider`, which says plainly
   * that this came from measurement rather than from a model. It can never open an
   * idea or a run: asking how things are going is not asking for work.
   */
  _statusTurn(session, text) {
    const started = Date.now();
    const reply = statusReport(this.statusFacts(), { text });
    const turnId = `turn-${started.toString(36)}-status`;
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'CHAT', text: reply,
      turnId, provider: 'bigkiji-state', latencyMs: Date.now() - started });
    const output = { accepted: true, kind: 'CHAT', reply, sessionId: session.id, turnId,
      provider: 'bigkiji-state', model: 'measured', latencyMs: Date.now() - started, degraded: false,
      draft: null, run: null, requiresApproval: false };
    this.publish('conversation', { kind: 'turn_complete', ...output });
    this.publish('session', this.sessions.read(session.id));
    return output;
  }

  requestIdeaEnhancement(id, { draftHash = '' } = {}) {
    const draft = this.ideas.read(id); if (!draft) throw new Error('Unknown idea draft');
    if (!draftHash || draftHash !== draft.draftHash) throw new Error('STALE_IDEA_DRAFT');
    const taskId = `idea-enhance-${Date.now().toString(36)}-${id}`;
    const prompt = `Improve this private BigKiji idea draft. Do not use tools, web search, files, or outside context. Preserve owner decisions and do not invent requirements. Return JSON only with keys title, summary, ideas, requirements, decisions, openQuestions, todos.\n\n${draft.markdown}`;
    // The provider used to be the literal 'gemini'. It went round the readiness gate,
    // the circuit breaker and the capability registry, so when Gemini's quota hit
    // `limit: 0` this one path kept dispatching to it and kept failing. Ask the same
    // router everything else asks.
    const provider = this.coordinator.pickProvider('facilitator', ['gemini', 'glm', 'claude-code', 'qwen']);
    const task = this.runner.plan({ id: taskId, provider, prompt, cwd: this.workspace,
      metadata: { kind: 'idea-enhancement', ideaId: draft.id, draftHash: draft.draftHash, promptOnly: true,
        title: `Gemini improvement for ${draft.title}`, write: false } });
    this.ideaEnhancements.set(task.id, { ideaId: draft.id, draftHash: draft.draftHash });
    this.publish('idea', { action: 'enhancement-planned', draft: { ...draft, markdown: undefined }, task });
    return { draft: { ...draft, markdown: undefined }, task };
  }

  approveIdeaEnhancement({ taskId, draftHash, disclosureHash } = {}) {
    const pending = this.ideaEnhancements.get(String(taskId || '')); if (!pending) throw new Error('Unknown idea enhancement');
    const draft = this.ideas.read(pending.ideaId); if (!draft || !draftHash || draftHash !== pending.draftHash || draftHash !== draft.draftHash) throw new Error('STALE_IDEA_DRAFT');
    const task = this.runner.get(taskId); if (!task || task.metadata?.kind !== 'idea-enhancement') throw new Error('Unknown idea enhancement task');
    return this.runner.approve(task.id, { disclosureHash });
  }

  finishIdeaEnhancement(task) {
    const pending = this.ideaEnhancements.get(task.id); if (!pending) return;
    if (task.status !== 'completed') { this.publish('idea', { action: 'enhancement-failed', ideaId: pending.ideaId, task }); return; }
    try {
      const raw = String(task.output || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const start = raw.indexOf('{'); const end = raw.lastIndexOf('}'); const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
      // Record who actually improved the draft. This said 'gemini' whatever ran,
      // so the draft history credited a provider that in practice never completed
      // anything — and the router now picks whoever can start.
      const draft = this.ideas.revise(pending.ideaId, { ...parsed, provider: task.provider || 'unknown', status: 'enhanced' }, { expectedHash: pending.draftHash });
      this.knowledge.rememberIdea?.(draft, 'enhanced');
      this.publish('idea', { action: 'enhanced', draft }); this.publish('knowledge', { status: 'ENHANCED', ideaId: draft.id, draftHash: draft.draftHash });
    } catch (error) { this.publish('idea', { action: 'enhancement-failed', ideaId: pending.ideaId, error: String(error.message).slice(0, 240), task }); }
    finally { this.ideaEnhancements.delete(task.id); }
  }

  planIdea(id, { draftHash = '' } = {}) {
    const draft = this.ideas.read(id); if (!draft) throw new Error('Unknown idea draft');
    if (!draftHash || draftHash !== draft.draftHash) throw new Error('STALE_IDEA_DRAFT');
    // Point the active session at the draft's own session first. onRun reads it to
    // decide where the run belongs, and it fires inside submit() — so setting it
    // afterwards filed the run under whichever session happened to be active, and
    // the correcting append below then wrote it a second time somewhere else.
    const sessionId = draft.sessionId || this.activeSessionId;
    if (sessionId) this.activeSessionId = sessionId;
    const run = this.coordinator.submit({ prompt: draft.markdown, promptSpec: { goal: draft.summary || draft.title,
      constraints: draft.requirements, steps: draft.todos, acceptance: draft.decisions, questions: draft.openQuestions, ideaId: draft.id }, cwd: this.workspace, mode: 'plan' });
    if (sessionId) this.runSessions.set(run.id, sessionId);
    return run;
  }

  // Tell the fleet display what the router already knows.
  //
  // These were two unconnected paths: the coordinator decided who could work,
  // and the model store decided what the owner was shown, and nobody ever told
  // the store anything. So every provider read `offline` regardless — which is
  // a word that explains nothing and cost an evening of looking for a fault
  // that was not there. The reason now travels with the verdict.
  refreshAvailability() {
    const rows = survey({ secret: (id) => this.secrets.get(id) || '' });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    this.providerReadiness = rows;
    this.models.setAvailability({
      claude: byId['claude-code']?.ready, codex: byId.codex?.ready,
      gemini: byId.gemini?.ready, glm: byId.glm?.ready, ollama: true,
    });
    for (const row of rows) {
      const id = row.id === 'claude' ? 'claude-code' : row.id;
      this.models.touch?.(id, { metrics: { apiHealth: row.ready ? `ready · ${row.via}` : row.detail } });
    }
    return rows;
  }

  setCredentials(values = {}, { replace = false } = {}) {
    for (const provider of ['claude', 'codex', 'gemini', 'glm']) {
      if (!replace && !Object.prototype.hasOwnProperty.call(values, provider)) continue;
      const value = typeof values[provider] === 'string' ? values[provider].trim() : '';
      if (value) this.secrets.set(provider, value);
      else this.secrets.delete(provider);
    }
    this.securityState.credentials = Object.fromEntries(['claude', 'codex', 'gemini', 'glm']
      .map((provider) => [provider, this.secrets.has(provider)]));
    // A key the owner just entered has to change what the fleet shows and what
    // the router will choose, in that order and immediately — pi-bridge has a
    // refreshChain() for exactly this that nothing has ever called.
    this.refreshAvailability();
    this.publish('security', this.securityState);
    this.publish('models', this.models.snapshot());
    return { ok: true, credentials: this.securityState.credentials };
  }

  /**
   * Hand the GPU back now instead of waiting out the idle window.
   *
   * The owner runs ComfyUI, LTX-2 and ACE-Step on the same card, and a render that
   * starts while 6.3GB of chat weights are still resident is the OOM the whole
   * gpu-signal arrangement exists to avoid. Unloading also clears the warm marker,
   * so the next conversation reloads rather than assuming weights that are gone.
   * @returns {Promise<{released: boolean, model: string, error?: string}>}
   */
  async releaseGpu() {
    this.warmedModel = null;
    const result = await this.conversation.release();
    this.publish('knowledge', { status: result.released ? 'GPU_RELEASED' : 'GPU_RELEASE_FAILED', conversation: result });
    return result;
  }

  configureConversation(config = {}) {
    if (config.model) this.conversation.model = String(config.model).slice(0, 120);
    if (config.contextTokens) this.conversation.maxContextTokens = Math.max(1024, Math.min(8192, Number(config.contextTokens) || 4096));
    if (config.keepAlive !== undefined) this.conversation.keepAlive = normalizeKeepAlive(config.keepAlive);
    this.conversationConfig.autoIdeas = config.autoIdeas !== false;
    this.conversationConfig.cloudEnhancementApproval = 'always';
    const snapshot = { ...this.conversation.snapshot(), ...this.conversationConfig };
    this.publish('knowledge', { status: 'CONVERSATION_CONFIGURED', conversation: snapshot });
    this.warmConversation();
    return snapshot;
  }

  // Load the conversation model now rather than on the owner's first sentence.
  //
  // ConversationEngine aborts a turn at 8s and answers from the deterministic fallback,
  // so a cold model does not merely feel slow — the first reply after launch comes from
  // the wrong path entirely. This is the only place that knows which model will actually
  // serve the turn, because settings override the engine's own default here.
  //
  // Fire and forget on purpose: nothing waits on the weights, and a failed warmup is
  // reported rather than retried, because the next turn loads the model anyway.
  warmConversation() {
    const model = this.conversation.model;
    // The context size is part of the identity of a loaded model, so the warmup has to
    // ask for the same one the turn will. Warming a different num_ctx just moves the
    // load cost to the owner's first sentence while looking like it prevented it.
    const numCtx = this.conversation.maxContextTokens;
    const key = `${model}::${numCtx}`;
    if (!model || this.warmedModel === key || this.warming) return null;
    this.warming = true;
    const promise = warmModel(model, { keepAlive: this.conversation.keepAlive, options: { num_ctx: numCtx } })
      .then((result) => {
        this.warming = false;
        if (result.ok) this.warmedModel = key;
        this.publish('knowledge', { status: result.ok ? 'CONVERSATION_WARM' : 'CONVERSATION_WARM_FAILED',
          conversation: { model: result.model, warmupMs: result.ms, error: result.error } });
        return result;
      });
    promise.catch(() => { this.warming = false; });
    return promise;
  }

  onRun(run) {
    this.models.ingestRun(run); const sessionId = this.runSessions.get(run.id) || this.activeSessionId;
    if (sessionId) {
      this.runSessions.set(run.id, sessionId);
      this.sessions.append(sessionId, { type: 'run', status: run.status, run });
    }
    const phase = ['PLANNING', 'AWAITING_APPROVAL'].includes(run.status) ? (run.status === 'AWAITING_APPROVAL' ? 'AWAITING_OWNER_DIRECTIVE' : 'PREFLIGHT')
      : ['EXECUTING', 'DISPATCHING', 'REPAIRING'].includes(run.status) ? 'EXECUTE' : 'VERIFY';
    // AWAITING_OWNER_DIRECTIVE used to fall through this chain to the VERIFY arm and
    // report 92%, so a run that had not started looked nearly finished. It is a
    // waiting state, not a late one.
    // Waiting is 0, not 25.
    //
    // The comment above records this same number being moved down from 92 once already,
    // and it stopped one step short: a run that has not started has executed nothing, so
    // any figure above zero is a claim about work that does not exist. Measured
    // 2026-08-04 — two runs held this at 25% for eleven hours while nothing ran, and the
    // renderer's own fallback (renderer.js keywordProgress) was fixed in the same pass.
    // Both had to move: a published number always wins over the fallback.
    const PROGRESS = { PREFLIGHT: 20, AWAITING_OWNER_DIRECTIVE: 0, EXECUTE: 62, VERIFY: 92 };
    this.publish('phase', { sessionId, runId: run.id, phase, status: run.status, progress: PROGRESS[phase] ?? 20 });
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
      mode: MODES.includes(mode) ? mode : 'plan' });
    this.runSessions.set(run.id, session.id); // onRun already appended and published it
    if (run.status === 'AWAITING_APPROVAL') {
      this.publish('phase', { sessionId: session.id, runId: run.id, phase: 'AWAITING_OWNER_DIRECTIVE', status: run.status, progress: 0 });
      this.publish('commentary', { source: 'BigKiji', status: 'SYNC', text: 'The change plan is ready. Accept, edit, reject, or send a custom directive.' });
    }
    return { accepted: true, sessionId: session.id, run };
  }

  directive({ action, runId, text, revision, planHash, disclosureHash, idempotencyKey }) {
    const run = this.coordinator.get(String(runId || '')); if (!run) throw new Error('Unknown run');
    const sessionId = this.runSessions.get(run.id); const normalized = String(action || '').toLowerCase();
    const inspected = redactPayload(String(text || ''));
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_DIRECTIVE');
    // A run created before any conversation existed has no session to log against
    // (planIdea only records the pair when a session is already open). Appending to
    // an empty id threw "Invalid session id" *before* the approval was evaluated, so
    // those runs could never be approved or aborted from any surface — the note went
    // missing, and the owner lost the run with it.
    if (sessionId) this.sessions.append(sessionId, { type: 'directive', action: normalized, text: inspected.text });
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

  /**
   * Which local tools are actually answering.
   *
   * tool-registry has had detection and health checks for nine of them since V2.5 —
   * ComfyUI, ACE-Step, LTX-2, Ollama, n8n, Obsidian, graphify and the GPU signal —
   * and nothing was wired to a display, so the owner had no way to see from BigKiji
   * whether the thing they were about to route work to was up.
   * @returns {Promise<{tools: object[], connected: number, scannedAt: number}>}
   */
  async refreshTools() {
    let rows = [];
    try {
      const result = await detectAndProbeAll({});
      rows = Array.isArray(result) ? result : (result?.tools || Object.values(result || {}));
    } catch (_) { rows = []; }
    const tools = rows.filter((row) => row && row.id).map((row) => ({
      id: row.id, status: row.status || 'missing', detail: String(row.detail || row.note || '').slice(0, 120),
    }));
    this.tools = { tools, connected: tools.filter((tool) => tool.status === 'connected').length, scannedAt: Date.now() };
    this.publish('tools', this.tools);
    return this.tools;
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

  // What the conversation model is allowed to state as fact.
  //
  // Everything here is read from live state at the moment of the turn; nothing is
  // cached, defaulted or rounded up. A count of zero is written as zero, because
  // "no runs are waiting" is a real and useful answer — it is the *absence* of
  // this block that produced the failure it exists to fix, where the model
  // announced there were no tasks while a run sat waiting for approval.
  //
  // It is deliberately a dozen short lines. The conversation runs on a 4k window
  // shared with the transcript, so this buys its space by answering the questions
  // owners actually ask: what is waiting on me, what is running, what did I say I
  // wanted, and which models can even do the work.
  /**
   * The owner's own line to Pi.
   *
   * Step ① of the workflow the owner described is "オーナーが Pi に話しかける", and
   * until now there was no way to do that from the CLI at all — Pi ran only inside
   * the Electron window, and the terminal talked to Ollama directly. This is the
   * same PiBridge, hosted by the daemon, so both surfaces drive one session rather
   * than two that disagree.
   *
   * It is deliberately toolless. PiBridge spawns with --no-tools, --no-extensions
   * and a sandboxed HOME, so this is a second brain to consult and not a second way
   * to execute anything: the approval gate stays the only door to work.
   * @returns {object}
   */
  pi() {
    if (this.piSession) return this.piSession;
    const { PiBridge } = require('../pi-agent/pi-bridge');
    const session = new PiBridge({ cwd: this.workspace });
    session.on('event', (event) => this.publish('pi', event));
    session.on('status', (status) => this.publish('pi', { kind: 'status', ...status, model: session.model }));
    session.on('stderr', (text) => {
      const line = String(text || '').trim();
      if (!line) return;
      // Pi installs its packages on every start and npm narrates it on stderr. Nine
      // lines of "added 6 packages", funding notices and an npm upgrade advert
      // arrived in the transcript as red error blocks before the answer did — the
      // owner asked Pi a question and got a changelog. Progress is not a failure.
      if (!PI_STDERR_NOISE.test(line)) this.publish('pi', { kind: 'stderr', text: line.slice(0, 400) });
      // A model Pi does not have, a spent quota, a 429: demote a tier rather than
      // dying silently. detectErrorAndFallback has existed since V13 and was wired
      // only inside Electron, so from the daemon Pi simply exited — measured, with
      // `Model "ollama/qwen2.5:0.5b" not found` on stderr and nothing anywhere else.
      if (!session.detectErrorAndFallback(line)) return;
      session.fallback().then((moved) => {
        this.publish('pi', { kind: moved ? 'degraded' : 'exhausted', model: session.model, reason: line.slice(0, 160) });
      }).catch(() => {});
    });
    session.on('degrade', (event) => this.publish('commentary', { source: 'Pi', status: 'DEGRADE',
      text: `${event.model} → next tier · ${String(event.reason || '').slice(0, 120)}` }));
    this.piSession = session;
    return session;
  }

  /**
   * One instruction to Pi, started on demand.
   * @returns {{ok: boolean, model: string, running: boolean, error?: string}}
   */
  piPrompt(text, { steer = false } = {}) {
    const inspected = redactPayload(String(text || '').trim());
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_PROMPT');
    const message = inspected.text;
    if (!message) throw new Error('Pi prompt is empty');
    const session = this.pi();
    if (!session.proc && !session.start()) return { ok: false, running: false, model: session.model, error: 'pi did not start' };
    if (steer) session.steer(message); else session.prompt(message);
    return { ok: true, running: true, model: session.model, streaming: session.isStreaming };
  }

  /** Which model Pi is borrowing, and whether it is up. */
  piStatus() {
    const session = this.piSession;
    return { running: !!session?.proc, model: session?.model || null, streaming: !!session?.isStreaming,
      chain: (session?.chainList || []).map((tier) => tier.id) };
  }

  /**
   * Ask the provider that did the work what it would do differently.
   *
   * Answered as data, not prose: model_performance.json had zero samples and priors
   * written by hand, so nothing could improve the routing. A structured reflection
   * is training data for a store that is empty — which is why this exists at all,
   * rather than being decoration on a result the owner has already read.
   * @returns {Promise<object|null>}
   */
  async reflect(review) {
    const prompt = reflectionPrompt(review);
    const local = new (require('../pi-core/conversation-engine').ConversationEngine)({
      model: this.conversation.model, endpoint: this.conversation.endpoint, timeoutMs: 12000, maxTurns: 2,
    });
    let parsed = null;
    try {
      // The local model, not the paid one. The finding is already known; this is
      // shaping a sentence, and shaping a sentence is not worth $10 per million.
      const turn = await local.turn({ text: prompt, sessionId: `reflect-${review.taskId}` });
      if (turn.degraded) return null;
      parsed = JSON.parse(String(turn.reply).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (_) {
      try { parsed = JSON.parse(String(parsed || '')); } catch (__) { parsed = null; }
    }
    const reflection = normalizeReflection(parsed, review);
    if (!reflection) return null;
    this.publish('reflection', reflection);
    this.models.ingestReflection?.(reflection);
    knowledge.recordEvent(review.runId, { type: 'agent-reflection', status: 'REFLECTED', provider: review.provider,
      evidence: `${review.role}: ${reflection.whatToDoDifferently}` });
    const sessionId = this.runSessions.get(review.runId);
    if (sessionId) this.sessions.append(sessionId, { type: 'reflection', ...reflection });
    return reflection;
  }

  /**
   * The same state `facts()` narrates, as numbers instead of prose.
   *
   * `facts()` writes English sentences for a model to read. This writes the objects the
   * deterministic status reply is assembled from, so that answer never passes through a
   * language model and cannot come back as an assurance. Both read one snapshot.
   * @returns {{running: object[], waiting: object[]}}
   */
  statusFacts() {
    const runs = this.coordinator.snapshot();
    const counted = (run) => {
      const assignments = Array.isArray(run.assignments) ? run.assignments : [];
      return { id: run.id, stage: run.stage || '', total: assignments.length,
        done: assignments.filter((item) => String(item.status || '').toLowerCase() === 'completed').length,
        writes: assignments.length ? assignments.some((item) => item.write !== false) : undefined,
        createdAt: run.createdAt, startedAt: run.startedAt || run.updatedAt };
    };
    return {
      running: runs.filter((run) => ['EXECUTING', 'REPAIRING', 'VERIFYING', 'PLANNING', 'DISPATCHING'].includes(run.status)).map(counted),
      waiting: runs.filter((run) => run.status === 'AWAITING_APPROVAL').map(counted),
    };
  }

  facts() {
    const runs = this.coordinator.snapshot();
    const waiting = runs.filter((run) => run.status === 'AWAITING_APPROVAL');
    const active = runs.filter((run) => ['EXECUTING', 'REPAIRING', 'VERIFYING', 'PLANNING'].includes(run.status));
    const tasks = this.runner.snapshot();
    const byStatus = tasks.reduce((acc, task) => ({ ...acc, [task.status]: (acc[task.status] || 0) + 1 }), {});
    const fleet = this.models.snapshot()?.models || [];
    // `connected` means "has a task running right now". Reported as reachability it
    // told the conversation model that no external provider was available while all
    // four were authenticated and idle — so it answered questions about what it
    // could do with the opposite of the truth.
    const usable = fleet.filter((model) => (model.available ?? model.connected)).map((model) => model.id);
    const busy = fleet.filter((model) => model.connected).map((model) => model.id);
    const ideas = this.ideas.list(6);
    const lines = [
      `- workspace: ${this.workspace}`,
      `- runs awaiting your approval: ${waiting.length}${waiting.length ? ` (latest: ${waiting.at(-1).id}, ${waiting.at(-1).assignments?.length || 0} assignments)` : ''}`,
      `- runs in progress: ${active.length}`,
      `- tasks: ${tasks.length}${tasks.length ? ` (${Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(', ')})` : ''}`,
      `- saved ideas: ${ideas.length}${ideas.length ? `; most recent: ${ideas.slice(0, 3).map((idea) => idea.title).join(' / ')}` : ''}`,
      `- conversation sessions on record: ${this.sessions.count()}`,
      `- providers that can run work: ${usable.length ? usable.join(', ') : 'none — only local work can run'}`,
      `- providers busy right now: ${busy.length ? busy.join(', ') : 'none'}`,
      `- to start a waiting run the owner types /approve in the bigkiji CLI`,
    ];
    return lines.join('\n');
  }

  state() {
    return { source: 'bigkiji-daemon', version: 2, pid: process.pid, startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt,
      workspace: this.workspace, activeSessionId: this.activeSessionId, sessions: this.sessions.list(24), runs: this.coordinator.snapshot(),
      tasks: this.runner.snapshot(),
      // The fleet by provider (who is up) and the record by model (what each tier
      // actually did). They are different questions and only the first was answered.
      models: { ...this.models.snapshot(), performance: this.coordinator.registry?.snapshot?.().performance || { models: {} } },
      inventory: this.inventory, tools: this.tools, security: this.securityState,
      conversation: this.conversation.snapshot(), ideas: this.ideas.list(24), phase: currentPhase(this.coordinator.snapshot()) };
  }
  shutdown() {
    clearInterval(this.inventoryTimer); clearInterval(this.toolTimer);
    // Pi is a child process. Leaving it behind means the next daemon finds the port
    // free and the model still loaded by a process nobody owns.
    try { this.piSession?.dispose(); } catch (_) {}
    this.runner.shutdown();
  }
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
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, source: 'bigkiji-daemon', version: 2, appVersion: APP_VERSION,
      dataRoot: DATA.dataRoot, stateRoot: engine.stateRoot, pid: process.pid, uptimeMs: Date.now() - engine.startedAt });
    const jar = cookies(req); const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const masterToken = bearer || url.searchParams.get('t') || jar.bk_t || ''; const isMaster = masterToken === config.token;
    const mobileDevice = jar.bk_mobile ? mobileDevices.authenticate(jar.bk_mobile) : null;
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const pairingCode = url.searchParams.get('pair') || '';
      if (url.pathname === '/' && !isMaster && !mobileDevice && !mobileDevices.validPairing(pairingCode)) return json(res, 401, { error: 'Open a current pairing QR from BigKiji Universe.' });
      const [relative, type] = staticFiles[url.pathname]; const file = path.join(engine.appRoot, relative);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'asset not found' });
      const headers = { 'content-type': type, 'cache-control': url.pathname === '/' ? 'no-cache' : 'public, max-age=86400' };
      // sendFile, not a bare pipe: the comment above it explains why, and this was
      // the one static route still bypassing it. `npm ci` removing node_modules/three
      // while a phone is mid-fetch is enough to take the whole daemon down.
      res.writeHead(200, headers); sendFile(res, file); return;
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
      // Owner-only. Used by the data-root migration to quiesce the daemon before files
      // move underneath it; a paired phone must never be able to stop the engine.
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        json(res, 200, { stopping: true, pid: process.pid });
        setTimeout(() => { try { engine.shutdown(); } catch (_) {} process.exit(0); }, 120);
        return;
      }
      // The phone records 16 kHz mono PCM16 and posts the WAV as the raw body.
      // Before V2.5 this route did not exist here at all, so the microphone always 404'd.
      if (req.method === 'POST' && url.pathname === '/api/voice') {
        const audio = await readBuffer(req);
        if (!audio.length) return json(res, 400, { error: 'empty audio' });
        fs.mkdirSync(PATHS.recordingsRoot, { recursive: true });
        const wav = path.join(PATHS.recordingsRoot, `mobile-${Date.now()}.wav`);
        fs.writeFileSync(wav, audio);
        try {
          const heard = await stt.transcribeWav({ wav, whisperBin: PATHS.whisperBin, whisperModel: PATHS.whisperModel });
          if (heard.error) return json(res, 503, { error: heard.error });
          if (!stt.isMeaningful(heard.text)) return json(res, 200, { text: '', lang: heard.lang, skipped: 'noise' });
          engine.publish('commentary', { text: `🎙 STT(${heard.lang}): ${heard.text.slice(0, 120)}`, source: 'mobile' });
          // 'plan', explicitly. This route is the phone talking, and it used to say
          // 'auto' — harmless only for as long as _turn() flattened every mode to
          // 'plan'. Now that the mode is honoured, a voice note from a handset must
          // not be the thing that authorises an unattended write.
          const turn = await engine.turn(heard.text, { mode: 'plan' });
          return json(res, 200, { text: heard.text, lang: heard.lang, reply: turn?.reply || '' });
        } finally { try { fs.unlinkSync(wav); } catch (_) {} }
      }
      if (req.method === 'POST' && url.pathname === '/api/security/credentials') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req, 64 * 1024);
        return json(res, 200, engine.setCredentials(body.values || body, { replace: body.replace === true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/conversation/config') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        return json(res, 200, engine.configureConversation(await readJson(req)));
      }
      // Free the card on demand. The owner asked for standby at zero, and a render
      // that has to wait sixty seconds for chat weights to time out is not zero.
      // The owner's line to Pi. Toolless by construction — PiBridge spawns with
      // --no-tools and --no-extensions — so nothing here can execute work, and the
      // approval gate remains the only door to that.
      if (req.method === 'POST' && url.pathname === '/api/pi/prompt') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req);
        return json(res, 200, engine.piPrompt(body.text, { steer: body.steer === true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/pi/model') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        const body = await readJson(req);
        const session = engine.pi();
        return json(res, 200, { model: session.setModel(body.model), running: !!session.proc });
      }
      if (req.method === 'POST' && url.pathname === '/api/pi/compact') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        return json(res, 200, { compacted: !!(await engine.pi().compact()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pi/stop') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        engine.piSession?.stop();
        return json(res, 200, engine.piStatus());
      }
      if (req.method === 'GET' && url.pathname === '/api/pi/status') return json(res, 200, engine.piStatus());
      if (req.method === 'POST' && url.pathname === '/api/gpu/release') {
        if (!isMaster) return json(res, 403, { error: 'desktop owner authorization required' });
        return json(res, 200, await engine.releaseGpu());
      }
      if (req.method === 'GET' && url.pathname === '/api/mobile/devices') return json(res, 200, { devices: mobileDevices.list() });
      if (req.method === 'GET' && url.pathname === '/api/mobile/me') return json(res, 200, { device: mobileDevice ? mobileDevices.public(mobileDevice) : null, master: isMaster });
      if (req.method === 'POST' && url.pathname === '/api/mobile/devices/revoke') { const body = await readJson(req); return json(res, 200, mobileDevices.revoke(String(body.id || ''))); }
      // Generated media. Before V2.5 the daemon served an explicit five-file whitelist
      // and nothing else, so anything BigKiji produced — a ComfyUI render, a generated
      // track — had no route to the phone at all. Serving a directory needs three
      // things the whitelist never had to think about: the path must be proven to be
      // inside the root after resolution (a decoded '..' is the whole attack), the type
      // must come from a fixed map rather than from the request, and video has to
      // answer Range or Safari will not play it.
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
        const relative = decodeURIComponent(url.pathname.slice('/assets/'.length));
        const root = path.resolve(PATHS.generatedMediaRoot);
        const lexical = path.resolve(root, relative);
        if (lexical !== root && !lexical.startsWith(root + path.sep)) return json(res, 403, { error: 'outside the media root' });
        // path.resolve is lexical; statSync follows links. Without realpath, a symlink
        // dropped in the media root by one of the generation pipelines serves whatever it
        // points at. Resolve the real target and re-check, so containment is a fact about
        // the file rather than about the string.
        let file; let realRoot;
        try { file = fs.realpathSync.native(lexical); realRoot = fs.realpathSync.native(root); }
        catch (_) { return json(res, 404, { error: 'not found' }); }
        if (file !== realRoot && !file.startsWith(realRoot + path.sep)) return json(res, 403, { error: 'outside the media root' });
        let stat; try { stat = fs.statSync(file); } catch (_) { return json(res, 404, { error: 'not found' }); }
        if (!stat.isFile()) return json(res, 404, { error: 'not found' });
        const type = ASSET_TYPES[path.extname(file).toLowerCase()];
        if (!type) return json(res, 415, { error: 'unsupported media type' });
        const base = { 'content-type': type, 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff' };
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
          let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
          start = Math.max(0, start); end = Math.min(stat.size - 1, end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
            res.writeHead(416, { ...base, 'content-range': `bytes */${stat.size}` }); res.end(); return;
          }
          res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
          if (req.method === 'HEAD') { res.end(); return; }
          sendFile(res, file, { start, end }); return;
        }
        res.writeHead(200, { ...base, 'content-length': stat.size });
        if (req.method === 'HEAD') { res.end(); return; }
        sendFile(res, file); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/assets') {
        const root = PATHS.generatedMediaRoot;
        let names = []; try { names = fs.readdirSync(root); } catch (_) {}
        const items = names.filter((name) => ASSET_TYPES[path.extname(name).toLowerCase()])
          .map((name) => { try { const stat = fs.statSync(path.join(root, name));
            return { name, url: `/assets/${encodeURIComponent(name)}`, size: stat.size, updatedAt: stat.mtimeMs,
              type: ASSET_TYPES[path.extname(name).toLowerCase()] }; } catch (_) { return null; } })
          .filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
        return json(res, 200, { root, items });
      }
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
      // A mode that can skip approval is only honoured from this machine.
      //
      // The daemon binds 0.0.0.0 — measured with lsof on 2026-08-04, `*:8777 (LISTEN)`,
      // and remote.json says `"bind": "0.0.0.0"` — so the phone is not the only thing on
      // the LAN that can reach these routes with a token. `ownerSettings()` used to pin
      // executionMode to 'plan' for exactly this reason, and the note there says so:
      // "the daemon is the surface a phone talks to, and a mode that could skip approval
      // must not be reachable from it."
      //
      // That pin is not removed. It is narrowed to what it was defending: requests from
      // 127.0.0.1 / ::1 — the CLI and the Electron app, both running as the owner on the
      // owner's machine — get the mode they asked for. Everything else is forced to
      // 'plan' and waits for a human, exactly as before.
      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        const body = await readJson(req);
        return json(res, 202, engine.prompt(body.text, { mode: effectiveMode(req, body.mode), sessionId: body.sessionId }));
      }
      if (req.method === 'POST' && url.pathname === '/api/turn') {
        const body = await readJson(req);
        return json(res, 200, await engine.turn(body.text, { mode: effectiveMode(req, body.mode), sessionId: body.sessionId }));
      }
      if (req.method === 'POST' && url.pathname === '/api/run/answer') {
        const body = await readJson(req);
        return json(res, 200, await engine.answerRun({ runId: body.runId, text: body.text }));
      }
      if (req.method === 'GET' && url.pathname === '/api/ideas') return json(res, 200, { ideas: engine.ideas.list(Number(url.searchParams.get('limit') || 40)) });
      if (req.method === 'GET' && url.pathname === '/api/idea') {
        const draft = engine.ideas.read(url.searchParams.get('id')); return json(res, draft ? 200 : 404, draft || { error: 'not found' });
      }
      if (req.method === 'POST' && url.pathname === '/api/idea/enhance') { const body = await readJson(req); return json(res, 202, engine.requestIdeaEnhancement(body.id, body)); }
      if (req.method === 'POST' && url.pathname === '/api/idea/enhance/approve') { const body = await readJson(req); return json(res, 202, engine.approveIdeaEnhancement(body)); }
      if (req.method === 'POST' && url.pathname === '/api/idea/plan') { const body = await readJson(req); return json(res, 202, engine.planIdea(body.id, body)); }
      if (req.method === 'POST' && url.pathname === '/api/idea/promote') { const body = await readJson(req); const draft = engine.ideas.promote(body.id, body); engine.knowledge.rememberIdea?.(draft, 'promoted'); engine.publish('idea', { action: 'promoted', draft }); return json(res, 200, draft); }
      if (req.method === 'POST' && url.pathname === '/api/idea/archive') { const body = await readJson(req); const result = engine.ideas.archive(body.id, body); engine.publish('idea', { action: 'archived', ...result }); return json(res, 200, result); }
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
    // The state directory normally exists because ensureLayout ran first. When it does
    // not — a fresh data root, a moved one, a test — writing the pid file threw inside
    // a listen callback, which is an uncaught exception rather than a startup error.
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    if (process.send) process.send({ type: 'ready', port: config.port });
    else console.log(`[BIGKIJI DAEMON READY] http://${config.bind}:${config.port}`);
  });
  server.on('error', (error) => { console.error(`[BIGKIJI DAEMON ERROR] ${error.message}`); process.exitCode = 1; });
  process.on('unhandledRejection', (reason) => {
    console.error('[DAEMON UNHANDLED REJECTION]', reason);
    engine.publish('error', { source: 'daemon', error: String(reason).slice(0, 200) });
  });
  process.on('uncaughtException', (error) => {
    console.error('[DAEMON UNCAUGHT EXCEPTION]', error);
    engine.publish('error', { source: 'daemon', error: String(error.message).slice(0, 200) });
    process.exit(1);
  });
  const close = () => { clearInterval(ping); for (const socket of sockets) socket.close(); wss.close(); engine.shutdown(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { server, engine, config, mobileDevices, close };
}

if (require.main === module) startDaemon();

module.exports = { HANDS_OFF_ANSWER, jsonSafe, DaemonEngine, startDaemon, loadConfig, EVENT_CHANNEL, APP_ROOT, STATE_ROOT, effectiveMode, isLoopback, MODES, currentPhase };
