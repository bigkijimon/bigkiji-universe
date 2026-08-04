'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DaemonEngine, startDaemon, jsonSafe } = require('../src/domain/server/daemon');
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
    await assert.rejects(() => spec.answerRun({ runId: answered.run.id, text: 'shooter' }), /no unanswered question/,
      'a plan with nothing to answer says so instead of rewriting itself');
    await assert.rejects(() => spec.answerRun({ runId: waiting.id, text: '   ' }), /answer is required/);
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

  await new Promise((resolve) => listener.server.close(resolve)); engine.shutdown();
  console.log('daemon selftest: PASS · WebSocket/SSE · JSONL session · one-time mobile pairing · stale-plan guard · reload · approval-skipping modes are loopback only · a finished run is not the current phase · the front desk writes the spec, an open question holds the run back, the answer builds it, and a waiting plan can be answered instead of guessed at · hands-off decides its own open questions and never over the LAN · the deliberation memory learns from what happened');
})().catch((error) => { console.error(error); process.exit(1); });
