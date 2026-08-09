'use strict';

// The two doors between "I asked for something" and "something is happening".
//
// 2026-08-09. The owner's report was 「まだ一度もまともに使えていない」 — never once used
// properly — and the diagnosis was not one bug but a corridor with two shut doors:
//
//   Door 1  CLASSIFICATION. `heuristicKind` looked for one of fourteen words, and
//           `guardedKind` demoted the model's own TASK unconditionally. Measured in the
//           owner's own session: 「…確認して欲しいす」 -> CHAT (no run), while the same
//           sentence with 「ほしい」 in kana -> TASK. A request survived or died on whether
//           one word was typed in kanji.
//
//   Door 2  VISIBILITY. Even when a run was created, the terminal showed a tool name, a
//           file and `+12 −3`. The owner's words: 「実際のコードを書いている様子のレビューを
//           全部見せてください」…「途中で間違った作業を指摘することも不可能」.
//
// And one thing that was answered by a model when the exact answer was already on disk:
// which providers can be asked. `circuit-breaker.json` held live cooldowns while `facts()`
// announced all four as available.
//
// The bargain that opens door 1 is the thing to keep honest, so it is pinned here: the
// model may now call a turn TASK, and a TASK it called waits for one approval even under
// auto-edit. Take either half away and this file fails.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-workgate-'));
process.env.BIGKIJI_KNOWLEDGE_ROOT = path.join(root, 'knowledge');

const { DaemonEngine } = require('../src/domain/server/daemon');
const { CircuitBreaker } = require('../src/domain/pi-agent/circuit-breaker');
const { isProviderQuestion, providerReport, isStatusQuestion } = require('../src/domain/pi-core/status-answer');
const { actionTier } = require('../src/domain/pi-core/conversation-engine');
const { buildFooter } = require('../src/cli/tui/footer');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

/**
 * Shut an engine down and take its worktrees with it.
 *
 * `shutdown()` stops timers and the runner; it does not touch the git worktrees an
 * AWAITING_APPROVAL run is holding, because in production those hold work the owner has
 * not looked at yet. In a test nobody is ever going to approve them — and this file
 * creates two runs per invocation. Measured 2026-08-09, after thirteen runs of the suite:
 * 26 worktrees and 651 MB in .bigkiji/worktrees, by the same mechanism that had once
 * reached 1,446 of them. A test that leaks is a test that has to be cleaned up by hand.
 */
const dispose = (engine) => {
  // shutdown() first: it aborts anything still running. Releasing a worktree out from
  // under a live child, then letting the child's dying output reach a session file this
  // script is about to delete, is an ENOENT after the last assertion has already passed.
  engine.shutdown();
  try { for (const run of engine.coordinator.snapshot()) engine.coordinator.forgetRun(engine.coordinator.runs.get(run.id) || run); } catch (_) {}
};

/**
 * Let a run reach EXECUTING without spawning anything.
 *
 * `auto` is the mode that releases a writing run with no approval — which is the whole
 * point of the assertion below, and also means the coordinator dispatches for real. This
 * test was measured starting codex and glm on every run of the suite: a selftest that
 * spends the owner's money to check a string. The gate under test is the daemon deciding
 * the mode; who executes it is not part of the claim.
 */
