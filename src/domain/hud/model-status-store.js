'use strict';

const { EventEmitter } = require('events');

const MODELS = Object.freeze({
  'claude-code': { id: 'claude-code', displayName: 'Claude Code', role: 'Primary reasoning & architecture', provider: 'anthropic' },
  codex: { id: 'codex', displayName: 'Codex', role: 'Deep code generation & analysis', provider: 'openai' },
  gemini: { id: 'gemini', displayName: 'Gemini', role: 'Owner facilitation & research', provider: 'google' },
  glm: { id: 'glm', displayName: 'GLM', role: 'Fast diagnostics & execution', provider: 'zai' },
  'pi-agent-core': { id: 'pi-agent-core', displayName: 'PiAgent Engine', role: 'Orchestration, pruning & file execution', provider: 'pi-agent' },
  'local-qwen': { id: 'local-qwen', displayName: 'Local Qwen', role: 'Local extraction, classification & fallback', provider: 'ollama' },
});

const providerId = (value) => /claude/i.test(value) ? 'claude-code' : /codex|openai/i.test(value) ? 'codex'
  : /gemini|google/i.test(value) ? 'gemini' : /glm|zai/i.test(value) ? 'glm'
    : /qwen|ollama/i.test(value) ? 'local-qwen' : 'pi-agent-core';
const initial = (meta) => ({ ...meta, status: meta.id === 'pi-agent-core' ? 'IDLE' : 'OFFLINE', available: meta.id === 'pi-agent-core', connected: meta.id === 'pi-agent-core',
  metrics: { promptTokens: 0, completionTokens: 0, tokensUsed: 0, tokensSaved: 0, latencyMs: 0,
    lastActive: '', estimatedCostUsd: null, prunedContextRatio: null, filesHandled: 0, executedCommands: 0,
    tokensPerSecond: null, vramUsage: null, apiHealth: 'unknown' } });

