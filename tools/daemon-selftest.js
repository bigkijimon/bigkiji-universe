'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before requiring the daemon: this test used to write into the owner's real memory.
//
// `stateRoot` below sends sessions to a temp folder, and that was assumed to cover
// everything. It does not. pi-knowledge-orchestrator resolves its ROOT once, at module
// load, from BIGKIJI_KNOWLEDGE_ROOT — nothing about `stateRoot` reaches it. So every run
// of this test appended to ~/BigKijiUniverse/knowledge/task_state.json.
//
// Measured 2026-08-09: one `npm test` replaced all 300 entries of the event ring with
// this test's own submit/plan/abort traffic, and the record of what the machine had
// really been doing since 2026-08-07 was gone. A test suite that destroys the evidence
// you run it to protect is worse than no test suite.
process.env.BIGKIJI_KNOWLEDGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-daemon-knowledge-'));

// The same hazard, one directory over: this test creates real runs, and real runs take
// real git worktrees. `npm test` exports BIGKIJI_WORKTREE_ROOT and deletes it in
// posttest — but running THIS FILE ALONE, which is what anyone does while working on it,
// exports nothing, so every worktree lands in the production .bigkiji/worktrees and stays.
//
// Measured 2026-08-15: three standalone runs left 12 worktrees and 307 MB, and then
// broke a different test — sandbox-boundary-selftest scans every .pi/sandbox.json under
// the repo and found the copies inside them. The failure names a file the author never
// touched, in a test they were not running.
//
// Only claimed when unset, so the suite's own value still wins.
//
// It has to be INSIDE the repository, not os.tmpdir(): the security policy drops every
// root outside the Vault, so a temp-dir worktree makes the run come back
// SECURITY_BLOCKED instead of AWAITING_APPROVAL. Same directory `npm test` uses.
const OWN_WORKTREE_ROOT = process.env.BIGKIJI_WORKTREE_ROOT
  ? '' : (process.env.BIGKIJI_WORKTREE_ROOT = path.join(__dirname, '..', '.bigkiji', 'test-worktrees'));
if (OWN_WORKTREE_ROOT) {
  process.on('exit', () => {
    try { fs.rmSync(OWN_WORKTREE_ROOT, { recursive: true, force: true }); } catch (_) {}
    // The worktrees are gone but git still lists them; prune or the next `git worktree
    // list` reads as leaked work that is not there.
    try { require('child_process').execFileSync('git', ['worktree', 'prune'], { cwd: path.join(__dirname, '..'), stdio: 'ignore' }); } catch (_) {}
  });
}

const { DaemonEngine, startDaemon, jsonSafe } = require('../src/domain/server/daemon');

