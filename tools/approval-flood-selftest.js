'use strict';

// Twenty-one plans waiting, six of them reachable.
//
// Every TASK turn submitted a run, so asking the same thing three different ways
// produced three identical plans all waiting for the owner. Nothing ever removed a
// run from the map — it had no delete in it at all — and the GUI showed the first
// six, so the seventh onwards had no approve button anywhere in the application.
// Measured on the owner's own data 2026-08-03: 27 assignments, 21 still awaiting.
//
// The approval gate itself is untouched. This is about which requests exist and
// which of them the owner can reach, not about what it takes to say yes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-flood-'));
const build = () => new CoreExecutionCoordinator({
  taskRunner: Object.assign(new EventEmitter(), { get: () => ({}), plan: (spec) => ({ id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }) }),
  registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) }),
  available: () => true,
});

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

ok('the same request asked twice waits once', () => {
  const c = build();
  const first = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode: 'plan' });
  const again = c.submit({ prompt: 'READMEのタイポを直してください。', cwd: '/tmp', mode: 'plan' });
  const spaced = c.submit({ prompt: 'README のタイポを  直してください', cwd: '/tmp', mode: 'plan' });
  assert.equal(again.id, first.id, 'a trailing 。 is not a different request');
  assert.equal(spaced.id, first.id, 'nor is a stray space, which is the likeliest difference in Japanese');
  assert.equal(c.runs.size, 1);
  assert.equal(c.runs.get(first.id).duplicateOf, 2, 'and the count of how many times it was asked is kept');
});

ok('different work still gets its own approval', () => {
  const c = build();
  const a = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode: 'plan' });
  const b = c.submit({ prompt: '別の作業をお願いします', cwd: '/tmp', mode: 'plan' });
  const elsewhere = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/other', mode: 'plan' });
  assert.notEqual(b.id, a.id, 'merging two different requests would lose one of them');
  assert.notEqual(elsewhere.id, a.id, 'the same words in another folder are another job');
  assert.equal(c.runs.size, 3);
});

ok('a run that has started is never merged into', () => {
  const c = build();
  const first = c.submit({ prompt: 'same request', cwd: '/tmp', mode: 'plan' });
  c.runs.get(first.id).status = 'EXECUTING';
  const second = c.submit({ prompt: 'same request', cwd: '/tmp', mode: 'plan' });
  assert.notEqual(second.id, first.id, 'work already running cannot absorb a new request');
});

ok('an unanswered approval expires instead of accumulating forever', () => {
  const c = build();
  const run = c.submit({ prompt: 'unanswered', cwd: '/tmp', mode: 'plan' });
  assert.equal(c.expireStaleApprovals(Date.now()), 0, 'a fresh plan is not stale');
  assert.equal(c.runs.size, 1);
  const events = [];
  c.on('run', (event) => events.push(event.kind));
  c.runs.get(run.id).updatedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  assert.equal(c.expireStaleApprovals(Date.now()), 1);
  assert.equal(c.runs.size, 0, 'this.runs had no delete in it at all — it only ever grew');
  assert.ok(events.includes('expired'), 'and the owner is told rather than the card silently vanishing');
});

ok('only waiting approvals expire', () => {
  const c = build();
  const run = c.submit({ prompt: 'running work', cwd: '/tmp', mode: 'plan' });
  c.runs.get(run.id).status = 'EXECUTING';
  c.runs.get(run.id).updatedAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  assert.equal(c.expireStaleApprovals(Date.now()), 0, 'a long-running job is not an unanswered question');
  assert.equal(c.runs.size, 1);
});

ok('the GUI shows every approval, and caps only what is finished', () => {
  // A completed card falling off the end costs nothing. An approval falling off the
  // end costs the whole run, because there is no other way to start it.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'components', 'multi-terminal-manager.js'), 'utf8');
  assert.ok(!/\.reverse\(\)\.slice\(0, 6\)/.test(source), 'a flat cap hid the seventh waiting run from the whole application');
  assert.match(source, /const waiting = visible\.filter\(\(run\) => run\.status === 'AWAITING_APPROVAL'\)/);
  assert.match(source, /Math\.max\(0, 6 - waiting\.length\)/);
  assert.match(source, /run\.status === 'AWAITING_APPROVAL'\s*\n\s*&& !window\.confirm/,
    'dismissing a waiting run looked like "later" and meant "never this session" — it has to ask');
});

