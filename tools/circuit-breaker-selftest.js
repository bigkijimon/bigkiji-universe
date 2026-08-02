'use strict';
// A provider that says "not now" has to be believed.
//
// The bug this guards against is quiet and expensive. BigKiji's fallback table is
// static, so when three assignments in a run all fail on the same exhausted
// quota, each of them proposes the same next provider, the owner approves three
// repairs, and all three walk into the same wall. Worse, every one of those
// failures used to be written into the routing penalty table, where it outlived
// the outage: a provider that was merely busy for an afternoon carried the mark
// for every routing decision afterwards.
//
// Everything below is asserted against injected time, so the cooldowns are
// exercised in full without the test taking fifteen minutes to run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CircuitBreaker } = require('../src/domain/pi-agent/circuit-breaker');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { classifyFailure, retryAfterMs, ERROR_PATTERN } = require('../src/domain/pi-agent/model-router');
const { CoreExecutionCoordinator, FALLBACKS } = require('../src/domain/pi-agent/core-execution-coordinator');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; if (process.env.VERBOSE) console.log(`  ok  ${label}`); };

// A clock the test drives. Nothing in the breaker reads the real one.
function clock(start = 1_000_000) {
  const state = { at: start };
  return { now: () => state.at, advance(ms) { state.at += ms; return state.at; } };
}
const breakerWith = (time, options = {}) => new CircuitBreaker({ now: time.now, ...options });

// ---------------------------------------------------------------------------
// 1. Classification — the distinction the whole feature rests on
// ---------------------------------------------------------------------------
ok('a quota answer and a rate limit are told apart, and a crash is neither', () => {
  // The real body Gemini returned on 2026-08-02: 429 *and* an exhausted quota.
  const gemini = '{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"},"retryDelay":"12s"}';
  assert.equal(classifyFailure(gemini), 'quota', 'quota outranks 429 — the recovery time is what differs');
  assert.equal(retryAfterMs(gemini), 12000, "the provider's own number is read, not guessed");
  assert.equal(classifyFailure('HTTP 429 Too Many Requests'), 'rate-limit');
  assert.equal(classifyFailure('overloaded_error'), 'rate-limit');
  assert.equal(classifyFailure('models/gemini-9-pro is not found for API version v1'), 'model-unavailable');
  assert.equal(classifyFailure('TypeError: cannot read property x of undefined'), '',
    'an ordinary failure must stay ordinary, or the router stops learning from real defects');
  assert.equal(classifyFailure(''), '');
  assert.equal(retryAfterMs('nothing here'), 0, 'no stated delay means no invented delay');
});
ok('the combined pattern still matches everything it used to', () => {
  // pi-bridge.js drives its local fallback off ERROR_PATTERN. Splitting the
  // regex in two must not change what that sees.
  for (const term of ['429', 'rate limit', 'rate-limit', 'quota', 'RESOURCE_EXHAUSTED',
    'insufficient_quota', 'exceeded', 'overloaded', 'billing']) {
    assert.ok(ERROR_PATTERN.test(term), `ERROR_PATTERN lost "${term}"`);
  }
});

