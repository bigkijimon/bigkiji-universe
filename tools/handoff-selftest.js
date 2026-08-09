'use strict';

// The specialists can leave each other notes, and the owner can read the roles against
// each other. The two orchestration gaps, and the constraint that shapes both.
//
// The owner's target system: 「ClaudeやCodex、Geminiの違った言語を使用するシステムを
// オープンソースのローカルLLMでそれぞれの課金AIがコミュニケーション取れるように。
// オーケストレーションできるように」. Most of it existed — one adapter layer, one step
// format, a local commander, failover. Two things did not:
//
//   1  IN-FLIGHT COMMUNICATION. Every assignment ran in its own git worktree and could
//      not see the others. Collision avoidance was a static file split.
//   2  INTEGRATION. buildReport listed who ran and how many lines moved — every fact
//      about the work except the work.
//
// The constraint that decides the shape of (1): `createDisclosureManifest` hashes the
// prepared prompt into `payloadHash` and `verifyDisclosureManifest` re-checks it at start
// (task-runner.js:157). Rebuilding a later assignment's prompt with earlier results —
// the obvious implementation — either fails that check or means re-sealing, which is the
// approval gate being worked around rather than honoured. So the CHANNEL is approved and
// only its contents are live. That is what the first assertion here pins.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-handoff-'));
process.env.BIGKIJI_KNOWLEDGE_ROOT = path.join(root, 'knowledge');

const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { createDisclosureManifest } = require('../src/domain/pi-core/security/disclosure-manifest');
const { renderEvent } = require('../src/cli/tui/transcript');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };
const plain = (lines) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));

const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

// The coordinator is used for its prompt and handoff logic only; no task runs here.
const coordinator = new CoreExecutionCoordinator({
  taskRunner: Object.assign(new (require('events').EventEmitter)(), { cwd: workspace, get: () => null }),
  settingsProvider: () => ({}),
});
const run = { id: 'run-test-1', cwd: workspace, prompt: 'build the thing', promptSpec: { goal: 'build the thing' },
  assignments: [{ taskId: 't1', role: 'leader', title: 'own the architecture', write: true },
    { taskId: 't2', role: 'ui', title: 'own the frontend', write: true }] };

