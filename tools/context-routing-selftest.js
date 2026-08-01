'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SandboxPolicyResolver } = require('../src/domain/pi-agent/sandbox-policy');
const { ContextPruner, estimateTokens } = require('../src/domain/pi-agent/context-pruner');
const { LocalQwenGuardrails } = require('../src/domain/pi-agent/local-qwen-guardrails');
const { buildSystemMemory } = require('../src/domain/pi-core/system-memory');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { FleetMetricsStore } = require('../src/core/fleet-metrics-store');
const { createPathConfig } = require('../src/core/path-config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-context-'));
const project = path.join(tmp, 'project'); fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({
  filesystem: { allowRead: [project], allowWrite: [project] }, models: { allowPaid: ['claude', 'codex', 'gemini', 'glm'] },
}));
fs.writeFileSync(path.join(project, 'target.js'), 'function tokenSavings(full, pruned) { return Math.max(0, full - pruned); }\n');
fs.writeFileSync(path.join(project, 'unrelated.md'), 'A long unrelated document. '.repeat(100));
fs.writeFileSync(path.join(project, '.env'), 'SECRET=never-send');

const resolver = new SandboxPolicyResolver({ vaultRoot: tmp });
const policy = resolver.resolve(project); assert(policy.valid); resolver.assertProvider(policy, 'codex');
assert.throws(() => resolver.assertProvider(policy, 'kimi'), /blocked/);
assert(resolver.resolve(os.homedir()).localOnly);
const pruned = new ContextPruner().prepare({ prompt: 'Fix tokenSavings in target.js', policy });
assert(pruned.metrics.includedFiles.includes('project/target.js'));
assert(!pruned.prompt.includes('never-send'));
assert.strictEqual(pruned.metrics.tokensSaved, Math.max(0, pruned.metrics.fullContextTokens - pruned.metrics.prunedContextTokens));
assert(estimateTokens('hello') > 0);
const localPruned = new ContextPruner({ maxTokens: 8192 }).prepare({ prompt: 'Fix tokenSavings in target.js', policy, maxTokens: 4096 });
assert(localPruned.metrics.prunedContextTokens <= 4096); assert.strictEqual(localPruned.metrics.contextTokenLimit, 4096);
const guardrails = new LocalQwenGuardrails({ fetchImpl: async () => ({ ok: true }), taskTimeoutMs: 60000 });
assert.strictEqual(guardrails.budget(), 6144); assert(guardrails.chunk('One task.\n\nTwo task.').length >= 1);
guardrails.degraded = true; assert.strictEqual(guardrails.budget(), 4096);
const memory = buildSystemMemory({ appRoot: project }); assert.strictEqual(memory.policies.localQwen.hardContextTokens, 8192);
assert(!JSON.stringify(memory).includes('never-send'));

const runner = new TaskRunner({ cwd: project, vaultRoot: tmp });
assert(runner.microTasks('Inspect target.js.\n\nReturn evidence.').length >= 1);
const codexArgs = runner.adapter('codex', 'prompt', project, policy).args;
assert.deepStrictEqual(codexArgs.slice(0, 2), ['exec', '--json']);
assert(codexArgs.includes('--skip-git-repo-check'));
assert(codexArgs.includes('--sandbox'));
assert.match(runner.adapter('gemini', 'prompt', project, policy).command, /gemini/);
const fleet = new FleetMetricsStore();
fleet.ingestTask({ id: 'task-1', status: 'running', context: pruned.metrics, tokens: { output: 7 }, updatedAt: new Date().toISOString() });
assert.strictEqual(fleet.snapshot().totals.tokensSaved, pruned.metrics.tokensSaved);

const paths = createPathConfig({ appRoot: project, userData: path.join(tmp, 'data'), env: { BIGKIJI_VAULT_ROOT: project } });
assert.strictEqual(paths.vaultRoot, project);
const commandPaths = createPathConfig({ appRoot: project, userData: path.join(tmp, 'data'), env: { BIGKIJI_VAULT_ROOT: project, CMUX_BIN: 'cmux', PI_BIN: 'pi' } });
assert.strictEqual(commandPaths.cmuxBin, 'cmux'); assert.strictEqual(commandPaths.piBin, 'pi');
const portablePaths = createPathConfig({ appRoot: project, userData: path.join(tmp, 'data'), env: {
  APP_ROOT: project, UI_ROOT: path.join(project, 'ui'), KNOWLEDGE_ROOT: path.join(project, 'knowledge'), BIGKIJI_VAULT_ROOT: project,
} });
assert.strictEqual(portablePaths.appRoot, project); assert.strictEqual(portablePaths.uiRoot, path.join(project, 'ui'));
assert.strictEqual(portablePaths.knowledgeRoot, path.join(project, 'knowledge'));
console.log('sandbox/context routing selftest: PASS');
