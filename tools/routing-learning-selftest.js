'use strict';
// PiAgent has to learn from the delegation it just did, not from the next planning
// round. The owner's rule was explicit: when a delegated agent is slow, update the
// sandbox/routing state then and there so the next run routes differently.
//
// Untested, this is the worst kind of feature — it silently changes which model runs
// the owner's work, and a bug looks like the router simply being erratic.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-'));
const registry = new ModelCapabilityRegistry({ root });
const SLOW = 240000; const FAST = 4000;

// ---- a fast success teaches nothing new -------------------------------------
assert.strictEqual(registry.record({ provider: 'codex', role: 'ui', ok: true, durationMs: FAST }), null,
  'a provider doing its job at normal speed must not move the routing weights');

// ---- a slow assignment is recorded against the pair that actually ran --------
const lesson = registry.record({ provider: 'claude-code', model: 'claude-opus-5', role: 'leader', ok: true, durationMs: SLOW });
assert(lesson, 'a slow assignment must produce a lesson');
assert.match(lesson.reason, /exceeded/);
assert(lesson.penalty > 0);

// The lesson has to change the next decision — measured against a provider that did the
// same work quickly, not against one nobody has ever used.
//
// This compared the score after the lesson with the score before it, when the provider
// had no record at all. That worked only because an unmeasured provider was scored on a
// different scale from a measured one, which was itself the defect fixed on 2026-08-10:
// a slow success is still a success, and ranking it below a total unknown was never the
// property this test was defending. Ranking it below a fast one is.
{
  const twin = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-speed-'));
  const speed = new ModelCapabilityRegistry({ root: twin });
  speed.record({ provider: 'slowcoach', model: 'm', role: 'leader', ok: true, durationMs: SLOW });
  speed.record({ provider: 'quick', model: 'm', role: 'leader', ok: true, durationMs: FAST });
  assert(speed.score('slowcoach', 'leader') < speed.score('quick', 'leader'),
    'the same work, done slowly, must lose to the same work done quickly');
  assert.equal(speed.choose('leader', ['slowcoach', 'quick']), 'quick', 'and choose() has to act on it');
  fs.rmSync(twin, { recursive: true, force: true });
}

const perf = registry.snapshot().performance.models;
assert(perf['claude-code::claude-opus-5'], 'observations are keyed by (provider, model)');
assert(perf['claude-code'], 'the provider row still learns, so provider-level choose() keeps working');
assert.strictEqual(perf['claude-code::claude-opus-5'].model, 'claude-opus-5');
assert(!perf['claude-code::claude-fable-5'], 'one slow tier must not indict a tier that never ran');

// ---- the penalty is what re-routes the work ---------------------------------
// Same role, two candidates: the one that was slow loses even though its prior is higher.
for (let i = 0; i < 4; i += 1) registry.record({ provider: 'claude-code', role: 'leader', ok: false, durationMs: SLOW });
assert.strictEqual(registry.choose('leader', ['claude-code', 'codex']), 'codex',
  'after repeated slow failures PiAgent must stop sending leader work to the same provider');

// ---- and it decays, so one bad afternoon does not retire a provider ----------
// Recovery takes a streak, not one good run. A provider that alternates fast and slow
// would otherwise look healthy on every other sample and never lose its slot.
const punished = registry.snapshot().capabilities.models['claude-code'].penalties.leader;
registry.record({ provider: 'claude-code', role: 'leader', ok: true, durationMs: FAST });
assert.strictEqual(registry.snapshot().capabilities.models['claude-code'].penalties.leader, punished,
  'one fast success is not recovery');
registry.record({ provider: 'claude-code', role: 'leader', ok: true, durationMs: FAST });
const afterStreak = registry.snapshot().capabilities.models['claude-code'].penalties.leader;
assert(afterStreak < punished, 'two in a row is');
registry.record({ provider: 'claude-code', role: 'leader', ok: true, durationMs: FAST });
registry.record({ provider: 'claude-code', role: 'leader', ok: false, durationMs: SLOW });
assert(registry.snapshot().capabilities.models['claude-code'].penalties.leader > afterStreak,
  'a failure mid-streak restarts the count and costs more');
for (let i = 0; i < 40; i += 1) registry.record({ provider: 'claude-code', role: 'leader', ok: true, durationMs: FAST });
assert.strictEqual(registry.snapshot().capabilities.models['claude-code'].penalties.leader, 0,
  'sustained fast success clears the penalty entirely');

