'use strict';

const fs = require('fs');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');
const { THROTTLED } = require('./circuit-breaker');

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

const VERSION = 2;

function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

class ModelCapabilityRegistry {
  constructor({ root = knowledge.ROOT } = {}) {
    this.root = root; this.capabilityFile = path.join(root, 'model_capabilities.json'); this.performanceFile = path.join(root, 'model_performance.json');
    this.capabilities = read(this.capabilityFile, { version: VERSION, models: {} });
    this.performance = read(this.performanceFile, { version: VERSION, models: {} }); this.migrate(); this.seed();
  }

  // One-time repair of data written before 2026-08-02.
  //
  // Until then a task that was blocked — by sandbox policy, by a missing credential, or
  // by the owner aborting it — was handed to record() as a provider failure with no
  // duration. This file could therefore only hold rows describing runs that never
  // happened: 207 samples across six providers, zero successes, zero latency, and
  // penalties sitting at or near the cap. The router was choosing between numbers that
  // measured nothing.
  //
  // Rows carrying that exact signature are dropped rather than kept. A seeded prior is a
  // better estimate than a fabricated observation, and leaving the penalties in place
  // would let the old bug keep steering routing long after it was fixed.
  migrate() {
    if (Number(this.performance.version || 1) >= VERSION) return;
    const poisoned = Object.entries(this.performance.models)
      .filter(([, row]) => Number(row.samples || 0) > 0 && !Number(row.successes || 0) && !Number(row.ewmaLatencyMs || 0))
      .map(([id]) => id);
    for (const id of poisoned) delete this.performance.models[id];
    this.performance.version = VERSION;
    if (poisoned.length) {
      for (const entry of Object.values(this.capabilities.models)) {
        delete entry.penalties; delete entry.streaks; delete entry.penaltyUpdatedAt;
      }
      this.capabilities.version = VERSION;
      atomic(this.capabilityFile, this.capabilities);
    }
    atomic(this.performanceFile, this.performance);
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
    // An unmeasured latency is not a fast one. Reading a missing duration as 0ms handed
    // the full speed bonus to assignments that never started, so the providers that
    // failed earliest scored best on speed. Unknown stays neutral until something is
    // actually timed.
    const latency = Number(perf.latencySamples || 0)
      ? Math.max(0, 1 - Number(perf.ewmaLatencyMs || 0) / 120000) : .5;
    return Math.max(0, prior * .55 + Number(perf.successRate || 0) * .3 + latency * .15 - penalty);
  }
  choose(role, candidates) { return [...candidates].sort((a, b) => this.score(b, role) - this.score(a, role))[0] || null; }

  // `reason` is how the failure is classified — see model-router.classifyFailure.
  // 'rate-limit' and 'quota' are recorded but not scored: being throttled is a
  // fact about the calendar, not about the provider, and the two must not be
  // conflated. The penalty this registry writes survives the outage, so a
  // provider that was merely busy for an afternoon would carry the mark for
  // every routing decision afterwards — the same shape of bug as the 207
  // samples with zero successes that the migration above cleans up, arriving by
  // a different road.
  record({ provider, role, ok, durationMs = 0, tokens = {}, model = '', reason = '' } = {}) {
    if (!provider) return;
    if (!ok && THROTTLED.has(reason)) return this._throttled({ provider, role, model, reason });
    for (const id of [...new Set([provider, ModelCapabilityRegistry.key(provider, model)])]) {
      const row = this.performance.models[id] || { samples: 0, successes: 0, failures: 0, ewmaLatencyMs: 0, roles: {} };
      row.provider = provider; if (model) row.model = model;
      row.samples += 1; ok ? row.successes += 1 : row.failures += 1; row.successRate = row.successes / row.samples;
      // Only a measured duration says anything about speed. A task that died before it
      // started has a duration of zero, and averaging that in is how a provider that
      // never ran came to look like the fastest one available.
      if (durationMs > 0) {
        row.latencySamples = Number(row.latencySamples || 0) + 1;
        row.ewmaLatencyMs = row.latencySamples === 1 ? durationMs : row.ewmaLatencyMs * .7 + durationMs * .3;
      }
      const roleRow = row.roles[role || 'general'] || { samples: 0, successes: 0 }; roleRow.samples += 1; if (ok) roleRow.successes += 1;
      roleRow.successRate = roleRow.successes / roleRow.samples; row.roles[role || 'general'] = roleRow;
      row.lastTokens = { input: Number(tokens.input || 0), output: Number(tokens.output || 0) }; row.updatedAt = new Date().toISOString();
      this.performance.models[id] = row;
    }
    atomic(this.performanceFile, this.performance);
    return this.learn({ provider, role, model, durationMs, ok });
  }

  // A throttled attempt is counted, so the owner can see how often it happens,
  // but it touches neither `samples` nor `successRate` nor any penalty. It is
  // not evidence either way about whether this provider does the job well.
  _throttled({ provider, role = 'general', model = '', reason = '' }) {
    for (const id of [...new Set([provider, ModelCapabilityRegistry.key(provider, model)])]) {
      const row = this.performance.models[id] || { samples: 0, successes: 0, failures: 0, ewmaLatencyMs: 0, roles: {} };
      row.provider = provider; if (model) row.model = model;
      row.throttled = Number(row.throttled || 0) + 1;
      row.throttledAt = new Date().toISOString();
      row.throttledReason = reason;
      this.performance.models[id] = row;
    }
    atomic(this.performanceFile, this.performance);
    return { provider, model, role, throttled: true, reason,
      note: reason === 'quota' ? 'quota exhausted — not scored' : 'rate limited — not scored' };
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
