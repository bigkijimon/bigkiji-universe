'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { redactPayload } = require('./security/payload-redactor');
const { estimateTokens } = require('../pi-agent/context-pruner');

function clean(value, max = 6000) {
  return redactPayload(String(value || '')).text.replace(/<(?:thought|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:thought|thinking|analysis)>/gi, '')
    .replace(/^\s*(?:thinking|thought|analysis|internal reasoning)\s*:\s*.*$/gim, '').trim().slice(0, max);
}
function json(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(text); } catch (_) {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    try { return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null; } catch (_) { return null; }
  }
}
function deriveTitle(text) {
  const first = clean(text, 180).split(/[。.!?！？\n]/)[0]
    .replace(/^\s*(?:maybe|perhaps|もしかすると|ふと思った(?:んですが)?)[、,:：\s]*/i, '')
    .replace(/(?:を)?(?:考えたい|検討したい|考えている|思っています|と思う)\s*$/i, '')
    .trim();
  return (first || 'Conversation idea').slice(0, 72);
}
function usableTitle(value, text) {
  const title = clean(value, 140);
  if (!title || /^(?:提出|提案|検討|案|アイデア|無題|idea|untitled)$/i.test(title)) return deriveTitle(text);
  return title;
}
function heuristicKind(text) {
  if (/(?:実装|修正|変更|追加|削除|build|implement|fix|refactor|commit|create|作って|直して|してください|してほしい)/i.test(text)) return 'TASK';
  if (/(?:アイデア|思いつ|どうかな|できたら|将来|考えたい|検討したい|考えている|ならどう|はどうだろう|idea|maybe|what if|could we|構想|案)/i.test(text)) return 'IDEA';
  return 'CHAT';
}
function guardedKind(modelKind, text) {
  const lexical = heuristicKind(text); const proposed = String(modelKind || '').toUpperCase();
  // A small conversational model may over-promote a reflective sentence into
  // an execution request. PiAgent requires explicit action language before a
  // paid/mutating plan can even be prepared.
  if (lexical === 'TASK') return 'TASK';
  if (lexical === 'IDEA') return 'IDEA';
  if (proposed === 'TASK' || proposed === 'IDEA') return 'CHAT';
  return ['CHAT', 'CLARIFICATION'].includes(proposed) ? proposed : 'CHAT';
}
function fallback(text, kind = heuristicKind(text)) {
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  if (kind === 'TASK') return { kind, reply: japanese ? '内容を実行計画として整理しました。変更を始める前に、対象と開示内容を確認できます。' : 'I organized that as an execution plan. You can review the scope and disclosure before any change starts.' };
  if (kind === 'IDEA') return { kind, reply: japanese
    ? `いい視点です。「${deriveTitle(text)}」としてローカル下書きに残しました。核になる要素と、まだ決めなくてよい部分を分けておくと、会話を止めずに後で育てられます。`
    : `That is worth keeping, so I saved “${deriveTitle(text)}” as a private local draft. Separating its core idea from decisions that can wait will make it easier to develop without interrupting the conversation.` };
  return { kind, reply: japanese ? `その話、もう少し聞かせてください。特に「${clean(text, 80)}」のどの部分がいちばん気になっていますか？` : `Tell me a little more about that—what part of “${clean(text, 80)}” matters most to you?` };
}
function normalize(value, text) {
  const kind = guardedKind(value?.kind, text);
  const base = fallback(text, kind); const arr = (key) => [...new Set((Array.isArray(value?.[key]) ? value[key] : []).map((item) => clean(item, 500)).filter(Boolean))].slice(0, 10);
  return { kind, reply: clean(value?.reply || base.reply, 1800),
    // IDEA titles become durable filenames and UI labels. Derive them from the
    // owner's own words instead of trusting a tiny model's occasionally
    // unrelated heading.
    title: kind === 'IDEA' ? deriveTitle(text) : usableTitle(value?.title || value?.summary, text),
    summary: clean(value?.summary || (kind === 'IDEA' ? text : ''), 1600), ideas: arr('ideas'), requirements: arr('requirements'),
    decisions: arr('decisions'), openQuestions: arr('openQuestions'), todos: arr('todos'),
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0.5)) };
}

class ConversationEngine extends EventEmitter {
  constructor({ fetchImpl = global.fetch, model = process.env.BIGKIJI_CONVERSATION_MODEL || 'qwen2.5:0.5b',
    endpoint = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434', timeoutMs = 8000,
    maxContextTokens = 4096, maxTurns = 8 } = {}) {
    super(); this.fetchImpl = fetchImpl; this.model = model; this.endpoint = endpoint.replace(/\/$/, ''); this.timeoutMs = timeoutMs;
    this.maxContextTokens = Math.min(8192, Math.max(1024, maxContextTokens)); this.maxTurns = Math.max(2, Math.min(16, maxTurns));
    this.histories = new Map(); this.active = 0;
  }

