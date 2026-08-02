'use strict';
// Turning a GPU intent into the three settings this app can actually change.
//
// The V3 spec names four levels — Eco 15%, Balanced 35%, Performance 60%, Maximum 95%.
// Those percentages are INTENT LABELS, not measurements and not something this module
// can deliver: Electron exposes no API that caps GPU utilisation at a percentage, and
// nothing in this repository sets one (no commandLine switch, no Metal flag). So this
// module never returns a utilisation figure, and the selftest asserts that it doesn't —
// a number nobody measures is worse than no number, because it reads like a guarantee.
//
// What the app can genuinely change is three things, all of them already in the code:
//   1. Drawing budget — appearance.renderPriority (settings-store.js), the perfStage tier
//      it pins (synapse.js), the per-frame point budget of the wave field
//      (audio-wave-field.js) and the frame-pacing target.
//   2. Local LLM offload — Ollama's options.num_gpu, i.e. how many model layers run on
//      the GPU. Nothing passes it today; omitting it keeps Ollama's own decision.
//   3. Generation serialisation — gpu-signal.sh, which the tool registry already locates.
//
// Pure Node, no dependencies, no side effects: it reads nothing and writes nothing, so
// the caller owns settings, the renderer and the job queue. It deliberately does NOT
// require settings-store or synapse — those values are mirrored below as constants and
// the selftest reconciles them against the real files.

// Ordered from the smallest drawing budget to the largest. The order is part of the
// contract: a preset later in this list never asks for less work than an earlier one.
const PRESETS = Object.freeze(['eco', 'balanced', 'performance', 'maximum']);
const DEFAULT_PRESET = 'balanced';

// Mirrors POINT_BUDGETS in src/domain/3d-canvas/components/audio-wave-field.js. That
// module is ESM and pulls in three, so it cannot be required from the main process;
// tools/gpu-scheduler-selftest.js parses the real values back out and compares, which is
// what makes this copy safe to keep.
const POINT_BUDGETS = Object.freeze({ auto: 14000, performance: 3200, graphics: 26000 });

// Ollama counts num_gpu in MODEL LAYERS, not percent, and the layer count differs per
// model — so there is no portable middle value. Only "none" and "more than any model
// has" mean the same thing for every model, which is why the presets say one of those
// two or say nothing at all.
const GPU_LAYERS_NONE = 0;
const GPU_LAYERS_ALL = 999;

// perfStage floors and ceilings are not a new range: they describe what
// synapse.js applyAppearanceSettings() already does with each renderPriority —
// 'performance' pins stage 2, 'graphics' pins stage 0, and 'auto' hands the stage back to
// the FPS tuner, which walks 0..2. If that mapping changes, these change with it.
const STAGE_BY_PRIORITY = Object.freeze({
  auto: { floor: 0, ceiling: 2 },
  performance: { floor: 2, ceiling: 2 },
  graphics: { floor: 0, ceiling: 0 },
});

// targetFps is a pacing cap for the caller to skip frames against. It is not a claim
// about what this machine reaches — the tuner in synapse.js measures that, and its own
// thresholds (below 28 fps degrade, above 45 fps recover) are the only measured numbers
// anywhere near this file.
const BUDGETS = Object.freeze({
  eco: Object.freeze({
    renderPriority: 'performance',
    pointBudget: POINT_BUDGETS.performance,
    targetFps: 30,
    // CPU-only inference. The point of eco is to hand the GPU to whatever else wants it,
    // and zero layers is the only offload count that means that for every model.
    numGpu: GPU_LAYERS_NONE,
    intent: 'Leave the GPU to other work; draw the cheapest tier.',
  }),
  balanced: Object.freeze({
    renderPriority: 'auto',
    pointBudget: POINT_BUDGETS.auto,
    targetFps: 60,
    // numGpu is deliberately absent, not null: balanced must send no num_gpu at all so
    // Ollama keeps splitting layers exactly as it does today. This is the preset that
    // guarantees the default behaviour is unchanged, so the selftest checks the key is
    // missing rather than merely falsy.
    intent: 'Today’s behaviour: adaptive drawing, Ollama picks its own split.',
  }),
  performance: Object.freeze({
    renderPriority: 'graphics',
    pointBudget: POINT_BUDGETS.graphics,
    targetFps: 60,
    numGpu: GPU_LAYERS_ALL,
    intent: 'Full-detail drawing and every model layer on the GPU.',
  }),
  maximum: Object.freeze({
    renderPriority: 'graphics',
    pointBudget: POINT_BUDGETS.graphics,
    targetFps: 120,
    numGpu: GPU_LAYERS_ALL,
    intent: 'As above, paced for a high-refresh display.',
  }),
});

// Unknown, empty, mistyped and differently-cased values all land on balanced. A GPU
// preset read from settings or from a model's tool call is exactly the kind of value
// that arrives as 'ECO', ' eco ' or undefined, and defaulting is safer than throwing:
// the caller's alternative is running with no budget at all.
function normalisePreset(value) {
  const name = String(value == null ? '' : value).trim().toLowerCase();
  return PRESETS.includes(name) ? name : DEFAULT_PRESET;
}

// Resolves a preset name into the settings the three levers take.
//
// serialiseGenerationJobs is true for every preset on purpose. Two GPU generators running
// at once is a measured crash on this machine, not a tuning trade-off, so no preset gets
// to switch the gpu-signal.sh arbitration off — it is returned so the caller has one
// place to read it, not so it can vary.
function resolveBudget(preset) {
  const name = normalisePreset(preset);
  const budget = BUDGETS[name];
  const stage = STAGE_BY_PRIORITY[budget.renderPriority];
  const resolved = {
    preset: name,
    renderPriority: budget.renderPriority,
    perfStageFloor: stage.floor,
    perfStageCeiling: stage.ceiling,
    pointBudget: budget.pointBudget,
    targetFps: budget.targetFps,
    serialiseGenerationJobs: true,
    intent: budget.intent,
  };
  // Assigned conditionally so 'numGpu' in resolved answers "does this preset have an
  // opinion about offload", which balanced needs to be able to answer with no.
  if (budget.numGpu !== undefined) resolved.numGpu = budget.numGpu;
  return Object.freeze(resolved);
}

// The Ollama request `options` fragment for a preset, in Ollama's own wire spelling.
// Exists so callers merge one object instead of translating numGpu themselves and
// accidentally sending num_gpu: undefined — which is a different request from sending
// nothing, and would take balanced off the default path.
function ollamaOptions(preset) {
  const { numGpu } = resolveBudget(preset);
  return Object.freeze(numGpu === undefined ? {} : { num_gpu: numGpu });
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET,
  POINT_BUDGETS,
  GPU_LAYERS_NONE,
  GPU_LAYERS_ALL,
  STAGE_BY_PRIORITY,
  normalisePreset,
  resolveBudget,
  ollamaOptions,
};