ok('the approval gate is not what changed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
  const dedupe = source.slice(source.indexOf('findWaitingDuplicate(text, cwd)'), source.indexOf('expireStaleApprovals'));
  for (const term of ['approve', 'disclosureHash', 'planHash', '_seal']) {
    assert.ok(!new RegExp(`\\b${term}\\b`).test(dedupe), `deduplication must not reach ${term}`);
  }
});

// ---------------------------------------------------------------------------
// Which runs have to wait at all (2026-08-04)
//
// Two runs sat untouched for eleven hours and both were read-only: `write: false` on
// every assignment, a pair of lenses that read the repository and argue about the
// approach. They were held by a gate whose own comment said it existed for
// "every mutation-capable run", and the code waited for every run full stop.
//
// The owner's decision that day: reading starts on its own, writing waits, and which of
// plan / ask / auto-edit you are in decides how long. These assertions are the shape of
// that decision — including the two that must never move, which are that a blocked run
// is not released by anything and that approve() still refuses a stale hash.
// ---------------------------------------------------------------------------

// A runner whose planned tasks can be marked blocked, so the security path is reachable.
const gateRunner = ({ blocked = false } = {}) => Object.assign(new EventEmitter(), {
  approved: [],
  get() { return { status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }; },
  plan(spec) { return { id: spec.id, status: blocked ? 'blocked' : 'awaiting_approval', disclosure: { disclosureHash: 'h' } }; },
  approve(id) { this.approved.push(id); },
});
const gateCoordinator = (options) => new CoreExecutionCoordinator({
  taskRunner: gateRunner(options),
  registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'g-')) }),
  available: () => true,
});
// Long enough and substantial enough that deliberation.needed() fires, which is what
// produces the read-only stage the owner was stranded behind.
// deliberation.needed() wants >= 120 characters as well as the substantial-work
// vocabulary, so this fixture is long on purpose. The assertion below checks the stage
// it produced rather than trusting the length.
const RESEARCH = 'BKU V3 の conversation UI を再構築します。セッション履歴・作業工程のリアルタイム表示・成果物ウィンドウを設計し、既存実装を分析してください。'
  + '既存のコードを読み、どこを再利用できるかを洗い出し、依存関係と検証方法まで整理してください。';

ok('a read-only stage starts without asking', () => {
  const c = gateCoordinator();
  const run = c.submit({ prompt: RESEARCH, cwd: '/tmp', mode: 'plan' });
  assert.equal(run.stage, 'deliberation', 'the fixture has to reach the lens stage or this proves nothing');
  assert.ok(run.assignments.every((item) => item.write === false), 'and every lens must be read-only');
  assert.equal(run.status, 'EXECUTING', 'reading changes nothing, so it does not wait — even in plan mode');
});

ok('a run that writes waits in plan and in ask', () => {
  for (const mode of ['plan', 'ask']) {
    const c = gateCoordinator();
    const run = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode });
    assert.equal(run.stage, 'execution');
    assert.ok(run.assignments.some((item) => item.write !== false), `${mode}: the fixture must contain a writer`);
    assert.equal(run.status, 'AWAITING_APPROVAL', `${mode} must stop before anything writes`);
  }
});

ok('auto-edit releases the same writing run', () => {
  const c = gateCoordinator();
  const run = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode: 'auto' });
  assert.equal(run.status, 'EXECUTING', 'this is the first time the mode has changed anything');
  assert.ok(run.startedAt, 'and a released run is actually started, not just relabelled');
});

ok('a blocked run is released by nothing', () => {
  for (const mode of ['plan', 'ask', 'auto']) {
    const c = gateCoordinator({ blocked: true });
    const run = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode });
    assert.equal(run.status, 'SECURITY_BLOCKED', `${mode} must not talk its way past the sandbox`);
    assert.ok(!run.startedAt, 'and nothing was dispatched');
  }
});

