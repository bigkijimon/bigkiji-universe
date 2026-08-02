'use strict';

(() => {
  // Sound-effect buses. Mirrors SFX_CATEGORIES in src/core/settings-store.js.
  const SFX_CATEGORIES = ['ui', 'alert', 'ambient'];
  const SFX_DEFAULTS = { ui: 0.5, alert: 0.6, ambient: 0.3 };
  // Assets are produced in a later phase; the folder may not exist yet.
  const SFX_DIR = './assets/sfx/';

  class BigKijiAudioEngine {
    constructor() {
      this.ctx = null; this.ownerGain = null; this.agentGain = null;
      // Single playback analyser. Every playback bus is routed through it so a background
      // wave visualization can call getByteFrequencyData on window.BKAudio.analyser.
      // NOTE: microphone capture (voice-live.js) runs on its OWN AudioContext, so this
      // analyser only ever sees output. The two contexts are intentionally not merged.
      this.analyser = null;
      this.sfxGains = {};
      this.sfxBuffers = new Map();   // name → decoded AudioBuffer
      this.sfxUnavailable = new Set(); // names already reported as missing (log once)
      this.queues = { owner: [], agent: [] }; this.active = { owner: null, agent: null };
      this.settings = { ownerVolume: 0.6, agentVolume: 0.3, attentionChime: true, chimeTone: 'arrival', telephonyEnabled: true, handsetCue: true, sfxEnabled: true, sfx: { ...SFX_DEFAULTS } };
    }
    async ensure() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.72;
        this.analyser.connect(this.ctx.destination);
        this.ownerGain = this.ctx.createGain(); this.agentGain = this.ctx.createGain();
        this.ownerGain.connect(this.analyser); this.agentGain.connect(this.analyser);
        for (const category of SFX_CATEGORIES) {
          const gain = this.ctx.createGain();
          gain.connect(this.analyser);
          this.sfxGains[category] = gain;
        }
        this.apply(this.settings);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    }
    apply(settings = {}) {
      this.settings = { ...this.settings, ...settings, sfx: { ...SFX_DEFAULTS, ...this.settings.sfx, ...settings.sfx } };
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (this.ownerGain) this.ownerGain.gain.setTargetAtTime(Number(this.settings.ownerVolume ?? 0.6), now, 0.02);
      if (this.agentGain) this.agentGain.gain.setTargetAtTime(Number(this.settings.agentVolume ?? 0.3), now, 0.02);
      const sfxOn = this.settings.sfxEnabled !== false;
      for (const category of SFX_CATEGORIES) {
        const gain = this.sfxGains[category];
        if (!gain) continue;
        const level = sfxOn ? Number(this.settings.sfx?.[category] ?? SFX_DEFAULTS[category]) : 0;
        gain.gain.setTargetAtTime(Number.isFinite(level) ? level : SFX_DEFAULTS[category], now, 0.02);
      }
    }
    // Play a one-shot effect from ./assets/sfx/<name>.wav on the given category bus.
    // Resolves to false (never throws) when effects are off or the asset is not shipped yet.
    async play(name, category = 'ui') {
      const key = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '');
      const bus = SFX_CATEGORIES.includes(category) ? category : 'ui';
      if (!key || this.settings.sfxEnabled === false || this.sfxUnavailable.has(key)) return false;
      try {
        await this.ensure();
        let buffer = this.sfxBuffers.get(key);
        if (!buffer) {
          const response = await fetch(`${SFX_DIR}${key}.wav`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
          this.sfxBuffers.set(key, buffer);
        }
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.sfxGains[bus] || this.analyser || this.ctx.destination);
        source.start();
        // Announce which cue is playing. The background wave needs the cue id to pick
        // its hue from the sfx manifest: at fftSize 512 the bins are ~86 Hz wide, which
        // cannot resolve these pitches, so every cue would collapse onto the same few
        // hues if the colour were derived from the spectrum. Emitting here means no
        // consumer has to monkey-patch this method to find out.
        window.dispatchEvent(new CustomEvent('bk-sfx-cue', {
          detail: { id: key, category: bus, durationMs: Math.round(buffer.duration * 1000) },
        }));
        return true;
      } catch (error) {
        // The asset pack ships later. Report each missing name once and stay silent after that.
        this.sfxUnavailable.add(key);
        console.info(`[BKAudio] sfx "${key}" unavailable (${error.message}) — effect skipped.`);
        return false;
      }
    }
    async chime() {
      if (!this.settings.attentionChime) return;
      await this.ensure();
      if (this.settings.telephonyEnabled && this.settings.handsetCue) { this.handsetCue('pickup'); await new Promise((resolve) => setTimeout(resolve, 180)); return; }
      const now = this.ctx.currentTime;
      const notes = this.settings.chimeTone === 'pulse' ? [660, 880] : this.settings.chimeTone === 'soft' ? [520, 650] : [740, 988];
      notes.forEach((frequency, index) => {
        const osc = this.ctx.createOscillator(); const gain = this.ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + index * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.08, now + index * 0.09 + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.09 + 0.21);
        osc.connect(gain).connect(this.ownerGain); osc.start(now + index * 0.09); osc.stop(now + index * 0.09 + 0.23);
      });
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
    handsetCue(kind = 'pickup') {
      if (!this.ctx || !this.settings.handsetCue) return;
      const now = this.ctx.currentTime; const duration = kind === 'pickup' ? 0.14 : 0.11;
      const buffer = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * duration), this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) { const env = Math.exp(-i / (this.ctx.sampleRate * .025)); data[i] = (Math.random() * 2 - 1) * env * (kind === 'pickup' ? .22 : .16); }
      const noise = this.ctx.createBufferSource(); noise.buffer = buffer;
      const filter = this.ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = kind === 'pickup' ? 1150 : 720; filter.Q.value = .8;
      const gain = this.ctx.createGain(); gain.gain.value = .22; noise.connect(filter).connect(gain).connect(this.ownerGain); noise.start(now);
      const osc = this.ctx.createOscillator(); const og = this.ctx.createGain(); osc.type = 'triangle'; osc.frequency.value = kind === 'pickup' ? 180 : 120;
      og.gain.setValueAtTime(.04, now); og.gain.exponentialRampToValueAtTime(.0001, now + duration); osc.connect(og).connect(this.ownerGain); osc.start(now); osc.stop(now + duration);
    }
    connectVoice(source, destination) {
      if (!this.settings.telephonyEnabled) { source.connect(destination); return; }
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 1;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 1;
      const boost = this.ctx.createBiquadFilter(); boost.type = 'peaking'; boost.frequency.value = 2800; boost.Q.value = 1.5; boost.gain.value = 3;
      const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -15; comp.ratio.value = 3; comp.attack.value = .008; comp.release.value = .16;
      source.connect(hp); hp.connect(lp); lp.connect(boost); boost.connect(comp); comp.connect(destination);
    }
    enqueue(chunk) {
      if (!chunk?.buf) return;
      const track = chunk.track === 'agent' ? 'agent' : 'owner';
      this.queues[track].push(chunk); this.playNext(track);
    }
    async playNext(track) {
      if (this.active[track] || !this.queues[track].length) return;
      const chunk = this.queues[track].shift();
      try {
        await this.ensure();
        if (track === 'owner' && chunk.first) await this.chime();
        const raw = chunk.buf instanceof ArrayBuffer ? chunk.buf : chunk.buf.buffer.slice(chunk.buf.byteOffset || 0, (chunk.buf.byteOffset || 0) + chunk.buf.byteLength);
        const audio = await this.ctx.decodeAudioData(raw.slice(0));
        const source = this.ctx.createBufferSource(); source.buffer = audio; source.playbackRate.value = Number(chunk.speed || 1);
        this.connectVoice(source, track === 'owner' ? this.ownerGain : this.agentGain); this.active[track] = source;
        const firstAudioMs = Date.now() - Number(chunk.requestedAt || Date.now());
        window.dispatchEvent(new CustomEvent('bk-audio-state', { detail: { state: 'playing', track, chunk, firstAudioMs } }));
        source.onended = () => {
          this.active[track] = null;
          window.dispatchEvent(new CustomEvent('bk-audio-state', { detail: { state: 'ended', track, chunk } }));
          if (track === 'owner' && !this.queues.owner.length && this.settings.telephonyEnabled) setTimeout(() => this.handsetCue('hangup'), 35);
          setTimeout(() => this.playNext(track), 45 + Math.round(Number(this.settings.pauseNaturalness || 0.55) * 120));
        };
        source.start();
      } catch (error) {
        this.active[track] = null;
        window.dispatchEvent(new CustomEvent('bk-audio-state', { detail: { state: 'error', track, error: error.message } }));
        this.playNext(track);
      }
    }
    stop(track) {
      const tracks = track ? [track] : ['owner', 'agent'];
      for (const name of tracks) {
        this.queues[name].length = 0;
        if (this.active[name]) { try { this.active[name].stop(); } catch (_) {} this.active[name] = null; }
      }
    }
  }
  // window.BKAudio.analyser is null until the first ensure()/play()/chime(): AudioContext
  // creation is deferred until a real sound is needed. Visualizations should await
  // BKAudio.ensure() once, then read BKAudio.analyser every frame.
  window.BKAudio = new BigKijiAudioEngine();
  window.BKAudio.SFX_CATEGORIES = SFX_CATEGORIES;
})();
