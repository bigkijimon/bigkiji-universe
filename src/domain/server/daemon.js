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
const { CoreExecutionCoordinator, ACTIVE_RUN, TERMINAL_RUN } = require('../pi-agent/core-execution-coordinator');
const { CircuitBreaker } = require('../pi-agent/circuit-breaker');
const { warmModel } = require('../pi-agent/model-router');
const { readiness, survey } = require('../pi-agent/provider-readiness');
const gpuLockModule = require('../pi-agent/gpu-lock');
const { detectAndProbeAll } = require('../pi-agent/tool-registry');
const { FastFacilitatorRouter, questionText } = require('../pi-agent/fast-api-router');
const { escape } = require('../pi-agent/cloud-escape');
const { ModelStatusStore } = require('../hud/model-status-store');
const { FleetMetricsStore } = require('../../core/fleet-metrics-store');
const knowledge = require('../pi-agent/pi-knowledge-orchestrator');
const { SessionStore } = require('./session-store');
const { MobileDeviceStore } = require('./mobile-device-store');
const { writeSystemMemory } = require('../pi-core/system-memory');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { localLookup } = require('../pi-core/local-lookup');
const { PROVIDER_SECRET } = require('../pi-core/security/security-policy');
const { ConversationEngine, normalizeKeepAlive, isAffirmative, endsWithQuestion, actionTier, isInspection } = require('../pi-core/conversation-engine');
const { isStatusQuestion, statusReport, isProviderQuestion, providerReport } = require('../pi-core/status-answer');
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
const { createPathConfig, detectVault } = require('../../core/path-config');
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

