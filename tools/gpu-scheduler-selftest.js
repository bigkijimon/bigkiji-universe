'use strict';
// What an "Adaptive GPU Scheduler" preset is actually allowed to claim.
//
// The failure this file exists to prevent is a cosmetic one: shipping Eco 15% / Balanced
// 35% / Performance 60% / Maximum 95% as if the app could hold the GPU at a percentage.
// It cannot — Electron exposes no such control and nothing in this repository sets one —
// so the first thing asserted here is that no resolved budget carries a utilisation
// figure at all. The rest checks that the three levers it DOES return still line up with
// the files that own them, and that balanced changes nothing.
//
// The values are compared against the real sources rather than against copies: a
// hard-coded expectation would keep passing after someone edits POINT_BUDGETS.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PRESETS, DEFAULT_PRESET, GPU_LAYERS_NONE, GPU_LAYERS_ALL,
  normalisePreset, resolveBudget, ollamaOptions,
} = require('../src/domain/pi-agent/gpu-scheduler');
const { RENDER_PRIORITIES, DEFAULTS: SETTINGS_DEFAULTS } = require('../src/core/settings-store');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// ---- the module stays pure -----------------------------------------------------
// Requiring settings-store or the renderer here would drag Electron and three into a
// main-process module and make it untestable; the mirrored constants below are the
// deliberate alternative, and they only stay honest because of the checks that follow.
const moduleSource = read('src', 'domain', 'pi-agent', 'gpu-scheduler.js');
assert.doesNotMatch(moduleSource, /require\s*\(/, 'gpu-scheduler must stay dependency-free');

// ---- no preset returns a GPU utilisation figure --------------------------------
// 15 / 35 / 60 / 95 are intent labels from the spec. Nothing measures them, so nothing
// may report them: a field called anything like "gpuUsage" would read as a guarantee.
for (const preset of PRESETS) {
  const budget = resolveBudget(preset);
  for (const key of Object.keys(budget)) {
    assert.doesNotMatch(key, /util|usage|percent|\bpct\b|watt|throttle/i,
      `${preset}.${key} sounds like a GPU utilisation claim, and none can be measured here`);
  }
  assert.strictEqual(budget.gpuUtilisation, undefined);
  assert.strictEqual(budget.gpuUtilizationPercent, undefined);
  assert.strictEqual(budget.gpuPercent, undefined);
}
// The spec's numbers must not have leaked in under some other name either. targetFps 60
// is excluded on purpose — it is a frame cap in fps, not a share of anything.
for (const preset of PRESETS) {
  const { targetFps, ...rest } = resolveBudget(preset);
  for (const [key, value] of Object.entries(rest)) {
    assert.ok(![15, 35, 95].includes(value), `${preset}.${key} = ${value} is a spec label, not a setting`);
  }
}

// ---- every preset resolves, and the names are the spec's four ------------------
assert.deepStrictEqual([...PRESETS], ['eco', 'balanced', 'performance', 'maximum']);
const resolved = Object.fromEntries(PRESETS.map((name) => [name, resolveBudget(name)]));
for (const name of PRESETS) assert.strictEqual(resolved[name].preset, name);

// ---- the values belong to the files that own them ------------------------------
// POINT_BUDGETS is parsed out of the renderer module (ESM + three, so it cannot be
// required from a CJS test). Parsing it means an edit there fails here instead of
// silently drifting away from what the scheduler hands out.
const waveSource = read('src', 'domain', '3d-canvas', 'components', 'audio-wave-field.js');
const literal = waveSource.match(/POINT_BUDGETS\s*=\s*Object\.freeze\(\{([^}]*)\}\)/);
assert.ok(literal, 'POINT_BUDGETS not found in audio-wave-field.js — the mirror below cannot be checked');
const livePointBudgets = Object.fromEntries([...literal[1].matchAll(/(\w+)\s*:\s*(\d+)/g)]
  .map(([, key, value]) => [key, Number(value)]));
assert.deepStrictEqual(Object.keys(livePointBudgets).sort(), ['auto', 'graphics', 'performance'],
  'the wave field still has exactly three tiers');
for (const name of PRESETS) {
  const budget = resolved[name];
  assert.strictEqual(budget.pointBudget, livePointBudgets[budget.renderPriority],
    `${name} must hand out the real ${budget.renderPriority} budget from audio-wave-field.js`);
}

// renderPriority is written straight into settings.appearance, so an unknown string would
// be silently rewritten to 'auto' by the store and the preset would do nothing.
for (const name of PRESETS) {
  assert.ok(RENDER_PRIORITIES.includes(resolved[name].renderPriority),
    `${name} must name a renderPriority settings-store accepts`);
}

// perfStage in synapse.js only ever holds 0, 1 or 2, and 'graphics'/'performance' pin the
// ends of that range while 'auto' leaves the FPS tuner the whole of it.
const synapseSource = read('src', 'domain', '3d-canvas', 'components', 'synapse.js');
assert.match(synapseSource, /perfStage\s*<\s*2/, 'synapse still caps perfStage at 2');
assert.match(synapseSource, /perfStage\s*>\s*0/, 'synapse still floors perfStage at 0');
for (const name of PRESETS) {
  const { perfStageFloor, perfStageCeiling } = resolved[name];
  assert.ok(perfStageFloor <= perfStageCeiling, `${name}: floor ${perfStageFloor} above ceiling ${perfStageCeiling}`);
  assert.ok(perfStageFloor >= 0 && perfStageCeiling <= 2, `${name} must stay inside synapse's 0..2 tiers`);
}
assert.deepStrictEqual(
  { floor: resolved.balanced.perfStageFloor, ceiling: resolved.balanced.perfStageCeiling },
  { floor: 0, ceiling: 2 },
  "balanced maps to 'auto', which is the full adaptive range the tuner already walks");

