'use strict';

// Thirty minutes is a checkpoint, not a guillotine.
//
// The owner's decision, 2026-08-03: 「期限で区切って途中経過を出す」. Killing work at
// the half-hour mark throws away whatever it had finished; saying nothing at the
// half-hour mark is how a run quietly eats an afternoon. Before this there was no
// run-level deadline at all — only a 900s per-task timeout — so a run that stalled
// produced no signal of any kind until someone went looking.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { renderEvent } = require('../src/cli/tui/transcript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-budget-'));
const build = () => {
  const tasks = new Map();
  return new CoreExecutionCoordinator({
    taskRunner: Object.assign(new EventEmitter(), {
      get: (id) => tasks.get(id) || {}, approve: () => ({}),
      plan: (spec) => { const task = { id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' }, metadata: spec.metadata }; tasks.set(spec.id, task); return task; },
    }),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) }),
    available: () => true,
  });
};

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

ok('the deadline reports and the run keeps going', () => {
  const c = build();
  const submitted = c.submit({ prompt: 'long job', cwd: '/tmp', mode: 'plan' });
  const run = c.runs.get(submitted.id);
  run.status = 'EXECUTING';
  run.deadlineAt = new Date(Date.now() - 60000).toISOString();
  run.assignments[0].status = 'completed';
  run.assignments[1].status = 'running';

  const reports = [];
  c.on('checkpoint', (report) => reports.push(report));
  c._reportProgress(run);

  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].completed, [`${run.assignments[0].role} · ${run.assignments[0].provider}`]);
  assert.deepEqual(reports[0].stillRunning, [`${run.assignments[1].role} · ${run.assignments[1].provider}`]);
  assert.equal(reports[0].budgetMinutes, 30, 'the owner chose thirty minutes');
  assert.equal(reports[0].overdueMinutes, 1);
  assert.equal(c.runs.get(submitted.id).status, 'EXECUTING', 'a checkpoint must not kill the work it is reporting on');
  clearTimeout(run.deadlineTimer);
});

ok('a finished run is not reported on', () => {
  const c = build();
  const submitted = c.submit({ prompt: 'done job', cwd: '/tmp', mode: 'plan' });
  const run = c.runs.get(submitted.id);
  run.deadlineAt = new Date(Date.now() - 60000).toISOString();
  const reports = [];
  c.on('checkpoint', (report) => reports.push(report));
  for (const status of ['COMPLETED', 'FAILED', 'EXPIRED']) { run.status = status; c._reportProgress(run); }
  run.status = 'EXECUTING'; run.aborting = true; c._reportProgress(run);
  assert.equal(reports.length, 0, 'nothing that has stopped needs a progress report');
});

ok('it keeps reporting instead of going quiet again', () => {
  const c = build();
  const submitted = c.submit({ prompt: 'stalled job', cwd: '/tmp', mode: 'plan' });
  const run = c.runs.get(submitted.id);
  run.status = 'EXECUTING'; run.deadlineAt = new Date(Date.now() - 60000).toISOString();
  c._reportProgress(run);
  assert.ok(run.deadlineTimer, 'one report and then silence is the failure this replaces');
  c._reportProgress(run); c._reportProgress(run);
  assert.equal(run.progressReports.length, 3);
  for (let i = 0; i < 8; i += 1) c._reportProgress(run);
  assert.ok(run.progressReports.length <= 6, 'and the history is bounded, not another map that only grows');
  clearTimeout(run.deadlineTimer);
});

ok('a live timer never reaches a response body', () => {
  // publicRun spreads the run. A Timeout carries a handle, a socket list and the
  // callback's closure, and this object goes over WebSocket and SSE on every event.
  const c = build();
  const submitted = c.submit({ prompt: 'serialise me', cwd: '/tmp', mode: 'plan' });
  const run = c.runs.get(submitted.id);
  run.status = 'EXECUTING'; run.deadlineAt = new Date(Date.now() + 60000).toISOString();
  c._armDeadline(run);
  assert.ok(run.deadlineTimer, 'the timer exists on the private object');
  assert.ok(!('deadlineTimer' in submitted));
  assert.doesNotThrow(() => JSON.stringify(c.approve ? submitted : submitted));
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
  assert.match(source, /const \{ prompt, deadlineTimer, \.\.\.safe \} = run;/);
  clearTimeout(run.deadlineTimer);
});

