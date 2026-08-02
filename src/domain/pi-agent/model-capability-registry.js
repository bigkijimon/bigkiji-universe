'use strict';

const fs = require('fs');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');

const SOURCES = Object.freeze({
  'claude-code': 'https://docs.anthropic.com/en/docs/claude-code/cli-usage',
  codex: 'https://developers.openai.com/codex/use-cases',
  gemini: 'https://developers.google.com/gemini-code-assist/docs/gemini-cli',
  glm: 'https://docs.z.ai/guides/overview/overview',
  qwen: 'local://ollama/qwen3.5',
});
const SEED = Object.freeze({
  'claude-code': { roles: { leader: 1, system: 1, repair: .92, ui: .65, debug: .9 } },
  codex: { roles: { ui: 1, qa: .95, system: .86, debug: .92, leader: .78 } },
  gemini: { roles: { facilitator: 1, research: 1, qa: .84, ui: .82, leader: .74 } },
  glm: { roles: { debug: 1, system: .88, repair: .85, research: .76, ui: .68 } },
  qwen: { roles: { context: 1, learning: 1, research: .62, debug: .58 } },
});

function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

class ModelCapabilityRegistry {
  constructor({ root = knowledge.ROOT } = {}) {
    this.root = root; this.capabilityFile = path.join(root, 'model_capabilities.json'); this.performanceFile = path.join(root, 'model_performance.json');
    this.capabilities = read(this.capabilityFile, { version: 1, models: {} });
    this.performance = read(this.performanceFile, { version: 1, models: {} }); this.seed();
  }
  seed() {
    for (const [provider, data] of Object.entries(SEED)) this.capabilities.models[provider] ||= {
      ...data, source: SOURCES[provider], sourceType: provider === 'qwen' ? 'local' : 'official', retrievedAt: '2026-08-01', confidence: .8,
    };
    atomic(this.capabilityFile, this.capabilities); atomic(this.performanceFile, this.performance);
  }
  // Performance is recorded per (provider, model), because "claude-code was slow" is
  // not a fact about Claude Code — it is a fact about the tier that ran. Priors stay
  // per provider; only observations are split.
  static key(provider, model = '') { return model ? `${provider}::${model}` : String(provider || ''); }

  score(provider, role, model = '') {
    const prior = Number(this.capabilities.models[provider]?.roles?.[role] || .35);
    // Penalties are keyed by (provider, model, role) and by (provider, role). choose()
    // runs before the model tier is picked, so it can only consult the provider-level
    // key — but the per-model key is what an assignment carrying a model is judged on,
    // and the provider key carries the worst of its tiers so a bad tier is still felt.
    const penalties = this.capabilities.models[provider]?.penalties || {};
    const penalty = Number(penalties[model ? `${model}::${role}` : role] || penalties[role] || 0);
    const perf = this.performance.models[ModelCapabilityRegistry.key(provider, model)] || this.performance.models[provider];
    if (!perf?.samples) return Math.max(0, prior - penalty);
    return Math.max(0, prior * .55 + Number(perf.successRate || 0) * .3
      + Math.max(0, 1 - Number(perf.ewmaLatencyMs || 30000) / 120000) * .15 - penalty);
  }
  choose(role, candidates) { return [...candidates].sort((a, b) => this.score(b, role) - this.score(a, role))[0] || null; }

  record({ provider, role, ok, durationMs = 0, tokens = {}, model = '' } = {}) {
    if (!provider) return;
    for (const id of [...new Set([provider, ModelCapabilityRegistry.key(provider, model)])]) {
      const row = this.performance.models[id] || { samples: 0, successes: 0, failures: 0, ewmaLatencyMs: 0, roles: {} };
      row.provider = provider; if (model) row.model = model;
      row.samples += 1; ok ? row.successes += 1 : row.failures += 1; row.successRate = row.successes / row.samples;
      row.ewmaLatencyMs = row.samples === 1 ? durationMs : row.ewmaLatencyMs * .7 + durationMs * .3;
      const roleRow = row.roles[role || 'general'] || { samples: 0, successes: 0 }; roleRow.samples += 1; if (ok) roleRow.successes += 1;
      roleRow.successRate = roleRow.successes / roleRow.samples; row.roles[role || 'general'] = roleRow;
      row.lastTokens = { input: Number(tokens.input || 0), output: Number(tokens.output || 0) }; row.updatedAt = new Date().toISOString();
      this.performance.models[id] = row;
    }
    atomic(this.performanceFile, this.performance);
    return this.learn({ provider, role, model, durationMs, ok });
  }

  // The owner's rule: when a delegated agent is slow, teach PiAgent then and there
  // rather than re-picking it next time. A penalty is written into the capability file
  // — the same file the priors live in — so the next choose() routes around it.
  //
  // Recovery needs a streak, not one good run. A single fast success undoing a penalty
  // makes a provider that alternates fast and slow look healthy on every other sample.
  learn({ provider, role = 'general', model = '', durationMs = 0, ok = true, slowMs = Number(process.env.BIGKIJI_SLOW_TASK_MS || 180000),
    recoveryStreak = 2 } = {}) {
    const entry = this.capabilities.models[provider]; if (!entry) return null;
    entry.penalties ||= {}; entry.streaks ||= {};
    const slow = durationMs > slowMs;
    // Both keys move together: choose() can only see the provider-level one, but an
    // assignment that carries a model is scored on the specific tier that ran.
    const keys = model ? [role, `${model}::${role}`] : [role];
    const before = Number(entry.penalties[role] || 0);
    if (slow || !ok) {
      entry.streaks[role] = 0;
    } else {
      entry.streaks[role] = Number(entry.streaks[role] || 0) + 1;
      if (entry.streaks[role] < recoveryStreak) return null;
      entry.streaks[role] = 0;
    }
    let after = before;
    for (const key of keys) {
      const current = Number(entry.penalties[key] || 0);
      const next = slow || !ok ? Math.min(.45, current + (slow && !ok ? .12 : .06)) : Math.max(0, current - .04);
      entry.penalties[key] = Number(next.toFixed(3));
      if (key === role) after = entry.penalties[key];
    }
    if (after === before) return null;
    entry.penaltyUpdatedAt = new Date().toISOString();
    atomic(this.capabilityFile, this.capabilities);
    return { provider, model, role, penalty: after, previous: before, durationMs, slow, ok,
      reason: slow ? `exceeded ${slowMs}ms` : (ok ? 'recovered' : 'assignment failed') };
  }
  needsResearch(provider, maxAgeDays = 30) {
    const item = this.capabilities.models[provider]; if (!item?.source || item.sourceType !== 'official') return provider !== 'qwen';
    return Date.now() - new Date(item.retrievedAt).getTime() > maxAgeDays * 86400000;
  }
  snapshot() { return { capabilities: this.capabilities, performance: this.performance }; }
}

module.exports = { ModelCapabilityRegistry, SOURCES, SEED };
