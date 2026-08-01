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
  console.log('conversation selftest: PASS · natural local turn · private draft · explicit adopt · sealed Gemini approval');
})().catch((error) => { console.error(error); process.exit(1); });
