'use strict';
const assert = require('assert');
const router = require('../src/domain/pi-agent/model-router');
const knowledge = require('../src/domain/pi-agent/pi-knowledge-orchestrator');

const chain = router.buildChain({ zai: true, ollama: true, google: true, moonshot: true, openrouter: true }, { allowPaid: true });
assert.deepStrictEqual(chain.map((x) => x.id), ['ollama/qwen2.5:0.5b', 'zai/glm-5.2', 'ollama/qwen3.5:35b-a3b']);
assert.deepStrictEqual(router.buildChain({ zai: true, ollama: true }).map((x) => x.id), ['ollama/qwen2.5:0.5b', 'ollama/qwen3.5:35b-a3b']);
for (const p of ['kimi', 'openrouter', 'elevenlabs']) assert.throws(() => knowledge.assertExecutor(p), /blocked/);
for (const p of ['claude', 'claude-code', 'codex', 'gemini', 'glm', 'ollama', 'qwen']) assert.equal(knowledge.assertExecutor(p), true);
assert.equal(knowledge.canSpend('ollama', false), true);
assert.equal(knowledge.canSpend('glm', true), true);
assert.equal(knowledge.canSpend('glm', false), false);
assert.equal(knowledge.canSpend('gemini', true), true);

// ---- warming the local model before the owner needs it ----------------------
// The predecessor of this function was written, exported, and never called once, so
// every first turn after launch paid the cold load. ConversationEngine gives up at 8s
// and answers from the deterministic fallback, which means a cold model does not
// answer slowly — it answers from the wrong path and marks itself degraded.
(async () => {
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ response: '' }) }; };
  const warm = await router.warmModel('qwen2.5:0.5b', { fetchImpl: okFetch });
  assert.strictEqual(warm.ok, true);
  assert.strictEqual(warm.model, 'qwen2.5:0.5b');
  assert(warm.ms >= 0 && Number.isFinite(warm.ms), 'the caller gets a real duration, not a promise that it happened');
  assert.match(calls[0].url, /\/api\/generate$/);
  assert.strictEqual(calls[0].body.prompt, '', 'an empty prompt loads the weights without generating anything to discard');
  assert.strictEqual(calls[0].body.keep_alive, -1, 'resident, matching what the conversation turn itself asks for');
  assert.strictEqual(calls[0].body.options, undefined, 'no options asked for, none sent');

  // Ollama keys a loaded instance on its runtime options, so a warmup that omits the
  // num_ctx the turn will use is unloaded and reloaded the moment real work arrives.
  // Measured 2026-08-02 on qwen3.5:latest: warm without num_ctx left the next
  // num_ctx:4096 request paying 3450ms; warming with it brought that to 254ms. This
  // assertion exists because the failure is invisible — the warmup still reports ok.
  const withCtx = [];
  await router.warmModel('qwen3.5:latest', { options: { num_ctx: 4096 },
    fetchImpl: async (url, init) => { withCtx.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; } });
  assert.deepStrictEqual(withCtx[0].options, { num_ctx: 4096 },
    'the warmup has to load the same instance the turn will ask for, or it warms nothing');

  // A model Ollama does not have must report, not throw: the next turn still works,
  // it is just slow, and a warmup that crashed the daemon would be far worse.
  const missing = await router.warmModel('not-installed:1b', {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'model not found' }) }) });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /model not found/);

  assert.strictEqual((await router.warmModel('', { fetchImpl: okFetch })).ok, false, 'no configured model is not a warmup');
  assert.strictEqual(calls.length, 1, 'and does not reach the network — only the real warmup did');

  const refused = await router.warmModel('qwen2.5:0.5b', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/, 'Ollama being down is reported, not thrown');

  console.log('cost policy selftest: PASS · warmup measured, non-throwing, and pinned to the resident keep-alive');
})().catch((error) => { console.error(error); process.exitCode = 1; });
