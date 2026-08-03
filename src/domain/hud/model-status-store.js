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
  piAgent: '', instruction: '',
  metrics: { promptTokens: 0, completionTokens: 0, tokensUsed: 0, tokensSaved: 0, latencyMs: 0,
    lastActive: '', estimatedCostUsd: null, prunedContextRatio: null, filesHandled: 0, executedCommands: 0,
    tokensPerSecond: null, vramUsage: null, apiHealth: 'unknown' } });

class ModelStatusStore extends EventEmitter {
  constructor({ knowledge, piAgentName = '' } = {}) {
    super(); this.knowledge = knowledge; this.models = Object.fromEntries(Object.values(MODELS).map((meta) => [meta.id, initial(meta)]));
    this.taskRecords = new Map(); this.persistTimer = null; this.swarmSaved = 0;
    if (piAgentName) this.setPiAgentName(piAgentName);
  }
  // The owner names their PiAgent in Settings; this store is the single source the
  // fleet HUD, the tray card and completion reports all read from.
  setPiAgentName(name) {
    const clean = String(name || '').trim().slice(0, 32);
    if (!clean) return;
    this.models['pi-agent-core'] = { ...this.models['pi-agent-core'], displayName: clean };
    this.emit('update', this.snapshot());
  }
  // Pi↔model bridge: context-pruner savings belong to the model that received the instruction.
  _savedFor(id) {
    return [...this.taskRecords.values()].filter((row) => row.modelId === id).reduce((sum, row) => sum + row.saved, 0)
      + (id === 'pi-agent-core' ? this.swarmSaved : 0);
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
  /**
   * Keep the task records the fleet numbers are computed from, and no more.
   *
   * This map had no delete: it held one row per task for the life of the process,
   * and every fleet number is a walk of it. Running work is never dropped, because
   * the numbers it feeds are the live ones.
   */
  forgetOldRecords(keep = 400) {
    if (this.taskRecords.size <= keep) return;
    const finished = [...this.taskRecords.entries()]
      .filter(([, row]) => row.status !== 'running')
      .sort((a, b) => String(a[1].updatedAt || '').localeCompare(String(b[1].updatedAt || '')));
    for (const [id] of finished.slice(0, Math.max(0, this.taskRecords.size - keep))) this.taskRecords.delete(id);
  }

  ingestTask(task = {}) {
    const id = providerId(task.provider || task.metadata?.provider || 'pi-agent-core');
    const terminal = ['completed', 'failed', 'blocked'].includes(task.status);
    // A plan is not a measurement.
    //
    // Two assignments awaiting approval each scanned the same vault and each booked
    // its estimate as a saving, so the fleet reported 11.56M tokens saved by work
    // that had not started and might never be approved. Only what actually ran, and
    // only what was actually measured, is counted: `measurement:'actual'` is set by
    // captureUsage from the provider's own usage report.
    const measured = task.context?.measurement === 'actual';
    if (task.id) this.taskRecords.set(task.id, { modelId: id, input: Number(task.tokens?.input || 0), output: Number(task.tokens?.output || 0),
      saved: measured ? Number(task.context?.tokensSaved || 0) : 0, files: Number(task.context?.includedFiles?.length || 0), command: task.startedAt ? 1 : 0,
      status: task.status, activeTask: task.promptPreview || task.id,
      piAgent: task.metadata?.agent || '', instruction: String(task.promptPreview || '').slice(0, 80), updatedAt: task.updatedAt });
    // One pass, not five.
    //
    // This filtered the whole record map and then reduced over the result four
    // separate times, on every task event — five walks of a map that never shrinks,
    // for every state change of every task. Over a long session that is quadratic in
    // the number of tasks, and this store is touched more often than anything else
    // in the daemon.
    let active = false; let live = null; let last = null;
    let promptTokens = 0; let completionTokens = 0; let filesHandled = 0; let executedCommands = 0;
    let anyActive = false; let allFiles = 0; let savedForCore = 0; let savedForId = 0;
    for (const row of this.taskRecords.values()) {
      if (row.status === 'running') anyActive = true;
      allFiles += row.files;
      if (row.modelId === 'pi-agent-core') savedForCore += row.saved;
      if (row.modelId !== id) continue;
      last = row;
      promptTokens += row.input; completionTokens += row.output;
      filesHandled += row.files; executedCommands += row.command; savedForId += row.saved;
      if (row.status === 'running') { active = true; live = row; }
    }
    const status = active ? 'EXECUTING' : (terminal && ['failed', 'blocked'].includes(task.status) ? 'ERROR' : 'IDLE');
    if (terminal) this.forgetOldRecords();
    const started = task.startedAt ? new Date(task.startedAt).getTime() : 0;
    const latencyMs = started ? Math.max(0, new Date(task.finishedAt || task.updatedAt || Date.now()).getTime() - started) : 0;
    this.touch(id, { available: true, connected: active, status, activeTask: active ? live?.activeTask : '',
      piAgent: (live || last)?.piAgent || this.models[id].piAgent || '',
      instruction: active ? (live?.instruction || '') : '',
      metrics: { promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens, tokensSaved: savedForId + (id === 'pi-agent-core' ? this.swarmSaved : 0),
        latencyMs, lastActive: task.updatedAt || new Date().toISOString(), apiHealth: status === 'ERROR' ? 'error' : (active ? 'active' : 'ready · sleeping'),
        filesHandled, executedCommands } });
    if (task.context) {
      const full = Number(task.context.fullContextTokens || 0), pruned = Number(task.context.prunedContextTokens || 0);
      // anyActive came from the same single pass above.
      this.touch('pi-agent-core', { connected: true, status: anyActive ? 'PRUNING' : 'IDLE',
        metrics: { tokensSaved: savedForCore + this.swarmSaved,
          prunedContextRatio: full ? Math.max(0, Math.min(100, (1 - pruned / full) * 100)) : null,
          filesHandled: allFiles, lastActive: task.updatedAt } });
    }
  }
  ingestStats(stats = {}) {
    const id = providerId(stats.provider || stats.model || 'pi-agent-core'), turn = stats.turn || {};
    const input = Number(turn.input || 0), output = Number(turn.output || 0), latencyMs = Number(stats.ms || 0);
    this.touch(id, { available: true, connected: true, status: 'THINKING', metrics: { promptTokens: input, completionTokens: output,
      tokensUsed: input + output, latencyMs, lastActive: new Date().toISOString(), tokensPerSecond: latencyMs && output ? output / (latencyMs / 1000) : null, apiHealth: 'healthy' } });
    setTimeout(() => this.touch(id, { connected: false, status: 'IDLE', metrics: { apiHealth: 'ready · sleeping' } }), 1600).unref?.();
  }
  ingestSwarm(event = {}) {
    this.swarmSaved += Math.max(0, Number(event.savedTokens || 0));
    this.touch('pi-agent-core', { status: event.phase === 'abort' ? 'IDLE' : 'PRUNING',
      metrics: { tokensSaved: this._savedFor('pi-agent-core'), lastActive: new Date().toISOString() } });
  }
  ingestRun(event = {}) { const status = event.status === 'VERIFYING' ? 'EXECUTING' : event.status === 'REPAIRING' ? 'EXECUTING'
    : event.status === 'FAILED' ? 'ERROR' : ['EXECUTING', 'DISPATCHING'].includes(event.status) ? 'EXECUTING' : 'IDLE';
    this.touch('pi-agent-core', { connected: true, status, activeTask: event.promptPreview || event.id || '',
      metrics: { lastActive: new Date().toISOString(), apiHealth: status === 'ERROR' ? 'error' : 'healthy' } }); }
  ingestSync() {}
  ingestVoice() {}
  ingestQwenHealth(health = {}) {
    this.touch('local-qwen', { available: true, connected: Number(health.active || 0) > 0,
      status: Number(health.active || 0) > 0 ? 'EXECUTING' : 'IDLE',
      metrics: { latencyMs: Number(health.durationMs || 0), apiHealth: health.degraded ? 'degraded · PiAgent resetting' : 'managed by PiAgent',
        contextTokenLimit: Number(health.contextTokens || 0), lastResetReason: health.resetReason || '', lastActive: new Date().toISOString() } });
  }
  snapshot() {
    const models = Object.values(this.models).map((model) => ({ ...model, metrics: { ...model.metrics } }));
    return { version: 2, models, connected: models.filter((model) => model.connected).length,
      totals: { tokensUsed: models.reduce((sum, model) => sum + Number(model.metrics.tokensUsed || 0), 0),
        tokensSaved: models.reduce((sum, model) => sum + Number(model.metrics.tokensSaved || 0), 0),
        estimatedCostUsd: null }, updatedAt: Date.now() };
  }
}

module.exports = { ModelStatusStore, MODELS, providerId };