ok('the channel is approved; only what is in it is live', () => {
  const before = coordinator._assignmentPrompt(run, run.assignments[0]);
  assert.match(before, /HANDOFF /, 'the prompt has to name the directory, or nobody looks in it');
  assert.match(before, /It is normal for it to be empty/,
    'an empty directory must read as "nobody has finished yet", not as "nobody is working"');
  assert.match(before, /Do not write to it/, 'the coordinator writes the notes; an agent that forgets is not a channel');

  // Now fill the directory and rebuild the prompt. If the contents leaked into the text,
  // the payload hash moves and the approval the owner gave no longer covers what runs.
  const dir = coordinator._handoffDir(run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '02-ui.md'), '# ui — completed\nchanged index.html');
  const after = coordinator._assignmentPrompt(run, run.assignments[0]);
  assert.equal(after, before, 'the prompt text must not change when the handoff fills up');

  const hashOf = (text) => createDisclosureManifest({ provider: 'codex', purpose: 'x', payload: text,
    policy: { vaultRoot: workspace, security: { policyHash: 'p' } } }).payloadHash;
  assert.equal(hashOf(after), hashOf(before),
    'same payload hash — this is the whole reason the contents are not inlined');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('a finished assignment leaves a note the next one can read', () => {
  const edits = new Map([['src/game.js', { writes: 2, added: 12, removed: 3 }], ['src/util.js', { writes: 1 }]]);
  const wrote = coordinator._writeHandoff(run, run.assignments[1],
    { status: 'completed', provider: 'claude-code', model: 'opus', output: 'Rewrote the loop and added a test.', edits });
  assert.equal(wrote, true);
  const file = path.join(coordinator._handoffDir(run), '02-ui.md');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /# ui — completed/);
  assert.match(body, /provider: claude-code · opus/, 'who did it, so a later specialist can weigh it');
  assert.match(body, /files: src\/game\.js, src\/util\.js/, 'and exactly which files are already taken');
  assert.match(body, /Rewrote the loop/);
  // Numbered by position in the run, so reading the directory in name order reads it in
  // the order the plan intended rather than in completion order.
  assert.ok(fs.readdirSync(coordinator._handoffDir(run))[0].startsWith('02-'));
});

ok('a failed assignment says so, rather than leaving nothing', () => {
  coordinator._writeHandoff(run, run.assignments[0],
    { status: 'failed', provider: 'codex', output: '', error: 'quota exhausted' });
  const body = fs.readFileSync(path.join(coordinator._handoffDir(run), '01-leader.md'), 'utf8');
  assert.match(body, /# leader — failed/);
  assert.match(body, /error: quota exhausted/,
    'silence here would let the next specialist assume the architecture was done');
  assert.match(body, /\(no output\)/);
});

ok('an unwritable directory does not take the run down', () => {
  const blocked = { ...run, id: 'run-blocked', cwd: path.join(root, 'nope', '\0bad') };
  assert.equal(coordinator._writeHandoff(blocked, run.assignments[0], { status: 'completed', provider: 'glm' }), false,
    'a note nobody could write is not worth failing a paid run over');
});

ok('the notes are cleaned up with the run', () => {
  const dir = coordinator._handoffDir(run);
  assert.ok(fs.existsSync(dir));
  coordinator.runs.set(run.id, run);
  coordinator.forgetRun(run);
  assert.equal(fs.existsSync(dir), false,
    'one directory per run kept forever is how 1,446 worktrees and 35 GB happened');
});

ok('the report puts the roles side by side, with the lines they wrote', () => {
  const report = { runId: 'r', status: 'COMPLETED', completed: 2, total: 2, ms: 1000, tokens: 10, cost: 0.01,
    checks: [], repairs: 0, collisions: [], rows: [
      { role: 'leader', provider: 'codex', status: 'completed', wrote: true, changed: [], isolated: true,
        workspacePath: '/w/a', skills: [], cost: 0.01, context: null,
        diff: 'diff --git a/game.js b/game.js\n@@ -1,2 +1,2 @@\n-const b = 2;\n+const b = 3;' },
      { role: 'ui', provider: 'claude-code', status: 'completed', wrote: true, changed: [], isolated: true,
        workspacePath: '/w/b', skills: [], cost: 0.01, context: null,
        diff: 'diff --git a/index.html b/index.html\n@@ -1,1 +1,2 @@\n+<h1>Hi</h1>' } ] };
  const shown = plain(renderEvent('report', report, { width: 84 })).join('\n');
  assert.match(shown, /leader · codex wrote:/);
  assert.match(shown, /ui · claude-code wrote:/);
  assert.match(shown, /- const b = 2;/);
  assert.match(shown, /\+ const b = 3;/);
  assert.match(shown, /\+ <h1>Hi<\/h1>/, 'both roles on one screen — that is the integration on offer');
  // No auto-merge. The report shows them; the owner merges.
  assert.ok(!/merged/i.test(shown), 'nothing here may claim the edits were combined');

  const quiet = plain(renderEvent('report', report, { width: 84, diffLines: 0 }));
  assert.ok(!quiet.join('\n').includes('wrote:'), 'a caller with no room still gets the summary alone');
  const none = plain(renderEvent('report', { ...report, rows: report.rows.map((r) => ({ ...r, diff: '' })) }, { width: 84 }));
  assert.ok(!none.join('\n').includes('wrote:'), 'and a run that changed nothing grows no empty diff block');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`handoff selftest: ${failures} FAILED`); process.exit(1); }
console.log('handoff selftest: PASS · the channel is approved and its contents are not · '
  + 'a finished assignment leaves who/what/which-files · a failure says so · an unwritable note never kills a run · '
  + 'cleaned up with the run · the report puts the roles side by side and merges nothing');
