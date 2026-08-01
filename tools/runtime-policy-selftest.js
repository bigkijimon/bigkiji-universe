'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { sanitizeOwnerSpeech, isOwnerFacingEvent } = require('../src/core/tts-policy');
const { ModelStatusStore } = require('../src/domain/hud/model-status-store');
const { DEFAULTS } = require('../src/core/settings-store');

const cleaned = sanitizeOwnerSpeech('<thinking>secret draft</thinking>\nThinking: hidden\n最終報告です。');
assert.strictEqual(cleaned, '最終報告です。');
assert.ok(isOwnerFacingEvent({ kind: 'agent_end' }));
assert.ok(!isOwnerFacingEvent({ kind: 'thinking' }));

const fleet = new ModelStatusStore();
fleet.setAvailability({ claude: true, codex: true, gemini: true, glm: true, ollama: true });
fleet.ingestSwarm({ mode: 'cache', savedTokens: 142500 });
const snapshot = fleet.snapshot();
assert.deepStrictEqual(snapshot.models.map((model) => model.displayName), ['Claude Code', 'Codex', 'Gemini', 'GLM', 'PiAgent Engine', 'Local Qwen']);
assert.strictEqual(snapshot.connected, 1);
assert.ok(snapshot.models.filter((model) => model.id !== 'pi-agent-core').every((model) => model.available && !model.connected));
assert.strictEqual(snapshot.totals.tokensSaved, 142500);
assert.strictEqual(DEFAULTS.routing.executionMode, 'plan');
assert.strictEqual(DEFAULTS.routing.maxAgents, 3);
assert.strictEqual(DEFAULTS.routing.activationMode, 'on-demand');
assert.strictEqual(DEFAULTS.quality.repairScope, 'broad');
assert.strictEqual(DEFAULTS.preview.preferredPort, 4317);

const mobile = fs.readFileSync(path.join(root, 'src/components/UI/remote/mobile.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/core/main.js'), 'utf8');
assert.doesNotMatch(mobile, /ttsScan\(false\)/);
assert.match(mobile, /powerPreference:\s*'high-performance'/);
assert.match(mobile, /DEVICE GPU/);
assert.match(mobile, /applyMobileInventory/);
assert.doesNotMatch(mobile, /const N = 500/);
assert.doesNotMatch(main, /function ttsScan/);
assert.match(main, /agent_end/);
console.log('runtime policy selftest: PASS');
