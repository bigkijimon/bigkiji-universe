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
// `includedFiles` holds paths relative to the vault root, in the platform's own
// separator (ContextPruner uses path.relative). Hardcoding a forward slash here
// made this check pass on macOS and fail on Windows for eight days.
assert(pruned.metrics.includedFiles.includes(path.join('project', 'target.js')));
assert(!pruned.prompt.includes('never-send'));
// This asserted full - pruned, which is what produced `saved 5,774,005` from the
// owner typing hello: fullContextTokens is every file the scan touched, and nothing
// was ever going to send the vault. The saving is what was scored as relevant and
// then left out — real work, honestly measured (2026-08-03).
assert.strictEqual(pruned.metrics.tokensSaved,
  Math.max(0, pruned.metrics.candidateContextTokens - pruned.metrics.prunedContextTokens));
assert(pruned.metrics.candidateContextTokens <= pruned.metrics.fullContextTokens,
  'the candidates are a subset of what was scanned');
{
  // A prompt that matches nothing saves nothing, however large the vault is.
  const idle = new ContextPruner().prepare({ prompt: 'hello', policy });
  assert.strictEqual(idle.metrics.tokensSaved, 0, 'scanning is not saving');
  assert(idle.metrics.fullContextTokens > 100, 'even though the scan really did walk the whole sandbox');
}
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
// ---- V2.5 data-root contract ------------------------------------------------
// Regression guard for the defect this replaced: path-config used to hardcode one
// person's Obsidian vault as a default, so every fresh install inherited it.
const pathConfigSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'path-config.js'), 'utf8');
assert.doesNotMatch(pathConfigSource, /CEOBigKiji/, 'path-config must not hardcode a personal vault path');
assert.doesNotMatch(pathConfigSource, /homedir\(\)[^)]*,\s*'\.bigkiji'/, 'path-config must not fall back to the pre-2.5 ~/.bigkiji layout');

// The app directory name must equal package.json "name" on every platform.
// Electron derives app.getPath('userData') from that field; the daemon derives its own
// paths from defaultUserData(). The 2.5 rename left this one word behind, so the app
// wrote settings to <userData>/bku/ while the daemon kept reading bigkiji-universe/ —
// the owner changed the leader for four days and nothing ever moved. Machine guard, not
// a comment, because a comment is exactly what failed here.
const dataRootDirs = require('../src/core/data-root');
const appName = require('../package.json').name;
const homeForName = path.resolve(path.sep, 'home', 'someone');
for (const [platform, env] of [['darwin', {}], ['win32', { APPDATA: path.resolve(path.sep, 'roaming') }], ['linux', {}]]) {
  assert.strictEqual(path.basename(dataRootDirs.defaultUserData(platform, env, homeForName)), appName,
    `defaultUserData() on ${platform} must end in package.json "name" (${appName})`);
}

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-home-'));
// A directory shaped like the old default must NOT win automatically...
fs.mkdirSync(path.join(fakeHome, 'Documents', 'CEOBigKiji'), { recursive: true });
const clean = createPathConfig({ appRoot: project, userData: path.join(fakeHome, 'ud'), env: {}, home: fakeHome });
assert.notStrictEqual(clean.vaultRoot, path.join(fakeHome, 'Documents', 'CEOBigKiji'),
  'a folder named CEOBigKiji must not be selected as a vault without .obsidian');
assert.strictEqual(clean.dataRoot, path.join(fakeHome, 'BigKijiUniverse'), 'default data root must be owner-independent');
assert.strictEqual(clean.knowledgeRoot, path.join(clean.dataRoot, 'knowledge'), 'knowledge lives under the data root');
assert.strictEqual(clean.sessionsRoot, path.join(clean.dataRoot, 'sessions'));
assert.strictEqual(clean.reportsRoot, path.join(clean.dataRoot, 'reports'));

