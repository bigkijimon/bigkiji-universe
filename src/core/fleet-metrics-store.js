'use strict';

const { EventEmitter } = require('events');
const { FLEET_STATUS } = require('./types');

const AGENTS = Object.freeze({
  arch: { id: 'arch', label: 'Arch-Pi', role: 'Architecture & Refactoring' },
  context: { id: 'context', label: 'Context-Pi', role: 'Token & Sandbox Memory' },
  sync: { id: 'sync', label: 'Sync-Pi', role: 'Obsidian / Graphify Sync' },
  voice: { id: 'voice', label: 'Voice-Pi', role: 'TTS & Audio Orchestration' },
  facilitator: { id: 'facilitator', label: 'Facilitator-Pi', role: 'Owner Requirements' },
  lead: { id: 'lead', label: 'Lead-Pi', role: 'Session Leadership' },
  design: { id: 'design', label: 'Design-Pi', role: 'UI / UX Implementation' },
  qa: { id: 'qa', label: 'QA-Pi', role: 'Independent Quality Gate' },
  debug: { id: 'debug', label: 'Debug-Pi', role: 'Diagnostics & Regression' },
  research: { id: 'research', label: 'Research-Pi', role: 'Technical Research' },
  learning: { id: 'learning', label: 'Learning-Pi', role: 'Performance Learning' },
  repair: { id: 'repair', label: 'Repair-Pi', role: 'Self Repair & Rollback' },
  improve: { id: 'improve', label: 'Improve-Pi', role: 'Continuous Improvement' },
});

const AGENT_KEY = Object.freeze({
  'Arch-Pi': 'arch', 'Context-Pi': 'context', 'Sync-Pi': 'sync', 'Voice-Pi': 'voice',
  'Facilitator-Pi': 'facilitator', 'Lead-Pi': 'lead', 'Design-Pi': 'design', 'QA-Pi': 'qa',
  'Debug-Pi': 'debug', 'Research-Pi': 'research', 'Learning-Pi': 'learning', 'Repair-Pi': 'repair', 'Improve-Pi': 'improve',
});

const emptyAgent = (meta) => ({ ...meta, status: FLEET_STATUS.IDLE, promptTokens: 0,
  completionTokens: 0, tokensSaved: 0, durationMs: 0, taskCount: 0, activeTask: '', updatedAt: 0 });

class FleetMetricsStore extends EventEmitter {
  constructor({ knowledge } = {}) {
    super();
    this.knowledge = knowledge;
    this.agents = Object.fromEntries(Object.entries(AGENTS).map(([key, meta]) => [key, emptyAgent(meta)]));
    this.persistTimer = null;
    this.contextRecords = new Map();
  }

