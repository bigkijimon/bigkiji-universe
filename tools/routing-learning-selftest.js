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
const baseline = registry.score('claude-code', 'leader');
const lesson = registry.record({ provider: 'claude-code', model: 'claude-opus-5', role: 'leader', ok: true, durationMs: SLOW });
assert(lesson, 'a slow assignment must produce a lesson');
assert.match(lesson.reason, /exceeded/);
assert(lesson.penalty > 0);
assert(registry.score('claude-code', 'leader') < baseline, 'the lesson has to change the next decision, not just be logged');

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
const punished = registry.snapshot().capabilities.models['claude-code'].penalties.leader;
for (let i = 0; i < 12; i += 1) registry.record({ provider: 'claude-code', role: 'leader', ok: true, durationMs: FAST });
const recovered = registry.snapshot().capabilities.models['claude-code'].penalties.leader;
assert(recovered < punished, 'recovery has to be possible');
assert.strictEqual(recovered, 0, 'sustained fast success clears the penalty entirely');

// ---- it survives a restart ---------------------------------------------------
registry.record({ provider: 'glm', role: 'debug', ok: false, durationMs: SLOW });
const reopened = new ModelCapabilityRegistry({ root });
assert(reopened.snapshot().capabilities.models.glm.penalties.debug > 0,
  'what PiAgent learned must outlive the process that learned it');

fs.rmSync(root, { recursive: true, force: true });
console.log('routing learning selftest: PASS · slow work penalised · keyed by (provider, model) · re-routes · decays · persists');
