'use strict';

(() => {
  class BigKijiAudioEngine {
    constructor() {
      this.ctx = null; this.ownerGain = null; this.agentGain = null;
      this.queues = { owner: [], agent: [] }; this.active = { owner: null, agent: null };
      this.settings = { ownerVolume: 0.6, agentVolume: 0.3, attentionChime: true, chimeTone: 'arrival' };
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
        source.connect(track === 'owner' ? this.ownerGain : this.agentGain); this.active[track] = source;
        const firstAudioMs = Date.now() - Number(chunk.requestedAt || Date.now());
        window.dispatchEvent(new CustomEvent('bk-audio-state', { detail: { state: 'playing', track, chunk, firstAudioMs } }));
        source.onended = () => {
          this.active[track] = null;
          window.dispatchEvent(new CustomEvent('bk-audio-state', { detail: { state: 'ended', track, chunk } }));
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
