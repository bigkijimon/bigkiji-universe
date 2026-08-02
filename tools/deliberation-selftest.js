'use strict';
// Independent proposals before work starts, merged by PiAgent.
//
// The parts worth pinning are the ones that fail silently: a parser that finds no
// steps, a memory that never recalls, and a discussion that strands the run when it
// produces nothing. Each of those looks like "deliberation is off" rather than a bug.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const deliberate = require('../src/domain/pi-agent/deliberation');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-delib-'));

// ---- when a discussion is worth its cost ------------------------------------
assert.strictEqual(deliberate.needed('こんにちは', { lenses: 2 }), false, 'chat must not trigger a discussion');
assert.strictEqual(deliberate.needed('Render a 12 second clip with ComfyUI', { lenses: 2 }), true,
  'local tool runs are slow and serialised on one GPU — always discuss first');
assert.strictEqual(deliberate.needed(`Implement the migration ${'x'.repeat(140)}`, { lenses: 2 }), true);
assert.strictEqual(deliberate.needed(`Implement the migration ${'x'.repeat(140)}`, { lenses: 1 }), false,
  'one lens is not a discussion');
assert.strictEqual(deliberate.needed(`just a long note ${'y'.repeat(200)}`, { lenses: 2 }), false,
  'length alone is not a reason to deliberate');

// ---- the parser has to survive the pipeline it actually sits in --------------
// Task output reaches consolidate() after cleanText(), which collapses newlines. A
// line-based parser returns zero steps here and the whole feature quietly does nothing.
const collapsed = 'Here is the plan. 1. Read the resolver first 2. Add the pointer file 3. Verify with the smoke test';
assert.deepStrictEqual(deliberate.extractSteps(collapsed),
  ['Read the resolver first', 'Add the pointer file', 'Verify with the smoke test']);
assert.deepStrictEqual(deliberate.extractSteps('- alpha step here\n- beta step here'), ['alpha step here', 'beta step here']);
assert.deepStrictEqual(deliberate.extractSteps('no markers at all in this sentence'), []);
assert.deepStrictEqual(deliberate.extractSteps('it is 3.5x faster now'), [], 'a decimal is not a step marker');

// ---- merging is set arithmetic, not a model ---------------------------------
const merged = deliberate.consolidate([
  { lens: 'architect', provider: 'qwen', text: '1. Read the resolver first 2. Add the pointer file' },
  { lens: 'risk', provider: 'glm', text: '1. Read the resolver first 2. Preflight the free disk space' },
]);
assert.deepStrictEqual(merged.steps, ['Read the resolver first', 'Add the pointer file', 'Preflight the free disk space'],
  'the second lens contributes only what nobody said yet');
assert.strictEqual(merged.contributors[1].contributed, 1);
assert.strictEqual(merged.lenses, 2);
assert.strictEqual(deliberate.consolidate([]).steps.length, 0);
assert.strictEqual(deliberate.brief(null), '', 'no plan means no injected text, not an empty header');
assert.match(deliberate.brief(merged), /DELIBERATED PLAN/);

// ---- memory: the same question is not paid for twice ------------------------
const memory = new deliberate.DeliberationMemory({ root });
memory.store('Rebuild the CLI footer so the phase bar stays pinned', merged);
const recalled = memory.lookup('Rebuild the CLI footer so that the phase bar stays pinned');
assert(recalled, 'near-identical work must recall the merged plan instead of re-discussing it');
assert.strictEqual(recalled.source, 'memory');
assert.deepStrictEqual(recalled.steps, merged.steps);
assert.strictEqual(memory.lookup('Generate a background track with ACE-Step'), null, 'unrelated work is not a recall');
assert.strictEqual(memory.store('Rebuild the CLI footer so the phase bar stays pinned', merged), null,
  'storing the same deliberation twice must not grow the memory');
assert(new deliberate.DeliberationMemory({ root }).lookup('Rebuild the CLI footer so the phase bar stays pinned'),
  'the memory has to outlive the process that wrote it');

// ---- end to end through the coordinator -------------------------------------
const project = path.join(root, 'project');
fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({
  filesystem: { allowRead: [project], allowWrite: [project] },
  models: { allowPaid: ['claude', 'claude-code', 'codex', 'gemini', 'glm'] } }));
fs.writeFileSync(path.join(project, 'src', 'target.js'), 'export function migrate(){ return true; }\n');

const PROPOSAL = '1. Read the resolver before touching paths 2. Write the manifest before moving a byte 3. Verify then delete';
function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 1; queueMicrotask(() => child.emit('close', 1, 'SIGTERM')); };
  queueMicrotask(() => { child.stdout.end(`${PROPOSAL}\n`); child.exitCode = 0; child.emit('close', 0, null); });
  return child;
}

