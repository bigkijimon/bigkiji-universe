'use strict';

// One paste is one turn.
//
// A nine-line paste used to become nine turns fired 31ms apart. readline emits a
// 'line' per newline and does not await its handler, so the CLI dispatched all
// nine; Ollama serves one at a time, so eight sat in its queue until the 8s stall
// timeout fired (measured: latencyMs 8000/8001/8002/8004) and every one of them
// came back degraded. Five of those degraded turns then returned HTTP 500.
//
// These checks hold the two halves of the repair: the CLI collects the lines of a
// paste before sending anything, and the daemon runs one turn per session at a
// time so a queued turn's timeout starts when the model does.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DaemonEngine } = require('../src/domain/server/daemon');
const { renderEvent } = require('../src/cli/tui/transcript');

const TURN_SHAPE = Object.freeze({
  title: '', summary: '', ideas: [], requirements: [], decisions: [], openQuestions: [], todos: [],
  confidence: 0.5, provider: 'stub', model: 'stub', latencyMs: 1, context: { estimatedTokens: 0 },
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-paste-test-'));
  const engine = new DaemonEngine({ stateRoot: root, workspace: process.cwd() });

  // --- the daemon runs one turn per session at a time ----------------------
  let inFlight = 0; let peak = 0; const served = [];
  engine.conversation.turn = async ({ text }) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 8));
    served.push(text); inFlight -= 1;
    return { ...TURN_SHAPE, kind: 'CHAT', reply: `ok ${text}`, turnId: text };
  };

  const lines = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`);
  const first = await engine.turn(lines[0]);
  const sessionId = first.sessionId;
  await Promise.all(lines.slice(1).map((text) => engine.turn(text, { sessionId })));
  assert.equal(peak, 1, `nine turns must not run at once — peak concurrency was ${peak}`);
  assert.deepEqual(served, lines, 'and they must reach the model in the order the owner typed them');

  // The transcript is written in that order too. Appends used to land in
  // completion order, so a fast reply overtook the question before it.
  const owner = engine.sessions.read(sessionId).events
    .filter((event) => event.type === 'conversation' && event.role === 'owner').map((event) => event.text);
  assert.deepEqual(owner, lines, 'the session file must read in the order it was typed');

  // A burst with no session id queues too: that is exactly the paste that opened
  // one session per line, because every line raced to create its own.
  peak = 0;
  await Promise.all(['a', 'b', 'c'].map((text) => engine.turn(text)));
  assert.equal(peak, 1, 'unsequenced turns must queue as well, not stampede the model');

  // A failing turn must not cancel the turns behind it.
  let calls = 0;
  engine.conversation.turn = async ({ text }) => {
    calls += 1;
    if (text === 'boom') throw new Error('model exploded');
    return { ...TURN_SHAPE, kind: 'CHAT', reply: 'ok', turnId: text };
  };
  const outcomes = await Promise.allSettled([engine.turn('boom', { sessionId }), engine.turn('after', { sessionId })]);
  assert.equal(outcomes[0].status, 'rejected', 'the caller still gets the real error');
  assert.equal(outcomes[1].status, 'fulfilled', 'and the next turn in the queue still runs');
  assert.equal(calls, 2);

  // --- a submitted run is published once ----------------------------------
  const runEvents = [];
  engine.on('event', (event) => { if (event.event === 'run') runEvents.push(event.data); });
  engine.conversation.turn = async () => ({ ...TURN_SHAPE, kind: 'TASK', reply: 'planning', title: 'fix readme',
    summary: 'fix the readme typo', todos: ['edit README'], turnId: 'task-1' });
  // The front desk is stubbed, and it has to be.
  //
  // This assertion passed for months on a hidden dependency: FastFacilitatorRouter starts
  // with `knowledge.findPlan(text)` (fast-api-router.js:121), and the owner's real
  // task_state.json happened to hold a cached plan for this sentence. Point the knowledge
  // root anywhere else — which is what test isolation does — and the facilitator instead
  // asks a model, gets `needs_clarification`, and daemon.js holds the run back to ask a
  // question. Measured 2026-08-09: with `plans` present the test passes, with `plans`
  // emptied and everything else identical it fails.
  //
  // What this block is about is that ONE run is published ONCE. Whether a first-time
  // request should stop and ask is a separate question about the product, not about
  // event plumbing, so it is pinned here rather than left to whatever is on disk.
  engine.facilitator.facilitate = async () => ({ status: 'ready', provider: 'stub', planHash: 'stub-plan',
    promptSpec: { goal: 'fix the readme typo', constraints: [], steps: ['edit README'], acceptance: [] } });
  const task = await engine.turn('READMEのタイポを直して', { sessionId });
  assert.ok(task.run?.id, 'a TASK turn submits a run');
  assert.equal(runEvents.filter((run) => run.id === task.run.id).length, 1,
    'the coordinator already publishes the run it just planned — publishing it again printed it twice');
  const recorded = engine.sessions.read(sessionId).events.filter((event) => event.type === 'run' && event.run?.id === task.run.id);
  assert.equal(recorded.length, 1, 'and it must be written to the session once, not twice');

  // /run travels the same path and used to double up in exactly the same way.
  runEvents.length = 0;
  const explicit = engine.prompt('Audit the daemon event vocabulary. Do not execute yet.', { mode: 'plan' });
  assert.equal(runEvents.filter((run) => run.id === explicit.run.id).length, 1, '/run must publish its run once');
  const promptRuns = engine.sessions.read(explicit.sessionId).events.filter((event) => event.type === 'run' && event.run?.id === explicit.run.id);
  assert.equal(promptRuns.length, 1, 'and record it in its own session once');

  // --- a failed run says why ----------------------------------------------
  const failed = renderEvent('run', { id: 'run-x1', status: 'FAILED', error: 'gemini quota exhausted', assignments: [] }, { width: 80 });
  assert.ok(failed.join('\n').includes('gemini quota exhausted'),
    'a failed run has to carry its reason to the transcript, which used to drop it');
  const clean = renderEvent('run', { id: 'run-x2', status: 'AWAITING_APPROVAL', assignments: [] }, { width: 80 });
  assert.ok(clean.every((line) => !line.includes('undefined')), 'and a run with no error must not grow an empty error line');

  // --- the CLI collects a paste instead of dispatching every line ----------
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'bigkiji-cli.js'), 'utf8');
  assert.ok(!/rl\.on\('line', async/.test(cli),
    'an async line handler readline never awaits is nine parallel turns on a nine-line paste');
  assert.match(cli, /rl\.on\('line', \(line\) => \{ pending\.push\(line\)/,
    'lines must be collected first and sent as one turn');
  assert.match(cli, /\\x1b\[\?2004h/, 'bracketed paste has to be requested so the boundary is exact where the terminal supports it');
  assert.match(cli, /\\x1b\[\?2004l/, 'and switched back off on exit, or the owner’s shell inherits it');
  assert.match(cli, /chain = chain\.then/, 'turns run one at a time on the CLI side too');
  assert.match(cli, /if \(rl\.line && \(pending\.length > 1 \|\| pastedBatch\)\) return;/,
    'a paste with no trailing newline must wait for Enter instead of sending the block without its last line');
  // Measured in a live pty: readline echoes each pasted line, every echo scrolls
  // the sticky region, and mid-paste the bottom rule and the MODE/SHELL/AGENT row
  // were overwritten by fragments of the pasted text.
  assert.match(cli, /rl\.output = SINK/, 'readline’s echo has to be silenced for the length of a paste');
  assert.match(cli, /prependListener\('data', watchPaste\)/,
    'and the watcher must run before readline’s own data handler, or the echo has already happened');
  assert.match(cli, /rl\.output = process\.stdout/, 'and the echo must come back afterwards');

  engine.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('paste/turn selftest: PASS · 9-line burst = 1 turn at a time · typed order kept · run published once · failure reason shown');
})().catch((error) => { console.error(error); process.exit(1); });
