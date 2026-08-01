'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { sanitizeOwnerSpeech, isOwnerFacingEvent } = require('../src/core/tts-policy');
const { FleetMetricsStore } = require('../src/core/fleet-metrics-store');

const cleaned = sanitizeOwnerSpeech('<thinking>secret draft</thinking>\nThinking: hidden\n最終報告です。');
assert.strictEqual(cleaned, '最終報告です。');
assert.ok(isOwnerFacingEvent({ kind: 'agent_end' }));
assert.ok(!isOwnerFacingEvent({ kind: 'thinking' }));

const fleet = new FleetMetricsStore();
fleet.ingestSwarm({ mode: 'cache', savedTokens: 142500 });
const snapshot = fleet.snapshot();
assert.deepStrictEqual(snapshot.agents.map((agent) => agent.label), ['Arch-Pi', 'Context-Pi', 'Sync-Pi', 'Voice-Pi']);
assert.strictEqual(snapshot.totals.tokensSaved, 142500);

const mobile = fs.readFileSync(path.join(root, 'src/components/UI/remote/mobile.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/core/main.js'), 'utf8');
assert.doesNotMatch(mobile, /ttsScan\(false\)/);
assert.doesNotMatch(main, /function ttsScan/);
assert.match(main, /agent_end/);
console.log('runtime policy selftest: PASS');
