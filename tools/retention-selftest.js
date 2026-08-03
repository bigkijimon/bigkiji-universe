'use strict';

// Nothing here grows forever, and off means off.
//
// Six maps in this daemon had no delete anywhere in the codebase — tasks,
// taskToRun, runSessions, taskRecords and two readers keyed by task id — so they
// held one entry per task for the life of the process, and the daemon runs for
// days. On top of that the fleet store walked its own map five separate times on
// every task event, which is quadratic in the number of tasks over a session.
//
// The rule for every cap below: work that is still queued, running or waiting for
// the owner is never dropped. Only what has already ended is forgotten, oldest
// first, and enough of it is kept that /status and the report still read.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { ModelStatusStore } = require('../src/domain/hud/model-status-store');
const { NaturalTTSService } = require('../src/core/natural-tts-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-retention-'));
let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

ok('finished tasks are forgotten, live ones never are', () => {
  const runner = new TaskRunner({ cwd: root });
  for (let i = 0; i < 260; i += 1) {
    runner.tasks.set(`t${i}`, { id: `t${i}`, status: 'completed', finishedAt: new Date(Date.now() + i).toISOString() });
  }
  runner.tasks.set('live', { id: 'live', status: 'running' });
  runner.tasks.set('queued', { id: 'queued', status: 'queued' });
  runner.tasks.set('waiting', { id: 'waiting', status: 'awaiting_approval' });
  runner.forgetOldTasks();
  assert.equal(runner.tasks.size, 203, `200 finished plus the three that have not: ${runner.tasks.size}`);
  for (const id of ['live', 'queued', 'waiting']) {
    assert.ok(runner.tasks.has(id), `${id} work must survive — dropping it would lose the run`);
  }
  assert.ok(!runner.tasks.has('t0'), 'oldest first');
  assert.ok(runner.tasks.has('t259'), 'and the most recent are what /status reads');
});

ok('the indexes that point at a task go with it', () => {
  const runner = new TaskRunner({ cwd: root });
  runner.tasks.set('gone', { id: 'gone', status: 'completed', finishedAt: '2020-01-01T00:00:00Z' });
  runner.stepReaders.set('gone', {}); runner.completions.set('gone', {});
  for (let i = 0; i < 200; i += 1) runner.tasks.set(`k${i}`, { id: `k${i}`, status: 'completed', finishedAt: '2030-01-01T00:00:00Z' });
  const forgotten = [];
  runner.on('forgotten', (event) => forgotten.push(event.taskId));
  runner.forgetOldTasks();
  assert.ok(!runner.tasks.has('gone'));
  assert.ok(!runner.stepReaders.has('gone'), 'a reader keyed by a task id outlives the task otherwise');
  assert.ok(!runner.completions.has('gone'));
  assert.deepEqual(forgotten, ['gone'], 'and it says so, rather than silently shrinking');
});

ok('a forgotten run takes its task index with it', () => {
  // taskToRun had no delete at all, so every task id this coordinator ever saw
  // stayed in it — including ones whose run was already gone. A map of dangling
  // pointers that only grows.
  const coordinator = new CoreExecutionCoordinator({
    taskRunner: Object.assign(new EventEmitter(), { get: () => ({}), plan: (spec) => ({ id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }) }),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) }), available: () => true,
  });
  const submitted = coordinator.submit({ prompt: 'a job', cwd: '/tmp', mode: 'plan' });
  const run = coordinator.runs.get(submitted.id);
  const ids = run.assignments.map((assignment) => assignment.taskId);
  for (const id of ids) assert.ok(coordinator.taskToRun.has(id));
  coordinator.forgetRun(run);
  assert.ok(!coordinator.runs.has(submitted.id));
  for (const id of ids) assert.ok(!coordinator.taskToRun.has(id), `${id} still points at a run that is gone`);
});