  touch(key, update = {}) {
    const current = this.agents[key]; if (!current) return;
    this.agents[key] = { ...current, ...update, updatedAt: Date.now() };
    const snapshot = this.snapshot();
    this.emit('update', snapshot);
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.knowledge?.saveFleetMetrics?.(snapshot), 250);
    this.persistTimer.unref?.();
  }

  ingestTask(task = {}) {
    const running = ['running', 'queued', 'awaiting_approval'].includes(task.status);
    const durationMs = task.startedAt
      ? Math.max(0, new Date(task.finishedAt || task.updatedAt || Date.now()).getTime() - new Date(task.startedAt).getTime()) : 0;
    const key = AGENT_KEY[task.metadata?.agent] || (task.metadata?.role === 'ui' ? 'design'
      : task.metadata?.role === 'debug' ? 'debug' : task.metadata?.role === 'facilitator' ? 'facilitator'
        : task.metadata?.role === 'context' ? 'context' : 'arch');
    const state = task.status === 'failed' || task.status === 'blocked' ? FLEET_STATUS.FAILED
      : task.status === 'completed' ? FLEET_STATUS.COMPLETED : running ? FLEET_STATUS.EXECUTING : FLEET_STATUS.IDLE;
    this.touch(key, {
      status: state,
      activeTask: running ? (task.promptPreview || task.id || '') : '', durationMs,
      promptTokens: Number(task.tokens?.input) || 0, completionTokens: Number(task.tokens?.output) || 0,
      taskCount: this.agents[key].taskCount + (task.status === 'completed' ? 1 : 0),
    });
    if (task.id && task.context) {
      this.contextRecords.set(task.id, {
        saved: Math.max(0, Number(task.context.tokensSaved) || 0),
        prompt: Math.max(0, Number(task.context.prunedContextTokens) || 0),
        completion: Math.max(0, Number(task.tokens?.output) || 0),
      });
      const records = [...this.contextRecords.values()];
      this.touch('context', { status: running ? FLEET_STATUS.ORCHESTRATING : FLEET_STATUS.IDLE,
        tokensSaved: records.reduce((sum, row) => sum + row.saved, 0),
        promptTokens: records.reduce((sum, row) => sum + row.prompt, 0),
        completionTokens: records.reduce((sum, row) => sum + row.completion, 0),
        activeTask: running ? `${task.context.includedFiles?.length || 0} relevant files` : '' });
    }
  }

  ingestRun(event = {}) {
    const status = String(event.status || 'IDLE');
    const mapped = status === 'REPAIRING' ? FLEET_STATUS.REPAIRING : status === 'VERIFYING' ? FLEET_STATUS.VERIFYING
      : status === 'FAILED' ? FLEET_STATUS.FAILED : status === 'COMPLETED' ? FLEET_STATUS.COMPLETED : FLEET_STATUS.EXECUTING;
    this.touch(status === 'REPAIRING' ? 'repair' : status === 'VERIFYING' ? 'qa' : 'lead', {
      status: mapped, activeTask: event.promptPreview || event.id || '', durationMs: event.startedAt
        ? Math.max(0, Date.now() - new Date(event.startedAt).getTime()) : 0,
    });
    if (status === 'COMPLETED' || status === 'FAILED') {
      this.touch('learning', { status: FLEET_STATUS.ORCHESTRATING, activeTask: `Learning from ${event.id || 'run'}`,
        taskCount: this.agents.learning.taskCount + 1 });
      setTimeout(() => this.touch('learning', { status: FLEET_STATUS.IDLE, activeTask: '' }), 1800).unref?.();
    }
  }

  ingestStats(stats = {}) {
    const turn = stats.turn || {};
    this.touch('context', { status: FLEET_STATUS.ORCHESTRATING,
      promptTokens: Number(turn.input) || 0, completionTokens: Number(turn.output) || 0,
      durationMs: Number(stats.ms) || 0, activeTask: stats.provider || 'Pi context pass' });
    setTimeout(() => this.touch('context', { status: FLEET_STATUS.IDLE, activeTask: '' }), 1600).unref?.();
  }

  ingestSwarm(event = {}) {
    const bypass = event.phase === 'abort' || event.mode === 'bypass';
    this.touch('context', { status: bypass ? FLEET_STATUS.BYPASSED_QWEN_TIMEOUT : FLEET_STATUS.ORCHESTRATING,
      tokensSaved: this.agents.context.tokensSaved + Math.max(0, Number(event.savedTokens) || 0),
      activeTask: event.mode === 'cache' ? 'Reusing local playbook' : 'Local preflight' });
  }

  ingestSync(event = {}) {
    this.touch('sync', { status: FLEET_STATUS.EXECUTING, activeTask: String(event.path || event.text || 'Vault sync').slice(0, 120),
      durationMs: Number(event.ms) || 0, taskCount: this.agents.sync.taskCount + 1 });
    setTimeout(() => this.touch('sync', { status: FLEET_STATUS.IDLE, activeTask: '' }), 1800).unref?.();
  }

  ingestVoice(event = {}) {
    const state = String(event.state || '').toUpperCase();
    this.touch('voice', { status: ['CAPTURE', 'SPEAK', 'LISTEN'].includes(state) ? FLEET_STATUS.EXECUTING : FLEET_STATUS.IDLE,
      activeTask: state ? `Voice ${state.toLowerCase()}` : '', taskCount: this.agents.voice.taskCount + (state === 'SPEAK' ? 1 : 0) });
  }

  snapshot() {
    const agents = Object.values(this.agents).map((agent) => ({ ...agent }));
    return { version: 1, agents, totals: {
      promptTokens: agents.reduce((sum, agent) => sum + agent.promptTokens, 0),
      completionTokens: agents.reduce((sum, agent) => sum + agent.completionTokens, 0),
      tokensSaved: agents.reduce((sum, agent) => sum + agent.tokensSaved, 0),
      durationMs: agents.reduce((sum, agent) => sum + agent.durationMs, 0),
    }, updatedAt: Date.now() };
  }
}

module.exports = { FleetMetricsStore, AGENTS };