(async () => {
  const runner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => fakeChild() });
  const coordinator = new CoreExecutionCoordinator({
    taskRunner: runner,
    registry: new ModelCapabilityRegistry({ root: path.join(root, 'capability') }),
    memory: new deliberate.DeliberationMemory({ root: path.join(root, 'coordinator') }),
    skills: { scan() {}, brief() { return ''; } },
    settingsProvider: () => ({ routing: { deliberationLenses: 2, maxAgents: 3 }, quality: { gate: 'strict' } }),
  });

  const goal = `Implement the data root migration end to end ${'and verify every moved file '.repeat(6)}`;
  const planned = coordinator.submit({ prompt: goal, cwd: project });
  assert.strictEqual(planned.stage, 'deliberation');
  assert.strictEqual(planned.assignments.length, 2);
  assert(planned.assignments.every((item) => item.write === false), 'a discussion never gets write access');
  assert.strictEqual(new Set(planned.assignments.map((item) => item.provider)).size, 2,
    'two lenses on one provider is one opinion twice');
  assert.strictEqual(planned.status, 'AWAITING_APPROVAL', 'a discussion costs tokens, so the owner still approves it');

  const finished = new Promise((resolve) => coordinator.on('run', (event) => { if (event.kind === 'deliberated') resolve(event); }));
  coordinator.approve(planned.id, { disclosureHash: planned.disclosureHash, planHash: planned.planHash, revision: planned.revision });
  const after = await finished;

  assert.strictEqual(after.stage, 'execution', 'the run has to move on by itself once the lenses answer');
  assert(after.deliberation.steps.length >= 3);
  assert.strictEqual(after.deliberation.source, 'live');
  assert.strictEqual(after.status, 'AWAITING_APPROVAL', 'the execution plan is a new thing to approve');
  assert.notStrictEqual(after.planHash, planned.planHash, 'a different plan must not reuse the approved hash');
  assert.strictEqual(after.revision, 2);
  assert(after.assignments.some((item) => item.write), 'execution is where write access appears');

  const leader = runner.get(after.assignments.find((item) => item.write).taskId);
  assert(leader.prompt.includes('DELIBERATED PLAN'),
    'the merged plan has to reach the specialist, not just the run record');
  assert(leader.prompt.includes('Write the manifest before moving a byte'));

  // The next similar run recalls it rather than paying for the same discussion.
  const repeat = coordinator.submit({ prompt: `${goal} once more`, cwd: project });
  assert.strictEqual(repeat.stage, 'execution', 'a recalled plan skips the discussion entirely');
  assert.strictEqual(repeat.deliberation.source, 'memory');

  // A discussion that returns nothing usable must not strand the work.
  const mute = new CoreExecutionCoordinator({
    taskRunner: new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      child.kill = () => {};
      queueMicrotask(() => { child.stdout.end('I have no opinion.\n'); child.exitCode = 0; child.emit('close', 0, null); });
      return child;
    } }),
    registry: new ModelCapabilityRegistry({ root: path.join(root, 'capability-2') }),
    memory: new deliberate.DeliberationMemory({ root: path.join(root, 'coordinator-2') }),
    skills: { scan() {}, brief() { return ''; } },
    settingsProvider: () => ({ routing: { deliberationLenses: 2 }, quality: { gate: 'strict' } }),
  });
  const muteRun = mute.submit({ prompt: goal, cwd: project });
  const degraded = new Promise((resolve) => mute.on('run', (event) => { if (event.kind === 'deliberated') resolve(event); }));
  mute.approve(muteRun.id, { disclosureHash: muteRun.disclosureHash, planHash: muteRun.planHash, revision: muteRun.revision });
  const fallback = await degraded;
  assert.strictEqual(fallback.stage, 'execution');
  assert.strictEqual(fallback.deliberation, null);
  assert.match(fallback.notes.join(' '), /no usable steps/, 'the owner is told the discussion produced nothing');

  // Off by settings means off — no stage, no cost.
  const direct = new CoreExecutionCoordinator({
    taskRunner: new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => fakeChild() }),
    registry: new ModelCapabilityRegistry({ root: path.join(root, 'capability-3') }),
    memory: new deliberate.DeliberationMemory({ root: path.join(root, 'coordinator-3') }),
    skills: { scan() {}, brief() { return ''; } },
    settingsProvider: () => ({ routing: { deliberationLenses: 0 }, quality: { gate: 'strict' } }),
  }).submit({ prompt: goal, cwd: project });
  assert.strictEqual(direct.stage, 'execution');
  assert.strictEqual(direct.deliberation, undefined);

  // ---- a provider that cannot start should not win the role ------------------
  // Scoring used to ignore availability entirely, so a provider with no credential
  // took the assignment and died at spawn — a full plan-approve-fail-repair cycle
  // spent discovering something knowable before planning.
  const coordinatorWith = (available) => new CoreExecutionCoordinator({
    taskRunner: new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => fakeChild() }),
    registry: new ModelCapabilityRegistry({ root: path.join(root, `cap-${Math.abs(String(available).length)}-${Date.now().toString(36)}`) }),
    memory: new deliberate.DeliberationMemory({ root: path.join(root, 'no-recall', String(Date.now())) }),
    skills: { scan() {}, brief() { return ''; } },
    settingsProvider: () => ({ routing: { deliberationLenses: 0, maxAgents: 5 }, quality: { gate: 'strict' } }),
    available,
  });
  const onlyGlm = coordinatorWith((provider) => provider === 'glm')
    .submit({ prompt: 'Fix the null check and verify the daemon build', cwd: project });
  assert(onlyGlm.assignments.every((item) => item.provider === 'glm'),
    'every role must land on the one provider that can actually start');
  const noneAvailable = coordinatorWith(() => false)
    .submit({ prompt: 'Fix the null check and verify the daemon build', cwd: project });
  assert(noneAvailable.assignments.length >= 1,
    'with nothing available, plan anyway and fail loudly — never silently produce no run');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('deliberation selftest: PASS · marker parsing survives cleanText · code-merged consensus · recall dedup · degrades when mute · off means off · unstartable providers deprioritised');
})().catch((error) => { console.error(error); process.exitCode = 1; });
