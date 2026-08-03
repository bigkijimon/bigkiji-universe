'use strict';

// Who gets the work, and what it costs.
//
// Measured on the owner's own data, 2026-08-03: 27 assignments, 1 completion, 0
// paid completions ever. Four separate reasons, all of them in the routing code
// rather than in the providers.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CoreExecutionCoordinator, FALLBACKS } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { CircuitBreaker } = require('../src/domain/pi-agent/circuit-breaker');
const { resolveModel, CLAUDE_MODELS, ROLE_TIER } = require('../src/domain/pi-agent/model-router');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-'));
const registry = () => new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) });
const runner = (planned = []) => Object.assign(new (require('events').EventEmitter)(), {
  get: () => ({ prompt: 'original', error: 'boom', metadata: {} }),
  plan: (spec) => { planned.push(spec); return { id: spec.id, status: 'queued', disclosure: { disclosureHash: 'h' } }; },
});

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

// --- R-1: the tier follows the owner's words, not the role's own title -------
ok('a role title cannot decide the tier', () => {
  // `leader`'s title is "Architecture, system implementation and integration" and
  // COMPLEX_SIGNALS matches /architect/, so concatenating it into the tier text
  // sent every leader assignment to Fable at $10/$50 whatever the owner asked.
  assert.equal(resolveModel('claude-code', 'fix the null check in the daemon', 'leader'), CLAUDE_MODELS.general,
    'an ordinary engineering request is Opus work');
  assert.equal(resolveModel('claude-code', 'fix the null check in the daemon Architecture, system implementation and integration', 'leader'),
    CLAUDE_MODELS.design, 'and it only becomes design work if those words are in the request — which is why the title must never be appended');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
  assert.ok(!/resolveModel\([^)]*\$\{[^}]*\.title\}/.test(source), 'no call site may mix a title into the tier text');
});
ok('the owner’s standing design rule still reaches every role', () => {
  // Pinning leader to Opus would have cancelled [[design-changes-use-fable5]] for
  // the role most likely to be handed a redesign. Two roles are pinned, and leader is
  // deliberately not one of them:
  //   ui     the owner's standing design rule
  //   debug  the owner asked for debugging to be owned by a model good at debugging
  //          (Terminal-Bench 2.1: Fable 5 83.8% / Opus 5 78.9%)
  assert.deepEqual(Object.keys(ROLE_TIER), ['ui', 'debug'], 'only the roles the owner named are decided before the words are read');
  assert.ok(!Object.keys(ROLE_TIER).includes('leader'),
    'leader must stay word-driven, or a redesign handed to it would miss the design rule');
  assert.equal(resolveModel('claude-code', 'anything at all', 'ui'), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'ログイン画面を作り直したい', 'leader'), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'Rewrite the README markdown', 'facilitator'), CLAUDE_MODELS.design);
});

ok('a file path cannot decide the tier either', () => {
  // Same family as the title bug, found by running a real task through the daemon:
  // `ui\b` had no leading boundary, so the "ui" inside src/cli/tui/ matched and a
  // plain code-reading request planned onto Fable at $10/$50.
  assert.equal(resolveModel('claude-code', 'Read src/cli/tui/footer.js and report what it degrades first', 'leader'),
    CLAUDE_MODELS.general, 'a path containing tui/ is not a design request');
  // facilitator, not debug: debug is now pinned by role, so it can no longer serve as
  // the control that proves the tier is decided by the words rather than by the role.
  assert.equal(resolveModel('claude-code', 'fix the guard in src/gui/main.js', 'facilitator'), CLAUDE_MODELS.general);
  assert.equal(resolveModel('claude-code', 'copy this function into the new module', 'leader'), CLAUDE_MODELS.general,
    'the verb "copy" is not copywriting');
  // and the signals that should fire still do
  assert.equal(resolveModel('claude-code', 'update the UI copywriting on the pricing page', 'leader'), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'restyle the button with css', 'leader'), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'ログイン画面のレイアウトを直したい', 'leader'), CLAUDE_MODELS.design);
});

// --- R-5: every chain ends local, and only local -----------------------------
ok('no fallback chain climbs from free to paid', () => {
  const paid = new Set(['claude-code', 'codex', 'gemini', 'glm']);
  assert.deepEqual(FALLBACKS.qwen, [], 'a local failure is the floor, not a reason to spend');
  for (const [from, chain] of Object.entries(FALLBACKS)) {
    if (!chain.length) continue;
    assert.equal(chain.at(-1), 'qwen', `${from} must end at the local model`);
    assert.equal(chain.filter((p) => p === 'qwen').length, 1, `${from} must not pass through local and climb back to paid`);
    for (const step of chain.slice(0, -1)) assert.ok(paid.has(step), `${from} -> ${step} should be a paid stand-in, not the floor`);
  }
});

