'use strict';

// The morning of 2026-08-09, in assertions.
//
// The owner started the CLI, typed two questions, got two canned replies and wrote
// 「指示が通ってないかも。」 Three separate faults produced that, and none of them was the
// conversation model being bad at conversation:
//
//   A  Ollama was SIGSTOPped. gpu-signal.sh had taken the card for a render at 10:05 and
//      ~/.bigkiji/ollama-watchdog.sh will not thaw while /tmp/bigkiji_gpu.lock exists.
//      ConversationEngine's 8s stall deadline fired twice — latencyMs 8012 and 8007 — and
//      the app said "the local model did not answer" without knowing why, because nothing
//      in src/ or tools/ had ever heard of that lock.
//   B  A run from 2026-08-06 19:07 was still DIAGNOSING with a 30-minute budget, 3260
//      minutes past its deadline, 1 of 3 assignments done and nothing running. It emitted
//      a checkpoint every ten minutes for 54 hours. `expireStaleApprovals` did not cover
//      it (wrong status) and would not have run anyway (it is only called from submit()).
//   C  Those 244 checkpoints filled the 300-entry event ring in task_state.json — 81% of
//      the entire record was one dead run, and nothing before 2026-08-07 08:58 survived.
//
// And one that made all three harder to see: `DIAGNOSING` was in neither facts() nor
// statusFacts(), so `/status` reported "runs in progress: 0" about the very run whose
// status the CLI's phase row was displaying.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-stalled-'));
// Before requiring the orchestrator: ROOT is resolved once, at module load.
process.env.BIGKIJI_KNOWLEDGE_ROOT = path.join(root, 'knowledge');

const gpu = require('../src/domain/pi-agent/gpu-lock');
const knowledge = require('../src/domain/pi-agent/pi-knowledge-orchestrator');
const { CoreExecutionCoordinator, ACTIVE_RUN, TERMINAL_RUN, STALL_CHECKPOINTS,
  STALL_TTL_MS } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
const { degradedHeader, degradedPrefix } = require('../src/domain/pi-core/conversation-engine');
const { buildFooter } = require('../src/cli/tui/footer');
const { machineNote, FROZEN_TURN_NOTE } = require('../src/domain/terminal/bigkiji-cli');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };
const plain = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// A — the freeze the app could not see
// ---------------------------------------------------------------------------

const lockFile = path.join(root, 'gpu.lock');

ok('no lock file is not a held lock', () => {
  const state = gpu.readGpuLock({ path: path.join(root, 'absent.lock') });
  assert.equal(state.held, false);
  assert.equal(state.ageMs, null, 'and no age is invented for a lock that is not there');
});

ok('the lock names the job and when it took the card', () => {
  fs.writeFileSync(lockFile, 'u09-final 10:05:45\n');
  const state = gpu.readGpuLock({ path: lockFile });
  assert.equal(state.held, true);
  assert.equal(state.holder, 'u09-final', 'the owner needs to know which of their own jobs to wait for');
  assert.equal(state.since, '10:05:45');
  assert.ok(state.ageMs >= 0, 'age comes from mtime — the HH:MM:SS in the file carries no date');
});

ok('an empty lock file is still a lock', () => {
  const empty = path.join(root, 'empty.lock');
  fs.writeFileSync(empty, '');
  // gpu-signal.sh creates the file and then writes the line; a job that got the card a
  // millisecond ago still has it.
  assert.equal(gpu.readGpuLock({ path: empty }).held, true);
});

ok('T is stopped and S is not', () => {
  const table = 'STAT COMM\nS    /Applications/Ollama.app/Contents/MacOS/Ollama\n'
    + 'T    /Applications/Ollama.app/Contents/Resources/ollama\n'
    + 'T    /Applications/Ollama.app/Contents/Resources/llama-server\n'
    + 'SN   /Users/yuma/Documents/ComfyUI/.venv/bin/python\n';
  const state = gpu.ollamaFrozen({ run: () => table });
  assert.deepEqual(state.stopped.sort(), ['llama-server', 'ollama']);
  assert.equal(state.frozen, true);
  const awake = gpu.ollamaFrozen({ run: () => 'STAT COMM\nS    /Applications/Ollama.app/Contents/Resources/ollama\n' });
  assert.equal(awake.frozen, false, 'a running server must never read as frozen');
});

