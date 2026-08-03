'use strict';

// Step ⑥ of the owner's workflow: 「レポートと一緒にオーナーに見せる」.
//
// A finished run produced N separate outputs and no summary. The owner read each
// provider's answer in turn and worked out for themselves whether the thing they
// asked for had actually happened — across up to five providers, two of which may
// have been stand-ins for a third.
//
// What this report is allowed to contain is the point. Only measurements: who ran,
// whether they finished, how long they took, what they actually consumed, and the
// first line each of them wrote. Nothing is combined and nothing is inferred.
// Merging several providers' edits automatically has no working precedent — the
// tools that do parallel execution all stop at "a human reviews the diffs" — and a
// report that implied otherwise would be the most expensive kind of wrong.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { renderEvent } = require('../src/cli/tui/transcript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-report-'));
let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

/** A coordinator whose task runner returns whatever the test says each task did. */
function build(tasks = {}) {
  return new CoreExecutionCoordinator({
    taskRunner: Object.assign(new EventEmitter(), {
      get: (id) => tasks[id] || {},
      plan: (spec) => ({ id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }),
    }),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) }),
    available: () => true,
  });
}

ok('the report is measurements, and an absent measurement is absent', () => {
  const coordinator = build({
    't-leader': { startedAt: '2026-08-03T10:00:00Z', finishedAt: '2026-08-03T10:00:42Z',
      tokens: { input: 21000, output: 324 }, output: '{"json":"noise"}\nSplit the change across three files; tests pass.' },
    't-debug': { startedAt: '2026-08-03T10:00:00Z', finishedAt: '2026-08-03T10:00:38Z', tokens: {}, output: 'No regressions found.' },
  });
  const run = {
    id: 'run-1', status: 'COMPLETED', startedAt: '2026-08-03T10:00:00Z', finishedAt: '2026-08-03T10:03:04Z',
    promptSpec: { goal: 'fix the footer' }, repairCycle: 1, quality: { checks: [{ id: 'specialists', pass: true }, { id: 'maker-checker', pass: false }] },
    assignments: [
      { taskId: 't-leader', role: 'leader', provider: 'glm', homeProvider: 'claude-code', model: 'glm-5.2', status: 'completed', write: true },
      { taskId: 't-debug', role: 'debug', provider: 'glm', homeProvider: 'glm', status: 'completed', write: false },
    ],
  };
  const report = coordinator.buildReport(run);
  assert.equal(report.completed, 2);
  assert.equal(report.total, 2);
  assert.equal(report.ms, 184000, 'wall clock, from the run that was measured');
  assert.equal(report.rows[0].tokens, 21324, 'what the provider actually reported');
  assert.equal(report.rows[1].tokens, null,
    'a provider whose usage was never reported did not use zero — this project shipped that mistake once already');
  assert.equal(report.rows[0].ms, 42000);
  assert.equal(report.rows[0].headline, 'Split the change across three files; tests pass.',
    'the first line a human wrote, not the JSON envelope around it');
  assert.equal(report.rows[0].standInFor, 'claude-code', 'a stand-in is named, because the owner did not choose it');
  assert.equal(report.rows[1].standInFor, '', 'and a provider doing its own job is not');
  assert.deepEqual(report.checks, [{ id: 'specialists', pass: true }, { id: 'maker-checker', pass: false }]);
  assert.equal(report.repairs, 1);
});

