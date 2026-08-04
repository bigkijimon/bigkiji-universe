'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConversationEngine } = require('../src/domain/pi-core/conversation-engine');
const { IdeaDraftStore } = require('../src/domain/pi-core/idea-draft-store');
const { DaemonEngine } = require('../src/domain/server/daemon');

function ollama(value) {
  return async () => ({ ok: true, json: async () => ({ response: JSON.stringify(value) }) });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-conversation-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'sandbox.json'), JSON.stringify({ filesystem: { allowRead: ['.'], allowWrite: ['.'] }, models: { allowPaid: ['gemini'] } }));
  const chat = new ConversationEngine({ fetchImpl: ollama({ kind:'CHAT', reply:'That sounds calm. What part would you like to explore?', confidence:.9 }), model:'qwen2.5:0.5b' });
  const chatResult = await chat.turn({ text:'I was thinking about a quiet workspace.', sessionId:'chat' });
  assert.equal(chatResult.kind, 'CHAT'); assert.match(chatResult.reply, /quiet|calm/i); assert.equal(chatResult.context.limit, 4096);

  const guarded = new ConversationEngine({ fetchImpl: ollama({ kind:'TASK', reply:'I will start implementing it now.', title:'提出', confidence:.99 }) });
  const guardedResult = await guarded.turn({ text:'今日は少し落ち着いて、このアプリの次のアイデアを考えたい。', sessionId:'guarded' });
  assert.equal(guardedResult.kind, 'IDEA', 'a small local model must not promote reflective idea chat into an executable task');
  const implicitIdea = await guarded.turn({ text:'Small Windowのカードが少し漂う演出を考えたい。', sessionId:'implicit-idea' });
  assert.equal(implicitIdea.kind, 'IDEA', 'a concrete possibility expressed as 考えたい must be retained as an idea draft');
  assert.notEqual(implicitIdea.title, '提出', 'generic model titles must be replaced with a deterministic owner-derived title');
  assert.match(implicitIdea.title, /Small Window/);

  const store = new IdeaDraftStore({ root:path.join(root, 'ideas'), workspace });
  const draft = store.create({ title:'Gentle graph motion', summary:'Let nodes drift without camera sickness.', ideas:['Use calm spring movement'], sessionId:'session-one', turnId:'turn-one' });
  assert.ok(fs.existsSync(path.join(root, 'ideas', `${draft.id}.md`))); assert.equal(fs.existsSync(path.join(workspace, 'docs', 'ideas')), false, 'draft must not mutate repo docs');
  assert.throws(() => store.promote(draft.id, { draftHash:'stale', ownerConfirmed:true }), /STALE/);
  const adopted = store.promote(draft.id, { draftHash:draft.draftHash, ownerConfirmed:true });
  assert.ok(fs.existsSync(path.join(workspace, adopted.promotedPath))); assert.match(fs.readFileSync(path.join(workspace, adopted.promotedPath), 'utf8'), /local-adopted/);

  const ideaConversation = new ConversationEngine({ fetchImpl: ollama({ kind:'IDEA', reply:'I saved that locally.', title:'Soft relationship field',
    summary:'Let actual files drift with wider spacing.', ideas:['Use real inventory only'], requirements:['No synthetic nodes'], todos:['Prototype the force field'], confidence:.92 }) });
  const engine = new DaemonEngine({ stateRoot:path.join(root, 'state'), workspace, conversationEngine:ideaConversation,
    ideaStore:new IdeaDraftStore({ root:path.join(root, 'state', 'ideas'), workspace }), knowledgeStore:{ rememberIdea() {} } });
  const turn = await engine.turn('Maybe the real files could drift more gently.');
  assert.equal(turn.kind, 'IDEA'); assert.ok(turn.draft?.draftHash); assert.equal(turn.run, null); assert.equal(engine.runner.snapshot().filter((task) => task.status === 'running').length, 0);
  const enhancement = engine.requestIdeaEnhancement(turn.draft.id, { draftHash:turn.draft.draftHash });
  assert.equal(enhancement.task.status, 'awaiting_approval'); assert.equal(enhancement.task.disclosure.files.length, 0); assert.ok(enhancement.task.disclosure.payloadHash);
  assert.equal(engine.runner.snapshot().filter((task) => task.status === 'running').length, 0, 'Gemini must remain asleep before exact approval');
  assert.throws(() => engine.approveIdeaEnhancement({ taskId:enhancement.task.id, draftHash:'stale', disclosureHash:enhancement.task.disclosure.disclosureHash }), /STALE/);
  engine.shutdown();

  // ---- streaming, TTFT, and what a deadline is allowed to mean ----------------
  // Ollama was called with stream:false everywhere, so "time to first token" was not a
  // measurable event: the request waited for the whole JSON. Worse, the 8s budget
  // covered the entire answer, so a model generating correctly but slowly lost all of
  // it and the owner got the deterministic fallback for a turn that was working.
  const streamOf = (chunks, { gapMs = 0, silent = false } = {}) => async (_url, init) => ({
    ok: true,
    body: {
      getReader() {
        let index = 0;
        return {
          read: () => new Promise((resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
            if (silent) return undefined; // never resolves: only the stall deadline ends it
            if (index >= chunks.length) return resolve({ done: true, value: undefined });
            // An empty string models a reasoning chunk: Ollama sends `thinking` with an
            // empty `response` while the model deliberates.
            const piece = chunks[index++];
            const line = `${JSON.stringify(piece ? { response: piece, done: false } : { response: '', thinking: '…', done: false })}\n`;
            const emit = () => resolve({ done: false, value: new TextEncoder().encode(line) });
            if (!gapMs) return emit();
            setTimeout(emit, gapMs); // deliberately kept ref'd: it is this script's clock
            return undefined;
          }),
        };
      },
    },
  });

  const answer = JSON.stringify({ kind: 'CHAT', reply: 'Streaming works.', confidence: 0.9 });
  const pieces = answer.match(/.{1,12}/g);

  const streamed = new ConversationEngine({ fetchImpl: streamOf(pieces), model: 'qwen2.5:0.5b' });
  const streamedTurn = await streamed.turn({ text: 'Say something.', sessionId: 'stream' });
  assert.strictEqual(streamedTurn.degraded, false, 'a streamed answer is a real answer, not a fallback');
  assert.strictEqual(streamedTurn.reply, 'Streaming works.');
  assert(Number.isFinite(streamedTurn.ttftMs) && streamedTurn.ttftMs >= 0,
    'time to first token is now an observable event');

  // Slow but alive: ten chunks 25ms apart is 250ms of work against a 60ms deadline.
  // Under the old whole-turn budget this answer was discarded; it must now survive,
  // because the model was never actually silent.
  const slow = new ConversationEngine({ fetchImpl: streamOf(pieces, { gapMs: 25 }), model: 'qwen2.5:0.5b', timeoutMs: 60 });
  const slowTurn = await slow.turn({ text: 'Take your time.', sessionId: 'slow' });
  assert.strictEqual(slowTurn.degraded, false, 'steady progress is not a timeout, however long it takes in total');
  assert.strictEqual(slowTurn.reply, 'Streaming works.');

  // Silence is still a timeout, and it still says which kind it was.
  // The abort timers are unref'd — as they were before this change — so in the daemon
  // the HTTP server keeps the loop alive while a turn waits. This script has no server,
  // so it has to hold the loop open itself or Node exits before the deadline fires.
  const keepalive = setInterval(() => {}, 10);
  const stalled = new ConversationEngine({ fetchImpl: streamOf([], { silent: true }), model: 'qwen2.5:0.5b', timeoutMs: 40 });
  const stalledTurn = await stalled.turn({ text: 'Hello?', sessionId: 'stalled' });
  clearInterval(keepalive);
  assert.strictEqual(stalledTurn.degraded, true);
  assert.match(stalledTurn.error, /timeout before first token/);
  assert.strictEqual(stalledTurn.ttftMs, null, 'nothing arrived, so nothing is claimed to have been measured');

  // A reasoning model streams `thinking` with an empty `response` for as long as it
  // deliberates. qwen3.5:latest does exactly this. Counting only answer tokens as signs
  // of life means the stall deadline fires while the model is working, and the owner
  // gets the deterministic fallback for a turn that had not failed.
  const thinking = ['', '', '', '', '', '', ...pieces];
  const reasoner = new ConversationEngine({ fetchImpl: streamOf(thinking, { gapMs: 25 }), model: 'qwen3.5:latest', timeoutMs: 60 });
  const reasonerTurn = await reasoner.turn({ text: 'Think it through.', sessionId: 'reasoning' });
  assert.strictEqual(reasonerTurn.degraded, false, 'deliberating is not being silent');
  assert.strictEqual(reasonerTurn.reply, 'Streaming works.');
  assert(reasonerTurn.ttftMs >= 150,
    'TTFT marks the first token of the answer, not the first sign of activity — thinking is not an answer');

  // Deliberation comes out of the same num_predict budget as the answer, so a
  // reasoning model can spend the whole allowance thinking and return nothing —
  // which is what qwen3.5 did, and why the conversation model was a 0.5b that
  // could not hold a conversation. `think: false` is what makes a capable model
  // usable here, so the request has to actually carry it.
  let sent = null;
  const capture = async (url, init) => { sent = JSON.parse(init.body); return ollama({ kind: 'CHAT', reply: 'ok', confidence: 0.9 })(url, init); };
  const asking = new ConversationEngine({ fetchImpl: capture, model: 'qwen3.5:latest' });
  await asking.turn({ text: 'anything', sessionId: 'think-off' });
  assert.strictEqual(sent.think, false, 'the request must switch reasoning off, or the answer budget goes to thinking');
  // This asserted -1 — resident forever — until the owner asked for the opposite by
  // name on 2026-08-03: standby at nearly zero, the whole card when spoken to, back
  // to zero afterwards. Sixty seconds keeps a back-and-forth instant because every
  // turn restarts the window; it is the pause between conversations that frees the
  // GPU for ComfyUI, LTX-2 and ACE-Step. See tools/gpu-residency-selftest.js.
  assert.strictEqual(sent.keep_alive, '60s', 'the model stays resident for a minute after the owner stops, then leaves');
  assert.strictEqual(sent.options.num_ctx, 4096);

  // Asked "残ってるタスクおしえて", BigKiji answered "タスクはまだ登録されていま
  // せん". It was not being evasive: the prompt carried a persona, style rules and
  // the transcript, and nothing whatsoever about the runs, tasks or ideas the
  // daemon was holding. A model with no facts does not say "I don't know" — it
  // says something plausible, which for a status question is the worst answer
  // available.
  let withFacts = null;
  const grab = async (url, init) => { withFacts = JSON.parse(init.body).prompt; return ollama({ kind: 'CHAT', reply: 'ok', confidence: 0.9 })(url, init); };
  const informed = new ConversationEngine({ fetchImpl: grab, model: 'qwen3.5:latest' });
  await informed.turn({ text: '残ってるタスクおしえて', sessionId: 'facts',
    facts: '- runs awaiting your approval: 1 (latest: run-abc, 2 assignments)\n- saved ideas: 6' });
  assert.ok(withFacts.includes('run-abc'), 'the facts have to reach the model, or it will make some up');
  assert.ok(withFacts.includes('- saved ideas: 6'));
  assert.ok(/never invent/i.test(withFacts), 'and it has to be told these are the only real numbers');
  assert.ok(/do not have it rather than guessing/i.test(withFacts),
    'with an explicit instruction to admit a gap instead of filling it');

  // No facts supplied is not the same as facts saying zero, and the prompt must
  // not claim otherwise.
  let withoutFacts = null;
  const bare = async (url, init) => { withoutFacts = JSON.parse(init.body).prompt; return ollama({ kind: 'CHAT', reply: 'ok', confidence: 0.9 })(url, init); };
  await new ConversationEngine({ fetchImpl: bare, model: 'qwen3.5:latest' }).turn({ text: 'hi', sessionId: 'nofacts' });
  assert.ok(!/Current system state/.test(withoutFacts), 'an empty facts block is omitted, not sent empty');

  // A response delivered in one piece still works — an injected fetch, a buffering
  // proxy, or a server without a readable body all land here.
  const whole = new ConversationEngine({ fetchImpl: ollama({ kind: 'CHAT', reply: 'One piece.', confidence: 0.8 }), model: 'qwen2.5:0.5b' });
  const wholeTurn = await whole.turn({ text: 'And this?', sessionId: 'whole' });
  assert.strictEqual(wholeTurn.reply, 'One piece.');
  assert.strictEqual(wholeTurn.ttftMs, null, 'null means not measured, never zero');

  // A degraded answer has to be a whole answer.
  //
  // `fallback()` returned `{kind, reply}`, which satisfies the line that prints
  // the reply and crashes the line that reads `result.ideas.length`
  // (daemon.js:243). Reaching it needs nothing exotic — Ollama queueing a second
  // request is enough — and any prompt with action language in it lands on the
  // TASK branch, which is the one that walks into `.ideas`. The owner pasted a
  // ten-line spec, all ten lines fired as separate turns, nine of them stalled at
  // the 8s ceiling, and five came back as HTTP 500.
  const SHAPE = ['kind', 'reply', 'title', 'summary', 'ideas', 'requirements', 'decisions', 'openQuestions', 'todos', 'confidence'];
  const dead = async () => { throw new Error('Ollama is down'); };
  for (const text of ['READMEのタイポを修正してください', 'こんにちは', 'こういうアイデアはどうかな']) {
    const turn = await new ConversationEngine({ fetchImpl: dead, model: 'qwen3.5:latest' })
      .turn({ text, sessionId: `degraded-${text.slice(0, 4)}` });
    assert.equal(turn.degraded, true, `${text}: this path must be reached`);
    for (const key of SHAPE) assert.ok(key in turn, `${text}: a degraded turn dropped "${key}" (kind=${turn.kind})`);
    for (const key of ['ideas', 'requirements', 'decisions', 'openQuestions', 'todos']) {
      assert.ok(Array.isArray(turn[key]), `${text}: "${key}" must be an array, not ${typeof turn[key]}`);
    }
    // The exact expression daemon.js:243 evaluates. It threw here.
    assert.doesNotThrow(() => (turn.ideas.length ? turn.ideas : (turn.kind === 'IDEA' ? [turn.summary || text] : [])));
    assert.ok(turn.reply.length > 6, `${text}: and it still has to say something`);
  }
  // The heuristic decides the branch, so prove the crashing one is actually taken.
  assert.equal((await new ConversationEngine({ fetchImpl: dead, model: 'q' })
    .turn({ text: 'READMEのタイポを修正してください', sessionId: 'degraded-kind' })).kind, 'TASK');

  // A turn the model never served must not read like one it did.
  //
  // The fallback is a template that sounds considered. After nine of them in a row
  // — a pasted spec, nine parallel turns, eight timed out — the owner concluded the
  // thing was stupid. It was absent. Saying so is the difference.
  {
    const dead = new ConversationEngine({ fetchImpl: async () => { throw new Error('Ollama is down'); } });
    const jp = await dead.turn({ text: 'READMEのタイポを修正してください', sessionId: 'degraded-jp' });
    assert.strictEqual(jp.degraded, true);
    assert.ok(jp.reply.startsWith('（ローカルモデルが応答しませんでした'), `it has to admit it: ${jp.reply.slice(0, 40)}`);
    const en = await dead.turn({ text: 'fix the readme typo', sessionId: 'degraded-en' });
    assert.ok(en.reply.startsWith('(the local model did not answer'), 'in the language the owner is writing in');
    for (const key of ['kind', 'reply', 'ideas', 'todos', 'confidence']) assert.ok(key in jp, `${key} must survive`);

    const alive = new ConversationEngine({ fetchImpl: ollama({ kind: 'CHAT', reply: 'A real answer.' }) });
    const good = await alive.turn({ text: 'hello', sessionId: 'not-degraded' });
    assert.strictEqual(good.degraded, false);
    assert.strictEqual(good.reply, 'A real answer.', 'a served turn is not decorated');
  }

  // maxTurns counts exchanges; the seed is individual messages, and the trim is
  // maxTurns * 2 for that reason. Slicing the seed by maxTurns threw half of a
  // resumed conversation away before the model saw it — the daemon hands over 16
  // and 8 arrived.
  {
    const engine = new ConversationEngine({ fetchImpl: ollama({ kind: 'CHAT', reply: 'ok' }) });
    const seed = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'owner', text: `m${index}` }));
    assert.strictEqual(engine.history('resumed', seed).length, 16, 'a resumed conversation keeps what the daemon sent');
    const overflowing = Array.from({ length: 40 }, (_, index) => ({ role: 'owner', text: `m${index}` }));
    assert.strictEqual(engine.history('long', overflowing).length, engine.maxTurns * 2, 'and the bound is still a bound');
  }

  // A default only reaches a key that is absent. The owner's settings.json was written
  // when the default was qwen2.5:0.5b, so raising the default changed nothing on the one
  // machine that mattered: an entire session ran on a 0.5B model, which replied
  // 「承認フロー整理案の保存と考察を完了しました」 to hello, to 「おーい」 and to
  // 「機能してないですよ」 alike — the same sentence every turn, in a screenshot from the
  // owner captioned 使い物にならない.
  {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { SettingsStore } = require('../src/core/settings-store');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-settings-'));
    fs.writeFileSync(path.join(userData, 'settings.json'),
      JSON.stringify({ conversation: { model: 'qwen2.5:0.5b', contextTokens: 4096 } }));
    const store = new SettingsStore({ userData });
    assert.strictEqual(store.get().conversation.model, 'qwen3.5:latest',
      'a model measured unfit for conversation must not survive in a saved file');
    // Anything the owner actually chose is still theirs.
    store.update({ conversation: { model: 'qwen3.6:latest' } });
    assert.strictEqual(store.get().conversation.model, 'qwen3.6:latest', 'an owner choice is kept');
    fs.rmSync(userData, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // "Is it actually working?" is not a question for a model (2026-08-04)
  //
  // The daemon hands the model the true numbers before every turn. Asked four times in
  // one session whether anything was happening, it answered "順調に進んでいます" four
  // times while two runs sat untouched for eleven hours. Re-measured the same day with
  // those exact facts in the prompt: two questions, two fabrications. Prompting harder
  // was measured too and traded the fabrication for a self-contradiction plus leaked
  // JSON. So this class of question never reaches a model.
  // -------------------------------------------------------------------------
  {
    const { isStatusQuestion, statusReport } = require('../src/domain/pi-core/status-answer');

    // The four the owner actually typed, plus the shapes around them.
    for (const asked of ['ほんとに動いてる？', '仕事できてる？', '進んでる？', 'さぎょうが遅くない？',
      'どうなってる？', '何してるの', 'どこまで進んだ？', 'status', 'any progress?', 'is it still running']) {
      assert.ok(isStatusQuestion(asked), `a status question must be intercepted: ${asked}`);
    }

    // The expensive mistake is the other one. Every line here is real work or real
    // conversation and has to reach the model, including the ones that contain the very
    // words the patterns above match.
    for (const kept of ['予約フローの進捗管理機能を作ってください', '進捗バーを実装して',
      'ページの表示が遅い問題を調査して', 'ログの読み込みが遅い原因を調べてほしい',
      '作業工程を可視化する機能を追加して', 'こんにちは', '今日は寒いね',
      'school フォルダを分析して改善点を洗い出してください']) {
      assert.ok(!isStatusQuestion(kept), `this is not a status question and must not be stolen: ${kept}`);
    }

    const now = Date.parse('2026-08-04T03:00:00Z');
    const waiting = statusReport({ running: [], waiting: [
      { id: 'run-msdy0mb2', createdAt: '2026-08-04T00:51:51Z', total: 2, writes: false, stage: 'deliberation' },
      { id: 'run-msdznc8o', createdAt: '2026-08-04T01:37:31Z', total: 2, writes: false, stage: 'deliberation' },
    ] }, { text: 'ほんとに動いてる？', now });
    assert.ok(/実行中 0 件/.test(waiting), 'the count comes first and it is the real one');
    assert.ok(/動いているものはありません/.test(waiting), 'and it says so in words, not only in a number');
    assert.ok(!/進んで|順調/.test(waiting), 'the sentence that started all of this can never be produced here');
    assert.ok(/run-msdy0mb2/.test(waiting) && /run-msdznc8o/.test(waiting), 'both waiting runs are named, including the older one');
    assert.ok(/2時間待機/.test(waiting), 'and how long they have been waiting, which is the fact that was missing');
    assert.ok(/\/approve run-msdy0mb2/.test(waiting), 'with the exact command that starts the oldest of them');

    const running = statusReport({ running: [{ id: 'run-x', startedAt: '2026-08-04T02:48:00Z', total: 4, done: 3, stage: 'execution' }], waiting: [] },
      { text: '進んでる？', now });
    assert.ok(/実行中 1 件/.test(running) && /3\/4/.test(running), 'real progress is reported as the fraction it is');
    assert.ok(!/動いているものはありません/.test(running), 'and is not denied');

    const idle = statusReport({ running: [], waiting: [] }, { text: 'any progress?', now });
    assert.ok(/0 running/.test(idle), 'english question, english answer');
    assert.ok(/Nothing has been asked of me yet/.test(idle), 'an empty machine says it is empty rather than inventing work');

    // A run whose start time was never recorded gets no elapsed clause at all.
    const unknown = statusReport({ running: [{ id: 'run-y', total: 2, done: 0 }], waiting: [] }, { text: '進んでる？', now });
    assert.ok(!/経過/.test(unknown), 'a measurement we never took is left out, not guessed');
  }

  // The model's own JSON, leaking into the sentence the owner reads. Both of these are
  // verbatim from the owner's session log of 2026-08-04.
  {
    const { normalize, clean } = require('../src/domain/pi-core/conversation-engine');
    assert.equal(normalize({ kind: 'CHAT', reply: 'ご安心ください。”}title=' }, 'テスト').reply, 'ご安心ください。');
    assert.equal(normalize({ kind: 'CHAT', reply: 'はい、進行中です。”、“まずはどの機能から？”}{' }, 'テスト').reply, 'はい、進行中です。');
    assert.equal(normalize({ kind: 'CHAT', reply: '「A」と「B」の違いを説明します。' }, 'テスト').reply, '「A」と「B」の違いを説明します。',
      'Japanese quotes prose with 「」 and that has to survive untouched');
    assert.ok(clean('この JSON を直して: function f(){ return {"a":1} }').includes('{"a":1}'),
      'and the owner\'s own pasted snippet is never cut — this runs on the model reply only');
  }

  console.log('conversation selftest: PASS · natural local turn · private draft · explicit adopt · sealed Gemini approval · streamed with measured TTFT · slow-but-alive survives · a reasoning model is not silent · silence still times out · a degraded turn keeps every field · a retired chat model is migrated out of a saved settings file · status questions are answered from measurements, never by a model · leaked JSON is stripped and real prose is not');
})().catch((error) => { console.error(error); process.exit(1); });
