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
const { CoreExecutionCoordinator, FALLBACKS, leaderProvider } = require('../src/domain/pi-agent/core-execution-coordinator');
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
  // glm's own chain starts with codex, but so would reading it wrongly — so this step
  // is checked by index rather than by name alone: reading from the stand-in would put
  // glm at position 1 of its own chain, while reading from the role's home provider
  // gives claude-code's second step. Both name Codex; only the latter keeps the index
  // meaningful for the hop after this one.
  assert.equal(assignment.provider, 'codex', 'the next step is claude-code\'s, not glm\'s');
  assert.equal(assignment.fallbackIndex, 2);
});

// --- the owner's order (2026-08-15, superseding 2026-08-05) ------------------
ok('a limit hands the work on in the order the owner chose', () => {
  // 2026-08-15: **GLM → Codex → Claude → Gemini → Qwen**.
  //   Claude Code is the commander — analysis, prompt authoring, quality control and
  //   sign-off — and is not the hand that produces. Putting it first meant the reviewer
  //   became the author on the first hiccup and nobody was left to check the work.
  //
  // Superseded 2026-08-05: 「リミットがかかった場合のaiの優先順位はClaude,codex,glm,gemini,qwenの順番に」
  //   Kept here on purpose. The old instruction was pinned by name too, so a future
  //   reader has to be able to see that this was a deliberate reversal rather than drift.
  //
  // Pinned literally, not derived from FALLBACKS, because FALLBACKS is the thing
  // under test: a table that computes its own expectation proves nothing. Before
  // this the five chains disagreed with each other — claude-code tried GLM before
  // Codex while codex tried Claude before GLM — and none of them reached Gemini, so
  // an exhausted Claude and Codex went past a working Gemini to the local model.
  assert.deepEqual(FALLBACKS['claude-code'], ['glm', 'codex', 'gemini', 'qwen']);
  assert.deepEqual(FALLBACKS.codex, ['glm', 'claude-code', 'gemini', 'qwen']);
  assert.deepEqual(FALLBACKS.glm, ['codex', 'claude-code', 'gemini', 'qwen']);
  assert.deepEqual(FALLBACKS.gemini, ['glm', 'codex', 'claude-code', 'qwen']);
  assert.deepEqual(FALLBACKS.qwen, [], 'the floor keeps its empty chain');
  // Every chain is the same list with itself removed — that is what makes them
  // impossible to drift apart, and it is the property worth guarding.
  const order = ['glm', 'codex', 'claude-code', 'gemini', 'qwen'];
  for (const [from, chain] of Object.entries(FALLBACKS)) {
    if (from === 'qwen') continue;
    assert.deepEqual(chain, order.filter((p) => p !== from), `${from}'s chain must follow the one order`);
  }
});

// A stand-in has to be one that can actually start. `_fallback` checked only the
// breaker while `_pick` checked the breaker, `isAvailable` and the paid allowlist,
// so a chain could hand the role to a provider with no key: it fails, the failure
// costs a repair cycle, and a repair cycle asks the owner to approve again. Harmless
// while the chains were short and hand-written; the owner's order puts Gemini in
// every chain, and Gemini is the one most likely to have no key on a given machine.
ok('a provider with no key is not offered as a stand-in', () => {
  const planned = [];
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 600000 });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(planned), breaker, registry: registry(),
    available: (provider) => provider !== 'gemini' && provider !== 'glm' });
  const run = { id: 'run-k', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', homeProvider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };
  breaker.record('claude-code', { ok: false, reason: 'quota' });
  coordinator._fallback(run, assignment);
  assert.equal(assignment.provider, 'codex', 'the first usable one takes it');
  breaker.record('codex', { ok: false, reason: 'quota' });
  coordinator._fallback(run, assignment);
  assert.equal(assignment.provider, 'qwen', 'GLM and Gemini have no key, so the work falls to the floor');
});

