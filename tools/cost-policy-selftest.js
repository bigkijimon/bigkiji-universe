'use strict';
const assert = require('assert');
const router = require('../src/domain/pi-agent/model-router');
const knowledge = require('../src/domain/pi-agent/pi-knowledge-orchestrator');

const chain = router.buildChain({ zai: true, ollama: true, google: true, moonshot: true, openrouter: true }, { allowPaid: true });
assert.deepStrictEqual(chain.map((x) => x.id), ['zai/glm-4.7-flash', 'ollama/qwen3.5:35b-a3b']);
assert.deepStrictEqual(router.buildChain({ zai: true, ollama: true }).map((x) => x.id), ['ollama/qwen3.5:35b-a3b']);
for (const p of ['gemini', 'kimi', 'openrouter', 'codex']) assert.throws(() => knowledge.assertExecutor(p), /blocked/);
for (const p of ['claude-code', 'glm', 'ollama']) assert.equal(knowledge.assertExecutor(p), true);
assert.equal(knowledge.canSpend('ollama', false), true);
assert.equal(knowledge.canSpend('glm', true), true);
assert.equal(knowledge.canSpend('glm', false), false);
console.log('cost policy selftest: PASS');
