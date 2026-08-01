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
  await new Promise((resolve) => listener.server.close(resolve)); engine.shutdown();
  console.log('daemon selftest: PASS · WebSocket/SSE · JSONL session · one-time mobile pairing · stale-plan guard · reload');
})().catch((error) => { console.error(error); process.exit(1); });