ok('a ps that does not answer says "unknown", never "fine"', () => {
  assert.equal(gpu.ollamaFrozen({ run: () => { throw new Error('ps: not found'); } }), null);
  assert.equal(gpu.ollamaFrozen({ run: () => '' }), null,
    'reporting a frozen model as running is the exact mistake this module exists to stop');
});

ok('the explanation names the job, in the language the owner is writing in', () => {
  const held = { held: true, holder: 'u09-final', since: '10:05:45', ageMs: 3_000_000 };
  const ja = gpu.freezeExplanation({ lock: held, procs: { frozen: true, stopped: ['ollama'] }, japanese: true });
  assert.match(ja, /u09-final/);
  assert.match(ja, /10:05:45/);
  assert.match(ja, /停止/);
  const en = gpu.freezeExplanation({ lock: held, procs: { frozen: true, stopped: ['ollama'] }, japanese: false });
  assert.match(en, /u09-final/);
  assert.doesNotMatch(en, /停止/, 'the English path must not leak the Japanese sentence');
});

ok('no lock means no explanation — a cause it cannot see is not one it invents', () => {
  assert.equal(gpu.freezeExplanation({ lock: { held: false }, procs: { frozen: true, stopped: ['ollama'] } }), '');
  assert.equal(gpu.frozenWithoutLock({ lock: { held: false }, procs: { frozen: true, stopped: ['ollama'] } }), true,
    'but a model frozen with nothing holding the lock is a fault worth reporting elsewhere');
});

ok('the degraded reply says why when the reason is knowable, and admits it when not', () => {
  const withCause = degradedHeader('モデル動いてる？', () => '（GPUを「u09-final」が使用中です）\n');
  assert.match(withCause, /u09-final/, 'nine identical "it did not answer" templates taught the owner nothing');
  const noCause = degradedHeader('モデル動いてる？', () => '');
  assert.equal(noCause, degradedPrefix('モデル動いてる？'), 'and with no lock it falls back to the plain admission');
  const broken = degradedHeader('is it working?', () => { throw new Error('ps died'); });
  assert.equal(broken, degradedPrefix('is it working?'), 'a probe that throws must not take the reply with it');
});

ok('the CLI footer draws degraded, which it never did', () => {
  const { lines } = buildFooter({ cols: 100, mode: 'plan', state: {}, comment: 'thinking',
    degraded: true, degradedNote: 'local model frozen — gpu busy' });
  const text = lines.filter(Boolean).map(plain).join('\n');
  assert.match(text, /local model frozen/, 'degraded was on every published turn and no surface drew it');
  assert.doesNotMatch(text, /thinking/, 'and it outranks a comment describing work that is not happening');
  const normal = buildFooter({ cols: 100, mode: 'plan', state: {}, comment: 'thinking' });
  assert.match(normal.lines.filter(Boolean).map(plain).join('\n'), /thinking/,
    'an undegraded turn keeps the comment slot it always had');
});

ok('the freeze on the footer is the machine now, not the machine when they last typed', () => {
  // 2026-08-10, from a screenshot. The render finished at 12:00 — lock gone, every Ollama
  // process back in state S — and at 12:32 the footer still read 「local model frozen —
  // gpu busy」. It was drawing the last turn's `gpuFrozen`, and the only thing that would
  // have cleared it was typing another turn, which is exactly what an owner does not do
  // while being told the model is stopped. Thirty-two minutes wrong about the one fact
  // that decides whether asking is worth it.
  assert.equal(machineNote({ gpu: { frozen: false }, turnNote: FROZEN_TURN_NOTE }), '',
    'the render is over — stop saying it is not');
  assert.match(machineNote({ gpu: { frozen: true, holder: 'u09-tile-answer' } }), /gpu busy/,
    'and while it really is held, say so without waiting to be asked');
  assert.match(machineNote({ gpu: { frozen: true, holder: 'u09-tile-answer' } }), /u09-tile-answer/,
    'naming the job is the difference between "wait" and "wait for what"');
  assert.match(machineNote({ gpu: { frozen: true, orphaned: true } }), /nobody holds the gpu/,
    'a freeze nobody will lift needs a hand, not patience — a different sentence');

  // A reason that is about the turn survives, because the machine being fine does not
  // make that turn fine.
  assert.equal(machineNote({ gpu: { frozen: false }, turnNote: 'local model unavailable' }),
    'local model unavailable', 'only the freeze is a claim about the machine');
  assert.equal(machineNote({ gpu: null, turnNote: '' }), '', 'and a healthy turn says nothing at all');
  assert.equal(machineNote(), '', 'a state poll that has not landed yet is not evidence of a freeze');
});