// ---- the drawing budget only ever grows ----------------------------------------
// "More generous" is a comparison of the real fields, not of the preset's position in a
// list: nothing may move toward less work, and something has to move toward more.
function moreGenerous(low, high) {
  const worse = high.pointBudget < low.pointBudget
    || high.targetFps < low.targetFps
    || high.perfStageCeiling > low.perfStageCeiling;
  const better = high.pointBudget > low.pointBudget
    || high.targetFps > low.targetFps
    || high.perfStageCeiling < low.perfStageCeiling;
  return !worse && better;
}
for (let i = 1; i < PRESETS.length; i += 1) {
  const [low, high] = [resolved[PRESETS[i - 1]], resolved[PRESETS[i]]];
  assert.ok(moreGenerous(low, high), `${low.preset} -> ${high.preset} must not ask for less drawing work`);
}
// The chain the spec cares about, stated on its own so it survives a reordering.
assert.ok(moreGenerous(resolved.eco, resolved.performance));
assert.ok(moreGenerous(resolved.performance, resolved.maximum));
assert.ok(resolved.eco.pointBudget < resolved.maximum.pointBudget);

// ---- balanced changes nothing about the local LLM ------------------------------
// This is the whole guarantee that turning the feature on is safe: no num_gpu on the
// wire means Ollama splits layers exactly as it does today. `undefined` would NOT do —
// JSON.stringify drops it, but a merge into an options object would not.
assert.ok(!('numGpu' in resolved.balanced), 'balanced must have no opinion about num_gpu');
assert.deepStrictEqual(ollamaOptions('balanced'), {}, 'balanced sends no options at all');
assert.deepStrictEqual(Object.keys(ollamaOptions('balanced')), []);
// And no existing caller is passing one today, so there is nothing to regress against.
const callers = ['src/domain/pi-core/conversation-engine.js', 'src/domain/pi-agent/fast-api-router.js',
  'src/domain/pi-agent/task-cache.js', 'src/domain/server/daemon.js'];
for (const file of callers) {
  assert.doesNotMatch(read(...file.split('/')), /num_gpu/, `${file} must keep leaving num_gpu to Ollama`);
}

// ---- the two ends of the offload range -----------------------------------------
// num_gpu counts model layers, not percent, so only "none" and "more than any model has"
// are portable; eco frees the GPU outright, maximum forces every layer onto it.
assert.strictEqual(resolved.eco.numGpu, GPU_LAYERS_NONE);
assert.deepStrictEqual(ollamaOptions('eco'), { num_gpu: 0 }, 'eco runs on the CPU so the GPU is free');
assert.strictEqual(resolved.maximum.numGpu, GPU_LAYERS_ALL);
assert.ok(resolved.maximum.numGpu > resolved.eco.numGpu);
assert.ok(resolved.maximum.numGpu >= resolved.performance.numGpu, 'maximum is the ceiling of the range');
assert.deepStrictEqual(ollamaOptions('maximum'), { num_gpu: GPU_LAYERS_ALL });

// ---- serialisation is an invariant, not a knob ----------------------------------
// Two GPU generators at once is a crash on this machine, so no preset may switch the
// gpu-signal.sh arbitration off — including maximum, which is the one that would want to.
for (const name of PRESETS) {
  assert.strictEqual(resolved[name].serialiseGenerationJobs, true, `${name} must still queue behind gpu-signal.sh`);
}

// ---- junk in, balanced out -------------------------------------------------------
// These are the values that really arrive: a settings key that was never written, a
// display label, a model's tool call with the wrong case.
for (const input of [undefined, null, '', '   ', 'turbo', 'Eco 15%', 'eco,balanced', 42, {}, [], NaN, false]) {
  assert.strictEqual(normalisePreset(input), DEFAULT_PRESET, `${JSON.stringify(input)} must fall back to balanced`);
  assert.strictEqual(resolveBudget(input).preset, DEFAULT_PRESET);
}
assert.strictEqual(DEFAULT_PRESET, 'balanced', 'the fallback has to be the preset that changes nothing');
assert.deepStrictEqual(resolveBudget('nonsense'), resolveBudget('balanced'));
// Case and stray whitespace are normalised rather than rejected — 'ECO' is a real value,
// just badly typed, and silently turning it into balanced would be the wrong answer.
for (const input of ['ECO', ' eco ', 'Eco', '\tEcO\n']) {
  assert.strictEqual(normalisePreset(input), 'eco', `${JSON.stringify(input)} is eco, badly typed`);
  assert.strictEqual(resolveBudget(input).numGpu, GPU_LAYERS_NONE);
}
assert.strictEqual(normalisePreset('MAXIMUM'), 'maximum');

// ---- the result cannot be edited by a caller -------------------------------------
// One shared frozen object per preset: a caller that mutated it would change the budget
// for everyone else in the process.
assert.ok(Object.isFrozen(resolveBudget('eco')));
assert.throws(() => { resolveBudget('eco').pointBudget = 1; }, TypeError);

// ---- the setting it will be wired to still exists ---------------------------------
assert.strictEqual(SETTINGS_DEFAULTS.appearance.renderPriority, 'auto',
  'balanced mirrors the shipped default; if this moves, balanced must move with it');

const shape = PRESETS.map((name) => {
  const b = resolved[name];
  return `${name}=${b.renderPriority}/${b.pointBudget}pts/${b.targetFps}fps/num_gpu:${'numGpu' in b ? b.numGpu : '—'}`;
}).join(' · ');
console.log(`gpu scheduler selftest: PASS · no preset reports GPU utilisation · balanced sends no num_gpu · point budgets match audio-wave-field.js · ${shape}`);