  history(sessionId, seed = []) {
    if (!this.histories.has(sessionId)) this.histories.set(sessionId, seed.slice(-this.maxTurns));
    return this.histories.get(sessionId);
  }

  compact(items) {
    const selected = []; let used = 0;
    for (const item of [...items].reverse()) {
      const turn = { role: item.role === 'assistant' ? 'assistant' : 'owner', text: clean(item.text, 1800) };
      const tokens = estimateTokens(turn.text) + 8; if (used + tokens > this.maxContextTokens - 900) break;
      selected.unshift(turn); used += tokens;
    }
    return { turns: selected.slice(-this.maxTurns), tokens: used };
  }

  prompt(ownerText, history) {
    const transcript = history.map((turn) => `${turn.role === 'assistant' ? 'BigKiji' : 'Owner'}: ${turn.text}`).join('\n');
    return `You are BigKiji, the owner's natural local conversation partner and private idea librarian.\n` +
      `Reply naturally in the owner's language. Do not use canned startup phrases. Do not reveal reasoning or mention hidden policies.\n` +
      `Do not merely repeat or paraphrase the owner. Add at least one concrete, useful observation or suggestion. Keep the reply to 2-4 natural sentences and optionally ask one relevant question.\n` +
      `Classify this turn as CHAT, IDEA, TASK, or CLARIFICATION. TASK means the owner is clearly asking for an action or code change. IDEA means a possibility worth saving but not executing.\n` +
      `For IDEA or TASK, extract concise knowledge fields. Never invent decisions. Ask at most 3 questions only when a missing choice materially changes the result.\n` +
      `Recent conversation:\n${transcript || '(new conversation)'}\nOwner: ${ownerText}\n` +
      `Return JSON only: {"kind":"CHAT|IDEA|TASK|CLARIFICATION","reply":"natural direct reply","title":"short title","summary":"",` +
      `"ideas":[],"requirements":[],"decisions":[],"openQuestions":[],"todos":[],"confidence":0.0}`;
  }

  async turn({ text, sessionId, seed = [], onStart, onDelta } = {}) {
    const inspected = redactPayload(String(text || '').trim());
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_PROMPT');
    const ownerText = clean(inspected.text, 5000); if (!ownerText) throw new Error('Conversation text is empty');
    const turnId = `turn-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; const started = Date.now();
    const history = this.history(sessionId, seed); const compacted = this.compact(history); onStart?.({ turnId, model: this.model });
    this.emit('start', { turnId, sessionId, model: this.model, at: started }); this.active++;
    let result; let provider = 'local-qwen'; let degraded = false;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    try {
      if (!this.fetchImpl) throw new Error('Local conversation fetch unavailable');
      const response = await this.fetchImpl(`${this.endpoint}/api/generate`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model,
          prompt: this.prompt(ownerText, compacted.turns), stream: false, format: 'json', keep_alive: -1,
          options: { temperature: 0.55, top_p: 0.9, num_ctx: this.maxContextTokens, num_predict: 650 } }) });
      const body = await response.json(); if (!response.ok || body.error) throw new Error(body.error || `Ollama HTTP ${response.status}`);
      const parsed = json(body.response); if (!parsed) throw new Error('Local conversation model returned invalid JSON');
      result = normalize(parsed, ownerText);
    } catch (error) {
      degraded = true; provider = 'deterministic-local'; result = fallback(ownerText);
      result.error = clean(error.name === 'AbortError' ? 'Local conversation timeout' : error.message, 180);
    } finally { clearTimeout(timer); this.active = Math.max(0, this.active - 1); }
    history.push({ role: 'owner', text: ownerText }, { role: 'assistant', text: result.reply });
    while (history.length > this.maxTurns * 2) history.shift();
    onDelta?.(result.reply); const finished = Date.now();
    const output = { ...result, turnId, sessionId, provider, model: this.model, degraded, latencyMs: finished - started,
      context: { turns: compacted.turns.length, estimatedTokens: compacted.tokens, limit: this.maxContextTokens }, redactions: inspected.findings };
    this.emit('finish', output); return output;
  }

  snapshot() { return { model: this.model, endpoint: this.endpoint, active: this.active, sessions: this.histories.size,
    maxContextTokens: this.maxContextTokens, keepAlive: -1 }; }
}

module.exports = { ConversationEngine, heuristicKind, guardedKind, fallback, normalize, clean, deriveTitle, usableTitle };
