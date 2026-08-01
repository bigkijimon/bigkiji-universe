'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  audio: {
    enabled: true,
    ownerVolume: 0.6,
    agentVolume: 0.3,
    attentionChime: true,
    chimeTone: 'arrival',
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
    localDefault: 'qwen',
    qwenBypassTimeoutMs: 1000,
  },
  cmux: {
    enabled: true,
    cliPath: '/Users/yuma/.local/bin/cmux',
    pollMs: 1200,
    mirrorLines: 160,
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
function clamp(n, min, max, fallback) {
  n = Number(n); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
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
    next.routing.paidAllowlist = ['claude', 'codex', 'gemini', 'glm'];
    next.routing.localDefault = 'qwen';
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
      if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('macOS Keychain encryption is unavailable');
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

module.exports = { SettingsStore, DEFAULTS };