const noDispatch = (engine) => { engine.runner.approve = () => ({ ok: true, stubbed: true }); return engine; };
const okAsync = async (name, body) => { try { await body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };
const plain = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

/** A conversation model that says TASK about everything — the promotion under test. */
const alwaysTask = () => ({ model: 'stub-qwen',
  turn: async ({ text }) => ({ kind: 'TASK', reply: 'わかりました。', title: 'stub', summary: text, ideas: [],
    requirements: [], decisions: [], openQuestions: [], todos: [], turnId: `turn-${text.slice(0, 6)}`,
    provider: 'local-qwen', latencyMs: 1, degraded: false,
    // normalize() sets this in the real engine; the stub states it so the daemon half of
    // the bargain is what is being tested rather than the classifier's.
    promotedByModel: true }) });

const readyFacilitator = () => ({
  async facilitate(text) { return { status: 'ready', provider: 'stub', planHash: 'stub-plan',
    promptSpec: { goal: text, constraints: [], steps: ['do it'], acceptance: [] } }; },
  async answer(request) { return { status: 'ready', provider: 'stub', promptSpec: { goal: request, steps: ['do it'] } }; },
  reset() {},
});

(async () => {
  // -------------------------------------------------------------------------
  // Door 1 — a request has to be recognised as one
  // -------------------------------------------------------------------------

  ok('the same request in kanji and in kana are both requests', () => {
    // The two lines from the owner's session, verbatim. They differ by 欲しい / ほしい.
    assert.equal(actionTier('課金トークンのリミット解除されてるか確認して欲しいす'), 'strong');
    assert.equal(actionTier('課金トークンのリミットを確認してほしい'), 'strong');
  });

  ok('a work verb with a request ending starts work; the same verb reporting does not', () => {
    for (const asked of ['スキルの一覧を出して', 'ログを調べておいて', 'セットアップして', '設定を見せてください',
      'バックアップを取っておいて', 'please check the rate limit']) {
      assert.ok(actionTier(asked), `${asked} is a request`);
    }
    for (const not of ['確認が取れました', '今日は確認が取れなくて、ちょっと疲れた', '調査によると難しいらしい',
      'こんにちは', 'ありがとう']) {
      assert.equal(actionTier(not), '', `${not} is not a request`);
    }
  });

  ok('widening the lexicon did not cost the status interception', () => {
    // 確認 and 調査 are also the verbs a status question is built from. Sharing the
    // widened test would have handed 「進捗を確認して」 to a model — which is the whole
    // failure status-answer.js exists to prevent.
    assert.equal(actionTier('進捗を確認して'), 'soft', 'it does read as a request…');
    assert.ok(isStatusQuestion('進捗を確認して'), '…and the status answer still gets it first');
    assert.ok(!isStatusQuestion('ページの表示が遅い問題を調査して'), 'real work is not swallowed as a status question');
  });

  // -------------------------------------------------------------------------
  // The price of door 1 — a promotion always stops for one approval
  // -------------------------------------------------------------------------

  await okAsync('a model-promoted TASK waits for approval even under auto-edit', async () => {
    const engine = noDispatch(new DaemonEngine({ stateRoot: path.join(root, 'promoted'), workspace: process.cwd(),
      conversationEngine: alwaysTask(), facilitator: readyFacilitator() }));
    // 'auto' is the mode that releases a writing run without asking. A promotion must
    // not be able to use it: the model is a 3B classifier, and the owner agreed to pay
    // for its mistakes with a prompt, not with an edit.
    const out = await engine.turn('リミットの件を進めたい', { mode: 'auto' });
    assert.ok(out.run, 'the promotion still produces a run — that is the point of allowing it');
    assert.equal(out.promotedByModel, true, 'and the turn says whose call it was');
    assert.equal(out.run.mode, 'plan', 'submitted as plan, whatever the owner’s mode was');
    assert.equal(out.run.status, 'AWAITING_APPROVAL', 'so it stops at the gate');
    dispose(engine);
  });

  await okAsync('an explicit request keeps the owner’s own mode', async () => {
    const conversationEngine = alwaysTask();
    const inner = conversationEngine.turn;
    // The lexicon recognised this one, so the model's opinion is not what promoted it.
    conversationEngine.turn = async (args) => ({ ...(await inner(args)), promotedByModel: false });
    const engine = noDispatch(new DaemonEngine({ stateRoot: path.join(root, 'explicit'), workspace: process.cwd(),
      conversationEngine, facilitator: readyFacilitator() }));
    const out = await engine.turn('READMEのタイポを修正して', { mode: 'auto' });
    assert.ok(out.run);
    assert.equal(out.promotedByModel, false);
    assert.equal(out.run.mode, 'auto', 'auto-edit still means auto-edit for something the owner clearly asked for');
    dispose(engine);
  });

  // -------------------------------------------------------------------------
  // Which AI can be asked — measured, never narrated
  // -------------------------------------------------------------------------

  ok('a limit question is a question, not a job', () => {
    assert.ok(isProviderQuestion('課金トークンのリミット解除されてるか確認して欲しいす'),
      'the owner’s own line: spending a paid run to look up a rate limit is absurd');
    assert.ok(isProviderQuestion('どのAIが使える？'));
    assert.ok(isProviderQuestion('claudeは使える？'));
    assert.ok(isProviderQuestion('which models are available?'));
    assert.ok(!isProviderQuestion('レート制限を回避する実装をしてください'),
      'and real work about limits is still real work');
  });

  await okAsync('the answer comes from the breaker, with no model in the path', async () => {
    const stateRoot = path.join(root, 'providers');
    const engine = new DaemonEngine({ stateRoot, workspace: process.cwd(),
      conversationEngine: alwaysTask(), facilitator: readyFacilitator() });
    // Two providers reachable; one of them inside a live quota cooldown.
    engine.models.touch('claude-code', { available: true, connected: false });
    engine.models.touch('gemini', { available: true, connected: false });
    engine.breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 300000 });
    engine.breaker.record('gemini', { ok: false, reason: 'quota' });

    const facts = engine.providerFacts();
    assert.ok(facts.usable.includes('claude-code'), 'the one that can be asked is listed');
    assert.ok(!facts.usable.includes('gemini'), 'the one on a cooldown is not — this was the lie');
    assert.equal(facts.cooling[0]?.provider, 'gemini');
    assert.equal(facts.cooling[0]?.reason, 'quota');

    const out = await engine.turn('課金トークンのリミット解除されてる？');
    assert.equal(out.provider, 'bigkiji-state', 'answered from state, not by the conversation model');
    assert.equal(out.run, null, 'and it costs no run');
    assert.match(out.reply, /gemini/, 'the reply names the provider that is out');
    assert.match(out.reply, /クールダウン/, 'and says it is on a cooldown, in the language it was asked in');

    // The same snapshot the model is briefed from must agree with what was just said.
    const briefing = engine.facts();
    assert.match(briefing, /providers on cooldown: gemini \(\d+s, quota\)/,
      `facts() must carry the cooldown it used to omit:\n${briefing}`);
    dispose(engine);
  });

  await okAsync('a resident agent is not reported as busy', async () => {
    const engine = new DaemonEngine({ stateRoot: path.join(root, 'busy'), workspace: process.cwd(),
      conversationEngine: alwaysTask(), facilitator: readyFacilitator() });
    // model-status-store pins pi-agent-core connected:true because it is resident, and
    // `facts()` read `connected` as "has a task running right now". So the screen said
    // 「pi-agent-core が忙しく…」 on an idle machine, in the app's own voice.
    engine.models.touch('pi-agent-core', { available: true, connected: true });
    assert.deepEqual(engine.providerFacts().busy, [],
      'nothing is running, so nothing is busy — whatever `connected` says');
    assert.match(engine.facts(), /providers busy right now: none/);
    dispose(engine);
  });

  // -------------------------------------------------------------------------
  // Door 2 — the machine has to say when it is holding
  // -------------------------------------------------------------------------

  ok('an open question reads as "asking", not as idle', () => {
    const asking = plain(buildFooter({ cols: 100, awaitingAnswer: true, phase: 'EXECUTING' }).lines.join('\n'));
    assert.match(asking, /asking/, 'the status word says the machine is holding for the owner');
    assert.match(asking, /answer to start/, 'and the comment slot says what unblocks it');
    const idle = plain(buildFooter({ cols: 100, awaitingAnswer: false, phase: 'EXECUTING' }).lines.join('\n'));
    assert.ok(!/asking/.test(idle), 'and a turn with nothing outstanding does not claim to be asking');
  });

  await okAsync('a status question does not consume the question the front desk asked', async () => {
    const facilitator = readyFacilitator();
    facilitator.facilitate = async () => ({ status: 'needs_clarification', provider: 'stub',
      questions: [{ ask: 'which folder?', options: ['a', 'b'] }] });
    const engine = new DaemonEngine({ stateRoot: path.join(root, 'holding'), workspace: process.cwd(),
      conversationEngine: alwaysTask(), facilitator });
    const asked = await engine.turn('ファイルを整理してください');
    assert.equal(asked.awaitingAnswer, true, 'the front desk is holding');
    assert.equal(asked.run, null);
    // Asking how things are going while a decision is owed must answer the status
    // question AND leave the decision owed. It used to clear the CLI's "asking" while
    // the daemon went on treating the next line as the answer.
    const status = await engine.turn('進んでる？', { sessionId: asked.sessionId });
    assert.equal(status.provider, 'bigkiji-state');
    assert.equal(status.awaitingAnswer, true, 'the question is still outstanding after a measured answer');
    dispose(engine);
  });

  ok('providerReport states an empty fleet as empty rather than softening it', () => {
    const said = providerReport({ usable: [], cooling: [], busy: [], throttled: [], unreachable: ['codex'] }, { text: 'どのAI？' });
    assert.match(said, /ローカルの作業だけ/, 'no provider is said plainly');
    assert.match(said, /codex/, 'and an unauthenticated one is named rather than omitted');
  });

  if (failures) { console.error(`work gate selftest: ${failures} FAILED`); process.exit(1); }
  console.log('work gate selftest: PASS · kanji and kana are one request · a work verb with a request ending starts work · '
    + 'the status answer still wins · a model-promoted TASK always waits for one approval · an explicit request keeps its mode · '
    + 'which AI can be asked is measured from the breaker · a resident agent is not busy · an open question reads as asking');
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exit(1); });