// ---------------------------------------------------------------------------
// 2. The circuit itself
// ---------------------------------------------------------------------------
ok('an ordinary failure never opens the circuit', () => {
  const time = clock(); const breaker = breakerWith(time);
  for (let i = 0; i < 10; i += 1) breaker.record('codex', { reason: '' });
  assert.equal(breaker.state('codex'), 'closed');
  assert.equal(breaker.isOpen('codex'), false);
  assert.deepEqual(breaker.snapshot(), [], 'a provider that never throttled is not worth reporting');
});
ok('one throttle is not enough; the threshold is', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 3 });
  assert.equal(breaker.record('gemini', { reason: 'rate-limit' }).opened, false);
  assert.equal(breaker.record('gemini', { reason: 'rate-limit' }).opened, false);
  assert.equal(breaker.state('gemini'), 'closed', 'two in a burst is a burst, not an outage');
  const tripped = breaker.record('gemini', { reason: 'rate-limit' });
  assert.equal(tripped.opened, true);
  assert.equal(breaker.state('gemini'), 'open');
  assert.equal(breaker.isOpen('gemini'), true);
});
ok('throttles older than the window are forgotten', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 3, windowMs: 60000 });
  breaker.record('glm', { reason: 'rate-limit' });
  breaker.record('glm', { reason: 'rate-limit' });
  time.advance(61000);
  assert.equal(breaker.record('glm', { reason: 'rate-limit' }).opened, false,
    'one throttle an hour is not an outage and must not trip anything');
  assert.equal(breaker.state('glm'), 'closed');
});
ok('the cooldown expires into half-open, which lets exactly one attempt through', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1, cooldownMs: 60000 });
  breaker.record('gemini', { reason: 'rate-limit' });
  assert.equal(breaker.state('gemini'), 'open');
  assert.equal(breaker.retryInMs('gemini'), 60000);
  time.advance(59999);
  assert.equal(breaker.isOpen('gemini'), true, 'still open one millisecond early');
  time.advance(1);
  assert.equal(breaker.state('gemini'), 'half-open');
  assert.equal(breaker.isOpen('gemini'), false, 'half-open means the caller may try once');
  assert.equal(breaker.retryInMs('gemini'), 0);
});
ok('a throttle on the trial attempt doubles the wait instead of repeating it', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1, cooldownMs: 60000 });
  breaker.record('gemini', { reason: 'rate-limit' });
  time.advance(60000);
  const again = breaker.record('gemini', { reason: 'rate-limit' });
  assert.equal(again.opened, true);
  assert.equal(again.cooldownMs, 120000, 'the previous wait was too short, so it grows');
  time.advance(120000);
  assert.equal(breaker.record('gemini', { reason: 'rate-limit' }).cooldownMs, 240000);
});
ok('the wait is capped, so nothing is retired forever', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1, cooldownMs: 60000, maxCooldownMs: 300000 });
  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    const result = breaker.record('gemini', { reason: 'rate-limit' });
    last = result.cooldownMs; time.advance(last);
  }
  assert.equal(last, 300000);
});
ok('one success closes the circuit and forgets the escalation', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1, cooldownMs: 60000 });
  breaker.record('gemini', { reason: 'rate-limit' });
  time.advance(60000);
  breaker.record('gemini', { reason: 'rate-limit' }); // cooldown now 120s
  time.advance(120000);
  const closed = breaker.record('gemini', { reason: '' });
  assert.equal(closed.state, 'closed');
  assert.equal(breaker.state('gemini'), 'closed');
  assert.equal(breaker.retryInMs('gemini'), 0);
  // And the next outage starts from the base wait again, not from 240s.
  assert.equal(breaker.record('gemini', { reason: 'rate-limit' }).cooldownMs, 60000);
});
ok('an exhausted quota waits longer than a rate limit', () => {
  const time = clock();
  const limited = breakerWith(time, { threshold: 1, cooldownMs: 60000 });
  const spent = breakerWith(time, { threshold: 1, cooldownMs: 60000 });
  const a = limited.record('gemini', { reason: 'rate-limit' });
  const b = spent.record('gemini', { reason: 'quota' });
  assert.ok(b.cooldownMs > a.cooldownMs, `${b.cooldownMs} should exceed ${a.cooldownMs}`);
});
ok("the provider's own retry-after wins when it is longer, and never shortens ours", () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1, cooldownMs: 60000, maxCooldownMs: 900000 });
  assert.equal(breaker.record('gemini', { reason: 'rate-limit', retryAfterMs: 300000 }).cooldownMs, 300000);
  const other = breakerWith(clock(), { threshold: 1, cooldownMs: 60000 });
  assert.equal(other.record('codex', { reason: 'rate-limit', retryAfterMs: 1000 }).cooldownMs, 60000,
    'a 1s hint must not undercut our own backoff');
});
ok('circuits are per provider', () => {
  const time = clock(); const breaker = breakerWith(time, { threshold: 1 });
  breaker.record('gemini', { reason: 'quota' });
  assert.equal(breaker.isOpen('gemini'), true);
  assert.equal(breaker.isOpen('codex'), false, 'one provider being out says nothing about another');
  assert.deepEqual(breaker.snapshot().map((row) => row.provider), ['gemini']);
});

// ---------------------------------------------------------------------------
// 3. The routing memory must not be poisoned by an outage
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-breaker-'));
ok('being throttled costs a provider nothing in the routing table', () => {
  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'a-')) });
  const before = registry.score('gemini', 'facilitator');
  for (let i = 0; i < 10; i += 1) {
    registry.record({ provider: 'gemini', role: 'facilitator', ok: false, durationMs: 900, reason: 'rate-limit' });
  }
  for (let i = 0; i < 10; i += 1) {
    registry.record({ provider: 'gemini', role: 'facilitator', ok: false, durationMs: 900, reason: 'quota' });
  }
  assert.equal(registry.score('gemini', 'facilitator'), before,
    'twenty throttles must leave the score exactly where it was');
  const row = registry.snapshot().performance.models.gemini;
  assert.equal(row.samples, 0, 'a throttled attempt is not a sample of how well it works');
  assert.equal(row.failures, 0, 'and specifically not a failure');
  assert.equal(row.throttled, 20, 'but it is counted, so the owner can see how often it happens');
  assert.equal(row.throttledReason, 'quota');
  const entry = registry.snapshot().capabilities.models.gemini;
  assert.ok(!entry.penalties || !entry.penalties.facilitator, 'and no penalty is written');
});
ok('a real failure is still learned from — the fix must not blind the router', () => {
  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'b-')) });
  const before = registry.score('codex', 'ui');
  for (let i = 0; i < 4; i += 1) {
    registry.record({ provider: 'codex', role: 'ui', ok: false, durationMs: 5000, reason: '' });
  }
  assert.ok(registry.score('codex', 'ui') < before, 'a provider that keeps crashing must still lose its slot');
});

