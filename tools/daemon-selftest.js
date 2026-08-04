'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DaemonEngine, startDaemon } = require('../src/domain/server/daemon');
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

  await new Promise((resolve) => listener.server.close(resolve)); engine.shutdown();
  console.log('daemon selftest: PASS · WebSocket/SSE · JSONL session · one-time mobile pairing · stale-plan guard · reload · approval-skipping modes are loopback only · a finished run is not the current phase');
})().catch((error) => { console.error(error); process.exit(1); });