ok('and neither is one the owner took off the paid allowlist', () => {
  const planned = [];
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 600000 });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(planned), breaker, registry: registry(),
    settingsProvider: () => ({ routing: { paidAllowlist: ['claude-code', 'glm'] } }) });
  const run = { id: 'run-l', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', homeProvider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };
  breaker.record('claude-code', { ok: false, reason: 'quota' });
  coordinator._fallback(run, assignment);
  assert.equal(assignment.provider, 'glm', 'codex is off the allowlist, so the chain steps past it');
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
ok('the two spellings of the Claude CLI are one provider on the allowlist', () => {
  // The roster assigns `claude-code`; the settings file says `claude`. For four days the
  // owner set the leader to Claude, the allowlist filter in _pick() dropped every
  // claude-code candidate, and the leader role went to whoever else could start —
  // 16 samples / 0 successes in model_performance.json, with no error anywhere.
  const asClaude = new CoreExecutionCoordinator({ taskRunner: runner(), registry: registry(), available: () => true,
    settingsProvider: () => ({ routing: { paidAllowlist: ['claude'] } }) });
  assert.equal(asClaude.pickProvider('leader', ['claude-code', 'glm', 'codex', 'qwen']), 'claude-code',
    'a settings file spelling it "claude" must still permit the roster\'s claude-code');
  // ...and the translation must not widen the list into providers nobody asked for.
  assert.equal(asClaude.pickProvider('leader', ['glm', 'codex', 'qwen']), 'qwen',
    'glm and codex are still off this allowlist');
  // Saving does not delete it either — the normalise filter used to drop the name.
  const { SettingsStore } = require('../src/core/settings-store');
  const store = new SettingsStore({ userData: fs.mkdtempSync(path.join(root, 'cc-')) });
  store.update({ routing: { paidAllowlist: ['claude-code', 'glm'] } });
  assert.deepEqual(store.get().routing.paidAllowlist, ['claude-code', 'glm'],
    'claude-code was missing from the known-provider list and was deleted on every save');
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

// --- R-8: "Session leader" is a control, not a caption ------------------------
//
// The settings window has offered Auto / Claude Code / Codex / Gemini / GLM since it was
// written, and picking one changed nothing that ran: `run.leader` was set from it and
// then read only by eight knowledge events and one line of HUD text, while the provider
// that did the work came from ROLE_BLUEPRINT's own `claude-code` every time. Traced
// 2026-08-10 and fixed at the owner's request.
ok('the leader the owner picked is the leader that runs', () => {
  const planned = [];
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner(planned), registry: registry(), available: () => true });
  const run = { id: 'run-lead', prompt: 'fix the null check in the daemon', cwd: '/tmp', revision: 1,
    maxAgents: 3, assignments: [], roleContext: { sessionLeader: 'codex' } };
  coordinator._planExecution(run);
  const leader = run.assignments.find((item) => item.role === 'leader');
  assert.ok(leader, 'a run always has a leader');
  assert.equal(leader.provider, 'codex', 'the setting reached the assignment');
  assert.equal(run.leader, 'codex', 'and the record agrees with the assignment');

  // Only the leader moves. Choosing who leads is not choosing who debugs — and the
  // other roles cannot be named outright here, because they go through the learned
  // score like they always have. So the claim is stated as a comparison: same run, two
  // settings, one differing role.
  const other = new CoreExecutionCoordinator({ taskRunner: runner([]), registry: registry(), available: () => true });
  const glmRun = { ...run, id: 'run-lead-glm', assignments: [], roleContext: { sessionLeader: 'glm' } };
  other._planExecution(glmRun);
  assert.equal(glmRun.assignments.find((item) => item.role === 'leader').provider, 'glm');
  const nonLeader = (list) => list.filter((item) => item.role !== 'leader').map((item) => `${item.role}:${item.provider}`);
  assert.deepEqual(nonLeader(glmRun.assignments), nonLeader(run.assignments),
    'changing the session leader must not reshuffle the specialists');
});

ok('auto is the owner declining to decide, and stays that way', () => {
  assert.equal(leaderProvider({ sessionLeader: 'auto' }), '', 'auto pins nothing — the learner keeps its job');
  assert.equal(leaderProvider({}), '');
  assert.equal(leaderProvider(), '');
  assert.equal(leaderProvider({ sessionLeader: 'nonsense' }), '');
  assert.equal(leaderProvider({ sessionLeader: 'codex' }), 'codex');
  assert.equal(leaderProvider({ sessionLeader: 'glm' }), 'glm');
  // The local provider is not a leader. The role writes, and qwen has no tool layer —
  // the same shape the roster records for GLM doing debugging with --no-tools.
  assert.equal(leaderProvider({ sessionLeader: 'qwen' }), '',
    'a writing role cannot be given the provider that cannot open a file');
});

ok('on auto the measured best still wins, and the record names it', () => {
  // The point of leaving it on Auto. A run planned with no named leader must not be
  // pinned to a hardcoded provider, and whoever ends up leading is who the knowledge
  // events and the HUD card report — they used to report the setting instead.
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner([]), registry: registry(), available: () => true });
  const run = { id: 'run-auto', prompt: 'fix the null check in the daemon', cwd: '/tmp', revision: 1,
    maxAgents: 3, assignments: [], leader: 'auto', roleContext: { sessionLeader: 'auto' } };
  coordinator._planExecution(run);
  const leader = run.assignments.find((item) => item.role === 'leader');
  assert.equal(run.leader, leader.provider, 'the run records who led, not who was asked for');
  assert.notEqual(run.leader, 'auto', 'and "auto" is never left in the record as if it were a provider');
});

