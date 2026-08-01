import assert from 'node:assert/strict';
import { TelemetryStore } from '../src/domain/telemetry/components/telemetry-store.js';

const store = new TelemetryStore({ limit: 3 });
store.ingest({ id: '1', source: 'claude-code', kind: 'tool_start', text: 'Refactoring shader', ts: 1000 }, 'pi');
store.ingest({ id: '1', source: 'claude-code', kind: 'tool_start', text: 'duplicate', ts: 1001 }, 'pi');
assert.equal(store.snapshot().events.length, 1, 'event ids must be deduplicated');
assert.equal(store.snapshot().events[0].agent, 'CLAUDE CODE');
assert.equal(store.snapshot().events[0].status, 'EXEC');
store.setPhase('EXECUTE', 62, 'Running tools');
assert.deepEqual(store.snapshot().phase, { name: 'EXECUTE', progress: 62, detail: 'Running tools', state: 'active' });
store.setComfy({ state: 'running', progress: 35, node: 'SAMPLING', message: 'Sampling 7/20' });
assert.equal(store.snapshot().comfy.progress, 35);
store.ingest({ id: '2', source: 'vault', kind: 'sync', text: 'file A', ts: 2000 });
store.ingest({ id: '3', source: 'vault', kind: 'sync', text: 'file B', ts: 3000 });
store.ingest({ id: '4', source: 'vault', kind: 'sync', text: 'file C', ts: 4000 });
assert.equal(store.snapshot().events.length, 3, 'feed must remain bounded');

console.log('telemetry store selftest: PASS');
