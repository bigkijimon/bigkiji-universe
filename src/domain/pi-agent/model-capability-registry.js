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
  score(provider, role) {
    const prior = Number(this.capabilities.models[provider]?.roles?.[role] || .35);
    const perf = this.performance.models[provider]; if (!perf?.samples) return prior;
    return prior * .55 + Number(perf.successRate || 0) * .3 + Math.max(0, 1 - Number(perf.ewmaLatencyMs || 30000) / 120000) * .15;
  }
  choose(role, candidates) { return [...candidates].sort((a, b) => this.score(b, role) - this.score(a, role))[0] || null; }
  record({ provider, role, ok, durationMs = 0, tokens = {} } = {}) {
    if (!provider) return;
    const row = this.performance.models[provider] || { samples: 0, successes: 0, failures: 0, ewmaLatencyMs: 0, roles: {} };
    row.samples += 1; ok ? row.successes += 1 : row.failures += 1; row.successRate = row.successes / row.samples;
    row.ewmaLatencyMs = row.samples === 1 ? durationMs : row.ewmaLatencyMs * .7 + durationMs * .3;
    const roleRow = row.roles[role || 'general'] || { samples: 0, successes: 0 }; roleRow.samples += 1; if (ok) roleRow.successes += 1;
    roleRow.successRate = roleRow.successes / roleRow.samples; row.roles[role || 'general'] = roleRow;
    row.lastTokens = { input: Number(tokens.input || 0), output: Number(tokens.output || 0) }; row.updatedAt = new Date().toISOString();
    this.performance.models[provider] = row; atomic(this.performanceFile, this.performance);
  }
  needsResearch(provider, maxAgeDays = 30) {
    const item = this.capabilities.models[provider]; if (!item?.source || item.sourceType !== 'official') return provider !== 'qwen';
    return Date.now() - new Date(item.retrievedAt).getTime() > maxAgeDays * 86400000;
  }
  snapshot() { return { capabilities: this.capabilities, performance: this.performance }; }
}

module.exports = { ModelCapabilityRegistry, SOURCES, SEED };