// ---------------------------------------------------------------------------
// B — the run that would not end
// ---------------------------------------------------------------------------

const build = () => new CoreExecutionCoordinator({
  taskRunner: Object.assign(new EventEmitter(), {
    get: () => ({}),
    plan: (spec) => ({ id: spec.id, status: 'awaiting_approval', disclosure: { disclosureHash: 'h' } }),
  }),
  registry: new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) }),
  available: () => true,
});

/** A run frozen in the shape the owner's was: some done, none running, none terminal. */
function stuckRun(coordinator, { done = 1, total = 3, status = 'DIAGNOSING' } = {}) {
  const submitted = coordinator.submit({ prompt: `stuck ${Math.random()}`, cwd: '/tmp', mode: 'plan' });
  // submit() hands back a public view; the sweeps walk this.runs, so mutate what they read.
  const run = coordinator.runs.get(submitted.id);
  run.status = status;
  run.startedAt = new Date(Date.now() - 54 * 3600 * 1000).toISOString();
  run.updatedAt = run.startedAt;
  run.deadlineAt = new Date(Date.now() - 53 * 3600 * 1000).toISOString();
  run.assignments = Array.from({ length: total }, (_, index) => ({
    taskId: `t${index}`, role: index ? 'architect' : 'debug', provider: index ? 'qwen' : 'glm',
    status: index < done ? 'completed' : 'failed',
  }));
  clearTimeout(run.deadlineTimer); run.deadlineTimer = null;
  return run;
}

ok('checkpoints stop when there is nothing left to report on', () => {
  const c = build();
  const run = stuckRun(c);
  // One more than the threshold: the first call only records the baseline.
  for (let i = 0; i <= STALL_CHECKPOINTS + 1 && run.status === 'DIAGNOSING'; i += 1) c._reportProgress(run);
  assert.equal(run.status, 'FAILED', `244 checkpoints over 54 hours is not reporting, it is a loop (${run.status})`);
  assert.match(run.error, /stalled/);
  assert.match(run.error, /1\/3 finished/, 'and it says what was and was not done');
  assert.match(run.error, /never finished: architect/, 'naming the assignments that never came back');
  assert.equal(run.deadlineTimer, null, 'the timer is not re-armed — that is the whole point');
});

ok('a run with work in flight keeps its old behaviour forever', () => {
  const c = build();
  const run = stuckRun(c);
  run.assignments[1].status = 'running';
  for (let i = 0; i < STALL_CHECKPOINTS * 3; i += 1) c._reportProgress(run);
  assert.equal(run.status, 'DIAGNOSING', 'a slow job is not a stalled one and must never be killed for being slow');
  assert.ok(run.progressReports.length > 0, 'it still reports, which was the owner\'s decision on 2026-08-03');
  clearTimeout(run.deadlineTimer);
});

ok('progress resets the count', () => {
  const c = build();
  const run = stuckRun(c, { done: 0 });
  c._reportProgress(run); c._reportProgress(run); c._reportProgress(run);
  run.assignments[0].status = 'completed'; // something finished
  c._reportProgress(run);
  assert.equal(run.stalledCheckpoints, 0, 'a run that just produced a result is not stalled');
  assert.equal(run.status, 'DIAGNOSING');
  clearTimeout(run.deadlineTimer);
});

ok('the sweep reaches runs the approval sweep never could', () => {
  const c = build();
  const run = stuckRun(c);
  const seen = [];
  c.on('run', (event) => seen.push(event.kind));
  assert.equal(c.expireStaleApprovals(Date.now()), 0, 'DIAGNOSING is not an unanswered question — this is why it survived');
  assert.equal(c.expireStalledRuns(Date.now()), 1);
  assert.equal(c.runs.size, 0, 'and the map does not keep growing');
  assert.ok(seen.includes('stalled'), 'the owner is told, rather than the run silently vanishing');
});

