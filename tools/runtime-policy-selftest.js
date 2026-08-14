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
assert.match(mobile, /Owner approval required/);
assert.match(mobile, /x-bigkiji-csrf/);
assert.match(mobile, /Hold to accept/);
assert.match(main, /action: request \? 'pair' : 'status'/);
assert.doesNotMatch(main, /function ttsScan/);
assert.match(main, /agent_end/);

// No control in the settings window may be wired to a setting nothing reads.
//
// Eight were, and the owner spent a session concluding that "設定が一回も効いたことがない".
// Two of those eight really were broken wiring (fixed 2026-08-14); the other six had no
// consumer at all and never could have worked. A knob that moves and changes nothing
// teaches the owner not to trust the window, which is more expensive than the missing
// feature. If one of these is implemented later, put its row back at the same time.
{
  const modal = fs.readFileSync(path.join(root, 'src/components/UI/settings-modal.js'), 'utf8');
  const UNREAD = ['quality.repairScope', 'quality.rollbackOnRegression', 'quality.smokeAfterRestart',
    'quality.testTimeoutMs', 'quality.researchCacheDays', 'quality.officialSourcesFirst',
    'routing.qwenBypassTimeoutMs', 'terminal.maxTabs'];
  for (const key of UNREAD) {
    assert.doesNotMatch(modal, new RegExp(`data-setting="${key.replace('.', '\\.')}"`),
      `${key} has no reader in the codebase — it must not be offered as a control`);
    // ...and the key itself stays in the store, because saved files hold it.
    const [group, name] = key.split('.');
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS[group], name),
      `${key} must stay in DEFAULTS so normalize() does not discard a saved value`);
  }
}

console.log('runtime policy selftest: PASS');