// ---- the model that ran is penalised, not just the provider -----------------
registry.record({ provider: 'codex', model: 'codex-slow-tier', role: 'ui', ok: false, durationMs: SLOW });
const codex = registry.snapshot().capabilities.models.codex.penalties;
assert(codex['codex-slow-tier::ui'] > 0, 'the tier that ran carries its own penalty');
assert(codex.ui > 0, 'and the provider key still moves, because choose() runs before the tier is picked');
assert(registry.score('codex', 'ui', 'codex-slow-tier') <= registry.score('codex', 'ui'),
  'scoring with the model must not be more generous than scoring without it');

// ---- it survives a restart ---------------------------------------------------
registry.record({ provider: 'glm', role: 'debug', ok: false, durationMs: SLOW });
const reopened = new ModelCapabilityRegistry({ root });
assert(reopened.snapshot().capabilities.models.glm.penalties.debug > 0,
  'what PiAgent learned must outlive the process that learned it');

// ---- an unmeasured duration is not a fast one -------------------------------
// A task that dies before it starts has durationMs 0, and 0ms used to read as the
// fastest possible run: `1 - 0/120000` handed it the full speed bonus. The provider
// that failed earliest scored best on speed.
const blank = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-blank-'));
const unmeasured = new ModelCapabilityRegistry({ root: blank });
unmeasured.record({ provider: 'gemini', role: 'ui', ok: false, durationMs: 0 });
const timed = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-timed-')) });
timed.record({ provider: 'gemini', role: 'ui', ok: false, durationMs: 2000 });
assert.strictEqual(unmeasured.snapshot().performance.models.gemini.ewmaLatencyMs, 0);
assert.strictEqual(unmeasured.snapshot().performance.models.gemini.latencySamples, undefined,
  'no duration means no latency observation, not an observation of zero');
assert(unmeasured.score('gemini', 'ui') < timed.score('gemini', 'ui'),
  'a provider that never ran must not outscore one that genuinely answered in 2s');

// ---- the poisoned file written before 2026-08-02 is repaired on open --------
// Every row in the shipped registry had samples but no successes and no latency,
// because blocked tasks were being recorded as provider failures. Left in place, the
// old bug keeps steering routing long after the code that caused it is gone.
const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-dirty-'));
fs.writeFileSync(path.join(dirty, 'model_performance.json'), JSON.stringify({
  version: 1,
  models: {
    'claude-code': { samples: 46, successes: 0, failures: 46, ewmaLatencyMs: 0, successRate: 0, roles: {}, provider: 'claude-code' },
    codex: { samples: 12, successes: 4, failures: 8, ewmaLatencyMs: 9000, successRate: 0.33, roles: {}, provider: 'codex' },
  },
}));
fs.writeFileSync(path.join(dirty, 'model_capabilities.json'), JSON.stringify({
  version: 1,
  models: {
    'claude-code': { roles: { leader: 1 }, penalties: { leader: 0.42 }, penaltyUpdatedAt: '2026-08-02T10:46:25.508Z' },
    codex: { roles: { ui: 1 }, penalties: { ui: 0.06 } },
  },
}));
const repaired = new ModelCapabilityRegistry({ root: dirty });
const after = repaired.snapshot();
assert.strictEqual(after.performance.models['claude-code'], undefined,
  'a row that never observed a run is dropped — a seeded prior beats a fabricated observation');
assert(after.performance.models.codex, 'a row with real successes and real latency is left alone');
assert.strictEqual(after.performance.models.codex.samples, 12);
assert.strictEqual(after.capabilities.models['claude-code'].penalties, undefined,
  'penalties earned under the bug must not outlive it');
assert.strictEqual(after.capabilities.models.codex.penalties, undefined);
assert.strictEqual(after.performance.version, 2);
assert.deepStrictEqual(new ModelCapabilityRegistry({ root: dirty }).snapshot().performance.models.codex.samples, 12,
  'the repair runs once, not on every open');