// ...but any directory containing .obsidian is detected generically, for anyone.
fs.mkdirSync(path.join(fakeHome, 'Documents', 'MyNotes', '.obsidian'), { recursive: true });
const detected = createPathConfig({ appRoot: project, userData: path.join(fakeHome, 'ud'), env: {}, home: fakeHome });
assert.strictEqual(detected.vaultRoot, path.join(fakeHome, 'Documents', 'MyNotes'), 'vault detection must be generic');

// The three path fields in the settings window have to reach the resolver.
//
// createPathConfig has read `saved` since it was written, and the daemon called it
// WITHOUT saved (server/daemon.js) — so BigKiji Vault, Knowledge cache and graph.json
// were owner-editable fields whose value was discarded on every resolve. It looked
// harmless only because all three are empty on this machine.
const savedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-saved-'));
const savedVault = path.join(savedHome, 'ChosenVault');
fs.mkdirSync(path.join(savedVault, '.obsidian'), { recursive: true });
const withSaved = createPathConfig({ appRoot: project, userData: path.join(savedHome, 'ud'), env: {}, home: savedHome,
  saved: { vaultRoot: savedVault, knowledgeRoot: path.join(savedHome, 'kb'), graphifyGraphPath: path.join(savedHome, 'g.json') } });
assert.strictEqual(withSaved.vaultRoot, savedVault, 'the owner’s vault path must win over detection');
assert.strictEqual(withSaved.knowledgeRoot, path.join(savedHome, 'kb'));
assert.strictEqual(withSaved.graphPath, path.join(savedHome, 'g.json'));
// ...and the daemon has to be the caller that passes them, which is where it was missed.
const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
assert.match(daemonSource, /createPathConfig\(\{[^}]*saved:/,
  'the daemon must pass the owner’s saved paths into createPathConfig');

// BIGKIJI_DATA_ROOT is the contract between the app and its child processes.
const forced = createPathConfig({ appRoot: project, userData: path.join(fakeHome, 'ud'),
  env: { BIGKIJI_DATA_ROOT: path.join(fakeHome, 'elsewhere') }, home: fakeHome });
assert.strictEqual(forced.dataRoot, path.join(fakeHome, 'elsewhere'));
assert.strictEqual(forced.dataRootSource, 'env');

// The pointer written by the setup wizard is honoured on the next launch.
const dataRootModule = require('../src/core/data-root');
const ud = path.join(fakeHome, 'ud2');
dataRootModule.writePointer(ud, { dataRoot: path.join(fakeHome, 'pointed') });
assert.strictEqual(dataRootModule.resolveDataRoot({ userData: ud, env: {}, home: fakeHome }).dataRoot, path.join(fakeHome, 'pointed'));

// Reference mode must keep each root pointing at its existing location.
// dataLayout runs the override through path.resolve, so on Windows a bare
// '/legacy/sessions' comes back as 'D:\legacy\sessions'. Build an absolute path the
// platform agrees with and assert the override survives, not how it is spelled.
const legacySessions = path.resolve(path.sep, 'legacy', 'sessions');
const layout = dataRootModule.dataLayout(path.join(fakeHome, 'newroot'), { sessionsRoot: legacySessions });
assert.strictEqual(layout.sessionsRoot, legacySessions);
assert.strictEqual(layout.ideasRoot, path.join(fakeHome, 'newroot', 'ideas'));

// The migration whitelist must never include the owner's vault or foreign scripts.
const { entryTable } = require('../src/core/migration-plan');
for (const entry of entryTable({ layout: dataRootModule.dataLayout(path.join(fakeHome, 'newroot')), home: fakeHome, userData: ud })) {
  assert.doesNotMatch(entry.src, /\.bigkiji\/?$/, 'never migrate ~/.bigkiji wholesale');
  assert.doesNotMatch(entry.src, /\.(sh|Modelfile)$/, 'shell automation is not ours to move');
}

console.log('sandbox/context routing selftest: PASS');