// Instrumentation for the intermittent CI kill (see docs/known-issues.md #1).
// Across 12 runs this test was cut short on macOS 12/12 and on Linux 7/12, always
// with "The runner has received a shutdown signal" and no failed assertion. Guessing
// from the outside has not narrowed it, so the job says what it saw. Everything here
// is quiet unless something actually happens, and none of it changes what is tested.
//
// Measured 2026-08-06 against runs 31067333069 (survived) and 31068993728 (killed):
// both reach the PASS line identically, and the kill lands ~113ms later, in the window
// where the process would otherwise exit on its own. So the interesting moments are
// the last few hundred milliseconds — which is exactly what the old instrumentation
// could not see: its heartbeat was 5s apart and the process died at 3.3s, so not one
// line of it was ever printed.
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const mb = (n) => `${Math.round(n / 1024 / 1024)}MB`;
// console.error reaches the runner through a pipe, and a write to a pipe is
// asynchronous: whatever has not flushed when SIGTERM arrives is lost, and the line
// that matters is always the last one. fs.writeSync goes to fd 2 before returning.
// A count alone says something is open; it does not say what. Sockets and timers fail
// a job in completely different ways, so the kinds are worth the one line they cost.
const handles = () => {
  const open = process._getActiveHandles?.() ?? [];
  const kinds = new Map();
  for (const handle of open) {
    const kind = handle?.constructor?.name || 'unknown';
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
  }
  const detail = [...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind}×${n}`).join(' ');
  // Where a socket points matters more than that it exists: a loopback pair is this
  // test talking to its own daemon, and anything else is the test reaching off the
  // machine, which is not something a selftest should ever be doing.
  const peers = open.filter((handle) => handle?.constructor?.name === 'Socket')
    .map((socket) => `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}`);
  const off = peers.filter((peer) => !/^(127\.|::1|::ffff:127\.|\?)/.test(peer));
  return `${open.length}${detail ? ` [${detail}]` : ''}`
    + `${peers.length ? ` peers=${[...new Set(peers)].join(',')}` : ''}`
    + `${off.length ? ` OFFBOX=${off.length}` : ''}`;
};
// A child process is the one handle that can outlive this process and keep holding the
// job's stdio, so when there is one, it gets named rather than counted.
// The arguments are a whole agent prompt — thousands of characters of owner skills —
// so only the binary and the first flag are worth printing. What matters is which
// program is running and how many of them, not what it was asked to do.
const children = () => (process._getActiveHandles?.() ?? [])
  .filter((handle) => handle?.constructor?.name === 'ChildProcess')
  .map((child) => `${child.pid}:${String(child.spawnfile || '?').split(/[\\/]/).pop()}`
    + ` ${String((child.spawnargs || [])[1] || '').slice(0, 24)}`.trimEnd())
  .join(' | ');
// Descriptors are the resource this test could plausibly exhaust — it opens sockets,
// spawns children and writes files — and the runner agent shares the limit with it.
// A count here is the difference between "we ran the machine out" and "we did not".
const fdDir = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
const fds = () => { try { return fs.readdirSync(fdDir).length; } catch (_) { return '?'; } };
const mark = process.env.CI ? (what) => {
  const m = process.memoryUsage();
  const kids = children();
  try {
    fs.writeSync(2, `[selftest] ${at()} ${what} · rss=${mb(m.rss)} heap=${mb(m.heapUsed)}`
      + ` fds=${fds()} handles=${handles()}${kids ? `\n[selftest] ${at()} children: ${kids}` : ''}\n`);
  } catch (_) {}   // a closed fd 2 must not be the thing that fails the test
} : () => {};
if (process.env.CI) {
  // What the machine was willing to give, printed once, so the counts above have
  // something to be measured against.
  try {
    const limits = process.report?.getReport?.()?.userLimits || {};
    const files = limits.open_files || {};
    fs.writeSync(2, `[selftest] limits: open_files ${files.soft}/${files.hard}`
      + ` · cpus=${os.cpus().length} · totalmem=${mb(os.totalmem())} · ${process.platform}\n`);
  } catch (_) {}
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      mark(`${sig} received`);
      process.exit(1);   // report it rather than dying silently
    });
  }
  // beforeExit fires when the loop drains, exit when the process is actually leaving.
  // Which of the two is reached says whether anything was still holding it open.
  process.on('beforeExit', () => mark('beforeExit'));
  process.on('exit', (code) => mark(`exit ${code}`));
  // A heartbeat pins how far it got. unref'd so it never holds the process open.
  // 250ms while the runner kill was being hunted; back to 5s now that it is fixed,
  // because at 250ms this prints more than the suite it is watching.
  const beat = setInterval(() => mark('alive'), 5000);
  beat.unref();
}
const { daemonSpawnEnv } = require('../src/domain/server/daemon-client');
const WebSocket = require('ws');

(async () => {
  assert.equal(daemonSpawnEnv({}, '/workspace', 42, { electron:'40.0.0' }).ELECTRON_RUN_AS_NODE, '1', 'Electron must spawn the daemon in Node mode');
  assert.equal(daemonSpawnEnv({}, '/workspace', 42, { node:'26.0.0' }).ELECTRON_RUN_AS_NODE, undefined, 'plain Node must not receive Electron-only flags');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-daemon-test-'));
  const engine = new DaemonEngine({ stateRoot: root, workspace: process.cwd() });
  const planned = engine.prompt('Review the daemon architecture and UI. Do not execute yet.', { mode: 'plan' });
  assert.equal(planned.run.status, 'AWAITING_APPROVAL');
  assert.ok(planned.run.assignments.length >= 2);
  assert.ok(fs.existsSync(path.join(root, 'sessions', `${planned.sessionId}.jsonl`)));
  assert.equal(engine.runner.snapshot().filter((task) => task.status === 'running').length, 0, 'models must stay asleep before owner approval');

  // What the conversation model is allowed to state as fact.
  //
  // Asked what work was outstanding, BigKiji answered that none was registered
  // while this engine held a run awaiting approval. The prompt had never carried
  // any of it, and a model with nothing to go on produces something plausible
  // rather than admitting the gap. These assert the numbers are real and that the
  // turn actually receives them — the second one matters because the wiring is a
  // single argument and losing it looks like nothing at all.
  {
    const facts = engine.facts();
    assert.match(facts, /runs awaiting your approval: 1/, `a waiting run has to be reported: ${facts}`);
    // "connected" means "has a task running right now". Reported as reachability it
    // told the model no external provider was available while all four were
    // authenticated and idle, so it answered questions about its own capability
    // with the opposite of the truth.
    assert.match(facts, /providers that can run work:/, `capability is what the model is asked about: ${facts}`);
    assert.match(facts, /providers busy right now:/, 'and busy is a separate fact from usable');
    assert.ok(!/models connected right now/.test(facts), 'the conflated line is gone');
    // Counting sessions must not read them: facts() runs on every conversation turn
    // and list(999) parses every event of every session file.
    const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
    assert.ok(!/this\.sessions\.list\(999\)/.test(daemonSource), 'a count must not cost a full transcript scan');
    assert.match(daemonSource, /this\.sessions\.count\(\)/);
    assert.equal(typeof engine.sessions.count(), 'number');
    assert.ok(facts.includes(planned.run.id), 'by id, so the owner can act on it');
    assert.match(facts, /runs in progress: 0/, 'and zero is stated as zero, not omitted');
    assert.match(facts, new RegExp(`tasks: ${engine.runner.snapshot().length}\\b`));
    assert.ok(facts.includes(process.cwd()), 'the workspace is a fact the owner asks about');
    assert.match(facts, /\/approve/, 'and it says how to start what is waiting');
    assert.ok(facts.split('\n').length <= 12, 'it shares a 4k window with the transcript');

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
    assert.match(source, /facts: this\.facts\(\)/, 'the turn must actually be given them');

    // The CLI can now start a waiting run. Until it could, the only answer to
    // "a run is waiting" was a note telling the owner to quit and open a
    // different program, so nothing was ever approved and the phase bar read
    // `awaiting approval` all day. The gate is unchanged: approve() still
    // refuses a stale revision, plan or disclosure, which is why the command
    // echoes all three rather than sending a bare id.
    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'bigkiji-cli.js'), 'utf8');
    assert.match(cli, /text === '\/approve'/, 'the CLI has to be able to approve where the owner already is');
    assert.match(cli, /text === '\/reject'/);
    for (const field of ['revision: run.revision', 'planHash: run.planHash', 'disclosureHash: run.disclosureHash', 'idempotencyKey']) {
      assert.ok(cli.includes(field), `/approve must echo ${field} or the coordinator rejects it`);
    }
    assert.ok(!/open .bigkiji monitor. and press a/.test(cli), 'and must not send the owner to another program');
  }
  const listener = startDaemon({ engine, config: { bind: '127.0.0.1', port: 0, token: 'selftest-token' } });
  await new Promise((resolve) => listener.server.once('listening', resolve));
  const address = listener.server.address(); const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/health`).then((response) => response.json()); assert.equal(health.source, 'bigkiji-daemon');
  const credentialSync = await fetch(`${base}/api/security/credentials`, { method: 'POST', headers: { authorization: 'Bearer selftest-token', 'content-type': 'application/json' },
    body: JSON.stringify({ claude: 'selftest-claude-secret' }) }).then((response) => response.json());
  assert.equal(credentialSync.credentials.claude, true); assert.ok(!JSON.stringify(credentialSync).includes('selftest-claude-secret'));
  const state = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer selftest-token' } }).then((response) => response.json());
  assert.equal(state.sessions.length, 1); assert.equal(state.models.connected, 1, 'only PiAgent is connected while awaiting approval');
  const wsState = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?t=selftest-token`);
    ws.once('message', (raw) => { const value = JSON.parse(String(raw)); ws.close(); resolve(value); }); ws.once('error', reject);
  });
  assert.equal(wsState.event, 'state');
  const pairing = await fetch(`${base}/api/mobile/pairing`, { method: 'POST', headers: { authorization: 'Bearer selftest-token' } }).then((response) => response.json());
  assert.ok(pairing.code); assert.equal((await fetch(`${base}/?pair=${pairing.code}`)).status, 200);
  const pairedResponse = await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, name: 'Test iPhone', platform: 'test' }) });
  assert.equal(pairedResponse.status, 201); const paired = await pairedResponse.json(); const cookie = pairedResponse.headers.get('set-cookie').split(';')[0];
  assert.ok(paired.csrf); assert.match(cookie, /^bk_mobile=/);
  const mobileState = await fetch(`${base}/api/state`, { headers: { cookie } }).then((response) => response.json()); assert.equal(mobileState.source, 'bigkiji-daemon');
  const stale = await fetch(`${base}/api/directive`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-bigkiji-csrf': paired.csrf },
    body: JSON.stringify({ action: 'accept', runId: planned.run.id, revision: 99, planHash: 'stale' }) });
  assert.equal(stale.status, 409, 'mobile may not approve a stale plan');
  const noCsrf = await fetch(`${base}/api/directive`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', runId: planned.run.id, revision: planned.run.revision, planHash: planned.run.planHash,
      disclosureHash: planned.run.disclosureHash }) });
  assert.equal(noCsrf.status, 403, 'mobile mutation requires CSRF proof');
  const rejected = await fetch(`${base}/api/directive`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-bigkiji-csrf': paired.csrf },
    body: JSON.stringify({ action: 'reject', runId: planned.run.id, revision: planned.run.revision, planHash: planned.run.planHash,
      disclosureHash: planned.run.disclosureHash, idempotencyKey: 'reject-once' }) }).then((response) => response.json());
  assert.equal(rejected.status, 'FAILED'); assert.equal(engine.runner.snapshot().filter((task) => task.status === 'running').length, 0);
  const devices = await fetch(`${base}/api/mobile/devices`, { headers: { authorization: 'Bearer selftest-token' } }).then((response) => response.json());
  assert.equal(devices.devices.length, 1); assert.equal(devices.devices[0].name, 'Test iPhone'); assert.ok(!('tokenHash' in devices.devices[0]));
  const mobileReload = await fetch(`${base}/api/reload`, { method: 'POST', headers: { cookie, 'x-bigkiji-csrf': paired.csrf } });
  assert.equal(mobileReload.status, 403, 'paired mobile may not reload daemon code');
  const reload = await fetch(`${base}/api/reload`, { method: 'POST', headers: { authorization: 'Bearer selftest-token', 'content-type': 'application/json' },
    body: JSON.stringify({ policyHash: state.security.policyHash, ownerConfirmed: true }) }).then((response) => response.json()); assert.equal(reload.ok, true);
  // A mode that can skip approval is only honoured from this machine.
  //
  // The daemon binds 0.0.0.0 — measured with lsof 2026-08-04, `*:8777 (LISTEN)`, and
  // remote.json carries `"bind": "0.0.0.0"` — so a token on the LAN reaches /api/turn.
  // Now that the mode decides whether a writing run waits for a human, "auto-edit" from
  // anywhere but loopback has to be refused. This is the assertion that must never be
  // relaxed: if it fails, nothing else in this change is safe to ship.
  const { effectiveMode } = require('../src/domain/server/daemon');
  const from = (address) => ({ socket: { remoteAddress: address } });
  for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(effectiveMode(from(local), 'auto'), 'auto', `${local} is the owner's own machine`);
    assert.equal(effectiveMode(from(local), 'ask'), 'ask');
  }
  for (const remote of ['192.168.1.42', '10.0.0.9', '::ffff:192.168.1.42', undefined]) {
    assert.equal(effectiveMode(from(remote), 'auto'), 'plan', `${remote} must not be able to buy an unattended write`);
    assert.equal(effectiveMode(from(remote), 'ask'), 'plan');
  }
  assert.equal(effectiveMode(from('127.0.0.1'), 'nonsense'), 'plan', 'an unrecognised mode is the one that waits');
  assert.equal(effectiveMode(from('127.0.0.1'), undefined), 'plan', 'and so is no mode at all');
  // The phone's voice route names its mode explicitly rather than inheriting a default.
  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(daemonSource, /const turn = await engine\.turn\(heard\.text, \{ mode: 'plan' \}\)/,
    'the mobile voice route used to say auto, which was safe only while every mode was flattened');
  assert.match(daemonSource, /async _turn\(text, \{ sessionId = '', mode = 'plan' \}/,
    'and the default for a caller that names no mode is the one that waits');

  // ---- the phase the footer draws ------------------------------------------
  // `phase` was the newest run's status whether or not that run had finished, so a
  // fresh REPL opened reading `failed` because some earlier session's last run had.
  // Measured in a real pty on 2026-08-05; `/runs` on the same screen said `0 waiting`,
  // which is how the two disagreed in front of the owner.
  {
    const { currentPhase } = require('../src/domain/server/daemon');
    assert.equal(currentPhase([]), 'IDLE', 'no runs at all is idle');
    assert.equal(currentPhase(undefined), 'IDLE', 'and so is no snapshot');
    assert.equal(currentPhase([{ status: 'FAILED' }]), 'IDLE',
      'a run that failed is history — this is the one that shipped as "failed" on an empty prompt');
    assert.equal(currentPhase([{ status: 'COMPLETED' }, { status: 'FAILED' }]), 'IDLE',
      'and so is a whole session of finished runs');
    assert.equal(currentPhase([{ status: 'FAILED' }, { status: 'EXECUTING' }]), 'EXECUTING',
      'a live run is the phase, whatever came before it');
    assert.equal(currentPhase([{ status: 'EXECUTING' }, { status: 'FAILED' }]), 'EXECUTING',
      'and a later failure does not hide a run that is still going');
    assert.equal(currentPhase([{ status: 'COMPLETED' }, { status: 'AWAITING_APPROVAL' }]), 'AWAITING_APPROVAL',
      'waiting on the owner is a current state, not a finished one');
    assert.equal(currentPhase([{ status: 'SECURITY_BLOCKED' }]), 'IDLE',
      'a blocked run is over too — the block is reported by the approval surface, not the phase');
  }

  // What the specialists are actually handed.
  //
  // Measured on the owner's machine 2026-08-05: 「3djsのゲームを作ってください。」 reached
  // the coordinator as goal = that same line, constraints [], steps [], acceptance [],
  // and one unanswered question — and a leader plus a UI specialist were dispatched
  // against it. The front desk that writes a real spec existed the whole time and was
  // required by main.js alone, which skips it whenever the daemon is connected. These
  // cover the wiring, not the model: the facilitator is a stub, so a green run here
  // means the path is connected and the fields survive it.
  {
    const specRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-spec-test-'));
    let calls = 0;
    const facilitator = {
      pending: null,
      reset() { this.pending = null; },
      async facilitate() {
        calls += 1;
        if (calls === 1) return { status: 'needs_clarification', provider: 'ollama', latencyMs: 1,
          questions: [{ ask: 'which genre?', options: ['shooter', 'puzzle'] }] };
        return { status: 'ready', provider: 'ollama', planHash: 'plan-hash-1', latencyMs: 1,
          // `constraints` is a bare string on purpose. A small model answering an
          // array schema emits one, specText() already had to learn that, and a spec
          // that throws on the way to the coordinator loses the whole turn.
          promptSpec: { goal: 'Create a single-file HTML5 3D game using Three.js.', constraints: 'Three.js via CDN',
            steps: ['scene, camera, renderer', 'player movement'], acceptance: ['runs in a browser with no build step'] },
          promptSpecText: 'Goal: Create a single-file HTML5 3D game using Three.js.' };
      },
      async answer(_ownerText, _questions, said) { return this.facilitate(said); },
    };
    const conversationEngine = {
      model: 'stub-qwen',
      turn: async () => ({ kind: 'TASK', reply: 'わかりました。', title: 'game', summary: '', ideas: [], requirements: [],
        decisions: [], openQuestions: [], todos: [], turnId: 'turn-stub', provider: 'local-qwen', latencyMs: 1, degraded: false }),
    };
    const spec = new DaemonEngine({ stateRoot: specRoot, workspace: process.cwd(), conversationEngine, facilitator });

    // A missing decision holds the run back. Guessing it is what produced plans that
    // came back asking the same question instead of building anything.
    const first = await spec.turn('3djsのゲームを作ってください。');
    assert.equal(first.run, null, 'a request with an open question must not dispatch specialists yet');
    assert.deepStrictEqual(first.questions, [{ ask: 'which genre?', options: ['shooter', 'puzzle'] }]);
    assert.equal(first.awaitingAnswer, true);
    assert.match(first.reply, /1\. which genre\?/, 'the question has to reach every surface, not just the field');
    // The owner asked for questions they can answer by picking. An open-ended question
    // is a form to fill in, and answering it costs more than the request did.
    assert.match(first.reply, /a\) shooter/, 'the options have to be on screen');
    assert.match(first.reply, /b\) puzzle/);
    assert.match(first.reply, /おまかせ/, 'and there is always an answer that needs no decision');

    // The next thing typed in that session is the answer, and it becomes the spec.
    const second = await spec.turn('おまかせ', { sessionId: first.sessionId });
    assert.ok(second.run, 'answering has to produce the run the first turn held back');
    assert.equal(second.run.status, 'AWAITING_APPROVAL');
    assert.equal(second.run.promptSpec.goal, 'Create a single-file HTML5 3D game using Three.js.');
    assert.deepStrictEqual(second.run.promptSpec.constraints, ['Three.js via CDN'], 'a string constraint has to survive as a list');
    assert.equal(second.run.promptSpec.steps.length, 2);
    assert.deepStrictEqual(second.run.promptSpec.questions, [], 'the answered question must not travel on as unanswered');
    assert.equal(second.provider, 'ollama', 'the spec turn is served by the front desk, not by a second conversation turn');
    // The run block prints the plan — steps, acceptance, constraints and all. This
    // reply says the answer was understood and how big the plan is; printing the steps
    // here too is the duplication the 2026-08-05 split was written to avoid.
    assert.ok(!/scene, camera, renderer/.test(second.reply),
      'the steps belong to the plan block now, and must not be printed twice');
    assert.ok(!/runs in a browser with no build step/.test(second.reply), 'nor the acceptance checks');
    assert.match(second.reply, /2 steps · 1 acceptance checks/, 'but the reply still says how big the plan is');
    assert.match(second.reply, /Create a single-file HTML5 3D game/, 'and what it understood');
    assert.ok(!/^Constraints:/m.test(second.reply), 'the constraints stay in the block that shows them');
    assert.equal(spec.facilitatorPending, null, 'the pending question is cleared once answered');

    // An open question is not a licence to reinterpret anything typed later. Past the
    // window the turn is an ordinary request again.
    const stale = await spec.turn('別件です', { sessionId: first.sessionId });
    spec.facilitatorPending = { sessionId: first.sessionId, questions: ['which genre?'], at: Date.now() - (16 * 60 * 1000) };
    const afterExpiry = await spec.turn('全然違う依頼', { sessionId: first.sessionId });
    assert.equal(afterExpiry.provider, 'local-qwen', 'an expired question must not swallow the next request');
    assert.ok(stale.run || afterExpiry.run, 'the ordinary path still submits runs');

    // Answering the `⚠ unanswered` a waiting plan already carries.
    const waiting = spec.coordinator.submit({ prompt: 'make a game', cwd: process.cwd(), mode: 'plan',
      promptSpec: { goal: 'make a game', constraints: [], steps: [], acceptance: [],
        questions: [{ ask: 'which genre?', options: ['shooter', 'puzzle'] }] } });
    assert.equal(waiting.promptSpec.questions.length, 1);
    const answered = await spec.answerRun({ runId: waiting.id, text: 'shooter' });
    assert.notEqual(answered.run.id, waiting.id, 'the plan is rebuilt on the answer, not started on a guess');
    assert.equal(answered.answered, waiting.id);
    assert.deepStrictEqual(answered.run.promptSpec.questions, []);
    assert.equal(answered.run.promptSpec.goal, 'Create a single-file HTML5 3D game using Three.js.');
    // A plan with nothing to answer is rewritten too — that is `tell`.
    //
    // This asserted the opposite until 2026-08-10, and it was right at the time: the only
    // way in was `/answer`, so answering a plan that had asked nothing was a mistake worth
    // naming. The approval prompt now offers `t` — "do not run it, tell me what to change"
    // — and a plan that needs changing is usually one that was confident enough not to
    // ask. The refusal would have made the new key fail on exactly the runs it is for.
    const corrected = await spec.answerRun({ runId: answered.run.id, text: 'make it a puzzle instead, and keep it to one file' });
    assert.notEqual(corrected.run.id, answered.run.id, 'an unsolicited correction rebuilds the plan');
    assert.equal(corrected.answered, answered.run.id, 'and names the plan it replaces');
    // Terminal, by the coordinator's own list rather than by a status name guessed here —
    // `abort()` lands on FAILED, and asserting the word would pin a spelling instead of
    // the property. What matters is that the corrected plan cannot still be approved.
    const { TERMINAL_RUN } = require('../src/domain/pi-agent/core-execution-coordinator');
    assert.ok(TERMINAL_RUN.includes(spec.coordinator.get(answered.run.id)?.status),
      'the plan being corrected is stopped, not left waiting beside its replacement');
    assert.deepStrictEqual(corrected.run.promptSpec.questions, [], 'the replacement is decision-complete — tell does not start another interrogation');
    // The empty guard is what the synthesised question protects. Relaxing the old check
    // instead of standing a question up would have let a blank line rewrite a plan.
    await assert.rejects(() => spec.answerRun({ runId: waiting.id, text: '   ' }), /answer is required/);
    await assert.rejects(() => spec.answerRun({ runId: 'run-does-not-exist', text: 'x' }), /Unknown run/);
    spec.shutdown();
  }

  // Hands-off mode: one instruction in, a finished thing to look at.
  //
  // The owner asked for a mode where the fleet settles the open decisions itself and
  // they only check the demo at the end. The front desk's stage two already existed
  // for exactly this — told the owner has answered, it may not ask again and must
  // choose safe defaults — so the answer is supplied rather than waited for.
  {
    const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-demo-test-'));
    let calls = 0;
    const facilitator = {
      pending: null,
      reset() { this.pending = null; },
      async facilitate() {
        calls += 1;
        if (calls === 1) return { status: 'needs_clarification', provider: 'ollama', latencyMs: 1,
          questions: [{ ask: 'which genre?', options: ['shooter', 'puzzle'] }] };
        return { status: 'ready', provider: 'ollama', planHash: 'h', latencyMs: 1,
          promptSpec: { goal: 'Build a browser shooter.', constraints: [], steps: ['a'], acceptance: ['runs'] },
          promptSpecText: 'Goal: Build a browser shooter.' };
      },
    };
    const conversationEngine = { model: 'stub',
      turn: async () => ({ kind: 'TASK', reply: 'はい。', title: 't', summary: '', ideas: [], requirements: [],
        decisions: [], openQuestions: [], todos: [], turnId: 'turn-demo', provider: 'local-qwen', latencyMs: 1, degraded: false }) };
    const hands = new DaemonEngine({ stateRoot: demoRoot, workspace: process.cwd(), conversationEngine, facilitator });
    const out = await hands.turn('ゲームを作って', { mode: 'demo' });
    assert.equal(out.awaitingAnswer, false, 'hands-off must not stop to ask the owner anything');
    assert.deepStrictEqual(out.questions, []);
    assert.ok(out.run, 'it still has to produce a run');
    assert.equal(out.run.promptSpec.goal, 'Build a browser shooter.', 'the decisions are made and written into the spec');
    assert.notEqual(out.run.status, 'AWAITING_APPROVAL', 'a hands-off writing run does not wait for approval');
    assert.equal(calls, 2, 'the open questions are answered by a second facilitation, not by guessing');
    // Hands-off is not unaccountable. The owner sees one instruction go in and a
    // finished thing come out, so what was settled for them is named on the plan.
    assert.deepStrictEqual(out.run.promptSpec.decidedWithoutOwner,
      [{ ask: 'which genre?', options: ['shooter', 'puzzle'] }],
      'the decisions made without asking have to be declared');
    // Permissive on this machine, never over the network. The daemon listens on
    // 0.0.0.0 and a token on the LAN must not be able to buy unattended writes.
    assert.equal(effectiveMode({ socket: { remoteAddress: '192.168.1.20' } }, 'demo'), 'plan',
      'hands-off may not be requested from the LAN');
    assert.equal(effectiveMode({ socket: { remoteAddress: '127.0.0.1' } }, 'demo'), 'demo');
    hands.shutdown();
  }

  // The memory learns, or it is only a cache.
  {
    const { DeliberationMemory } = require('../src/domain/pi-agent/deliberation');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-delib-')), 'memory.json');
    const memory = new DeliberationMemory({ file });
    const ask = 'build a three js shooter game for the browser';
    memory.store(ask, { steps: ['scene', 'player', 'enemies'], contributors: ['leader'], lenses: 2 });
    assert.deepStrictEqual(memory.lookup(ask).outcomes, { ok: 0, failed: 0 }, 'untried is stated, not inferred');
    assert.equal(memory.lookup(ask).proven, false);
    // store() ran at planning time and nothing ever came back, so a plan that led
    // straight to a failed run was recalled forever with the confidence of one that
    // shipped.
    memory.record(ask, { ok: false, runId: 'run-1', reason: 'tests-pass' });
    assert.equal(memory.lookup(ask), null, 'a plan that has failed more than it has worked is not recalled');
    memory.record(ask, { ok: true, runId: 'run-2' });
    assert.deepStrictEqual(memory.lookup(ask).outcomes, { ok: 1, failed: 1 }, 'and it comes back once it has worked');
    assert.equal(memory.lookup(ask).proven, true);
    assert.equal(memory.record('an unrelated request about music generation', { ok: true }), null,
      'an outcome lands on the plan it belongs to or on nothing');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
    assert.match(source, /this\.memory\.record\(run\.prompt/, 'a finished run has to tell the memory what happened');
  }

  // The open decisions reach the discussion, not just the front desk.
  //
  // One local model choosing alone is a thin basis for "what kind of thing are we
  // building". The lenses already answer independently and are already merged, so the
  // questions go in front of them and the merge is the discussion.
  {
    const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
    const coordinator = Object.create(CoreExecutionCoordinator.prototype);
    coordinator.skills = { brief: () => '' };
    const lens = { id: 'risk', instruction: 'Find what breaks.', title: 'Risk' };
    const withOpen = coordinator._lensPrompt({ id: 'run-1', prompt: 'ゲームを作って',
      promptSpec: { decidedWithoutOwner: [{ ask: 'どのジャンルにしますか？' }] } }, lens);
    assert.match(withOpen, /どのジャンルにしますか？/, 'the lens has to see the decision it is meant to weigh in on');
    assert.match(withOpen, /state your own position on each/, 'and be told to take a position rather than assume one');
    const without = coordinator._lensPrompt({ id: 'run-2', prompt: 'x', promptSpec: {} }, lens);
    assert.ok(!/state your own position/.test(without), 'a run with nothing open must not be given a question list');
  }

  // Self-repair: it asks why, it does not stop to ask permission, and it remembers.
  {
    const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
    const { FailureMemory, signatureOf } = require('../src/domain/pi-agent/failure-memory');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');

    // A. The repair ran the whole loop and then stopped for approval in every mode,
    // including the hands-off one — which is why an unattended run never finished.
    assert.match(source, /REPAIR_RUNS_UNATTENDED/, 'the decision has to be one word to find and to reverse');
    assert.match(source, /this\._emit\(run, 'repair-released'\); this\._release\(run\)/,
      'a released repair has to actually be released');
    assert.ok(!/run\.status = 'AWAITING_APPROVAL'; this\._emit\(run, 'repair-awaiting-approval'\); return;/.test(source),
      'and must not still claim to be waiting on the way past');

    // B. The diagnosis is read-only and belongs to the assignment it explains. A repair
    // that could acquire write permission the original plan lacked would be an
    // escalation, not a repair.
    const planned = [];
    const coordinator = Object.create(CoreExecutionCoordinator.prototype);
    coordinator.taskRunner = {
      get: (id) => (id === 'task-a' ? { failureReason: 'quota-exhausted', error: 'gemini quota spent' } : null),
      plan: (task) => { planned.push(task); return { ...task, status: 'queued', disclosure: {} }; },
    };
    coordinator.taskToRun = new Map();
    coordinator.failures = new FailureMemory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-')), 'm.json') });
    coordinator._pick = () => 'qwen';
    const run = { id: 'run-1', prompt: 'build a browser game', cwd: process.cwd(), repairCycle: 0, planHash: 'h', assignments: [] };
    const failing = { taskId: 'task-a', role: 'leader', provider: 'gemini', model: 'gemini-x', write: true, status: 'failed' };
    run.assignments.push(failing);
    assert.equal(coordinator._planDiagnosis(run, failing), true);
    assert.equal(planned.length, 1);
    assert.equal(planned[0].metadata.write, false, 'a diagnosis may never be given write permission');
    assert.equal(planned[0].metadata.kind, 'diagnosis');
    assert.equal(planned[0].metadata.diagnosisFor, 'task-a', 'it has to be attributable to what it explains');
    assert.match(planned[0].prompt, /Classified as: quota-exhausted/, 'the classification was computed and never used before');
    assert.match(planned[0].prompt, /read-only\. Do not edit files/);
    assert.match(planned[0].prompt, /CAUSE:/); assert.match(planned[0].prompt, /FIX:/);
    assert.equal(run.assignments.at(-1).kind, 'diagnosis');
    assert.equal(run.assignments.at(-1).write, false);
    assert.equal(coordinator._planDiagnosis(run, failing), false, 'asked once, not once per cycle');

    // The answer has to reach the retry, or asking was theatre.
    assert.match(source, /Diagnosis: \$\{assignment\.diagnosis\.cause\}/, 'the repair prompt carries the cause');
    assert.match(source, /Smallest fix: \$\{assignment\.diagnosis\.fix\}/);

    // A diagnosis is not a deliverable: it must not satisfy a quality check, and a
    // failed diagnosis must not become another thing to repair.
    assert.match(source, /item\.kind !== 'diagnosis' && item\.status === 'completed'/, 'maker-checker excludes diagnoses');
    assert.match(source, /item\.status !== 'completed' && item\.kind !== 'diagnosis'/, 'and so does the failed set');

    // D. The memory learns, and can be disappointed.
    const memory = coordinator.failures;
    const sig = signatureOf({ reason: 'quota-exhausted', check: 'leader' });
    assert.equal(memory.lookup({ signature: sig }), null, 'nothing is known before anything happens');
    memory.record({ signature: sig, prompt: 'build a browser game', cause: 'quota spent', fix: 'route to glm first', runId: 'run-1' });
    const known = memory.lookup({ signature: sig });
    assert.equal(known.fix, 'route to glm first');
    assert.equal(known.resolved, false, 'untried is stored as untried, never dressed up as proven');
    memory.record({ signature: sig, prompt: 'build a browser game', runId: 'run-2' });
    assert.equal(memory.lookup({ signature: sig }).occurrences, 2, 'a repeat is a count, not a second entry');
    memory.resolve({ signature: sig, ok: false });
    assert.equal(memory.lookup({ signature: sig }), null, 'a remedy that has only ever failed is not recalled');
    memory.resolve({ signature: sig, ok: true });
    assert.equal(memory.lookup({ signature: sig }).resolved, true, 'and it comes back once it has worked');
    assert.match(memory.lookup({ prompt: 'make a game for the browser' })?.source || '', /wording/,
      'a request that has not failed yet can still be warned about the wall it is walking into');
  }

  // A live handle must never reach the session file.
  //
  // Measured 2026-08-05: a task carrying its abort timer went into JSON.stringify and
  // threw "Converting circular structure to JSON" out of shutdown(), from inside an
  // EventEmitter callback where nothing could catch it — so the process died instead
  // of one append failing.
  {
    const timer = setTimeout(() => {}, 60000); timer.unref();
    const task = { id: 'task-1', status: 'running', when: new Date('2026-08-05T00:00:00Z'),
      deadlineTimer: timer, onDone: () => {}, nested: { list: [1, 'two'] } };
    task.self = task;
    const safe = jsonSafe(task);
    assert.doesNotThrow(() => JSON.stringify(safe), 'whatever a task carries, the transcript line has to serialise');
    assert.equal(safe.id, 'task-1');
    assert.equal(safe.status, 'running');
    assert.equal(safe.when, '2026-08-05T00:00:00.000Z', 'a Date is a timestamp, not an empty object');
    assert.deepStrictEqual(safe.nested, { list: [1, 'two'] }, 'real data survives intact');
    assert.equal(safe.deadlineTimer, undefined, 'a timer handle is dropped');
    assert.equal(safe.onDone, undefined, 'so is a function');
    assert.equal(safe.self, undefined, 'and a cycle does not recurse forever');
    clearTimeout(timer);
  }

  // The three marks around teardown are the point of the instrumentation: they say
  // whether the kill lands before close() is reached, inside it, or after it while
  // the process is winding down on its own.
  mark('closing listener');
  await new Promise((resolve) => listener.close(resolve));
  mark('listener closed');
  // ---- the settings block that never left the file ---------------------------
  //
  // `ownerSettings()` assembled two keys — routing and quality — and `conversation` was
  // not one of them, so `cloudFallback: () => ownerSettings()?.conversation?.cloudFallback
  // || 'off'` read undefined and answered 'off' on every call. Measured 2026-08-10: the
  // owner's settings.json had said "gpu-busy" for a day and the escape it enables had
  // never once been reachable. A switch they had already thrown, wired to nothing.
  {
    const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-daemon-settings-'));
    const engine = new DaemonEngine({ stateRoot: settingsRoot, workspace: process.cwd() });
    const file = path.join(require('../src/core/path-config').createPathConfig({ appRoot: process.cwd() }).userData, 'settings.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { saved = {}; }
    const settings = engine.ownerSettings();
    assert.ok(settings.conversation, 'the conversation block reaches the daemon at all');
    assert.equal(settings.conversation.cloudFallback, saved.conversation?.cloudFallback,
      'and it carries the owner’s own value rather than a second default invented here');
    // The two that are deliberately overridden stay overridden. executionMode is the safe
    // fallback under effectiveMode(), not a setting this layer is allowed to relay.
    assert.equal(settings.routing.executionMode, 'plan', 'the pin the HTTP layer relies on is untouched');
    assert.equal(settings.quality.gate, 'strict');

    // The same omission, third time (2026-08-15). It was createPathConfig without
    // `saved`, then the conversation block above, then `detectAndProbeAll({})` — the
    // daemon's own tool scan, passing nothing where main.js passes the owner's paths.
    // A tool path typed into Settings showed "present" in the settings window and
    // "missing" in /api/state, for the same tool, at the same moment.
    //
    // So this no longer checks one named block. Every group the store persists must
    // either arrive, or be listed here as deliberately withheld — adding a group to
    // settings-store and forgetting to carry it fails the suite instead of going quiet.
    const { DEFAULTS } = require('../src/core/settings-store');
    const WITHHELD = new Set([
      'audio', 'preview', 'appearance', 'piAgent', 'terminal', 'cmux', // renderer-only
    ]);
    const dropped = Object.keys(DEFAULTS)
      .filter((group) => !WITHHELD.has(group) && !settings[group]);
    assert.deepEqual(dropped, [],
      `these settings groups never reach the daemon: ${dropped.join(', ')}`
      + '\n       → carry them in ownerSettings(), or add them to WITHHELD with a reason');

    // And the one that had a live consumer: the daemon must hand its own tool scan the
    // owner's paths, not an empty object.
    // Comments are stripped first: the note explaining this bug quotes the broken call
    // verbatim, and a guard that its own documentation trips is a guard nobody keeps.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8')
      .split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.doesNotMatch(source, /detectAndProbeAll\(\s*\{\s*\}\s*\)/,
      'refreshTools() must pass the owner’s paths into the registry, not {}');

    fs.rmSync(settingsRoot, { recursive: true, force: true });
    mark('settings block reaches the router');
  }

  console.log('daemon selftest: PASS · WebSocket/SSE · JSONL session · one-time mobile pairing · stale-plan guard · reload · approval-skipping modes are loopback only · a finished run is not the current phase · the front desk writes the spec, an open question holds the run back, the answer builds it, and a waiting plan can be answered instead of guessed at · hands-off decides its own open questions and never over the LAN · the deliberation memory learns from what happened · the repair asks why, does not stop to ask permission, and remembers the answer · the conversation settings block reaches the router instead of being dropped');
  mark('pass printed');
})().catch((error) => { console.error(error); process.exit(1); });