ok('choosing a leader that is exhausted still gets a run, not a wall', () => {
  // Being able to choose is not the same as a run dying because that choice is out of
  // quota. The pick is the head of the chain, and the chain still works underneath it.
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 600000 });
  breaker.record('codex', { ok: false, reason: 'quota' });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner([]), registry: registry(), breaker, available: () => true });
  const run = { id: 'run-lead-out', prompt: 'fix the null check in the daemon', cwd: '/tmp', revision: 1,
    maxAgents: 3, assignments: [], roleContext: { sessionLeader: 'codex' } };
  coordinator._planExecution(run);
  const leader = run.assignments.find((item) => item.role === 'leader');
  assert.notEqual(leader.provider, 'codex', 'the breaker is open, so the chain steps past the chosen leader');
  assert.ok(FALLBACKS.codex.includes(leader.provider), 'and lands somewhere on codex own fallback chain');
});

// The saved value the console can produce has to be one this function accepts, or the
// owner picks a leader and gets Claude Code anyway — the bug this section exists to fix.
ok('every leader the settings store will save is a leader this code honours', () => {
  const { SettingsStore } = require('../src/core/settings-store');
  const store = new SettingsStore({ userData: fs.mkdtempSync(path.join(root, 's-')) });
  for (const wanted of ['claude-code', 'codex', 'gemini', 'glm']) {
    const saved = store.update({ routing: { sessionLeader: wanted } }).routing.sessionLeader;
    assert.equal(saved, wanted, `${wanted} survives the validator`);
    assert.equal(leaderProvider({ sessionLeader: saved }), wanted, `${wanted} reaches the assignment`);
  }
  assert.equal(store.update({ routing: { sessionLeader: 'qwen' } }).routing.sessionLeader, 'auto',
    'and the one that cannot lead is refused at the door rather than silently downgraded later');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`routing assignment selftest: ${failures} FAILED`); process.exit(1); }
console.log('routing assignment selftest: PASS · tier follows the request not the title · every chain ends local · a stand-in hands the role back · readiness excludes · no hardcoded provider · the session leader the owner picks is the one that runs');
