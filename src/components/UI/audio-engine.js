'use strict';

(() => {
  class BigKijiAudioEngine {
    constructor() {
      this.ctx = null; this.ownerGain = null; this.agentGain = null;
      this.queues = { owner: [], agent: [] }; this.active = { owner: null, agent: null };
      this.settings = { ownerVolume: 0.6, agentVolume: 0.3, attentionChime: true, chimeTone: 'arrival', telephonyEnabled: true, handsetCue: true };
    }
    async ensure() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.ownerGain = this.ctx.createGain(); this.agentGain = this.ctx.createGain();
        this.ownerGain.connect(this.ctx.destination); this.agentGain.connect(this.ctx.destination);
        this.apply(this.settings);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    }
    apply(settings = {}) {
      this.settings = { ...this.settings, ...settings };
      if (this.ownerGain) this.ownerGain.gain.setTargetAtTime(Number(this.settings.ownerVolume ?? 0.6), this.ctx.currentTime, 0.02);
      if (this.agentGain) this.agentGain.gain.setTargetAtTime(Number(this.settings.agentVolume ?? 0.3), this.ctx.currentTime, 0.02);
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
  window.BKAudio = new BigKijiAudioEngine();
})();