// ---------------------------------------------------------------------------
// 4. The coordinator skips a provider in cooldown — and still asks the owner
// ---------------------------------------------------------------------------
ok('_fallback walks past providers in cooldown and stops at the first available one', () => {
  const time = clock();
  const breaker = breakerWith(time, { threshold: 1 });
  const planned = [];
  const taskRunner = Object.assign(new (require('events').EventEmitter)(), {
    get: () => ({ prompt: 'original', error: 'boom', metadata: {} }),
    plan: (spec) => { planned.push(spec); return { id: spec.id, status: 'queued', disclosure: { disclosureHash: 'h' } }; },
  });
  const coordinator = new CoreExecutionCoordinator({ taskRunner, breaker,
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'c-')) }) });

  // claude-code falls back to glm, then codex, then qwen. Take the first two out.
  assert.deepEqual(FALLBACKS['claude-code'], ['glm', 'codex', 'qwen']);
  breaker.record('glm', { reason: 'quota' });
  breaker.record('codex', { reason: 'rate-limit' });

  const run = { id: 'run-1', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };
  assert.equal(coordinator._fallback(run, assignment), true);
  assert.equal(assignment.provider, 'qwen', 'the two in cooldown are skipped, not offered');
  assert.equal(planned.length, 1, 'and only one replacement is planned');
});
ok('when every fallback is in cooldown the run fails instead of looping', () => {
  const time = clock();
  const breaker = breakerWith(time, { threshold: 1 });
  const taskRunner = Object.assign(new (require('events').EventEmitter)(), {
    get: () => ({ prompt: 'original', error: 'boom', metadata: {} }),
    plan: () => { throw new Error('must not plan anything'); },
  });
  const coordinator = new CoreExecutionCoordinator({ taskRunner, breaker,
    registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'd-')) }) });
  for (const provider of FALLBACKS['claude-code']) breaker.record(provider, { reason: 'quota' });
  const run = { id: 'run-2', prompt: 'p', cwd: '/tmp', planHash: 'ph', repairCycle: 1, assignments: [] };
  const assignment = { taskId: 't1', provider: 'claude-code', role: 'leader', title: 'work', fallbackIndex: 0 };
  assert.equal(coordinator._fallback(run, assignment), false);
});
ok('the breaker never touches the approval gate', () => {
  // The whole safety design is that nothing external runs without the owner
  // saying so. A throttled API is not a reason to relax that, so assert it in
  // the source rather than trusting the change was careful.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'circuit-breaker.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, ''); // the comments explain the gate; the code must not reach it
  for (const term of ['approve', 'AWAITING_APPROVAL', 'disclosureHash', 'planHash']) {
    assert.ok(!new RegExp(`\\b${term}\\b`).test(source), `circuit-breaker.js must not reference ${term}`);
  }
});

// ---------------------------------------------------------------------------
// 5. End to end: bytes on stderr → classification → the routing table
// ---------------------------------------------------------------------------
// Everything above feeds the classifier directly. This starts where the provider
// does — a child process writing to stderr and exiting non-zero — because that
// is the journey the bug took, and an exit code alone cannot tell a rate limit
// from a bad patch.
(async () => {
  const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
  const { EventEmitter } = require('events');
  const { PassThrough } = require('stream');

  const project = fs.mkdtempSync(path.join(root, 'e2e-'));
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({
    filesystem: { allowRead: [project], allowWrite: [project] },
    models: { allowPaid: ['gemini'] } }));

  // The body Gemini actually returned on 2026-08-02, trimmed.
  const BODY = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.",'
    + '"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]}}';
  const spawnImpl = () => {
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    queueMicrotask(() => { proc.stderr.end(`${BODY}\n`); queueMicrotask(() => proc.emit('close', 1, null)); });
    return proc;
  };

  const runner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl });
  const planned = runner.plan({ provider: 'gemini', model: 'gemini-3.1-pro', cwd: project, prompt: 'anything' });
  runner.approve(planned.id, { disclosureHash: planned.disclosure?.disclosureHash });
  const task = await runner.waitFor(planned.id, 10000);

  assert.equal(task.status, 'failed', 'the process really did exit non-zero');
  assert.equal(task.failureReason, 'quota', 'and the reason came off stderr, not off the exit code');
  assert.equal(task.retryAfterMs, 12000, "including the provider's own retry delay");
  checks += 3;

  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'e-')) });
  const before = registry.score('gemini', 'facilitator');
  registry.record({ provider: 'gemini', model: task.model, role: 'facilitator', ok: false, durationMs: 400, reason: task.failureReason });
  assert.equal(registry.score('gemini', 'facilitator'), before,
    'and by the time it reaches the routing table it has cost the provider nothing');
  checks += 1;
  if (process.env.VERBOSE) console.log('  ok  a real 429 body travels runner → classification → registry unscored');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`circuit breaker selftest: PASS · ${checks} checks · quota outranks 429 · window forgets · cooldown doubles and caps · success closes · retry-after honoured only when longer · throttles cost no penalty · real failures still do · fallback walks past cooldowns · a real 429 body survives the whole path · approval gate untouched`);
})().catch((error) => { console.error(error); process.exit(1); });