for (const dir of [root, blank, dirty]) fs.rmSync(dir, { recursive: true, force: true });
// Two processes hold this registry — the daemon and the Electron app — and each
// loaded its copy at boot and wrote the whole object back on every result. So
// whichever finished last erased everything the other had recorded since startup.
// Measured before the fix: the daemon records a glm success, the app records a codex
// success, and the file ends with codex only.
{
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-two-writers-'));
  const daemon = new ModelCapabilityRegistry({ root: shared });
  const app = new ModelCapabilityRegistry({ root: shared });

  daemon.record({ provider: 'glm', role: 'debug', ok: true, durationMs: 1200, tokens: { input: 10, output: 5 } });
  app.record({ provider: 'codex', role: 'ui', ok: true, durationMs: 900, tokens: { input: 20, output: 3 } });
  const both = JSON.parse(fs.readFileSync(path.join(shared, 'model_performance.json'), 'utf8')).models;
  assert.ok(both.glm, 'the daemon\'s result must survive the app writing after it');
  assert.ok(both.codex, 'and the other way round');

  // Interleaved records are counters, so they sum — neither process has the whole
  // truth and taking one and discarding the other loses half of it.
  for (let i = 0; i < 5; i += 1) {
    daemon.record({ provider: 'glm', role: 'debug', ok: true, durationMs: 1000, tokens: {} });
    app.record({ provider: 'glm', role: 'debug', ok: false, durationMs: 1000, tokens: {} });
  }
  const glm = JSON.parse(fs.readFileSync(path.join(shared, 'model_performance.json'), 'utf8')).models.glm;
  assert.strictEqual(glm.samples, 11, `every record counted once: ${glm.samples}`);
  assert.strictEqual(glm.successes, 6, `and the successes are the real ones: ${glm.successes}`);
  assert.strictEqual(glm.roles.debug.samples, 11);
  assert.strictEqual(glm.roles.debug.successRate, 6 / 11);

  // A throttle is counted the same way — it was the other whole-file write.
  const before = JSON.parse(fs.readFileSync(path.join(shared, 'model_performance.json'), 'utf8')).models.codex.samples;
  daemon.record({ provider: 'codex', role: 'ui', ok: false, reason: 'quota', durationMs: 0, tokens: {} });
  const after = JSON.parse(fs.readFileSync(path.join(shared, 'model_performance.json'), 'utf8')).models;
  assert.strictEqual(after.codex.samples, before, 'a throttle is not a sample');
  assert.ok(after.glm, 'and it still must not erase the other provider');
  fs.rmSync(shared, { recursive: true, force: true });
}

// Being measured must not cost a provider the assignment.
//
// `score()` returned the raw prior for anything with no samples while everything with a
// record had its prior multiplied by 0.55, so the two branches were on different scales
// and comparing them meant nothing. Measured on the owner's data 2026-08-10:
//
//   codex   prior 0.78  penalty 0.24  152 samples  →  0.5706
//   gemini  prior 0.74  penalty 0.00    0 samples  →  0.7400
//
// The higher prior scored lower, purely for having been used, and Auto handed the leader
// role to the provider with zero completions and a limit:0 free quota.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-routing-unknown-'));
  const registry = new ModelCapabilityRegistry({ root });
  const prior = (id, value) => {
    registry.capabilities.models[id] = registry.capabilities.models[id] || { roles: {}, penalties: {} };
    registry.capabilities.models[id].roles.leader = value;
  };
  prior('proven', 0.5); prior('untouched', 0.9); prior('tried', 0.9);

  // Reached 152 times and mostly succeeded.
  for (let i = 0; i < 20; i += 1) registry.record({ provider: 'proven', role: 'leader', ok: true, durationMs: 5000 });
  // Never reached at all — genuinely unknown, and neutral is the honest reading.
  // Reached repeatedly and never once completed: throttles only, no samples. That is not
  // ignorance, it is a record, and it is the exact shape of gemini on this machine.
  for (let i = 0; i < 6; i += 1) registry.record({ provider: 'tried', role: 'leader', ok: false, reason: 'quota' });

  const snap = registry.snapshot().performance.models;
  assert.equal(snap.tried.samples, 0, 'a throttle is still not a sample — that rule is untouched');
  assert.ok(Number(snap.tried.throttled) >= 6, 'but it is still counted, which is what makes it evidence');

  const score = (id) => registry.score(id, 'leader');
  assert.ok(score('proven') > score('tried'),
    `a provider that has completed work outranks one that has only ever been turned away: ${score('proven')} vs ${score('tried')}`);
  assert.ok(score('untouched') > score('tried'),
    'and never having been asked is not worse than having failed every time');
  assert.equal(registry.choose('leader', ['tried', 'proven']), 'proven', 'choose() follows the score');

  // Unknown stays neutral rather than free: a prior of 0.9 with no evidence must not beat
  // measured success outright, or the fix simply moves the same defect one provider over.
  assert.ok(score('untouched') < 0.9, 'an unmeasured provider no longer keeps its full prior');

  // Self-healing. One completion and it is scored like anything else — this demotes on
  // evidence, it does not ban.
  const before = score('tried');
  registry.record({ provider: 'tried', role: 'leader', ok: true, durationMs: 4000 });
  assert.ok(score('tried') > before, `one completion puts it back in the running: ${before} -> ${score('tried')}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('routing learning selftest: PASS · slow work penalised · keyed by (provider, model) · re-routes · decays · persists · unmeasured latency stays neutral · being measured costs nothing · reached-and-never-completed is evidence, not ignorance · poisoned history repaired once');