// --- the owner's rule: a stand-in hands the role back -------------------------
ok('a stand-in returns the role when its owner recovers', () => {
  const planned = [];
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60000 });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(planned), breaker, registry: registry() });
  const run = { id: 'run-h', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', homeProvider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };

  breaker.record('claude-code', { ok: false, reason: 'quota' });
  assert.equal(coordinator._fallback(run, assignment), true);
  assert.equal(assignment.provider, 'glm', 'someone covers while the owner of the role is limited');

  breaker.record('claude-code', { ok: true });
  const restored = [];
  coordinator.on('restored', (event) => restored.push(event));
  assert.equal(coordinator._fallback(run, assignment), true);
  assert.equal(assignment.provider, 'claude-code', 'and hands it back the moment the limit lifts');
  assert.equal(assignment.fallbackIndex, 0, 'with the chain rewound, so the next outage starts from the top again');
  assert.deepEqual(restored, [{ runId: 'run-h', role: 'leader', from: 'glm', to: 'claude-code' }],
    'and the owner is told, because a silent reassignment is indistinguishable from an erratic router');
});
ok('the fallback chain belongs to the role, not to the stand-in', () => {
  // Read from the stand-in, `fallbackIndex` indexed into a different list after
  // every hop: position 2 of claude-code's chain became position 2 of glm's.
  const planned = [];
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 600000 });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(planned), breaker, registry: registry() });
  const run = { id: 'run-c', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', homeProvider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };
  breaker.record('claude-code', { ok: false, reason: 'quota' });
  coordinator._fallback(run, assignment);
  assert.equal(assignment.provider, 'glm');
  breaker.record('glm', { ok: false, reason: 'quota' });
  coordinator._fallback(run, assignment);
  assert.equal(assignment.provider, 'codex', 'the next step is claude-code\'s, not glm\'s');
  assert.equal(assignment.fallbackIndex, 2);
});

// --- R-3: readiness excludes; the floor is local ------------------------------
ok('when nothing paid can start, work goes local rather than to the first name', () => {
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(),
    available: (provider) => provider === 'qwen' });
  assert.equal(coordinator.pickProvider('leader', ['claude-code', 'glm', 'codex', 'qwen']), 'qwen');
  assert.equal(coordinator.pickProvider('leader', ['claude-code', 'glm']), 'qwen',
    'even when local is not in the candidate list — it is the stated last resort, not a candidate');
});
ok('a provider in cooldown is not planned onto in the first place', () => {
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 600000 });
  breaker.record('glm', { ok: false, reason: 'quota' });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(), breaker,
    available: () => true });
  assert.notEqual(coordinator.pickProvider('debug', ['glm', 'codex']), 'glm');
});

// --- R-7: the owner's paid allowlist is a real control, not a dead setting -----
ok('an exhausted provider can be taken out of rotation', () => {
  // settings-store forced this to a constant on every save, and no assignment code
  // ever read it, so there was no way to stop sending work to an exhausted provider.
  const withAll = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(), available: () => true });
  assert.equal(withAll.pickProvider('leader', ['claude-code', 'glm', 'codex', 'qwen']), 'claude-code');
  const glmOnly = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(), available: () => true,
    settingsProvider: () => ({ routing: { paidAllowlist: ['glm'] } }) });
  assert.equal(glmOnly.pickProvider('leader', ['claude-code', 'glm', 'codex', 'qwen']), 'glm');
  assert.equal(glmOnly.pickProvider('leader', ['claude-code', 'codex', 'qwen']), 'qwen',
    'with every permitted paid provider gone the work goes local, not to a forbidden one');
  // An empty or absent list means all of them, never none of them: a normalise bug
  // must not silently stop the whole fleet.
  const empty = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(), available: () => true,
    settingsProvider: () => ({ routing: { paidAllowlist: [] } }) });
  assert.equal(empty.pickProvider('leader', ['claude-code', 'glm']), 'claude-code');
});
ok('the allowlist survives a settings save', () => {
  const { SettingsStore } = require('../src/core/settings-store');
  const store = new SettingsStore({ userData: fs.mkdtempSync(path.join(root, 's-')) });
  store.update({ routing: { paidAllowlist: ['glm', 'codex'] } });
  assert.deepEqual(store.get().routing.paidAllowlist, ['glm', 'codex'], 'it used to be overwritten with a constant every time');
  store.update({ routing: { paidAllowlist: ['glm', 'not-a-provider'] } });
  assert.deepEqual(store.get().routing.paidAllowlist, ['glm'], 'and an unknown name is dropped, not trusted');
});

// --- R-9: something has to decide which model codex runs ----------------------
ok('codex is told which model to run', () => {
  const { resolveModel: resolve, CODEX_MODELS } = require('../src/domain/pi-agent/model-router');
  assert.equal(resolve('codex', 'anything', 'leader'), CODEX_MODELS.general);
  const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
  const args = new TaskRunner({ cwd: root }).adapter('codex', 'p', root, { allowRead: [], allowWrite: [] }, {}, CODEX_MODELS.general).args;
  assert.ok(args.includes('--model'), 'BigKiji passes --ignore-user-config, so without this nobody chose the model');
  assert.equal(args[args.indexOf('--model') + 1], CODEX_MODELS.general);
  const bare = new TaskRunner({ cwd: root }).adapter('codex', 'p', root, { allowRead: [], allowWrite: [] }, {}, '').args;
  assert.ok(!bare.includes('--model'), 'and no model id is invented when none was resolved');
});

// --- R-4: no dispatch path may name its provider in source --------------------
ok('idea enhancement goes through the router like everything else', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.ok(!/provider: 'gemini'/.test(daemon),
    'a hardcoded provider skips readiness, the breaker and the registry — and kept dispatching to a quota of exactly zero');
  assert.match(daemon, /this\.coordinator\.pickProvider\('facilitator'/);
});

// --- R-2: the app has the same gate the daemon has ----------------------------
ok('both dispatch paths use the readiness gate', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
  assert.match(main, /available: \(provider\) => providerReadiness\(provider/,
    'the app coordinator defaulted to () => true, so it assigned work to providers that could not start');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`routing assignment selftest: ${failures} FAILED`); process.exit(1); }
console.log('routing assignment selftest: PASS · tier follows the request not the title · every chain ends local · a stand-in hands the role back · readiness excludes · no hardcoded provider');