ok('the sweep does not touch work that is young, running, or already over', () => {
  const fresh = build();
  const young = stuckRun(fresh);
  young.updatedAt = new Date().toISOString();
  assert.equal(fresh.expireStalledRuns(Date.now()), 0, 'a run that stopped a minute ago may simply be between steps');

  const busy = build();
  const moving = stuckRun(busy);
  moving.assignments[2].status = 'executing';
  assert.equal(busy.expireStalledRuns(Date.now()), 0, 'work in flight is never swept');

  const waiting = build();
  const asked = stuckRun(waiting, { status: 'AWAITING_APPROVAL' });
  assert.equal(waiting.expireStalledRuns(Date.now()), 0, 'an unanswered plan belongs to the other sweep');
  assert.ok(asked);

  const over = build();
  const finished = stuckRun(over, { status: 'COMPLETED' });
  assert.equal(over.expireStalledRuns(Date.now()), 0, 'and a finished run is not failed retroactively');
  assert.ok(finished);
});

ok('the stall TTL is longer than the budget it follows', () => {
  assert.ok(STALL_TTL_MS > 30 * 60 * 1000, 'sweeping at or before the checkpoint would turn reporting back into killing');
});

// ---------------------------------------------------------------------------
// The contradiction on screen: phase row vs /status
// ---------------------------------------------------------------------------

ok('DIAGNOSING is work in progress everywhere, or it is nowhere', () => {
  assert.ok(ACTIVE_RUN.includes('DIAGNOSING'), 'the CLI showed this status while /status said "runs in progress: 0"');
  assert.ok(ACTIVE_RUN.includes('DISPATCHING'), 'statusFacts counted this and facts() did not');
  for (const status of ACTIVE_RUN) {
    assert.ok(!TERMINAL_RUN.includes(status), `${status} cannot be both active and terminal`);
  }
});

ok('the daemon asks the coordinator instead of keeping its own list', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(source, /ACTIVE_RUN.*require\('\.\.\/pi-agent\/core-execution-coordinator'\)/,
    'three hand-written copies of this list gave three different answers about the same run');
  assert.doesNotMatch(source, /\['EXECUTING', 'REPAIRING', 'VERIFYING', 'PLANNING'/,
    'the facts() copy is the one that omitted DIAGNOSING and DISPATCHING');
});

// ---------------------------------------------------------------------------
// C — the record a stuck run was erasing
// ---------------------------------------------------------------------------

ok('consecutive checkpoints from one run collapse instead of eating the log', () => {
  knowledge.recordEvent('run-old', { type: 'run-planned', status: 'PLANNING', provider: 'glm', evidence: 'the history that got evicted' });
  for (let i = 0; i < 400; i += 1) {
    knowledge.recordEvent('run-zombie', { type: 'run-checkpoint', status: 'DIAGNOSING', provider: 'claude-code',
      evidence: `1/3 done after ${30 + i * 10} minutes` });
  }
  const events = knowledge.loadState().events;
  assert.ok(events.length < 300, `400 checkpoints must not fill a 300-entry ring (${events.length})`);
  assert.ok(events.some((event) => event.type === 'run-planned'),
    'on 2026-08-09 one run held 244 of 300 entries and every older event was gone');
  const collapsed = events.find((event) => event.taskId === 'run-zombie');
  assert.equal(collapsed.repeat, 400, 'how many times it repeated is kept, because that is the signal');
  assert.ok(collapsed.firstAt, 'and when it started, so the duration is still recoverable');
  assert.match(collapsed.evidence, /4020 minutes/, 'the newest one wins — the oldest number is the useless one');
});

ok('two different runs checkpointing do not collapse into each other', () => {
  knowledge.recordEvent('run-a', { type: 'run-checkpoint', status: 'EXECUTING', provider: 'glm', evidence: 'a' });
  knowledge.recordEvent('run-b', { type: 'run-checkpoint', status: 'EXECUTING', provider: 'glm', evidence: 'b' });
  const tail = knowledge.loadState().events.slice(-2);
  assert.deepEqual(tail.map((event) => event.taskId), ['run-a', 'run-b']);
});

