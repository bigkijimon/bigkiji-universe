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

  // A response delivered in one piece still works — an injected fetch, a buffering
  // proxy, or a server without a readable body all land here.
  const whole = new ConversationEngine({ fetchImpl: ollama({ kind: 'CHAT', reply: 'One piece.', confidence: 0.8 }), model: 'qwen2.5:0.5b' });
  const wholeTurn = await whole.turn({ text: 'And this?', sessionId: 'whole' });
  assert.strictEqual(wholeTurn.reply, 'One piece.');
  assert.strictEqual(wholeTurn.ttftMs, null, 'null means not measured, never zero');

  console.log('conversation selftest: PASS · natural local turn · private draft · explicit adopt · sealed Gemini approval · streamed with measured TTFT · slow-but-alive survives · a reasoning model is not silent · silence still times out');
})().catch((error) => { console.error(error); process.exit(1); });
