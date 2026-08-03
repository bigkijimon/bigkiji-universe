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

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`approval flood selftest: ${failures} FAILED`); process.exit(1); }
console.log('approval flood selftest: PASS · one request waits once · different work stays separate · unanswered plans expire · every approval reachable · gate untouched');