ok('running the tests cannot overwrite the memory they exist to protect', () => {
  // Nine selftests reach knowledge.recordEvent one way or another, and every one of them
  // wrote into ~/BigKijiUniverse/knowledge/task_state.json, because ROOT is resolved from
  // the environment at module load and no `stateRoot` argument reaches it. Measured
  // 2026-08-09: one `npm test` replaced all 300 entries of the event ring with the daemon
  // selftest's own submit/plan/abort traffic and erased the record of the fault being
  // investigated at the time.
  //
  // Patching the nine would leave the tenth. The chain exports one temp root instead, and
  // this asserts the export is still there — it is a single character away from silently
  // not applying, and the failure mode is invisible until the day it matters.
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts;
  // Both roots, and both before the first `npm run` — an export placed after the chain
  // starts reaches nothing. Matched on the property rather than the exact spelling, so
  // adding a third root does not fail this for no reason (which is what happened when
  // BIGKIJI_WORKTREE_ROOT was added: 1,446 leaked worktrees, 35 GB, 85 of them made by
  // this very suite).
  const prelude = scripts.test.split(';')[0];
  assert.match(prelude, /\bexport\b[^;]*\bBIGKIJI_KNOWLEDGE_ROOT="\$\(mktemp -d\)"/,
    'the whole suite has to run against a throwaway knowledge root');
  // The worktree root cannot be a temp dir: SandboxPolicyResolver refuses a cwd outside
  // the Vault, so worktrees in os.tmpdir() make every task SECURITY_BLOCKED (measured —
  // it broke daemon-selftest the moment it was tried). It relocates within the repo.
  assert.match(prelude, /\bBIGKIJI_WORKTREE_ROOT="[^"]*\/\.bigkiji\/test-worktrees"/,
    'and against a worktree root that is separate from production but still inside the Vault');
  assert.doesNotMatch(prelude, /BIGKIJI_WORKTREE_ROOT="\$\(mktemp/,
    'a temp worktree root looks safer and blocks every task in the suite');
  // Tests that deliberately keep a worktree left 13 behind per run (326 MB). Cleared at
  // the start, not the end: a failing chain stops before any cleanup at the end would run.
  assert.match(scripts.test, /;\s*rm -rf "\$BIGKIJI_WORKTREE_ROOT";\s*git worktree prune;/,
    'and the suite has to clear its own worktrees before it starts, or they accumulate again');
  assert.ok(!/npm run/.test(prelude), 'the exports must come before the first test in the chain');
  // The one that did the damage keeps its own guard: it is also run directly, by hand and
  // by `npm run test:daemon`, where the chain's export does not apply.
  const daemonTest = fs.readFileSync(path.join(__dirname, 'daemon-selftest.js'), 'utf8');
  const setup = daemonTest.slice(0, daemonTest.indexOf("require('../src/domain/server/daemon')"));
  assert.match(setup, /process\.env\.BIGKIJI_KNOWLEDGE_ROOT = fs\.mkdtempSync/,
    'and it must be set before the require, because ROOT is resolved once at module load');
});

ok('a plan record learns how its work ended', () => {
  const text = 'タイ英語教材 U09 の見開きを作ってください';
  const task = knowledge.createTask(text, 'preflight');
  knowledge.rememberPlan(task, 'a plan', ['decide']);
  assert.equal(knowledge.loadState().tasks.find((item) => item.id === task.id).status, 'planned');
  const updated = knowledge.recordTaskOutcome(text, 'failed', 'stalled after 54 hours');
  assert.equal(updated.status, 'failed', '81 records all reading `planned` is not an answer, it just looks like one');
  assert.match(updated.evidence, /54 hours/);
  assert.ok(updated.updatedAt);
  assert.equal(knowledge.recordTaskOutcome('a request nobody ever planned', 'completed'), null,
    'and a run with no plan record is a normal case, not something to throw into a live run');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`stalled run selftest: ${failures} FAILED`); process.exit(1); }
console.log('stalled run selftest: PASS · the gpu lock is read and named · a frozen model is reported as frozen, never as running · the footer shows degraded · checkpoints stop when nothing moves · slow work is still never killed · the stall sweep reaches DIAGNOSING · one active-run list · a stuck run cannot erase the event log · plan records learn their outcome');
