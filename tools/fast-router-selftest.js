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
    const shut = await router.detect({ cloudFallback: 'off', gpuHeld: true, localReady: false });
    for (const paid of ['glm', 'claude', 'codex', 'gemini', 'kimi', 'openrouter']) {
      assert.equal(shut[paid], false, `${paid}: the default is shut, whatever the GPU is doing`);
    }
  }
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: false, localReady: true, glmReady: true })).glm, false,
    'a free GPU means local — the escape is not a preference for the cloud');
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: true, localReady: true, glmReady: true })).glm, false,
    'and a lock held by a job that left Ollama answering is still no reason to leave the machine');
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: true, localReady: false, glmReady: true })).glm, true,
    'held card, local silent, a key on the machine, and an owner who asked for it: this one turn may leave');

  // A setting is a permission. A credential is a different fact.
  //
  // These were the same test until 2026-08-10, when the owner reported that simple
  // questions were very slow and the machine said why: `~/.pi/agent/auth.json` is `{}`,
  // the daemon's environment carries GEMINI_API_KEY and GOOGLE_API_KEY and no
  // ZAI_API_KEY, and settings hold no secret. The escape had been switched on and
  // delivered as working, and GLM had never once been reachable. `detect()` offered it
  // on every frozen turn and every one of those turns paid a spawn to find out.
  assert.equal((await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: true, localReady: false, glmReady: false })).glm, false,
    'no ZAI_API_KEY means no candidate — do not spawn a provider that can only fail');
  assert.equal(router.glmCredentialled({}), false, 'an empty environment is not a configured provider');
  assert.equal(router.glmCredentialled({ ZAI_API_KEY: 'zk-test' }), true,
    'and the key pi documents for zai is the one that counts — it is the child that has to see it');

  // 850 ms spent confirming that a SIGSTOPped process will not answer.
  //
  // The probe cannot succeed against a stopped server: it accepts the connection and
  // returns nothing, so `ollamaReady()` can only run out its own clock. That was 850 ms
  // on the front of the slowest turn the owner has — the one taken during a render.
  // A source assertion, and named as one: the alternative is a test whose result depends
  // on whether the owner happens to be rendering, which is the mistake this file already
  // carries a comment about.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'fast-api-router.js'), 'utf8');
    assert.match(source, /isFrozen\(\) \? false : await ollamaReady\(\)/,
      'a stopped server is known to be unready without spending the probe on it');
  }
  // And nothing is probed at all when the caller states the machine.
  {
    let probes = 0;
    const realFetch = global.fetch;
    global.fetch = async (...args) => { probes += 1; return realFetch(...args); };
    try { await router.detect({ cloudFallback: 'gpu-busy', gpuHeld: true, localReady: false, glmReady: false }); }
    finally { global.fetch = realFetch; }
    assert.equal(probes, 0, 'an injected machine state must not reach out to 11434');
  }

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

  // The 60 seconds, and the reason there were 60 of them.
  //
  // Measured on the owner's machine 2026-08-10, while they watched it: the same command
  // with `< /dev/null` prints "No API key found for zai." and exits in 0.56 s; through
  // execFile, whose stdin is an open pipe, it ran 60010 ms and returned empty stdout and
  // empty stderr. pi wants to offer `/login` and waits for an answer nobody can give. So
  // every question asked during a render cost one full timeout before falling back to the
  // three generic steps. local-lookup.js closes stdin and explains why in a comment; the
  // reason had not reached the second place that spawns pi.
  {
    let closed = false;
    await router.runGlm('anything', {
      spawn: (bin, args, opts, done) => { done(null, '{}', ''); return { stdin: { end() { closed = true; } } }; },
    });
    assert.equal(closed, true, 'stdin is closed, or pi waits out the whole timeout with nothing to say');
  }

  // A plan nobody wrote must say so.
  //
  // `fallbackSpec` is three generic steps under the owner's own sentence. With no
  // candidate at all the loop never ran, `fallbackReason` stayed null, and the daemon
  // published `degraded: false` — indistinguishable on screen from a spec a model had
  // thought about. The owner was looking at one of these when they said the answers were
  // slow, and nothing on it said the front desk had had nothing to think with.
  {
    const mute = new router.FastFacilitatorRouter({ cloudFallback: () => 'gpu-busy',
      detectImpl: async () => ({ ollama: false, glm: false }) });
    const out = await mute.facilitate(`nothing available ${process.pid}`);
    assert.equal(out.provider, 'deterministic-local');
    assert.match(out.fallbackReason || '', /no front-desk model was available/,
      'a loop that never ran is still a reason, and it was being recorded as no reason at all');
    assert.ok(out.degradedNote, 'and the owner is told, in their own language, on the line above the plan');
    assert.match(out.degradedNote, /下書き/, 'named as a draft rather than presented as a plan');
  }
  // A spec a model did write carries no such note.
  {
    const spec = JSON.stringify({ status: 'ready', promptSpec: { goal: 'g', constraints: [], steps: ['s'], acceptance: ['a'] } });
    const wrote = new router.FastFacilitatorRouter({ runners: { ollama: async () => spec },
      detectImpl: async () => ({ ollama: true, glm: false }) });
    const out = await wrote.facilitate(`a real spec ${process.pid}`);
    assert.equal(out.degradedNote, '', 'the note is for the empty answer, not decoration on every reply');
  }
  // The note names the job holding the card, because "unavailable" is not actionable.
  //
  // And the two cases stay apart. The first draft of this reported both at once, so a turn
  // where the local model answered and produced unusable JSON told the owner that "the
  // cloud escape is off" — true, irrelevant, and pointing at the wrong thing to fix. The
  // test below is the one that caught it.
  {
    const held = router.draftNote('gpu-busy', { ollama: false, glm: false });
    assert.match(held, /ローカルモデル/, 'what is down');
    assert.ok(/ZAI_API_KEY/.test(held) || /クラウド退避/.test(held), 'and why the escape did not cover for it');
    const answered = router.draftNote('off', { ollama: true, glm: false });
    assert.doesNotMatch(answered, /クラウド退避/, 'a working local model is not a cloud problem');
    assert.match(answered, /モデルは応答しました/, 'it is a model that answered and said nothing usable');
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

  console.log('fast router selftest: PASS · think:false or the model spends the answer on thinking · '
    + 'the deterministic fallback is never cached · a fieldless cache entry reads as a miss · spec in English, questions in the '
    + 'owner\'s language · proper nouns verbatim · answer() refuses an empty pair and cleans up after itself · the GPU-busy escape '
    + 'is shut by default, never used while local works, and names itself in the reply · each candidate runs its own runner · '
    + 'no ZAI_API_KEY means no candidate · a stopped server is not probed · stdin is closed or pi waits out the timeout · '
    + 'a plan nobody wrote says so');
})();