ok('what each provider put on disk, and where two of them collided', () => {
  // The one thing this report exists to catch. leader (claude-code) and ui (codex) both
  // carry write:true, share one working directory, and are separated only by wording in
  // their prompts — "index.html and app.css only" / "game.js only" — which is a request,
  // not a boundary. When both touched a file the later writer won and nothing said so.
  const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
  const coordinator = build({
    't-leader': { startedAt: '2026-08-04T10:00:00Z', finishedAt: '2026-08-04T10:00:42Z', output: 'split it up',
      edits: new Map([['src/app.js', { writes: 2, added: 12, removed: 3 }], ['src/ui.css', { writes: 1, added: 4, removed: 0 }]]) },
    't-ui': { startedAt: '2026-08-04T10:00:00Z', finishedAt: '2026-08-04T10:00:38Z', output: 'styled it',
      edits: new Map([['src/app.js', { writes: 1, added: null, removed: null }]]) },
    't-debug': { startedAt: '2026-08-04T10:00:00Z', finishedAt: '2026-08-04T10:00:20Z', output: 'tests pass' },
  });
  coordinator.taskRunner.changedFiles = TaskRunner.prototype.changedFiles;
  const report = coordinator.buildReport({
    id: 'run-4', status: 'COMPLETED', quality: { checks: [] }, assignments: [
      { taskId: 't-leader', role: 'leader', provider: 'claude-code', status: 'completed', write: true },
      { taskId: 't-ui', role: 'ui', provider: 'codex', status: 'completed', write: true },
      { taskId: 't-debug', role: 'debug', provider: 'glm', status: 'completed', write: false },
    ],
  });
  assert.deepStrictEqual(report.rows[0].changed.map((change) => change.path), ['src/app.js', 'src/ui.css']);
  assert.strictEqual(report.rows[0].changed[0].added, 12, 'claude reports line counts and they are kept');
  assert.strictEqual(report.rows[1].changed[0].added, null,
    'codex names its files but reports no line counts, and an absent measurement stays absent');
  assert.deepStrictEqual(report.rows[2].changed, [], 'a read-only role changed nothing');
  assert.strictEqual(report.collisions.length, 1);
  assert.strictEqual(report.collisions[0].path, 'src/app.js');
  assert.deepStrictEqual(report.collisions[0].writers.map((writer) => writer.role), ['leader', 'ui']);

  // A file only one of them wrote is not a collision, and neither is a reader.
  assert.ok(!report.collisions.some((hit) => hit.path === 'src/ui.css'));

  const text = renderEvent('report', report, { width: 88 }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(text, /2 files · \+16 -3/, 'the owner is told how much, per provider');
  assert.match(text, /1 file · — —/, 'and a dash where nothing was measured');
  assert.match(text, /same file, two writers: src\/app\.js \(leader \+ ui\)/);
  assert.ok(!/\+0 -0/.test(text), 'never a fabricated zero');
});

ok('a failure says why, in the report rather than only in a log', () => {
  const coordinator = build({ 't-ui': { startedAt: '2026-08-03T10:00:00Z', finishedAt: '2026-08-03T10:00:09Z', failureReason: '', error: '401 Unauthorized\nstack…' } });
  const report = coordinator.buildReport({
    id: 'run-2', status: 'FAILED', quality: { checks: [] }, assignments: [
      { taskId: 't-ui', role: 'ui', provider: 'codex', status: 'failed', write: true },
    ],
  });
  assert.equal(report.completed, 0);
  assert.equal(report.rows[0].error, '401 Unauthorized', 'first line only — a stack trace is not a report');
  assert.equal(report.rows[0].tokens, null);
});

ok('BigKiji’s own findings travel with the row they are about', () => {
  const coordinator = build({ 't-a': { startedAt: '2026-08-03T10:00:00Z', finishedAt: '2026-08-03T10:00:05Z', output: 'done' } });
  const report = coordinator.buildReport({
    id: 'run-3', status: 'COMPLETED', quality: { checks: [] }, assignments: [
      { taskId: 't-a', role: 'leader', provider: 'glm', status: 'completed', write: true,
        review: { findings: [{ id: 'unverified', note: 'no sign that anything was run' }] } },
    ],
  });
  assert.deepEqual(report.rows[0].findings, ['unverified']);
});

ok('nothing in the report is combined or invented', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
  const body = source.slice(source.indexOf('  buildReport(run) {'), source.indexOf('  _fallback(run, assignment) {'));
  // No model is asked to summarise, and no output is concatenated into a single
  // answer: that is the step with no working precedent.
  for (const term of ['fetch', 'ConversationEngine', 'concat', 'join(\'\\n\')']) {
    assert.ok(!body.includes(term), `buildReport must not ${term}`);
  }
  assert.ok(!/approve|planHash|disclosureHash|_seal/.test(body), 'and it must not reach the approval gate');
});

ok('the owner reads it as one block', () => {
  const lines = renderEvent('report', {
    runId: 'run-1', status: 'COMPLETED', completed: 2, total: 3, ms: 184000, tokens: 21335, repairs: 1,
    checks: [{ id: 'specialists', pass: true }, { id: 'maker-checker', pass: false }],
    rows: [
      { role: 'leader', provider: 'glm', status: 'completed', ms: 42000, tokens: 21324, headline: 'Split the change across three files.', standInFor: 'claude-code' },
      { role: 'debug', provider: 'glm', status: 'completed', ms: 38000, tokens: 11, headline: 'No regressions found.' },
      { role: 'ui', provider: 'codex', status: 'failed', ms: 9000, tokens: null, error: '401 Unauthorized' },
    ],
  }, { width: 88 }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const text = lines.join('\n');
  assert.match(text, /report\(2\/3 done · completed · 184s · 21335 tok\)/);
  assert.match(text, /leader · glm \(for claude-code\)/, 'the owner is told who actually did it');
  assert.match(text, /401 Unauthorized/);
  assert.match(text, /not verified: maker-checker/, 'an unmet check is the point of a report');
  assert.match(text, /repair cycles: 1/);
  assert.match(text, /9s —$/m, 'an unreported token count is a dash, not a zero');
  assert.ok(!/0 tok/.test(text), 'and never a fabricated zero');
  for (const line of lines) assert.ok(line.replace(/\s+$/, '').length <= 88, `overflows: ${JSON.stringify(line)}`);
  // Unboxed, like the rest of the transcript — the owner asked for that by name.
  for (const line of lines) assert.ok(!/[╭╮╰╯│]/.test(line));
});

ok('it is published and recorded, not just built', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(daemon, /this\.coordinator\.on\('report'/);
  assert.match(daemon, /this\.publish\('report', report\)/);
  assert.match(daemon, /type: 'report', \.\.\.report/, 'the session keeps it, so /resume can show it again');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'bigkiji-cli.js'), 'utf8');
  assert.match(cli.match(/const RELAY_EVENTS = \[([^\]]*)\]/)[1], /'report'/);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`run report selftest: ${failures} FAILED`); process.exit(1); }
console.log('run report selftest: PASS · measurements only · an absent number is a dash · stand-ins named · failures say why · nothing combined · per-provider file changes · two writers on one file are named · one block');