ok('finished runs are capped, unfinished ones are not', () => {
  const coordinator = new CoreExecutionCoordinator({
    taskRunner: Object.assign(new EventEmitter(), { get: () => ({}), plan: (spec) => ({ id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }) }),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r2-')) }), available: () => true,
  });
  for (let i = 0; i < 70; i += 1) {
    coordinator.runs.set(`done${i}`, { id: `done${i}`, status: 'COMPLETED', finishedAt: new Date(Date.now() + i).toISOString(), assignments: [] });
  }
  coordinator.runs.set('waiting', { id: 'waiting', status: 'AWAITING_APPROVAL', assignments: [] });
  coordinator.runs.set('running', { id: 'running', status: 'EXECUTING', assignments: [] });
  coordinator.forgetOldRuns();
  assert.equal(coordinator.runs.size, 52, `50 finished plus the two that are not: ${coordinator.runs.size}`);
  assert.ok(coordinator.runs.has('waiting'), 'a run the owner has not answered is not finished');
  assert.ok(coordinator.runs.has('running'));
});

ok('the fleet store is walked once per event, not five times', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'hud', 'model-status-store.js'), 'utf8');
  const body = source.slice(source.indexOf('  ingestTask(task = {}) {'), source.indexOf('  ingestRun('));
  const walks = (body.match(/\[\.\.\.this\.taskRecords\.values\(\)\]/g) || []).length
    + (body.match(/this\._savedFor\(/g) || []).length;
  assert.ok(walks <= 1, `this walked the map five times per event; at most one fallback remains: ${walks}`);
  assert.match(body, /for \(const row of this\.taskRecords\.values\(\)\)/, 'one pass');

  // And the numbers it produces are unchanged.
  const store = new ModelStatusStore({});
  for (let i = 0; i < 5; i += 1) {
    store.ingestTask({ id: `t${i}`, provider: 'glm', status: i < 3 ? 'completed' : 'running',
      tokens: { input: 10, output: 2 }, startedAt: new Date().toISOString(),
      context: { measurement: 'actual', tokensSaved: 5, includedFiles: ['a'] } });
  }
  const glm = store.snapshot().models.find((model) => model.id === 'glm');
  assert.equal(glm.metrics.tokensUsed, 60);
  assert.equal(glm.metrics.filesHandled, 5);
  assert.equal(glm.status, 'EXECUTING', 'a running task still shows as running');
});

ok('task records are capped, and a running one is never the entry dropped', () => {
  const store = new ModelStatusStore({});
  for (let i = 0; i < 450; i += 1) {
    store.ingestTask({ id: `t${i}`, provider: 'glm', status: 'completed', tokens: {}, updatedAt: new Date(Date.now() + i).toISOString() });
  }
  store.ingestTask({ id: 'live', provider: 'glm', status: 'running', tokens: {}, updatedAt: new Date().toISOString() });
  store.ingestTask({ id: 'newest', provider: 'glm', status: 'completed', tokens: {}, updatedAt: new Date(Date.now() + 99999).toISOString() });
  assert.ok(store.taskRecords.size <= 401, `capped: ${store.taskRecords.size}`);
  assert.ok(store.taskRecords.has('live'), 'the numbers it feeds are the live ones');
  assert.ok(store.taskRecords.has('newest'));
  assert.ok(!store.taskRecords.has('t0'));
});

ok('switching the voice off actually stops the model', () => {
  // audio.enabled has been a setting all along and this service never read it, so
  // turning the voice off still started a Python process that loads a TTS model —
  // 1.4GB of venv on disk, a model in memory, for a feature switched off.
  const settings = (enabled) => ({ get: () => ({ audio: { enabled, ttsEndpoint: 'http://127.0.0.1:17890' } }) });
  const off = new NaturalTTSService({ appRoot: root, userData: root, settingsStore: settings(false) });
  return off.start().then(() => {
    assert.equal(off.proc, null, 'nothing is spawned');
    assert.equal(off.snapshot().state, 'off', 'and the status says why, rather than reading as broken');

    // And it stops what is already running, because by then the model is loaded.
    const live = new NaturalTTSService({ appRoot: root, userData: root, settingsStore: settings(true) });
    let killed = false;
    live.proc = { kill() { killed = true; } };
    live.settingsStore = settings(false);
    live.applySettings();
    assert.ok(killed || live.proc === null, 'a running voice server must stop when the switch is turned off');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
    assert.match(main, /ttsService\?\.applySettings\?\.\(\)/, 'and saving settings has to call it');
  });
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`retention selftest: ${failures} FAILED`); process.exit(1); }
console.log('retention selftest: PASS · finished work is forgotten oldest first · live work never is · indexes go with it · one pass not five · off means off');
