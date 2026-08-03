'use strict';

const fs = require('fs');
const path = require('path');
const { TOOL_PATH_IDS, TOOL_SETTING_ALIASES, expandPath } = require('../domain/pi-agent/tool-registry');

// Owner-facing PiAgent name. Kept short so it fits every HUD label without truncation.
const PI_AGENT_NAME_MAX = 32;
const PI_AGENT_NAME_FALLBACK = 'PiAgent';
// Render priority: 'auto' keeps the adaptive FPS tuner, the other two pin a fixed tier.
const RENDER_PRIORITIES = ['auto', 'performance', 'graphics'];
// 'auto' maps to nativeTheme.themeSource = 'system'; the other two force it either way.
const COLOR_SCHEMES = ['auto', 'light', 'dark'];
// Sound-effect buses. Each one is an independent gain node in the renderer audio engine.
const SFX_CATEGORIES = ['ui', 'alert', 'ambient'];

const DEFAULTS = Object.freeze({
  audio: {
    enabled: true,
    ownerVolume: 0.6,
    agentVolume: 0.3,
    attentionChime: true,
    chimeTone: 'arrival',
    telephonyEnabled: true,
    handsetCue: true,
    defaultLanguage: 'English',
    ownerSpeedEnglish: 1.08,
    ownerSpeedJapanese: 1.04,
    pauseNaturalness: 0.55,
    agentChatter: true,
    ttsEndpoint: 'http://127.0.0.1:17890',
    ttsModel: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    qwenTtsTimeoutMs: 9000,
    firstSpeechDeadlineMs: 30000,
    systemFallbackAtMs: 22000,
    sfxEnabled: true,
    sfx: { ui: 0.5, alert: 0.6, ambient: 0.3 },
    profiles: {
      claude: { speaker: 'Serena', label: 'Bright warm female', speed: 1.08 },
      codex: { speaker: 'Vivian', label: 'Grounded professional female', speed: 1.06 },
      glm: { speaker: 'Serena', label: 'Soft conversational female', speed: 1.08 },
      pi: { speaker: 'Aiden', label: 'Crisp operations male', speed: 1.1 },
      gemini: { speaker: 'Ryan', label: 'Authoritative command male', speed: 1.06 },
    },
  },
  routing: {
    paidAllowlist: ['claude', 'codex', 'gemini', 'glm'],
    maxParallel: 3,
    localDefault: 'qwen',
    qwenBypassTimeoutMs: 1000,
    executionMode: 'plan',
    maxAgents: 3,
    activationMode: 'on-demand',
    allSpecialists: false,
    sessionLeader: 'auto',
    // How many independent lenses discuss the approach before work starts.
    // 0 or 1 disables it — one lens is not a discussion.
    deliberationLenses: 2,
  },
  conversation: {
    // Measured 2026-08-03 against the owner's own question: qwen2.5:0.5b
    // contradicts itself in ungrammatical Japanese, qwen3.5 answers correctly.
    // See conversation-engine.js. The 0.5b model stays as the fast-ACK tier.
    model: 'qwen3.5:latest',
    contextTokens: 4096,
    autoIdeas: true,
    cloudEnhancementApproval: 'always',
  },
  quality: {
    gate: 'strict',
    repairScope: 'broad',
    maxRepairCycles: 3,
    rollbackOnRegression: true,
    smokeAfterRestart: true,
    testTimeoutMs: 300000,
    researchCacheDays: 30,
    officialSourcesFirst: true,
  },
  preview: {
    enabled: true,
    preferredPort: 4317,
    liveReload: true,
    autoOpen: true,
    viewport: 'desktop',
  },
  appearance: {
    theme: 'studio',
    // Which design language ('studio') and whether it is light or dark are two different
    // questions, so they are two different settings rather than one list of four themes.
    // 'auto' follows the OS, which is what nativeTheme.themeSource = 'system' means.
    colorScheme: 'auto',
    // Console session drawer. Open by default — there is already a real history to show.
    consoleSidebar: true,
    density: 'comfortable',
    textScale: 1,
    reducedGlow: true,
    reduceMotion: false,
    renderPriority: 'auto',
  },
  piAgent: {
    displayName: PI_AGENT_NAME_FALLBACK,
  },
  terminal: {
    pinnedSession: true,
    maxTabs: 8,
    restoreSelection: true,
  },
  paths: {
    vaultRoot: '',
    knowledgeRoot: '',
    graphifyGraphPath: '',
    comfyRoot: '',
    whisperBin: '',
    whisperModel: '',
    // Local tool connections: id -> absolute path. Empty means "detect it", never
    // "there is none", so clearing a row hands the decision back to detection.
    tools: {},
  },
  cmux: {
    enabled: process.platform === 'darwin',
    cliPath: 'cmux',
    pollMs: 700,
    mirrorLines: 160,
    theme: '',
    confirmDangerous: true,
  },
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function merge(base, patch) {
  const out = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}
// Models measured unfit to hold a conversation. A saved settings.json outlives the
// default that wrote it, so retiring one here is the only thing that actually removes it
// from a machine that has already run.
const RETIRED_CHAT_MODELS = new Set(['qwen2.5:0.5b', 'qwen2.5:1.5b']);

function clamp(n, min, max, fallback) {
  n = Number(n); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// `paths.tools` is an id -> absolute-path map for tools that live outside the app and are
// never copied into it. Hand-edited settings files reach detection unfiltered otherwise,
// so: unknown ids are dropped, `~` is expanded, a non-string is ignored and an emptied
// value is removed rather than pinned as '' — an empty string would suppress detection
// forever, which is the opposite of what clearing a field means.
//
// Three tools already own a dedicated key (comfyRoot, vaultRoot, graphifyGraphPath) that
// path-config.js and the ComfyUI bridge read. Those keys stay authoritative; a value that
// arrives under `paths.tools.<id>` folds into the dedicated key instead of becoming a
// second source of truth that can disagree with it.
function normalizePaths(next) {
  if (!next.paths || typeof next.paths !== 'object' || Array.isArray(next.paths)) next.paths = clone(DEFAULTS.paths);
  const incoming = (next.paths.tools && typeof next.paths.tools === 'object' && !Array.isArray(next.paths.tools))
    ? next.paths.tools : {};
  const tools = {};
  for (const [id, value] of Object.entries(incoming)) {
    if (typeof value !== 'string') continue;
    const resolved = expandPath(value);
    if (!resolved) continue;
    const dedicated = TOOL_SETTING_ALIASES[id];
    if (dedicated) { next.paths[dedicated] = resolved; continue; }
    if (!TOOL_PATH_IDS.includes(id)) continue;
    tools[id] = resolved;
  }
  next.paths.tools = tools;
  for (const key of Object.keys(DEFAULTS.paths)) {
    if (key === 'tools') continue;
    if (typeof next.paths[key] !== 'string') next.paths[key] = '';
  }
  return next.paths;
}

class SettingsStore {
  constructor({ userData, safeStorage }) {
    this.safeStorage = safeStorage;
    this.file = path.join(userData, 'settings.json');
    this.secretFile = path.join(userData, 'secrets.enc.json');
    this.state = this._load();
  }
  _load() {
    try { return this._normalize(merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')))); }
    catch (_) { return clone(DEFAULTS); }
  }
  _normalize(next) {
    next.audio.ownerVolume = clamp(next.audio.ownerVolume, 0, 1, 0.6);
    next.audio.agentVolume = clamp(next.audio.agentVolume, 0, 1, 0.3);
    next.audio.ownerSpeedEnglish = clamp(next.audio.ownerSpeedEnglish, 0.85, 1.4, 1.08);
    next.audio.ownerSpeedJapanese = clamp(next.audio.ownerSpeedJapanese, 0.85, 1.4, 1.04);
    next.audio.pauseNaturalness = clamp(next.audio.pauseNaturalness, 0, 1, 0.55);
    next.audio.qwenTtsTimeoutMs = clamp(next.audio.qwenTtsTimeoutMs, 1000, 20000, 9000);
    next.audio.firstSpeechDeadlineMs = clamp(next.audio.firstSpeechDeadlineMs, 10000, 60000, 30000);
    next.audio.systemFallbackAtMs = Math.min(next.audio.firstSpeechDeadlineMs - 1000,
      clamp(next.audio.systemFallbackAtMs, 5000, 50000, 22000));
    next.audio.sfxEnabled = next.audio.sfxEnabled !== false;
    if (!next.audio.sfx || typeof next.audio.sfx !== 'object') next.audio.sfx = clone(DEFAULTS.audio.sfx);
    for (const category of SFX_CATEGORIES) {
      next.audio.sfx[category] = clamp(next.audio.sfx[category], 0, 1, DEFAULTS.audio.sfx[category]);
    }
    // This used to be an unconditional assignment, so the owner's choice was
    // overwritten on every normalise and the setting could not be changed at all —
    // there was no way to take an exhausted provider out of rotation. It is a
    // filter over the known providers now: unknown names are dropped, and an empty
    // or absent list means all of them rather than none of them.
    const PAID = ['claude', 'codex', 'gemini', 'glm'];
    const requested = Array.isArray(next.routing.paidAllowlist)
      ? next.routing.paidAllowlist.map(String).filter((id) => PAID.includes(id)) : [];
    next.routing.paidAllowlist = requested.length ? [...new Set(requested)] : [...PAID];
    next.routing.localDefault = 'qwen';
    next.routing.executionMode = ['plan', 'auto', 'manual'].includes(next.routing.executionMode) ? next.routing.executionMode : 'plan';
    next.routing.maxAgents = clamp(next.routing.maxAgents, 1, 5, 3);
    // maxAgents is how many roles one run may use; maxParallel is how many jobs run
    // at once across every run. They are different questions and had one answer.
    next.routing.maxParallel = clamp(next.routing.maxParallel, 1, 8, 3);
    next.routing.deliberationLenses = clamp(next.routing.deliberationLenses, 0, 3, 2);
    next.routing.activationMode = 'on-demand';
    next.routing.allSpecialists = false;
    next.routing.sessionLeader = ['auto', 'claude-code', 'codex', 'gemini', 'glm', 'qwen'].includes(next.routing.sessionLeader)
      ? next.routing.sessionLeader : 'auto';
    next.conversation = next.conversation || clone(DEFAULTS.conversation);
    // Changing the default was not enough: a settings.json written before 2026-08-03
    // still pins qwen2.5:0.5b, defaults never reach a key that is already present, and
    // nothing migrated it. The owner ran an entire session against a 0.5B model, which
    // answered 「承認フロー整理案の保存と考察を完了しました」 to hello, to 「おーい」 and to
    // 「機能してないですよ」 alike. A model this project has measured as unfit for
    // conversation is retired on load rather than left to sit in a saved file forever.
    next.conversation.model = String(next.conversation.model || DEFAULTS.conversation.model).slice(0, 120);
    if (RETIRED_CHAT_MODELS.has(next.conversation.model)) next.conversation.model = DEFAULTS.conversation.model;
    next.conversation.contextTokens = clamp(next.conversation.contextTokens, 1024, 8192, DEFAULTS.conversation.contextTokens);
    next.conversation.autoIdeas = next.conversation.autoIdeas !== false;
    next.conversation.cloudEnhancementApproval = 'always';
    next.quality.gate = ['standard', 'strict'].includes(next.quality.gate) ? next.quality.gate : 'strict';
    next.quality.repairScope = ['off', 'low', 'broad'].includes(next.quality.repairScope) ? next.quality.repairScope : 'broad';
    next.quality.maxRepairCycles = clamp(next.quality.maxRepairCycles, 0, 5, 3);
    next.quality.testTimeoutMs = clamp(next.quality.testTimeoutMs, 30000, 900000, 300000);
    next.quality.researchCacheDays = clamp(next.quality.researchCacheDays, 1, 180, 30);
    next.preview.preferredPort = clamp(next.preview.preferredPort, 1024, 65500, 4317);
    next.preview.enabled = next.preview.enabled !== false; next.preview.liveReload = next.preview.liveReload !== false;
    next.preview.viewport = ['desktop', 'tablet', 'mobile'].includes(next.preview.viewport) ? next.preview.viewport : 'desktop';
    next.appearance.theme = 'studio';
    next.appearance.colorScheme = COLOR_SCHEMES.includes(next.appearance.colorScheme)
      ? next.appearance.colorScheme : 'auto';
    next.appearance.consoleSidebar = next.appearance.consoleSidebar !== false;
    next.appearance.textScale = clamp(next.appearance.textScale, 0.85, 1.25, 1);
    next.appearance.renderPriority = RENDER_PRIORITIES.includes(next.appearance.renderPriority)
      ? next.appearance.renderPriority : 'auto';
    // The owner names their own PiAgent. Trim, cap the length and fall back when it is emptied.
    if (!next.piAgent || typeof next.piAgent !== 'object') next.piAgent = clone(DEFAULTS.piAgent);
    next.piAgent.displayName = String(next.piAgent.displayName ?? '').trim().slice(0, PI_AGENT_NAME_MAX)
      || PI_AGENT_NAME_FALLBACK;
    next.terminal.maxTabs = clamp(next.terminal.maxTabs, 2, 16, 8); next.terminal.pinnedSession = true;
    normalizePaths(next);
    next.cmux.enabled = process.platform === 'darwin' && next.cmux.enabled !== false;
    next.cmux.cliPath = String(next.cmux.cliPath || 'cmux');
    next.cmux.pollMs = clamp(next.cmux.pollMs, 350, 5000, 700);
    next.cmux.mirrorLines = clamp(next.cmux.mirrorLines, 40, 2000, 160);
    next.cmux.confirmDangerous = true;
    return next;
  }
  get() { return clone(this.state); }
  update(patch) {
    this.state = this._normalize(merge(this.state, patch));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    return this.get();
  }
  _readSecrets() {
    try { return JSON.parse(fs.readFileSync(this.secretFile, 'utf8')); } catch (_) { return {}; }
  }
  setSecret(id, value) {
    const allowed = new Set(['claude', 'codex', 'gemini', 'glm', 'cmux']);
    if (!allowed.has(id)) throw new Error('Secret provider is not allowed');
    const all = this._readSecrets();
    if (!value) delete all[id];
    else {
      if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('OS secure credential storage is unavailable');
      all[id] = this.safeStorage.encryptString(String(value)).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.secretFile), { recursive: true });
    fs.writeFileSync(this.secretFile, JSON.stringify(all, null, 2), { mode: 0o600 });
    return this.secretStatus();
  }
  getSecret(id) {
    const encoded = this._readSecrets()[id];
    if (!encoded || !this.safeStorage?.isEncryptionAvailable()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(encoded, 'base64')); } catch (_) { return ''; }
  }
  secretStatus() {
    const all = this._readSecrets();
    return Object.fromEntries(['claude', 'codex', 'gemini', 'glm', 'cmux'].map((id) => [id, !!all[id]]));
  }
}

module.exports = { SettingsStore, DEFAULTS, PI_AGENT_NAME_MAX, PI_AGENT_NAME_FALLBACK, RENDER_PRIORITIES, COLOR_SCHEMES, SFX_CATEGORIES, normalizePaths };