/** True for a bind address that only this machine can reach. */
function isLoopbackBind(address) {
  const value = String(address || '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/**
 * Refuse to start on an address the LAN can reach unless the owner asked for it.
 *
 * `loadConfig` defaults `bind` to 127.0.0.1, but remote.json is a plain file the owner
 * (or an older build) can edit, and a value of '0.0.0.0' there is silent: the daemon
 * comes up looking identical and every device on the network can reach /api/turn behind
 * one bearer token. Measured on 2026-08-05 — `lsof` showed `*:8777 (LISTEN)` while the
 * shipped default said otherwise. A typo in a config file should fail loudly at startup,
 * not widen the attack surface quietly, so LAN binds now need BIGKIJI_ALLOW_LAN=1.
 */
function assertBindAllowed(bind) {
  if (isLoopbackBind(bind)) return;
  if (process.env.BIGKIJI_ALLOW_LAN === '1') {
    console.warn(`[BIGKIJI DAEMON] binding ${bind} — reachable from the network (BIGKIJI_ALLOW_LAN=1)`);
    return;
  }
  throw new Error(
    `refusing to bind ${bind}: reachable from the network. `
    + 'Set "bind" to 127.0.0.1 in remote.json, or set BIGKIJI_ALLOW_LAN=1 to allow it deliberately.',
  );
}

/**
 * The mode a request is allowed to run in.
 *
 * Loopback — the CLI and the Electron window, running as the owner on the owner's
 * machine — gets what it asked for. Anything else gets 'plan' and waits for a human,
 * because the daemon can be told to listen beyond loopback (BIGKIJI_ALLOW_LAN=1) and a
 * token on the LAN must not be able to buy unattended writes. Requesting a mode is not
 * the same as being allowed one.
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
 * Where a run's files live.
 *
 * Launched from the home directory, the home directory became the workspace, and the
 * sandbox then offered everything underneath it as candidate context. Measured on the
 * owner's machine 2026-08-07: `fullContextTokens: 5,661,108` for a one-line request,
 * with BigKiji's own data directory inside the scan — which is what put a file the app
 * rewrites every few seconds into a sealed disclosure manifest.
 *
 * Home is never a project. detectVault() already knows how to find one (a directory
 * containing `.obsidian/`) and is what the Electron app resolves with, so the daemon
 * gives the same answer rather than a second one.
 *
 * Being told beats detecting: an explicit BIGKIJI_WORKSPACE, or a workspace handed in
 * by a caller such as a test, is used exactly as given even if it is the home directory.
 */
function resolveWorkspace(requested, env = process.env, home = os.homedir(), dataRoot = DATA.dataRoot, appRoot = APP_ROOT) {
  const explicit = requested || env.BIGKIJI_WORKSPACE;
  if (explicit) return { workspace: path.resolve(explicit), redirected: null };
  const cwd = path.resolve(process.cwd());
  // Two cwds mean "nobody chose", not "here".
  //
  // $HOME is the obvious one. The app's own directory is the other, and it is the one
  // that actually happens: DaemonClient.ensure() always spawns with `cwd: appRoot`, so a
  // daemon started without BIGKIJI_WORKSPACE has the BigKiji repository as its working
  // directory and adopted it as the owner's workspace. Measured 2026-08-10, immediately
  // after the fix that stopped the CLI from passing $HOME: reads went from "the whole
  // home directory" to "the app's own source tree" — a different wrong answer.
  //
  // An owner who really is working on BigKiji still gets it: running the CLI from here
  // makes cwd ≠ home, so daemon-client sends BIGKIJI_WORKSPACE and `explicit` wins above.
  // This branch is only reached when nothing was requested at all.
  const unchosen = path.resolve(home) === cwd || path.resolve(appRoot || '') === cwd;
  if (!unchosen) return { workspace: cwd, redirected: null };
  let vault = '';
  try { vault = detectVault(env, {}, home); } catch (_) { vault = ''; }
  // BigKiji's own storage is not the owner's workspace, whatever markers it carries.
  //
  // `~/BigKijiUniverse` holds 正典.md and the sessions, and it has an `.obsidian/` folder,
  // so `detectVault` picks it first — the app would run the owner's work inside its own
  // filing cabinet. Their departments are five folders away, under `~/Documents`.
  if (dataRoot && path.resolve(vault || '') === path.resolve(dataRoot)) vault = '';
  // Detection first — an `.obsidian/` marker elsewhere is the owner saying "this one is
  // mine" — and `~/Documents` only when it finds nothing real.
  //
  // Without this the fallback was the home directory itself: `detectVault` ends by
  // inventing `~/Documents/BigKiji`, which does not exist here, so the guard below gave up
  // and every run was handed $HOME. One of them sent gemini 711,395 input tokens against a
  // 250,000 free-tier limit (measured 2026-08-10). The owner chose `~/Documents` as the
  // Vault the same day.
  if (!vault || path.resolve(vault) === cwd || !fs.existsSync(vault)) {
    const documents = path.join(home, 'Documents');
    if (fs.existsSync(documents) && path.resolve(documents) !== cwd) {
      return { workspace: path.resolve(documents), redirected: { from: cwd, to: path.resolve(documents) } };
    }
  }
  // A detector that points back at home, or at somewhere that does not exist, has not
  // found anything. Staying put and saying so beats inventing a directory.
  if (!vault || path.resolve(vault) === cwd || !fs.existsSync(vault)) return { workspace: cwd, redirected: null };
  return { workspace: path.resolve(vault), redirected: { from: cwd, to: path.resolve(vault) } };
}

/**
 * The question out of a reply that ends in one.
 *
 * A model's reply is usually a paragraph with the question as its last sentence, and
 * handing the whole paragraph to the spec writer as "the question" buries it. Split on
 * sentence ends in both scripts; falls back to the tail if the reply is one long line.
 */
function lastSentence(reply) {
  const text = String(reply || '').trim();
  const parts = text.split(/(?<=[。.!?！？])\s*/).map((part) => part.trim()).filter(Boolean);
  return (parts[parts.length - 1] || text).slice(0, 320);
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

/**
 * May this request run without stopping for approval — `'owner'` yes, `'plan'` no.
 *
 * One function because the decision is made in two places and they drifted. Measured
 * 2026-08-10 on the live daemon: 「BKUのスキル一覧を出して」 (soft) correctly waited, the
 * front desk asked which format, the owner answered 「1a」 — and the run that came out of
 * the answer was `auto / EXECUTING`. The gate was reading the *answer* text, and "1a" is
 * not a request at all, so it fell through to the owner's mode. Every gated request could
 * be walked straight past it by answering one question.
 *
 * So the gate belongs to the request being satisfied, and it is carried on the pending
 * question rather than recomputed from whatever the owner typed last.
 *
 * - a model-promoted TASK — a 3B classifier's opinion, paid for with one prompt
 * - the soft lexical tier — a work verb near a request ending, widened 2026-08-09
 * - anything with no recorded gate — fail closed; an answer whose request we cannot
 *   identify must not dispatch paid work on the owner's behalf
 *
 * `strong` (the original fourteen words, 作って, 直して) keeps the owner's own mode. That
 * door was never the problem, and an approval in front of 「修正して」 is how this goes
 * back to feeling like nothing ever starts.
 */
function runGate(text, promotedByModel = false) {
  if (promotedByModel) return 'plan';
  return actionTier(text) === 'strong' ? 'owner' : 'plan';
}
// ACTIVE_RUN and TERMINAL_RUN come from the coordinator that sets those statuses.
// They used to be written out by hand here and in two methods below, with three
// different answers — see the comment on ACTIVE_RUN for what that cost.
function currentPhase(runs) {
  const live = (Array.isArray(runs) ? runs : []).filter((run) => !TERMINAL_RUN.includes(run?.status));
  return live.at(-1)?.status || 'IDLE';
}

const EVENT_CHANNEL = Object.freeze({
  task: 'task:event', tasklog: 'task:log', step: 'task:step', run: 'run:event', models: 'model:status:update',
  commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event',
  stats: 'pi:stats', bus: 'bus:event', preview: 'preview:status', fleet: 'pi:fleet', inventory: 'inventory:update', security: 'security:status',
  conversation: 'conversation:update', idea: 'idea:update', knowledge: 'knowledge:status', checkpoint: 'run:checkpoint', report: 'run:report', tools: 'tools:status',
  review: 'run:review', reflection: 'run:reflection', corpus: 'corpus:ingested',
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
  constructor({ appRoot = APP_ROOT, stateRoot = STATE_ROOT, layout = LAYOUT, workspace = '',
    conversationEngine = null, ideaStore = null, knowledgeStore = knowledge, facilitator = null,
    gpuLock = gpuLockModule, lookup = localLookup } = {}) {
    super();
    // Defaulted here rather than in the parameter list so resolveWorkspace can tell an
    // explicit choice from a fallen-back one — process.cwd() in the signature makes the
    // two indistinguishable, and only one of them may be overridden.
    const resolved = resolveWorkspace(workspace);
    this.appRoot = path.resolve(appRoot); this.stateRoot = path.resolve(stateRoot); this.workspace = resolved.workspace;
    // Shown, not silent. The owner has to be able to see that the daemon is working
    // somewhere other than where they started it.
    this.workspaceRedirect = resolved.redirected;
    if (resolved.redirected) {
      console.log(`workspace: started in the home directory — using ${resolved.redirected.to} instead`
        + ' (set BIGKIJI_WORKSPACE to choose)');
    }
    // Tests inject a throwaway stateRoot; production uses the resolved data layout,
    // where sessions/ideas are siblings of state/ rather than children of it.
    this.customState = path.resolve(stateRoot) !== path.resolve(STATE_ROOT);
    const rootFor = (key, name) => (this.customState ? path.join(this.stateRoot, name) : layout[key]);
    this.startedAt = Date.now(); this.sessions = new SessionStore({ root: rootFor('sessionsRoot', 'sessions') });
    // How many jobs run at once. The owner sets it; 3 was a literal nobody could
    // reach. Local tasks are additionally serialised inside the runner, because they
    // all share one GPU — see canStart().
    // The runner is told where BigKiji's own working files live so the context pruner
    // never seals one into a disclosure manifest. Without this the daemon invalidates
    // its own seal: recordEvent() writes task_state.json between sealing and verifying,
    // and every run dies on STALE_DISCLOSURE_MANIFEST. Built through rootFor() so an
    // injected stateRoot in tests is covered by the same exclusion as production.
    // Same rootFor: a test's throwaway stateRoot must carry the corpus with it, or the
    // suite writes the owner's real one. That mistake has been made here before, with
    // task_state.json, and it destroyed 300 events of history.
    this.corpusRoot = rootFor('corpusRoot', 'corpus');
    // Whether the local model is stopped. Injectable because the real reader spawns `ps`,
    // and a suite whose verdict depends on what the owner's GPU happens to be doing is
    // the machine-state dependence conversation-selftest.js was already burned by once.
    this.gpuLock = gpuLock;
    // The read-only local answer for a look-at-it request. Injectable for the same reason
    // gpuLock is: the real one spawns pi against the GPU, and a suite that does that has
    // an opinion about what the owner is rendering.
    this.lookup = lookup;
    // Two roots, because the canon is a sibling of the departments rather than a child.
    //
    // The five department folders are under ~/Documents; ~/BigKijiUniverse holds 正典.md,
    // the skill index and the failure memory, and every department's own `.pi/sandbox.json`
    // grants read on all three. With one boundary those three grants were filtered out of
    // every policy without a word — see SandboxPolicyResolver's constructor.
    //
    // dataRoot is added rather than hardcoded: a test injects a throwaway stateRoot and
    // must not have the owner's real BigKijiUniverse quietly inside its Vault.
    this.runner = new TaskRunner({ cwd: this.workspace,
      vaultRoots: [...new Set([this.workspace, DATA.dataRoot].filter(Boolean))],
      dataRoots: [this.stateRoot, rootFor('sessionsRoot', 'sessions'),
        rootFor('knowledgeRoot', 'knowledge'), rootFor('logsRoot', 'logs')],
      maxParallel: Math.max(1, Math.min(8, Number(this.ownerSettings()?.routing?.maxParallel) || 3)) });
    // The conversation, with a way out when a render has switched the local model off.
    //
    // `gpu-signal.sh` SIGSTOPs Ollama for the whole of a render, so the owner's questions
    // came back as a template for as long as their video took: 「生成中のためローカルが
    // 使えないので会話ができないと表示されています」. Their `cloudFallback` had said
    // 'gpu-busy' for a day and reached only the front desk, and only GLM, which has never
    // had a key here.
    //
    // Read per call, not captured, and for the same reason the facilitator's switch is:
    // a privacy control that needs a restart to take effect is one nobody can trust in the
    // moment. Off means the escape function is never called at all, not called and refused.
    this.conversation = conversationEngine || new ConversationEngine({
      cloudEscape: (prompt) => (this.ownerSettings()?.conversation?.cloudFallback === 'gpu-busy'
        ? escape(prompt)
        : Promise.resolve(null)),
    });
    // The front desk that turns a one-line request into a spec worth executing.
    //
    // It existed and worked — measured 2026-08-05, 17 characters in, a 945-character
    // decision-complete spec out in 5.7s on a local model that costs nothing — and it
    // was reachable from nowhere. `fast-api-router` was required by main.js alone, and
    // main.js only calls it when the daemon is *not* connected, which on a running
    // machine is never. So every request arrived here as `goal: <the owner's one line>`
    // with empty constraints, steps and acceptance, and the specialists were asked to
    // build from it. This is that router, on the path both surfaces actually use.
    // Read per call, not captured: `cloudFallback` is a privacy switch, and a switch that
    // needs a restart to take effect is one the owner cannot trust in the moment.
    this.facilitator = facilitator
      || new FastFacilitatorRouter({ cloudFallback: () => this.ownerSettings()?.conversation?.cloudFallback || 'off' });
    this.facilitatorPending = null;
    // The last thing this session actually asked for, so a later "please start" has
    // something to refer to. Without it a go-ahead is a word with no object and the
    // only honest reading is chat. Cleared on /reset with the pending question.
    this.lastRequest = null;
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
    // Retire runs that stopped moving, and plans nobody answered.
    //
    // Both sweeps existed and neither had a caller that fires while the owner is away:
    // expireStaleApprovals runs from submit(), so it only sweeps when something new
    // starts. This daemon stayed up for 2 days 6 hours holding a run that had been over
    // for 54 of them. A minute is far below both TTLs and costs a map walk.
    this.sweepTimer = setInterval(() => {
      try {
        const stalled = this.coordinator.expireStalledRuns();
        const expired = this.coordinator.expireStaleApprovals();
        if (stalled || expired) this.publish('phase', { phase: currentPhase(this.coordinator.snapshot()) });
      } catch (_) { /* a sweep that throws must not take the daemon with it */ }
    }, 60000);
    this.sweepTimer.unref();
    this.ingestCorpus();
  }

  /**
   * Collect what the owner has actually asked for, across every CLI they use.
   *
   * `corpus-ingest.js` was written, complete, and never called: measured 2026-08-09, no
   * file in src/ or tools/ referenced it and `owner-turns.jsonl` did not exist. So the one
   * body of evidence about how this owner phrases a request — 359 turns across
   * ~/.claude/projects, ~/.codex, ~/.pi/agent/sessions and this daemon's own sessions —
   * was sitting on disk unread while the classifier guessed.
   *
   * Deferred and best-effort by construction. The first pass reads ~/.claude/projects
   * (808 MB here), so it must not sit in front of the daemon accepting its first turn;
   * afterwards `ingest-state.json` makes it one stat per unchanged file (measured: 232
   * files, 0.4 s). It writes only inside the corpus directory, never to the transcripts
   * it reads, and redacts before writing. A failure is published and dropped — a corpus
   * is an asset, not a dependency.
   */
  ingestCorpus({ delayMs = 5000 } = {}) {
    if (this.corpusTimer || String(process.env.BIGKIJI_SKIP_CORPUS || '') === '1') return null;
    this.corpusTimer = setTimeout(async () => {
      try {
        const { CorpusIngest } = require('../pi-core/corpus-ingest');
        // `dataRoot` is where this daemon's own sessions live — the fourth source. In a
        // test that is the injected stateRoot; in production it is the data layout's root.
        const dataRoot = this.customState ? this.stateRoot : LAYOUT.dataRoot;
        const summary = await new CorpusIngest({ corpusRoot: this.corpusRoot, dataRoot }).run();
        this.corpusSummary = { ...summary, at: new Date().toISOString() };
        this.publish('corpus', this.corpusSummary);
      } catch (error) {
        this.publish('corpus', { error: String(error?.message || error).slice(0, 200) });
      }
    }, delayMs);
    this.corpusTimer.unref();
    return this.corpusTimer;
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
        // The block this object forgot to carry.
        //
        // Two keys were assembled here and `conversation` was not one of them, so
        // `cloudFallback: () => this.ownerSettings()?.conversation?.cloudFallback || 'off'`
        // (below) read `undefined` and answered 'off' on every call, whatever the owner
        // had chosen. Measured 2026-08-10: their settings.json has said
        // `"cloudFallback": "gpu-busy"` for a day, and the escape it enables has never
        // once been reachable. A switch the owner has already thrown, wired to nothing.
        //
        // Passed through rather than defaulted: this is a privacy control, and the safe
        // value is the store's own ('off' — settings-store.js DEFAULTS). Inventing a
        // second default here is how the two would disagree.
        conversation: { ...(saved.conversation || {}) },
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
    // "Is the token limit lifted?" — same argument, different snapshot.
    //
    // Checked before the classifier, not after, because the widened action lexicon reads
    // 「確認して欲しい」 as work and would answer a rate-limit question by spending a run on
    // it. The breaker already holds the exact number of seconds left.
    if (isProviderQuestion(clean)) {
      return this._measuredTurn(session, providerReport(this.providerFacts(), { text: clean }), 'providers');
    }
    // The owner answering the question the front desk asked last turn.
    //
    // Bound to the session that was asked and to a window, because "what did you mean
    // by that" cannot be allowed to swallow an unrelated request typed an hour later.
    // A status question is already intercepted above, so asking how things are going
    // while a question is open still answers the status question.
    const asked = this.facilitatorPending;
    if (asked && asked.sessionId === session.id && Date.now() - asked.at < FACILITATION_WINDOW_MS) {
      return await this._answerTurn(session, clean, mode, asked);
    }
    if (asked) { this.facilitatorPending = null; this.facilitator.reset(); }
    // "please start" — a go-ahead for the request already on the table.
    //
    // With no question outstanding this fell through to the conversation model, which
    // classified it CHAT (no verb to find) and created nothing. Measured on the owner's
    // machine 2026-08-07: two explicit go-aheads in a row produced no run, and the model
    // then reported that it had started. Nothing had.
    //
    // Scoped hard — same session, inside the same window, and only when this session
    // has already made an actionable request that a go-ahead can refer to. A bare
    // "yes" in a session that asked for nothing still means nothing. And the run this
    // creates is a *plan*, so a wrong reading costs an approval prompt, not an action.
    const open = this.lastRequest;
    if (open && open.sessionId === session.id && Date.now() - open.at < FACILITATION_WINDOW_MS && isAffirmative(clean)) {
      // Always `plan` here, whatever the original request's own standing was — and this
      // line is why the sentence above could be written. `isAffirmative` reads 「はい」,
      // 「そう」, `ok` out of ordinary conversation; a misreading that costs an approval
      // prompt is a design, a misreading that costs an edit is a bug. It was asserted in
      // this comment and not implemented until 2026-08-10.
      return await this._answerTurn(session, clean, mode, { request: open.text, questions: open.questions, gate: 'plan' });
    }
    const result = await this.conversation.turn({ text: clean, sessionId: session.id, seed, facts: this.facts(),
      onDelta: (delta) => this.publish('pi', { kind: 'delta', text: delta, model: this.conversation.model }) });
    // `degraded` and `error` go on the record, not just on the wire.
    //
    // The session jsonl held provider and latency and nothing else, so a turn served by
    // the model and a turn that timed out looked identical apart from a string inside
    // `text`. Diagnosing 2026-08-09 needed `ps -Ao stat` on a live process to establish
    // that Ollama had been SIGSTOPped — a fact the file could have carried and did not.
    // Two extra fields make the log answer the question by itself.
    // `spoken`, not `reply`: the machine notice is shown and not saved.
    //
    // `sessionSeed()` reads these back on /resume and hands them to the model as its own
    // previous turns. Measured 2026-08-10 from the owner's session file — the notice
    // 「GPUを『u09-tile-answer』が10:55:51から使用中のため…」 was stored at 10:55, the render
    // exited at 12:00, and at 12:42 the resumed model told them twice that the GPU was in
    // use. A fact about one minute, saved as prose, becomes something the assistant
    // believes forever. The two fields below carry it instead, which is what they are for.
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: result.kind, text: result.spoken || result.reply,
      turnId: result.turnId, provider: result.provider, latencyMs: result.latencyMs,
      degraded: !!result.degraded, gpuFrozen: !!result.gpuFrozen, ...(result.error ? { error: result.error } : {}) });
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
    // A request that only looks at something is answered by looking.
    //
    // 「データ見せてください」 used to become a plan: two invented questions, then a spec,
    // then a paid dispatch held for an approval. Three steps and a bill to list what is on
    // disk. The owner said it twice — 「まだすぐにだしてくれません」 — and chose (2026-08-10)
    // to have these answered locally instead.
    //
    // Free, read-only and enforced by pi's own tool allowlist rather than by a sentence in
    // a prompt. See local-lookup.js. If it cannot serve the turn — pi missing, GPU frozen,
    // nothing found — it says so and the ordinary planning route runs underneath, because
    // a broken shortcut must not be how a request disappears.
    if (result.kind === 'TASK' && isInspection(clean)) {
      const looked = await this._lookLocally(session, clean, result);
      if (looked) return looked;
    }
    if (result.kind === 'TASK') {
      facilitation = await this._facilitate(clean);
      // Hands-off: the fleet decides rather than the owner. Same two-stage front desk,
      // with the answer supplied here instead of waited for, so the decisions are made
      // once and written into the spec rather than left open for a specialist to guess
      // at mid-run — which is the failure this whole path exists to stop.
      // …and for a request that only looks at something, whether the owner asked for
      // hands-off or not.
      //
      // 2026-08-10, the owner's own line 「データ見せてください」 came back as two questions
      // with six invented options — 「売上レポート」 is not a thing this system has. The
      // front desk is told to ask for every materially important decision that is
      // missing, and a 6.6B model reading a four-word request decides everything is
      // missing and makes up the choices. The owner's report: 「まだすぐにだしてくれません。
      // 質問が多いです。」
      //
      // Questions should cost what being wrong costs. Sorting a list the wrong way costs
      // one more turn; deleting the wrong folder costs the folder. The front desk asked
      // the same number either way. An inspection gets safe defaults and goes.
      const inspection = isInspection(clean);
      if (facilitation?.status === 'needs_clarification' && (mode === 'demo' || inspection)) {
        this.publish('commentary', { source: 'Front desk', status: 'PLANNING',
          text: inspection
            ? `Choosing defaults for ${facilitation.questions.length} question${facilitation.questions.length === 1 ? '' : 's'} — this only reads, so a wrong guess costs one turn.`
            : `Deciding ${facilitation.questions.length} open question${facilitation.questions.length === 1 ? '' : 's'} without the owner — hands-off mode.` });
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
        // `gate` travels with the question. The answer that comes back is 「1a」 or
        // 「はい、Markdownで」 — text that is not a request and never classifies as one —
        // so the run it produces has to inherit the standing of the request it completes,
        // not of the words that completed it. See runGate().
        this.facilitatorPending = { sessionId: session.id, questions: facilitation.questions, at: Date.now(),
          gate: runGate(clean, result.promotedByModel) };
      }
    }
    // What a later go-ahead refers to. Recorded for anything the owner asked *for* —
    // not for chat — and refreshed on every such turn, so "please start" always means
    // the most recent request rather than something from an hour ago.
    if (result.kind === 'TASK') {
      this.lastRequest = { sessionId: session.id, text: clean, at: Date.now(),
        gate: runGate(clean, result.promotedByModel),
        questions: facilitation?.status === 'needs_clarification' ? facilitation.questions : [] };
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
      // A TASK the lexicon did not recognise runs under `plan`, whatever the mode says.
      //
      // The conversation model is now allowed to call a turn TASK on its own (see
      // classifyKind) — that is what re-opened the door after every request outside a
      // fourteen-word list started nothing. The price of letting a small model decide is
      // paid here rather than in the classifier: `plan` means the run stops at
      // AWAITING_APPROVAL even under `auto-edit`, so a wrong promotion costs one prompt
      // and never an edit. An explicit request keeps whatever mode the owner set.
      //
      // The soft lexical tier pays the same price, and did not at first.
      //
      // 2026-08-09 widened the classifier twice on the same day: the model may promote,
      // and a work verb near a request ending (`actionTier` -> 'soft') counts as a
      // request. Only the first paid for the widening. Measured on the owner's own 361
      // turns, three of the fifteen the soft tier newly recognises are not work —
      // 「こんにちは 今日は何ができますか 数踏みで教えてください」, `how can you run btw`,
      // 「日本の首都について三行で教えてください」 — and under `auto-edit` each of those
      // dispatched a paid provider with nothing asked of the owner. The regex written that
      // afternoon was trusted further than the model whose mistakes it was hired to fix.
      // The owner chose (2026-08-09) to make the two doors cost the same.
      //
      // `strong` — the original fourteen words plus 作って/直して — is untouched. That door
      // was never the problem, and putting an approval in front of it is how the machine
      // goes back to feeling like nothing ever starts.
      const runMode = runGate(clean, result.promotedByModel) === 'plan' ? 'plan' : mode;
      run = this.coordinator.submit({ prompt: clean, promptSpec, planHash: facilitation?.planHash || null, cwd: this.workspace, mode: runMode });
      // submit() emits 'run' synchronously, so onRun has already appended this run
      // to the session and published it. Doing it again here printed the same run
      // twice in the transcript and wrote it twice into the session file.
      this.runSessions.set(run.id, session.id);
    }
    const questions = facilitation?.status === 'needs_clarification' ? facilitation.questions : [];
    // The questions travel in the reply as well as in their own field. Every surface
    // renders `reply`; only the CLI knows what to do with `questions`, and a question
    // the owner cannot see is the same as one that was never asked.
    // The cloud note goes in front of the reply, not into a log.
    //
    // The front desk is local by default and the owner is entitled to assume it stays
    // that way. On the one path where it does not — the GPU was held by a render and the
    // owner had switched the escape on — the sentence naming the provider is part of the
    // answer, because "which of my words left this machine" is not an implementation
    // detail. See fast-api-router.js `runGlm`.
    const spoken = questions.length ? `${result.reply}\n\n${questionText(questions)}` : result.reply;
    // And the same treatment for the opposite fact: the plan attached to this reply is
    // three generic steps that no model wrote. Measured 2026-08-10 during one of the
    // owner's renders — the run brief looked exactly like a considered plan.
    //
    // Suppressed when the conversation reply already carried the reason. A frozen turn
    // opens with the holder and the time, and printing the same sentence twice is noise,
    // which is its own way of not being read.
    const draftNote = facilitation?.degradedNote && !result.gpuFrozen ? facilitation.degradedNote : '';
    // The facilitator's note says 「この整理だけ」クラウドに出した — only the organising. That
    // is true when the reply itself was written here, and false the moment the conversation
    // took the same escape, which it now can. `result.reply` already opens with its own
    // note in that case, so printing this one after it would both repeat the fact and
    // misstate its scope.
    const cloudNote = facilitation?.viaCloud && !result.viaCloud ? facilitation.cloudNote : '';
    const reply = [cloudNote, draftNote, spoken].filter(Boolean).join('\n');
    // A question the conversation model asked in prose is still a question.
    //
    // Only the facilitator's questions were ever registered, so when the model asked one
    // itself — 「…教えていただけますでしょうか？」, turn 2 of the owner's session — the
    // answer arrived with nothing waiting for it. Registered here so the next turn
    // reaches _answerTurn carrying the request the question was about. Structural test
    // (`？` at the end), because the model's own labelling is the part that failed.
    //
    // Restricted to TASK turns on purpose. A CHAT reply ends in a question constantly —
    // the built-in fallback literally ends 「…気になっていますか？」 — and registering
    // those would turn the next thing the owner typed, whatever it was, into a run.
    // Conversation is allowed to be conversation.
    if (!run && !questions.length && result.kind === 'TASK' && endsWithQuestion(result.reply)) {
      this.facilitatorPending = { sessionId: session.id, questions: [lastSentence(result.reply)],
        at: Date.now(), request: clean, gate: runGate(clean, result.promotedByModel) };
    }
    const output = { accepted: true, kind: result.kind, reply, sessionId: session.id, turnId: result.turnId,
      provider: result.provider, model: result.model, latencyMs: result.latencyMs, degraded: result.degraded,
      gpuFrozen: !!result.gpuFrozen, draft, run, promotedByModel: !!result.promotedByModel,
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
  /**
   * A spec written from (an earlier request + what the owner just said).
   *
   * `facilitator.answer` requires at least one question to hang the answer on; a plain
   * go-ahead has none, so one is supplied that says what is actually being decided.
   * Falls back to the ordinary path rather than failing the turn — an unwritable spec
   * must not be the reason a go-ahead disappears again.
   */
  async _answerWith(request, questions, said) {
    const asked = (questions || []).length ? questions : ['Proceed with the request as stated?'];
    try {
      return await this.facilitator.answer(request, asked, said, {
        onStart: (provider) => this.publish('commentary', { source: 'Front desk', status: 'PLANNING',
          text: `Writing a decision-complete spec with ${provider}.` }),
      });
    } catch (error) {
      this.publish('commentary', { source: 'Front desk', status: 'DEGRADED',
        text: `Could not write a spec from that answer (${String(error.message).slice(0, 120)}) — using the request on its own.` });
      this.facilitator.reset();
      return await this._facilitate(`${request}\n\nOwner answers: ${said}`);
    }
  }

  /**
   * Answer a look-at-it request from the local model, or return null and let the
   * ordinary planning route have it.
   *
   * Null on every failure, on purpose. The alternative — reporting "I could not look" as
   * the answer — turns a working request into a dead end, and this whole path exists
   * because requests were dying in the corridor. What went wrong is published as
   * commentary so it is visible without being terminal.
   *
   * @returns {Promise<object|null>}
   */
  async _lookLocally(session, text, result) {
    const started = Date.now();
    this.publish('commentary', { source: 'Local', status: 'READING',
      text: 'Looking, locally — this request only reads, so nothing paid is started.' });
    let looked = null;
    try {
      looked = await this.lookup(text, { facts: this.facts(), cwd: this.workspace,
        model: this.conversation.model });
    } catch (error) {
      looked = { ok: false, text: '', reason: String(error?.message || error).slice(0, 160) };
    }
    if (!looked?.ok) {
      this.publish('commentary', { source: 'Local', status: 'DEGRADED',
        text: `Could not look it up locally (${looked?.reason || 'unknown'}) — planning it instead.` });
      return null;
    }
    const turnId = `turn-${started.toString(36)}-look`;
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'TASK',
      text: looked.text, turnId, provider: 'local-lookup', latencyMs: looked.ms });
    // No run, no approval, no draft. The answer is the whole of it, which is the point.
    const output = { accepted: true, kind: 'TASK', reply: looked.text, sessionId: session.id, turnId,
      provider: 'local-lookup', model: this.conversation.model, latencyMs: Date.now() - started,
      degraded: false, gpuFrozen: false, draft: null, run: null, promotedByModel: !!result?.promotedByModel,
      questions: [], awaitingAnswer: false, requiresApproval: false, readOnly: true };
    this.publish('conversation', { kind: 'turn_complete', ...output });
    this.publish('session', this.sessions.read(session.id));
    return output;
  }

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
  async _answerTurn(session, text, mode, pending = null) {
    const started = Date.now();
    this.facilitatorPending = null;
    // When the question came from somewhere other than the facilitator's own state —
    // the conversation model asking in prose, or a bare go-ahead against an earlier
    // request — the router has nothing remembered to attach the answer to, and
    // facilitate() would write a spec whose whole goal is the word "yes". `answer()`
    // exists for exactly this and is what /answer on a run already uses.
    const spec = pending?.request
      ? await this._answerWith(pending.request, pending.questions, text)
      : await this._facilitate(text);
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
    // The gate of the request being satisfied, not of the answer. `pending.gate` is set
    // where the question was asked; absent means we cannot identify the request, and an
    // unidentifiable request does not get to spend money — see runGate().
    const runMode = pending?.gate === 'owner' ? mode : 'plan';
    const run = this.coordinator.submit({ prompt: `${written.goal || text}\n\nOwner answers: ${text}`,
      promptSpec, planHash: spec.planHash || null, cwd: this.workspace, mode: runMode });
    this.runSessions.set(run.id, session.id);
    // The goal stays on the table. In the owner's session the first run FAILED and the
    // next thing typed was 「please start」 — a retry, which has to find something to
    // retry. Kept rather than consumed for that reason; a second go-ahead makes a second
    // plan, which is visible and needs approval, not a second action.
    this.lastRequest = { sessionId: session.id, text: written.goal || text, at: Date.now(), questions: [] };
    // The run brief prints the goal and the constraints under the run line, so sending
    // the whole spec here as well put the same paragraph on screen twice — measured on
    // the owner's machine 2026-08-05, a 20-page textbook spec appeared in the brief and
    // again immediately below it. Split rather than deduplicated at render time: the
    // brief says what is being built, this says how it will be done and judged, and
    // `/runs` still shows the goal long after this reply has scrolled away.
    const detail = [
      written.steps?.length ? `Steps:\n${asList(written.steps).map((step, i) => `  ${i + 1}. ${step}`).join('\n')}` : '',
      written.acceptance?.length ? `Acceptance:\n${asList(written.acceptance).map((item) => `  · ${item}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    // A plan nobody wrote says so, on the line above itself.
    //
    // `degraded` already travelled on the wire and reached no one the owner could see;
    // measured 2026-08-10, a request made during a render came back as the three generic
    // steps with no indication that the front desk had had nothing to think with. Same
    // treatment as `cloudNote`: a fact about how the answer was made belongs in front of
    // the answer, not only in a field.
    const reply = [spec.degradedNote, detail || spec.promptSpecText || written.goal || text].filter(Boolean).join('\n');
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'TASK', text: reply,
      turnId, provider: spec.provider, latencyMs: spec.latencyMs });
    const output = { accepted: true, kind: 'TASK', reply, sessionId: session.id, turnId, provider: spec.provider,
      model: 'facilitator', latencyMs: Date.now() - started, degraded: !!(spec.fallbackReason || spec.degradedNote), draft: null, run,
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
  _statusTurn(session, text) { return this._measuredTurn(session, statusReport(this.statusFacts(), { text }), 'status'); }

  /**
   * A reply assembled from this machine's own state, with no model in the path.
   *
   * Two kinds of question qualify: what is running (`statusReport`) and which providers
   * can be asked (`providerReport`). Both were being answered by a 3B model that had the
   * true numbers in its prompt and reported something else anyway. Recorded as
   * `provider: 'bigkiji-state'` so a later reader can tell a measurement from an opinion.
   * @returns {object}
   */
  _measuredTurn(session, reply, tag) {
    const started = Date.now();
    const turnId = `turn-${started.toString(36)}-${tag}`;
    this.sessions.append(session.id, { type: 'conversation', role: 'assistant', status: 'CHAT', text: reply,
      turnId, provider: 'bigkiji-state', latencyMs: Date.now() - started });
    // A measured answer does not consume the front desk's question — 「進んでる？」 asked
    // while a plan is waiting on a decision still gets the status, and the decision is
    // still owed. So the flag has to say so, or the CLI's footer clears "asking" while
    // the daemon goes on treating the next line as the answer.
    const holding = this.facilitatorPending;
    const stillAsking = !!holding && holding.sessionId === session.id && Date.now() - holding.at < FACILITATION_WINDOW_MS;
    const output = { accepted: true, kind: 'CHAT', reply, sessionId: session.id, turnId,
      provider: 'bigkiji-state', model: 'measured', latencyMs: Date.now() - started, degraded: false,
      draft: null, run: null, requiresApproval: false,
      questions: stillAsking ? holding.questions || [] : [], awaitingAnswer: stillAsking };
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
      running: runs.filter((run) => ACTIVE_RUN.includes(run.status)).map(counted),
      waiting: runs.filter((run) => run.status === 'AWAITING_APPROVAL').map(counted),
    };
  }

  /**
   * Which AI can actually be asked to do something, right now, and why not.
   *
   * Three sources had the answer and none of them were joined: the fleet store knows who
   * is authenticated, `circuit-breaker.json` knows who is inside a cooldown, and
   * `model_performance.json` records the rate-limit and quota hits that put them there.
   * Measured 2026-08-09 — live cooldowns on disk while `facts()` announced all four
   * providers as able to run work, which is the list the conversation model then answered
   * 「どのAIが使えますか」 from.
   *
   * Returned as objects rather than prose so the deterministic reply and the model's
   * briefing read one snapshot, the same arrangement `statusFacts()` has with `facts()`.
   * @returns {{usable: string[], cooling: object[], busy: string[], throttled: object[], unreachable: string[]}}
   */
  providerFacts() {
    const fleet = this.models.snapshot()?.models || [];
    // `connected` means "has a task running right now". Reported as reachability it
    // told the conversation model that no external provider was available while all
    // four were authenticated and idle — so it answered questions about what it
    // could do with the opposite of the truth.
    const reachable = fleet.filter((model) => (model.available ?? model.connected)).map((model) => model.id);
    const unreachable = fleet.filter((model) => !(model.available ?? model.connected)).map((model) => model.id);
    const cooling = (this.breaker?.openCircuits?.() || []);
    const chilled = new Set(cooling.map((item) => item.provider));
    // `connected` is not "busy".
    //
    // model-status-store.js:53 pins `connected: true` for pi-agent-core because it is
    // resident, so the busy list always contained it and the screen always read
    // 「pi-agent-core が忙しく…」 — an idle machine reporting itself busy, in the app's own
    // voice. Busy is a task in the `running` state, which the runner already knows.
    const busy = [...new Set(this.runner.snapshot()
      .filter((task) => task.status === 'running').map((task) => task.provider).filter(Boolean))];
    const performance = this.coordinator.registry?.snapshot?.()?.performance?.models || {};
    // Rows keyed `provider::model` are the per-tier record; the provider-level row is the
    // one a sentence about "which AI" is about. A provider already named in `cooling` is
    // not repeated — the cooldown is the live fact and this is only its history.
    const throttled = Object.entries(performance)
      .filter(([id, row]) => row?.throttledReason && !id.includes('::') && !chilled.has(id))
      .map(([id, row]) => ({ provider: id, reason: String(row.throttledReason), at: row.throttledAt || '' }));
    const frozen = this.frozenProviders();
    const stopped = new Set(frozen.map((item) => item.provider));
    return { usable: reachable.filter((id) => !chilled.has(id) && !stopped.has(id)),
      cooling, busy, throttled, unreachable, frozen };
  }

  /**
   * Local providers that are stopped rather than merely idle.
   *
   * `provider-readiness.js` answers "is this provider installed and authenticated", and
   * for anything local that is unconditionally yes (`LOCAL` → `runs on this machine`).
   * That is the right answer to that question. But `providerReport()` answers a different
   * one — 「どのAIが使えますか」 — and while gpu-signal.sh holds the card Ollama is
   * SIGSTOPped. Measured 2026-08-09: the reply named local-qwen among six usable
   * providers with `ps` showing it in state T two lines away.
   *
   * Announcing a stopped model as usable is exactly the plausible-and-wrong answer this
   * whole path was built to stop producing, so the freeze is applied here rather than in
   * readiness, where it would change what a different question means.
   *
   * Only `local-qwen`. `pi-agent-core` runs whatever `model-router.buildChain()` puts at
   * the head of the chain, which is not always Ollama, so it cannot be declared frozen
   * from the state of a process it may not be using.
   * @returns {Array<{provider: string, holder: string, since: string, orphaned: boolean}>}
   */
  frozenProviders() {
    let state = null; let lock = { held: false, holder: '', since: '' };
    try { state = this.gpuLock?.ollamaFrozen?.() ?? null; } catch (_) { return []; }
    if (state?.frozen !== true) return [];
    try { lock = this.gpuLock?.readGpuLock?.() || lock; } catch (_) {}
    // `orphaned` is the freeze nobody will lift: stopped with no lock, so the watchdog has
    // nothing to wait for and no job will finish and release it. Measured once as a
    // llama-server that sat in T for a day. It reads differently to the owner — "wait for
    // your render" versus "this needs a hand" — so the two are not collapsed.
    //
    // Asked of gpu-lock rather than derived from `lock.held` here, so the definition of
    // that state lives in one place. It had been written, exported and never called.
    const orphaned = this.gpuLock?.frozenWithoutLock?.({ lock, procs: state }) === true;
    return [{ provider: 'local-qwen', holder: lock.holder || '', since: lock.since || '', orphaned }];
  }

  facts() {
    const runs = this.coordinator.snapshot();
    const waiting = runs.filter((run) => run.status === 'AWAITING_APPROVAL');
    const active = runs.filter((run) => ACTIVE_RUN.includes(run.status));
    const tasks = this.runner.snapshot();
    const byStatus = tasks.reduce((acc, task) => ({ ...acc, [task.status]: (acc[task.status] || 0) + 1 }), {});
    const { usable, cooling, busy, throttled, frozen } = this.providerFacts();
    const ideas = this.ideas.list(6);
    const lines = [
      `- workspace: ${this.workspace}`,
      `- runs awaiting your approval: ${waiting.length}${waiting.length ? ` (latest: ${waiting.at(-1).id}, ${waiting.at(-1).assignments?.length || 0} assignments)` : ''}`,
      `- runs in progress: ${active.length}`,
      `- tasks: ${tasks.length}${tasks.length ? ` (${Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(', ')})` : ''}`,
      `- saved ideas: ${ideas.length}${ideas.length ? `; most recent: ${ideas.slice(0, 3).map((idea) => idea.title).join(' / ')}` : ''}`,
      `- conversation sessions on record: ${this.sessions.count()}`,
      `- providers that can run work: ${usable.length ? usable.join(', ') : 'none — only local work can run'}`,
      `- providers on cooldown: ${cooling.length
        ? cooling.map((item) => `${item.provider} (${Math.max(1, Math.round(item.retryInMs / 1000))}s${item.reason ? `, ${item.reason}` : ''})`).join(', ')
        : 'none'}`,
      `- providers busy right now: ${busy.length ? busy.join(', ') : 'none'}`,
      // Told to the model too, not only to the deterministic reply. Without it the model
      // is briefed that local-qwen is missing from the usable list and given no reason,
      // and a model with a gap and no reason fills it.
      ...(frozen.length ? [`- providers stopped by the GPU lock: ${frozen.map((item) => `${item.provider}`
        + `${item.orphaned ? ' (stopped with no job holding the lock — needs a manual thaw)'
          : ` (the GPU is held by "${item.holder || 'a generation job'}"${item.since ? ` since ${item.since}` : ''})`}`).join(', ')}`] : []),
      ...(throttled.length ? [`- providers throttled earlier: ${throttled.map((item) => `${item.provider} (${item.reason})`).join(', ')}`] : []),
      `- to start a waiting run the owner types /approve in the bigkiji CLI`,
    ];
    return lines.join('\n');
  }

  state() {
    return { source: 'bigkiji-daemon', version: 2, pid: process.pid, startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt,
      workspace: this.workspace, workspaceRedirect: this.workspaceRedirect,
      activeSessionId: this.activeSessionId, sessions: this.sessions.list(24), runs: this.coordinator.snapshot(),
      tasks: this.runner.snapshot(),
      // The fleet by provider (who is up) and the record by model (what each tier
      // actually did). They are different questions and only the first was answered.
      models: { ...this.models.snapshot(), performance: this.coordinator.registry?.snapshot?.().performance || { models: {} } },
      inventory: this.inventory, tools: this.tools, security: this.securityState,
      conversation: this.conversation.snapshot(), ideas: this.ideas.list(24), phase: currentPhase(this.coordinator.snapshot()),
      // Whether the local model is stopped *now*, not whether it was stopped when the
      // owner last typed.
      //
      // The CLI footer printed 「local model frozen — gpu busy」 from the last turn's
      // `gpuFrozen` flag and kept printing it, because the flag describes a turn and the
      // footer reads as a description of the machine. Measured 2026-08-10: the render
      // finished at 12:00, `/tmp/bigkiji_gpu.lock` was gone and every Ollama process was
      // back in state S, and at 12:32 the footer still said the GPU was busy — for
      // thirty-two minutes the only way to correct it was to type something, which is
      // exactly what the owner would not do while being told the machine was frozen.
      //
      // One `ps` per four-second poll, and gpu-lock memoises it for two, so a poll costs
      // one reading and a burst of pollers costs the same one.
      gpu: this.gpuState() };
  }

  /** The freeze as a fact about now: `{frozen, holder, since, orphaned}`. */
  gpuState() {
    const [frozen] = this.frozenProviders();
    return frozen
      ? { frozen: true, holder: frozen.holder, since: frozen.since, orphaned: !!frozen.orphaned }
      : { frozen: false, holder: '', since: '', orphaned: false };
  }
  shutdown() {
    clearInterval(this.inventoryTimer); clearInterval(this.toolTimer); clearInterval(this.sweepTimer);
    clearTimeout(this.corpusTimer);
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
  assertBindAllowed(config.bind);
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
  // Shutting down and leaving the process are two different jobs. `close` used to do
  // both, so the only correct teardown was unusable from a test — which is why the
  // selftests each hand-rolled a partial one, closed the HTTP server but not the
  // WebSocket server, and called process.exit() with a close still in flight. POSIX
  // tolerates that; Windows aborts inside libuv with
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
  // Now `close(cb)` finishes and calls back, and whoever wanted to exit does it.
  const close = (onClosed) => {
    clearInterval(ping);
    for (const socket of sockets) socket.close();
    wss.close();
    engine.shutdown();
    server.close(() => { if (typeof onClosed === 'function') onClosed(); });
  };
  // A signal handler is called with the signal name, so it cannot be `close` itself —
  // the name would arrive as `onClosed` and silently not be a function.
  const closeAndExit = () => close(() => process.exit(0));
  process.once('SIGTERM', closeAndExit); process.once('SIGINT', closeAndExit);
  return { server, engine, config, mobileDevices, close };
}

if (require.main === module) startDaemon();

module.exports = { HANDS_OFF_ANSWER, jsonSafe, DaemonEngine, startDaemon, loadConfig, EVENT_CHANNEL, APP_ROOT, STATE_ROOT, effectiveMode, isLoopback, MODES, currentPhase, resolveWorkspace, lastSentence };