class ModelStatusStore extends EventEmitter {
  constructor({ knowledge } = {}) {
    super(); this.knowledge = knowledge; this.models = Object.fromEntries(Object.values(MODELS).map((meta) => [meta.id, initial(meta)]));
    this.taskRecords = new Map(); this.persistTimer = null;
  }
  touch(id, patch = {}) {
    const current = this.models[id]; if (!current) return;
    this.models[id] = { ...current, ...patch, metrics: { ...current.metrics, ...(patch.metrics || {}) } };
    this.emit('update', this.snapshot()); clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.knowledge?.saveFleetMetrics?.(this.snapshot()), 250); this.persistTimer.unref?.();
  }
  setAvailability(availability = {}) {
    const map = { 'claude-code': availability.claude, codex: availability.codex, gemini: availability.gemini, glm: availability.glm,
      'local-qwen': availability.ollama, 'pi-agent-core': true };
    for (const [id, value] of Object.entries(map)) {
      const active = this.models[id].connected;
      this.touch(id, { available: !!value, connected: id === 'pi-agent-core' ? true : active,
        status: value ? (active ? this.models[id].status : 'IDLE') : 'OFFLINE',
        metrics: { apiHealth: value ? (active ? 'active' : 'ready · sleeping') : 'offline' } });
    }
  }
  ingestTask(task = {}) {
    const id = providerId(task.provider || task.metadata?.provider || 'pi-agent-core');
    const terminal = ['completed', 'failed', 'blocked'].includes(task.status);
    if (task.id) this.taskRecords.set(task.id, { modelId: id, input: Number(task.tokens?.input || 0), output: Number(task.tokens?.output || 0),
      saved: Number(task.context?.tokensSaved || 0), files: Number(task.context?.includedFiles?.length || 0), command: task.startedAt ? 1 : 0,
      status: task.status, activeTask: task.promptPreview || task.id, updatedAt: task.updatedAt });
    const records = [...this.taskRecords.values()].filter((row) => row.modelId === id);
    const activeRecords = records.filter((row) => row.status === 'running');
    const active = activeRecords.length > 0;
    const status = active ? 'EXECUTING' : (terminal && ['failed', 'blocked'].includes(task.status) ? 'ERROR' : 'IDLE');
    const promptTokens = records.reduce((sum, row) => sum + row.input, 0), completionTokens = records.reduce((sum, row) => sum + row.output, 0);
    const started = task.startedAt ? new Date(task.startedAt).getTime() : 0;
    const latencyMs = started ? Math.max(0, new Date(task.finishedAt || task.updatedAt || Date.now()).getTime() - started) : 0;
    this.touch(id, { available: true, connected: active, status, activeTask: active ? activeRecords.at(-1)?.activeTask : '',
      metrics: { promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens,
        latencyMs, lastActive: task.updatedAt || new Date().toISOString(), apiHealth: status === 'ERROR' ? 'error' : (active ? 'active' : 'ready · sleeping'),
        filesHandled: records.reduce((sum, row) => sum + row.files, 0), executedCommands: records.reduce((sum, row) => sum + row.command, 0) } });
    if (task.context) {
      const full = Number(task.context.fullContextTokens || 0), pruned = Number(task.context.prunedContextTokens || 0);
      const anyActive = [...this.taskRecords.values()].some((row) => row.status === 'running');
      this.touch('pi-agent-core', { connected: true, status: anyActive ? 'PRUNING' : 'IDLE',
        metrics: { tokensSaved: [...this.taskRecords.values()].reduce((sum, row) => sum + row.saved, 0),
          prunedContextRatio: full ? Math.max(0, Math.min(100, (1 - pruned / full) * 100)) : null,
          filesHandled: [...this.taskRecords.values()].reduce((sum, row) => sum + row.files, 0), lastActive: task.updatedAt } });
    }
  }
  ingestStats(stats = {}) {
    const id = providerId(stats.provider || stats.model || 'pi-agent-core'), turn = stats.turn || {};
    const input = Number(turn.input || 0), output = Number(turn.output || 0), latencyMs = Number(stats.ms || 0);
    this.touch(id, { available: true, connected: true, status: 'THINKING', metrics: { promptTokens: input, completionTokens: output,
      tokensUsed: input + output, latencyMs, lastActive: new Date().toISOString(), tokensPerSecond: latencyMs && output ? output / (latencyMs / 1000) : null, apiHealth: 'healthy' } });
    setTimeout(() => this.touch(id, { connected: false, status: 'IDLE', metrics: { apiHealth: 'ready · sleeping' } }), 1600).unref?.();
  }
  ingestSwarm(event = {}) { this.touch('pi-agent-core', { status: event.phase === 'abort' ? 'IDLE' : 'PRUNING',
    metrics: { tokensSaved: this.models['pi-agent-core'].metrics.tokensSaved + Math.max(0, Number(event.savedTokens || 0)), lastActive: new Date().toISOString() } }); }
  ingestRun(event = {}) { const status = event.status === 'VERIFYING' ? 'EXECUTING' : event.status === 'REPAIRING' ? 'EXECUTING'
    : event.status === 'FAILED' ? 'ERROR' : ['EXECUTING', 'DISPATCHING'].includes(event.status) ? 'EXECUTING' : 'IDLE';
    this.touch('pi-agent-core', { connected: true, status, activeTask: event.promptPreview || event.id || '',
      metrics: { lastActive: new Date().toISOString(), apiHealth: status === 'ERROR' ? 'error' : 'healthy' } }); }
  ingestSync() {}
  ingestVoice() {}
  snapshot() {
    const models = Object.values(this.models).map((model) => ({ ...model, metrics: { ...model.metrics } }));
    return { version: 2, models, connected: models.filter((model) => model.connected).length,
      totals: { tokensUsed: models.reduce((sum, model) => sum + Number(model.metrics.tokensUsed || 0), 0),
        tokensSaved: models.reduce((sum, model) => sum + Number(model.metrics.tokensSaved || 0), 0),
        estimatedCostUsd: null }, updatedAt: Date.now() };
  }
}

module.exports = { ModelStatusStore, MODELS, providerId };