ok('the owner sees it as a checkpoint they can act on', () => {
  const lines = renderEvent('checkpoint', { runId: 'run-1', completed: ['leader · claude-code'], stillRunning: ['ui · codex'], budgetMinutes: 30, overdueMinutes: 4 }, { width: 78 });
  const text = lines.join('\n');
  assert.match(text, /checkpoint/);
  assert.match(text, /1\/2 done · 34m/, 'how far in, and how far along');
  assert.match(text, /still running: ui · codex/);
  assert.match(text, /\/abort/, 'a report with no way to act on it is just noise');
  const idle = renderEvent('checkpoint', { completed: [], stillRunning: [], budgetMinutes: 30, overdueMinutes: 0 }, { width: 78 }).join('\n');
  assert.match(idle, /nothing is running/, 'a stalled run says so rather than showing an empty list');
});

ok('the footer says what is happening, not what was answered', () => {
  // It reached for data.reply first, so it re-printed the answer already sitting in
  // the transcript two lines above — clipped mid-word, in Japanese, next to an
  // English status word.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'bigkiji-cli.js'), 'utf8');
  assert.match(cli, /const text = data\.phase \|\| data\.status \|\| data\.action/);
  assert.ok(!/const text = data\.reply \|\|/.test(cli));
  assert.match(cli, /'checkpoint'\]/, 'and the checkpoint has to reach the transcript at all');
});

ok('the bottom row says what the fleet is doing, and stays quiet when it is not', () => {
  const { workSegment, buildFooter } = require('../src/cli/tui/footer');
  const now = Date.now();
  assert.equal(workSegment({ runs: [] }), '', 'an idle machine reporting its idleness every 67ms stops being read');
  assert.equal(workSegment({ runs: [{ status: 'AWAITING_APPROVAL' }, { status: 'AWAITING_APPROVAL' }] }), '2 awaiting /approve');
  const running = { status: 'EXECUTING', startedAt: new Date(now - 8 * 60000).toISOString(),
    deadlineAt: new Date(now + 22 * 60000).toISOString(), assignments: [{ status: 'completed' }, { status: 'running' }, { status: 'queued' }] };
  assert.equal(workSegment({ runs: [running] }), '1/3 · 8m · 22m left', 'what, how far, how long left');
  const late = { ...running, startedAt: new Date(now - 37 * 60000).toISOString(), deadlineAt: new Date(now - 7 * 60000).toISOString() };
  assert.match(workSegment({ runs: [late] }), /7m over$/, 'past the mark it says so rather than counting down past zero');
  // Waiting for the owner is not the machine being busy — that conflation is why
  // the phase bar read 92% for a run that had not started.
  assert.equal(workSegment({ runs: [{ status: 'AWAITING_APPROVAL' }, running] }), '1/3 · 8m · 22m left');

  const wide = buildFooter({ cols: 100, mode: 'plan', state: { runs: [running] } });
  assert.match(wide.lines.at(-1).replace(/\x1b\[[0-9;]*m/g, ''), /work: 1\/3 · 8m · 22m left/);
  const narrow = buildFooter({ cols: 52, mode: 'plan', state: { runs: [running] } });
  const plainNarrow = narrow.lines.at(-1).replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(!plainNarrow.includes('work:'), 'the newest segment is the first one a narrow terminal drops');
  assert.ok(plainNarrow.includes('mode:'), 'and the row it shares does not break');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`run budget selftest: ${failures} FAILED`); process.exit(1); }
console.log('run budget selftest: PASS · 30 minutes reports and does not kill · keeps reporting · history bounded · no live timer in a response · actionable on screen');