ok('approve() still refuses what it always refused', () => {
  const c = gateCoordinator();
  const run = c.submit({ prompt: 'READMEのタイポを直してください', cwd: '/tmp', mode: 'plan' });
  assert.throws(() => c.approve(run.id, { revision: run.revision + 1, planHash: run.planHash, disclosureHash: run.disclosureHash }), /STALE_RUN_REVISION/);
  assert.throws(() => c.approve(run.id, { revision: run.revision, planHash: 'nope', disclosureHash: run.disclosureHash }), /STALE_PLAN_HASH/);
  assert.throws(() => c.approve(run.id, { revision: run.revision, planHash: run.planHash, disclosureHash: '' }), /STALE_DISCLOSURE_HASH/);
  const started = c.approve(run.id, { revision: run.revision, planHash: run.planHash, disclosureHash: run.disclosureHash });
  assert.equal(started.status, 'EXECUTING', 'and the correct hashes still start it');
});

// ---------------------------------------------------------------------------
// A plan written after nothing must say so.
//
// The owner watched both lenses die in the live stream — one model-unavailable, one
// 429 — and the run still presented its plan for approval with no sign that the
// groundwork behind it had produced zero results. Approving a plan informed by two
// lenses and approving one informed by none are different decisions, and the screen
// could not tell them apart.
// ---------------------------------------------------------------------------

// Every lens fails, with the two reasons the owner actually saw.
const deadLensRunner = () => {
  const tasks = new Map();
  const reasons = ['Model "qwen3.5:35b-a3b" not found', '429 rate-limit'];
  return Object.assign(new EventEmitter(), {
    get(id) { return tasks.get(id) || null; },
    plan(spec) {
      const task = { id: spec.id, status: 'failed', output: '',
        error: reasons[tasks.size % reasons.length], disclosure: { disclosureHash: 'h' } };
      tasks.set(spec.id, task);
      return task;
    },
    approve() {},
  });
};

ok('a plan written after zero groundwork says so, with the reasons', () => {
  const c = new CoreExecutionCoordinator({
    taskRunner: deadLensRunner(),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'd-')) }),
    available: () => true,
  });
  const run = c.submit({ prompt: RESEARCH, cwd: '/tmp', mode: 'plan' });
  assert.equal(run.stage, 'deliberation', 'the fixture has to reach the lens stage or this proves nothing');
  const lenses = run.assignments.length;
  c._concludeDeliberation(run);

  assert.ok(run.groundwork, 'the run has to carry what the groundwork produced');
  assert.equal(run.groundwork.lenses, lenses);
  assert.equal(run.groundwork.completed, 0, 'no lens completed');
  assert.equal(run.groundwork.failures.length, lenses, 'every failure is accounted for, not just counted');
  // The reason is carried through verbatim, not flattened to "failed": a missing model
  // and a rate limit are different problems with different answers.
  assert.ok(run.groundwork.failures.some((item) => /not found/i.test(item.reason)),
    `the model-unavailable reason survives: ${JSON.stringify(run.groundwork.failures)}`);
  assert.ok(run.groundwork.failures.some((item) => /rate-limit/i.test(item.reason)),
    'and so does the rate limit');
  const note = (run.notes || []).join(' | ');
  assert.match(note, /No groundwork: 0 of \d+ lenses completed/, `the note states the fact: ${note}`);
  assert.match(note, /written without any of it/, 'and says what it means for the plan below');
});

ok('a deliberation that ran but said nothing is a different sentence', () => {
  const quiet = () => {
    const tasks = new Map();
    return Object.assign(new EventEmitter(), {
      // Completed, with output — but nothing consolidate() can turn into steps.
      get(id) { return tasks.get(id) || null; },
      plan(spec) {
        const task = { id: spec.id, status: 'completed', output: '...', error: '', disclosure: { disclosureHash: 'h' } };
        tasks.set(spec.id, task); return task;
      },
      approve() {},
    });
  };
  const c = new CoreExecutionCoordinator({
    taskRunner: quiet(),
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'q-')) }),
    available: () => true,
  });
  const run = c.submit({ prompt: RESEARCH, cwd: '/tmp', mode: 'plan' });
  c._concludeDeliberation(run);
  assert.ok(run.groundwork.completed > 0, 'these lenses did answer');
  const note = (run.notes || []).join(' | ');
  if (note) assert.doesNotMatch(note, /No groundwork/,
    'lenses that answered must never be reported as lenses that never ran');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`approval flood selftest: ${failures} FAILED`); process.exit(1); }
console.log('approval flood selftest: PASS · one request waits once · different work stays separate · unanswered plans expire · every approval reachable · reading starts itself · writing waits unless auto-edit · blocked stays blocked · stale hashes still refused · a plan built on no groundwork says so, with the real reasons');
