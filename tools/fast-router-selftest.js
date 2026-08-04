'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const router = require('../src/domain/pi-agent/fast-api-router');
assert.deepStrictEqual(router.PRIORITY, ['ollama']);
assert.deepStrictEqual(router.PAID_EXECUTORS, ['claude', 'codex', 'gemini', 'glm']);
assert.deepStrictEqual(router.availableOrder({ gemini: true, ollama: true, glm: false, codex: true, kimi: true }), ['ollama']);
for (const blocked of ['kimi', 'openrouter', 'openai-tts', 'elevenlabs']) assert(router.BLOCKED_PAID.includes(blocked));
assert.deepStrictEqual(router.availableOrder({}), []);
const fallback = router.fallbackSpec('Implement a safe test');
assert.equal(fallback.status, 'ready');
assert.match(router.facilitatorPrompt('task', '["answer"]'), /Do not ask another question/);

// The spec is written in English; the questions are not.
//
// Measured 2026-08-05: 「3djsのゲームを作ってください。」 already produced an English
// spec, because this prompt is in English and the model followed it — incidentally,
// not because anything asked. The half that was missing is the one that costs: a
// translated proper noun is a requirement change the owner cannot see, since they
// read the request in Japanese and the spec in English.
const prompt = router.facilitatorPrompt('3djsのゲームを作ってください。');
assert.match(prompt, /Write the Prompt Spec in English/, 'the spec language has to be stated, not left to luck');
assert.match(prompt, /Ask your questions in the owner's own language/, 'a question the owner cannot read is not a question');
assert.match(prompt, /Never translate names, file paths, identifiers, numbers/, 'proper nouns must survive the trip');

// Stage two for a question this router did not ask.
//
// The `⚠ unanswered` on a waiting plan came from the conversation model, so the
// router holds no pending state for it — the pair has to be handed in. Everything
// below is checked without a model: `answer()` must refuse an empty pair rather
// than quietly facilitate a blank one.
const facilitator = new router.FastFacilitatorRouter();
assert.equal(facilitator.pending, null);
assert.rejects(() => facilitator.answer('goal', [], 'my answer'), /no question to answer/,
  'answering nothing must fail loudly, not build a spec out of thin air');
assert.rejects(() => facilitator.answer('goal', ['which genre?'], '   '), /answer is required/,
  'whitespace is not an answer');
// The reasoning budget, and the cache that outlived its own failure.
//
// Three measurements from 2026-08-05, in the order they were found:
//   1. every request came back as the deterministic spec — `fallbackReason` said
//      "ollama returned invalid facilitator JSON" after 2.6s. qwen3.5 is a reasoning
//      model and spent all 700 tokens of num_predict thinking, so nothing parsed.
//      conversation-engine.js had already found this and set `think: false`; the fix
//      never reached here.
//   2. that deterministic spec was then written to the plan cache, so one unreachable
//      moment became the permanent answer to that request — served in 2ms forever.
//   3. the cache carried prose and no fields, so a hit produced a *worse* spec than a
//      miss: the caller read `promptSpec`, found nothing, and used what it already had.
// Source assertions, because the alternative is a test that needs a 21GB model.
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'fast-api-router.js'), 'utf8');
  assert.match(source, /think: false/, 'a reasoning model spends the whole answer budget thinking unless told not to');
  assert.match(source, /if \(cached\?\.spec\)/, 'a cache entry without fields must read as a miss, not as a spec');
  assert.match(source, /modelWrote \? knowledge\.rememberPlan/, 'the deterministic fallback must not be remembered as a plan');
}

// The plan cache keeps the fields, not just the prose.
{
  const knowledge = require('../src/domain/pi-agent/pi-knowledge-orchestrator');
  const task = knowledge.createTask(`selftest facilitator round trip ${process.pid}`, 'facilitated');
  const spec = { goal: 'Create a single-file HTML5 3D game using Three.js.', constraints: 'Three.js via CDN',
    steps: ['scene, camera, renderer'], acceptance: ['runs with no build step'] };
  const stored = knowledge.rememberPlan(task, 'Goal: ...', [], spec);
  assert.equal(stored.spec.goal, spec.goal);
  assert.deepStrictEqual(stored.spec.constraints, ['Three.js via CDN'], 'a bare string has to survive as a list');
  const found = knowledge.findPlan(`selftest facilitator round trip ${process.pid}`);
  assert.ok(found, 'the entry has to be findable by the text it was written for');
  assert.equal(found.spec.goal, spec.goal, 'and it has to still carry its fields');
  assert.equal(knowledge.rememberPlan(task, 'Goal: ...', []).spec, null, 'no spec handed in means no spec claimed');
}

(async () => {
  // A failing stage two leaves nothing behind. Pending state that outlives its own
  // failure would make the next unrelated turn read as an answer to a dead question.
  const broken = new router.FastFacilitatorRouter();
  broken.facilitate = async () => { throw new Error('ollama unreachable'); };
  await assert.rejects(() => broken.answer('goal', ['which genre?'], 'shooter'), /ollama unreachable/);
  assert.equal(broken.pending, null, 'a failed answer must not leave the router waiting for one');
  console.log('fast router selftest: PASS · 16 added checks · think:false or the model spends the answer on thinking · the deterministic fallback is never cached · a fieldless cache entry reads as a miss · spec in English, questions in the owner\'s language · proper nouns verbatim · answer() refuses an empty pair and cleans up after itself');
})();
