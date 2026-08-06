'use strict';

const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signalChild } = require('./child-signal');
const { sanitizeOwnerSpeech, sanitizeAgentSpeech, detectSpeechLanguage } = require('./tts-policy');

const SYSTEM_VOICES = {
  English: { female: 'Samantha', male: 'Daniel' },
  Japanese: { female: 'Kyoko', male: 'Otoya (Enhanced)' },
};
const PROFILE_INSTRUCTIONS = {
  claude: 'Speak in a bright, intelligent and warm female voice. Be concise and natural.',
  codex: 'Speak in a calm, grounded professional female voice with precise articulation.',
  glm: 'Speak in a soft, smooth female voice with a conversational tone.',
  pi: 'Speak as a clear, crisp male operations assistant. Keep the delivery efficient.',
  gemini: 'Speak in a confident, authoritative neutral male command voice.',
};

function execFileBuffer(file, args, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout }, (error) => error ? reject(error) : resolve());
    child.on('error', reject);
  });
}

class NaturalTTSService extends EventEmitter {
  constructor({ appRoot, userData, settingsStore, cacheDir = '', venvPython = '' }) {
    super();
    this.appRoot = appRoot;
    this.userData = userData;
    this.settingsStore = settingsStore;
    this.cacheDir = cacheDir || path.join(userData, 'tts-cache');
    this.venvPython = venvPython;
    this.proc = null;
    this.starting = null;
    this.idleTimer = null;
    this.status = { state: 'sleeping', engine: 'system-neural', ready: false, latencyMs: null, detail: 'Starts on first speech request' };
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }
  snapshot() { return { ...this.status, endpoint: this.settingsStore.get().audio.ttsEndpoint }; }
  _setStatus(patch) { this.status = { ...this.status, ...patch, ts: Date.now() }; this.emit('status', this.snapshot()); }
  start() {
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    const cfg = this.settingsStore.get().audio;
    // Off means off.
    //
    // `audio.enabled` has existed as a setting and this service never read it, so
    // turning the voice off still started a Python process that loads a TTS model —
    // 1.4GB of venv on disk and a model in memory, for a feature the owner had
    // switched off. The only way to actually stop it was to not run BigKiji.
    if (cfg.enabled === false) {
      this._setStatus({ state: 'off', ready: false, engine: 'system-neural', detail: 'Voice is switched off in settings' });
      return;
    }
    if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(`${cfg.ttsEndpoint}/`)) return;
    if (this.proc) return;
    // Reuse a healthy owner-started service. This avoids a duplicate model
    // allocation and a misleading EADDRINUSE failure during app restarts.
    const existing = await this.health(650).catch(() => null);
    if (existing?.ready) return;
    // Resolved by path-config, which probes both the app data root and the
    // pre-2.5 location so an unmoved 1.4 GB venv keeps working.
    const venvPython = this.venvPython;
    const python = fs.existsSync(venvPython) ? venvPython : (process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python.exe' : 'python3'));
    const script = path.join(this.appRoot, 'tools', 'qwen3-tts-server.py');
    const endpoint = new URL(cfg.ttsEndpoint);
    this._setStatus({ state: 'loading', ready: false, detail: `Starting local ${path.basename(cfg.ttsModel)}` });
    this.proc = spawn(python, [script, '--host', '127.0.0.1', '--port', endpoint.port || '17890', '--model', cfg.ttsModel], {
      cwd: this.appRoot,
      env: { ...process.env, PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (data) => this.emit('log', String(data).trim()));
    this.proc.stderr.on('data', (data) => this.emit('log', String(data).trim()));
    this.proc.on('exit', (code) => {
      this.proc = null;
      this._setStatus({ state: 'offline', ready: false, detail: `Local TTS exited (${code ?? 'signal'})` });
    });
    this._pollHealth();
  }
  stop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (this.proc) { signalChild(this.proc); this.proc = null; }
    this.starting = null;
    this._setStatus({ state: 'sleeping', ready: false, engine: 'system-neural', detail: 'Stopped after idle timeout' });
  }
  /** Switching the voice off stops what is already running, not only what starts next. */
  applySettings() {
    if (this.settingsStore.get().audio?.enabled === false && this.proc) this.stop();
  }

  async ensureReady(timeoutMs = 9000) {
    const existing = await this.health(500).catch(() => null);
    if (existing?.ready) return true;
    await this.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const health = await this.health(650).catch(() => null);
      if (health?.ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }
  _scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    const idleMs = Math.max(15000, Number(process.env.BIGKIJI_TTS_IDLE_MS || 60000));
    this.idleTimer = setTimeout(() => this.stop(), idleMs); this.idleTimer.unref?.();
  }
  async _pollHealth() {
    for (let i = 0; i < 90 && this.proc; i++) {
      const health = await this.health(700).catch(() => null);
      if (health?.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  async health(timeoutMs = 900) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.settingsStore.get().audio.ttsEndpoint}/health`, { signal: ctrl.signal });
      const body = await response.json();
      this._setStatus({ state: body.ready ? 'ready' : (body.state || 'loading'), ready: !!body.ready,
        engine: body.ready ? 'qwen3-tts-local' : 'system-neural', detail: body.detail || body.model || 'Local TTS' });
      return body;
    } finally { clearTimeout(timer); }
  }
  _profile(agent, language, track) {
    const key = /claude/i.test(agent) ? 'claude' : /codex/i.test(agent) ? 'codex' : /glm/i.test(agent) ? 'glm' : /gemini/i.test(agent) ? 'gemini' : 'pi';
    const cfg = this.settingsStore.get().audio;
    const profile = cfg.profiles[key] || cfg.profiles.pi;
    const speed = track === 'agent' ? Math.min(1.22, (profile.speed || 1.08) + 0.04)
      : (language === 'Japanese' ? cfg.ownerSpeedJapanese : cfg.ownerSpeedEnglish);
    return { key, ...profile, speed, instruct: PROFILE_INSTRUCTIONS[key] };
  }
  _cachePath(payload) {
    const id = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return path.join(this.cacheDir, `${id}.wav`);
  }
  async synthesize({ text, track = 'owner', agent = 'codex', requestedAt = Date.now(), forceSystem = false }) {
    const clean = track === 'owner' ? sanitizeOwnerSpeech(text, 900) : sanitizeAgentSpeech(text, 260);
    if (!clean) throw new Error('Speech was empty or blocked by policy');
    const language = detectSpeechLanguage(clean, 'English');
    const profile = this._profile(agent, language, track);
    const payload = { text: clean, language, speaker: profile.speaker, instruct: profile.instruct,
      model: this.settingsStore.get().audio.ttsModel };
    const cached = this._cachePath(payload);
    const started = Date.now();
    let buffer; let engine = 'qwen3-tts-local'; let fallback = false;
    if (!forceSystem && fs.existsSync(cached)) buffer = await fs.promises.readFile(cached);
    if (!buffer && !forceSystem) {
      try {
        const cfg = this.settingsStore.get().audio;
        if (!await this.ensureReady(Math.min(cfg.qwenTtsTimeoutMs, 12000))) throw new Error('local TTS wake timeout');
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), cfg.qwenTtsTimeoutMs);
        const response = await fetch(`${cfg.ttsEndpoint}/synthesize`, {
          method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        }).finally(() => clearTimeout(timer));
        if (!response.ok) throw new Error(`local TTS HTTP ${response.status}`);
        buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 1000) throw new Error('local TTS returned no audio');
        await fs.promises.writeFile(cached, buffer);
      } catch (error) {
        this._setStatus({ state: 'fallback', ready: false, engine: 'system-neural', detail: error.message });
      }
    }
    if (!buffer) {
      fallback = true; engine = 'system-neural';
      const gender = ['pi', 'gemini'].includes(profile.key) ? 'male' : 'female';
      const voice = SYSTEM_VOICES[language]?.[gender] || 'Samantha';
      const tmp = path.join(os.tmpdir(), `bigkiji-tts-${process.pid}-${Date.now()}.wav`);
      if (process.platform === 'darwin') {
        await execFileBuffer('/usr/bin/say', ['-v', voice, '-r', String(Math.round(175 * profile.speed)), '-o', tmp,
          '--data-format=LEI16@22050', clean]);
      } else if (process.platform === 'linux') {
        await execFileBuffer(process.env.ESPEAK_BIN || 'espeak-ng', ['-s', String(Math.round(175 * profile.speed)), '-w', tmp, clean]);
      } else {
        const script = '$s=New-Object -ComObject SAPI.SpVoice;$f=New-Object -ComObject SAPI.SpFileStream;$f.Open($env:BIGKIJI_TTS_FILE,3,$false);$s.AudioOutputStream=$f;$s.Speak($env:BIGKIJI_TTS_TEXT);$f.Close()';
        await new Promise((resolve, reject) => execFile(process.env.POWERSHELL_BIN || 'powershell.exe', ['-NoProfile', '-Command', script],
          { timeout: 12000, env: { ...process.env, BIGKIJI_TTS_FILE: tmp, BIGKIJI_TTS_TEXT: clean } }, (error) => error ? reject(error) : resolve()));
      }
      buffer = await fs.promises.readFile(tmp);
      fs.promises.unlink(tmp).catch(() => {});
    }
    const latencyMs = Date.now() - started;
    this._setStatus({ state: fallback ? 'fallback' : 'ready', ready: !fallback, engine, latencyMs,
      detail: fallback ? `${process.platform} system voice fallback active` : `${path.basename(payload.model)} ready` });
    this._scheduleIdleStop();
    return { buffer, track, agent: profile.key, language, speed: profile.speed, engine, fallback,
      requestedAt, synthesizedAt: Date.now(), synthesisMs: latencyMs, text: clean };
  }
}

module.exports = { NaturalTTSService, SYSTEM_VOICES, PROFILE_INSTRUCTIONS };
