'use strict';

const { EventEmitter } = require('events');

class LocalQwenGuardrails extends EventEmitter {
  constructor({ model = process.env.BIGKIJI_QWEN_MODEL || 'qwen3.5:35b-a3b', fetchImpl = global.fetch,
    defaultContextTokens = 6144, degradedContextTokens = 4096, hardContextTokens = 8192, taskTimeoutMs = 60000 } = {}) {
    super(); this.model = model; this.fetchImpl = fetchImpl; this.defaultContextTokens = defaultContextTokens;
    this.degradedContextTokens = degradedContextTokens; this.hardContextTokens = hardContextTokens; this.taskTimeoutMs = taskTimeoutMs;
    this.samples = []; this.timeouts = 0; this.degraded = false; this.active = 0; this.resetting = false;
  }
  budget() { return Math.min(this.hardContextTokens, this.degraded ? this.degradedContextTokens : this.defaultContextTokens); }
  enter() { this.active += 1; }
  leave({ durationMs = 0, timedOut = false } = {}) {
    this.active = Math.max(0, this.active - 1); this.samples.push(Number(durationMs) || 0); this.samples = this.samples.slice(-6);
    this.timeouts = timedOut ? this.timeouts + 1 : 0;
    const recent = this.samples.slice(-3); const baseline = this.samples.slice(0, Math.max(1, this.samples.length - 3));
    const recentAvg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const baselineAvg = baseline.reduce((a, b) => a + b, 0) / Math.max(1, baseline.length);
    if (this.timeouts >= 2 || (recent.length === 3 && baseline.length && recentAvg > Math.max(15000, baselineAvg * 1.8))) this.degraded = true;
    const resetReason = this.timeouts >= 2 ? 'two-consecutive-timeouts' : (this.degraded ? 'sustained-latency-degradation' : '');
    this.emit('health', { active: this.active, degraded: this.degraded, contextTokens: this.budget(), durationMs, resetReason });
    if (resetReason && this.active === 0) this.reset(resetReason).catch(() => {});
  }
  chunk(prompt, { targetChars = 1800, maxChunks = 12 } = {}) {
    const text = String(prompt || '').trim(); if (!text) return [];
    const blocks = text.split(/\n{2,}|(?<=[。.!?])\s+/).filter(Boolean); const chunks = []; let current = '';
    for (const block of blocks) {
      if (current && current.length + block.length + 2 > targetChars) { chunks.push(current); current = ''; if (chunks.length >= maxChunks) break; }
      current += `${current ? '\n\n' : ''}${block}`;
    }
    if (current && chunks.length < maxChunks) chunks.push(current);
    return chunks.length ? chunks : [text.slice(0, targetChars)];
  }
  async reset(reason = 'manual') {
    if (this.active || this.resetting || !this.fetchImpl) return { reset: false, reason: this.active ? 'active-request' : 'unavailable' };
    this.resetting = true;
    try {
      const response = await this.fetchImpl('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: '', stream: false, keep_alive: 0 }) });
      if (!response.ok) throw new Error(`Ollama reset ${response.status}`);
      this.timeouts = 0; this.samples = []; this.degraded = false; this.emit('reset', { reason, at: new Date().toISOString() });
      return { reset: true, reason };
    } finally { this.resetting = false; }
  }
}

module.exports = { LocalQwenGuardrails };

