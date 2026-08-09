'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const router = require('../src/domain/pi-agent/fast-api-router');
// Local first, and the only other entry is the GPU-busy escape. The order matters: a
// candidate list that put glm ahead of ollama would send the owner's text to a cloud
// provider on a machine that was perfectly able to answer.
assert.deepStrictEqual(router.PRIORITY, ['ollama', 'glm']);
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

  // ---- the GPU-busy escape, and the two bugs that were waiting for it ----------
  //
  // The front desk is local-only by design: no owner text may reach a paid provider
  // before a disclosure manifest is approved. That is also why, while gpu-signal.sh held
  // the card for a render, every request fell through to the three-step deterministic
  // spec — the machine had nothing to think with. The owner asked for a way through
  // (2026-08-09) and chose GLM's free flash tier.
  //
  // What must stay true: it is shut unless BOTH the GPU is unavailable AND the owner
  // turned it on, it never runs while local can, and the answer says where it went.

  // Asserted key by key, and never on `ollama`: that one is a live probe of whatever is
  // listening on 11434 while the suite runs, so a deepStrictEqual here passes at midnight
  // and fails at noon. This file is not allowed to have an opinion about the owner's GPU.
  {
    const shut = await router.detect({ cloudFallback: 'off', gpuHeld: true });
    for (const paid of ['glm', 'claude', 'codex', 'gemini', 'kimi', 'openrouter']) {
      assert.equal(shut[paid], false, `${paid}: the default is shut, whatever the GPU is doing`);
    }
  }
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: false })).glm, false,
    'a free GPU means local — the escape is not a preference for the cloud');
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: true })).glm, true,
    'held card plus an owner who asked for it: this one turn may leave the machine');

  // The dispatch table. The loop used to call runOllama whatever the candidate was — a
  // provider name recorded against another model's output. Invisible while nothing but
  // ollama could ever be a candidate, and wrong the moment one could.
  {
    const called = [];
    const spec = JSON.stringify({ status: 'ready', promptSpec: { goal: 'g', constraints: [], steps: ['s'], acceptance: ['a'] } });
    const runners = {
      ollama: async () => { called.push('ollama'); throw new Error('SIGSTOPped'); },
      glm: async () => { called.push('glm'); return spec; },
    };
    const escaped = new router.FastFacilitatorRouter({ cloudFallback: () => 'gpu-busy', runners,
      detectImpl: async () => ({ ollama: true, glm: true }) });
    const out = await escaped.facilitate(`gpu busy escape ${process.pid}`);
    assert.deepStrictEqual(called, ['ollama', 'glm'], 'local is tried first and the fallback is second');
    assert.equal(out.provider, 'glm', 'the name has to be the thing that actually wrote it');
    assert.equal(out.viaCloud, true);
    assert.match(out.cloudNote, /クラウド/, 'the owner is told, in the reply, that their words left the machine');
    assert.match(out.promptSpecText, /Goal: g/, 'and the spec is the one the cloud model wrote');
  }

  // A candidate with no runner is a drifted table, not a silent substitution.
  {
    const orphan = new router.FastFacilitatorRouter({ runners: {}, detectImpl: async () => ({ ollama: true }) });
    const out = await orphan.facilitate(`no runner ${process.pid}`);
    assert.equal(out.provider, 'deterministic-local', 'nothing ran, so nothing is credited');
    assert.match(out.fallbackReason || '', /no runner for ollama/);
  }

  // Redaction before the machine boundary. There is no disclosure manifest on this path,
  // so the half that can still be kept is kept — the same `redactPayload` the manifest
  // runs, with the same two outcomes it has everywhere else: a key is replaced, a private
  // key stops the call.
  {
    let sent = null;
    await router.runGlm(`use my key sk-ant-api03-${'A'.repeat(80)} to do it`,
      { spawn: (bin, args, opts, done) => { sent = args.at(-1); done(null, '{}', ''); } });
    assert.ok(!sent.includes('sk-ant-'), `the key must not reach the argv of a cloud process: ${sent}`);
    assert.match(sent, /<REDACTED:anthropic-key>/, 'and its absence is marked rather than silently blanked');
    assert.match(sent, /use my .* to do it/, 'the rest of the request survives — redaction is not truncation');
  }
  await assert.rejects(
    async () => router.runGlm('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      { spawn: () => { throw new Error('must not spawn'); } }),
    /SECURITY_CRITICAL_SECRET/, 'a private key is the one that stops the call instead of being masked');

  // The command itself: single-shot, no tools, no context, no session. What leaves is one
  // prompt — not this repository.
  {
    let seen = null;
    await router.runGlm('shape this request', { spawn: (bin, args, opts, done) => { seen = { bin, args, opts }; done(null, 'ok', ''); } });
    for (const flag of ['--print', '--no-tools', '--no-context-files', '--no-session', '--no-skills']) {
      assert.ok(seen.args.includes(flag), `${flag} is what keeps this to one prompt and nothing else`);
    }
    assert.ok(seen.args.includes(`zai/${router.MODELS.glm}`), 'the flash tier, which is the free one');
    assert.equal(seen.args.at(-1), 'shape this request', 'the prompt is the last argument, not shell-interpolated');
    assert.equal(seen.opts.timeout, router.GLM_TIMEOUT_MS, 'and it cannot hang the front desk');
  }

  // runOllama had no deadline at all. `ollamaReady()` probes with 850ms in front of it,
  // which hid the hang — but a render that starts between the probe and the call leaves
  // this awaiting a socket that a SIGSTOPped process accepted and will never answer.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'fast-api-router.js'), 'utf8');
    assert.match(source, /new AbortController\(\)[\s\S]{0,200}OLLAMA_TIMEOUT_MS/,
      'the local call needs its own deadline, not the readiness probe’s');
    assert.match(source, /redactPayload/, 'and nothing reaches a cloud provider unredacted');
  }

  console.log('fast router selftest: PASS · 16 added checks · think:false or the model spends the answer on thinking · '
    + 'the deterministic fallback is never cached · a fieldless cache entry reads as a miss · spec in English, questions in the '
    + 'owner\'s language · proper nouns verbatim · answer() refuses an empty pair and cleans up after itself · the GPU-busy escape '
    + 'is shut by default, never used while local works, and names itself in the reply · each candidate runs its own runner');
})();
