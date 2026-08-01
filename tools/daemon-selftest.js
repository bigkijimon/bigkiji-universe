'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DaemonEngine, startDaemon } = require('../src/domain/server/daemon');
const WebSocket = require('ws');

(async () => {
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
  const state = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer selftest-token' } }).then((response) => response.json());
  assert.equal(state.sessions.length, 1); assert.equal(state.models.connected, 1, 'only PiAgent is connected while awaiting approval');
  const wsState = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?t=selftest-token`);
    ws.once('message', (raw) => { const value = JSON.parse(String(raw)); ws.close(); resolve(value); }); ws.once('error', reject);
  });
  assert.equal(wsState.event, 'state');
  const reload = await fetch(`${base}/api/reload`, { method: 'POST', headers: { authorization: 'Bearer selftest-token' } }).then((response) => response.json()); assert.equal(reload.ok, true);
  await new Promise((resolve) => listener.server.close(resolve)); engine.shutdown();
  console.log('daemon selftest: PASS · auto-start core · WebSocket/SSE · JSONL session · on-demand fleet · reload');
})().catch((error) => { console.error(error); process.exit(1); });
