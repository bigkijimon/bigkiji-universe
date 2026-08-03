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
const { ModelStatusStore } = require('../hud/model-status-store');
const { FleetMetricsStore } = require('../../core/fleet-metrics-store');
const knowledge = require('../pi-agent/pi-knowledge-orchestrator');
const { SessionStore } = require('./session-store');
const { MobileDeviceStore } = require('./mobile-device-store');
const { writeSystemMemory } = require('../pi-core/system-memory');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { PROVIDER_SECRET } = require('../pi-core/security/security-policy');
const { ConversationEngine, normalizeKeepAlive } = require('../pi-core/conversation-engine');
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

const EVENT_CHANNEL = Object.freeze({
  task: 'task:event', tasklog: 'task:log', run: 'run:event', models: 'model:status:update',
  commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event',
  stats: 'pi:stats', bus: 'bus:event', preview: 'preview:status', fleet: 'pi:fleet', inventory: 'inventory:update', security: 'security:status',
  conversation: 'conversation:update', idea: 'idea:update', knowledge: 'knowledge:status', checkpoint: 'run:checkpoint',
});

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
    conversationEngine = null, ideaStore = null, knowledgeStore = knowledge } = {}) {
    super();
    this.appRoot = path.resolve(appRoot); this.stateRoot = path.resolve(stateRoot); this.workspace = path.resolve(workspace);
    // Tests inject a throwaway stateRoot; production uses the resolved data layout,
    // where sessions/ideas are siblings of state/ rather than children of it.
    this.customState = path.resolve(stateRoot) !== path.resolve(STATE_ROOT);
    const rootFor = (key, name) => (this.customState ? path.join(this.stateRoot, name) : layout[key]);
    this.startedAt = Date.now(); this.sessions = new SessionStore({ root: rootFor('sessionsRoot', 'sessions') });
    this.runner = new TaskRunner({ cwd: this.workspace, vaultRoot: this.workspace, maxParallel: 3 });
    this.conversation = conversationEngine || new ConversationEngine();
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
      if (sessionId) this.sessions.append(sessionId, { type: 'task', status: task.status, task });
      if (task.metadata?.kind === 'idea-enhancement' && ['completed', 'failed', 'blocked'].includes(task.status)) this.finishIdeaEnhancement(task);
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
    this.coordinator.on('run', (run) => { this.piFleet.ingestRun(run); this.onRun(run); });
    // The thirty-minute checkpoint. It is a report, not a kill — the owner asked for
    // 「期限で区切って途中経過を出す」, so the run continues and says where it is.
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
    this.inventoryTimer = setInterval(() => this.refreshInventory().catch((err) => {
      // `engine` is a parameter of startDaemon(), not a name in class scope: the only
      // path that reported an inventory failure threw a ReferenceError instead.
      this.publish('error', { source: 'daemon', error: `Inventory refresh failed: ${String(err.message).slice(0, 100)}` });
    }), 300000);
    this.inventoryTimer.unref();
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
        // executionMode stays pinned to 'plan' here: the daemon is the surface a phone
        // talks to, and a mode that could skip approval must not be reachable from it.
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

  async _turn(text, { sessionId = '', mode = 'auto' } = {}) {
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
    if (result.kind === 'TASK') {
      const goal = result.summary || clean;
      const promptSpec = { goal, constraints: result.requirements || [], steps: result.todos || [],
        acceptance: result.decisions || [], questions: result.openQuestions || [], ideaId: draft?.id };
      run = this.coordinator.submit({ prompt: clean, promptSpec, cwd: this.workspace, mode: mode === 'manual' ? 'manual' : 'plan' });
      // submit() emits 'run' synchronously, so onRun has already appended this run
      // to the session and published it. Doing it again here printed the same run
      // twice in the transcript and wrote it twice into the session file.
      this.runSessions.set(run.id, session.id);
    }
    const output = { accepted: true, kind: result.kind, reply: result.reply, sessionId: session.id, turnId: result.turnId,
      provider: result.provider, model: result.model, latencyMs: result.latencyMs, degraded: result.degraded, draft, run,
      requiresApproval: !!run || false };
    this.publish('conversation', { kind: 'turn_complete', ...output });
    this.publish('stats', { turn: { input: result.context?.estimatedTokens || 0, output: Math.max(1, Math.ceil(result.reply.length / 4)) },
      ms: result.latencyMs, provider: result.provider, model: result.model });
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
    const PROGRESS = { PREFLIGHT: 20, AWAITING_OWNER_DIRECTIVE: 25, EXECUTE: 62, VERIFY: 92 };
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
      mode: mode === 'auto' ? 'auto' : 'plan' });
    this.runSessions.set(run.id, session.id); // onRun already appended and published it
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
  facts() {
    const runs = this.coordinator.snapshot();
    const waiting = runs.filter((run) => run.status === 'AWAITING_APPROVAL');
    const active = runs.filter((run) => ['EXECUTING', 'REPAIRING', 'VERIFYING', 'PLANNING'].includes(run.status));
    const tasks = this.runner.snapshot();
    const byStatus = tasks.reduce((acc, task) => ({ ...acc, [task.status]: (acc[task.status] || 0) + 1 }), {});
    const fleet = this.models.snapshot()?.models || [];
    const connected = fleet.filter((model) => model.connected).map((model) => model.id);
    const ideas = this.ideas.list(6);
    const lines = [
      `- workspace: ${this.workspace}`,
      `- runs awaiting your approval: ${waiting.length}${waiting.length ? ` (latest: ${waiting.at(-1).id}, ${waiting.at(-1).assignments?.length || 0} assignments)` : ''}`,
      `- runs in progress: ${active.length}`,
      `- tasks: ${tasks.length}${tasks.length ? ` (${Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(', ')})` : ''}`,
      `- saved ideas: ${ideas.length}${ideas.length ? `; most recent: ${ideas.slice(0, 3).map((idea) => idea.title).join(' / ')}` : ''}`,
      `- conversation sessions on record: ${this.sessions.list(999).length}`,
      `- models connected right now: ${connected.length ? connected.join(', ') : 'none — no external provider is reachable, so only local work can run'}`,
      `- to start a waiting run the owner types /approve in the bigkiji CLI`,
    ];
    return lines.join('\n');
  }

  state() {
    return { source: 'bigkiji-daemon', version: 2, pid: process.pid, startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt,
      workspace: this.workspace, activeSessionId: this.activeSessionId, sessions: this.sessions.list(24), runs: this.coordinator.snapshot(),
      tasks: this.runner.snapshot(), models: this.models.snapshot(), inventory: this.inventory, security: this.securityState,
      conversation: this.conversation.snapshot(), ideas: this.ideas.list(24), phase: this.coordinator.snapshot().at(-1)?.status || 'IDLE' };
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
          const turn = await engine.turn(heard.text, { mode: 'auto' });
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
      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        const body = await readJson(req);
        return json(res, 202, engine.prompt(body.text, { mode: body.mode, sessionId: body.sessionId }));
      }
      if (req.method === 'POST' && url.pathname === '/api/turn') {
        const body = await readJson(req); return json(res, 200, await engine.turn(body.text, { mode: body.mode, sessionId: body.sessionId }));
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

module.exports = { DaemonEngine, startDaemon, loadConfig, EVENT_CHANNEL, APP_ROOT, STATE_ROOT };
