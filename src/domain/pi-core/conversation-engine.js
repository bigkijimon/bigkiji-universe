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
// The model's own JSON, leaking into the sentence the owner reads.
//
// Ollama's `format: json` constrains the output to valid JSON, which guarantees the
// envelope parses and guarantees nothing about what is inside the string. Measured in
// the owner's session on 2026-08-04:
//
//     …まずはどの機能から優先的に修復すべきか教えていただけますでしょうか？”}{
//     …/approve を入力いただければすぐに処理を開始いたしますね。”}title=
//
// A closing quote followed by a brace is never prose in any language; it is the model
// starting the next field inside the current one. Cut there and keep what came before.
//
// This runs on the model's `reply` only — never on the owner's text, which routinely
// contains `"}` inside a pasted snippet and must survive intact.
// Two shapes, both structural: a quote against a brace, and a quote-comma-quote, which
// is the model closing "reply" and opening the next field while still inside the string.
// Japanese quotes prose with 「」, so `”、“` mid-sentence is the machine showing through.
const STRUCTURE = /["”]\s*[}{]|}\s*{|["”]\s*[、,]\s*[“"]/;
function stripStructure(reply) {
  const text = String(reply || '');
  const hit = text.search(STRUCTURE);
  if (hit < 0) return text;
  // Only when there is a real answer in front of it. A reply that is nothing but
  // structure is a failure, and truncating it to '' lets normalize() fall back rather
  // than hand the owner an empty bubble.
  const kept = text.slice(0, hit).trim();
  return kept.length >= 6 ? kept : text;
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
// "Yes — go ahead." An answer, never an instruction standing on its own.
//
// Ground truth, session-mshrjht0-5cb915.jsonl, 2026-08-07:
//
//     50 owner      please start
//     52 owner      そこファイルでいいです。お願いします
//
// Both produced `kind: CHAT` and no run, because heuristicKind looks for a verb and a
// go-ahead has none. Two turns later the model said it had started, and `/status` said
// "実行中 0 件 · まだ依頼を受けていません". The owner was told work was underway that had
// never been requested of anything.
//
// This is deliberately NOT folded into heuristicKind: on its own 「お願いします」 must
// stay CHAT, or every polite acknowledgement in a conversation starts a paid run. It
// means "start" only when something is waiting to be started, so the daemon consults it
// only when it is holding a request to apply the answer to.
//
// Matched at the END rather than as the whole string, because turn 52 is the common
// shape: an answer and a go-ahead in one line. The whole line is then handed to the
// spec writer, so the content in front of the go-ahead is not lost.
//
// Longest alternatives first — alternation is leftmost-first, so 「そう」 ahead of
// 「そうです」 matches the short one and leaves 「です」 to fail the anchor.
const AFFIRM = '(?:よろしくお願いします|お願いいたします|お願いします|やってください|進めてください|始めてください|実行してください'
  + '|それでお願い|それでいい|お願い|よろしく|そうです|そうだね|やって|進めて|始めて|開始|実行して|大丈夫|はい|うん|ええ|そう'
  + '|go ahead|sounds good|please go|please start|please do|do it|proceed|start|okay|yes|yeah|yep|sure|ok)';
const AFFIRMATIVE = new RegExp(`(?:^|[\\s、,。.!！])${AFFIRM}[\\s、,。.!！]*$`, 'i');
/** True when the owner's line ends in a go-ahead. Only meaningful next to a request. */
function isAffirmative(text) { return AFFIRMATIVE.test(String(text || '').trim()); }

// A reply ending in a question mark is asking one, whatever the model labelled it.
// Structural on purpose: it must not depend on the model getting `kind` right, since
// that is the part that failed.
function endsWithQuestion(text) { return /[?？]\s*$/.test(String(text || '').trim()); }

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
function fallbackReply(text, kind = heuristicKind(text)) {
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  if (kind === 'TASK') return { kind, reply: japanese ? `「${deriveTitle(text)}」を実行計画として整理しています。始める前に対象と手順を一緒に確認しましょう。決めておきたい条件はありますか？` : `I am organizing “${deriveTitle(text)}” into an execution plan. Let's review the scope and steps before starting—any constraints you want fixed up front?` };
  if (kind === 'IDEA') return { kind, reply: japanese
    ? `いい視点です。「${deriveTitle(text)}」としてローカル下書きに残しました。核になる要素と、まだ決めなくてよい部分を分けておくと、会話を止めずに後で育てられます。`
    : `That is worth keeping, so I saved “${deriveTitle(text)}” as a private local draft. Separating its core idea from decisions that can wait will make it easier to develop without interrupting the conversation.` };
  return { kind, reply: japanese ? `その話、もう少し聞かせてください。特に「${clean(text, 80)}」のどの部分がいちばん気になっていますか？` : `Tell me a little more about that—what part of “${clean(text, 80)}” matters most to you?` };
}
/** A one-line admission, in the language the owner is writing in. */
function degradedPrefix(text) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''))
    ? '（ローカルモデルが応答しませんでした。以下は定型の下書きです）\n'
    : '(the local model did not answer — what follows is a template, not a reply)\n';
}

// The shape every caller is entitled to assume.
//
// This used to return `{kind, reply}` and nothing else, which was correct for
// the one line that reads `.reply` and a guaranteed TypeError for the one that
// reads `.ideas.length`. Ollama being slow — a queued request, an 8s stall, a
// truncated body — put every turn through here, and any prompt containing
// action language ("修正して", "implement") became `kind: 'TASK'`, which is the
// branch daemon.js:243 walks. The owner pasted a ten-line spec and got five
// HTTP 500s. A degraded answer has to be a whole answer.
function fallback(text, kind = heuristicKind(text)) {
  return normalize({ kind, reply: fallbackReply(text, kind).reply }, text);
}
function normalize(value, text) {
  const kind = guardedKind(value?.kind, text);
  const base = fallbackReply(text, kind);
  // 小型モデルは配列要素をオブジェクト({question:...}等)で返すことがある。
  // String(obj)="[object Object]" がpromptSpecまで流れていた実バグの修正。
  const asText = (item) => typeof item === 'object' && item !== null
    ? (item.q || item.question || item.text || item.title || item.reply || '') : item;
  const arr = (key) => [...new Set((Array.isArray(value?.[key]) ? value[key] : []).map((item) => clean(asText(item), 500)).filter(Boolean))].slice(0, 10);
  // 劣化応答ガード: 返答が欠落・極端に短い・goal/summaryの鸚鵡返しなら文脈フォールバックへ
  let reply = stripStructure(clean(asText(value?.reply), 1800));
  const echo = clean(asText(value?.summary), 200);
  if (!reply || reply.length < 6 || (echo && reply === echo)) reply = base.reply;
  return { kind, reply,
    // IDEA titles become durable filenames and UI labels. Derive them from the
    // owner's own words instead of trusting a tiny model's occasionally
    // unrelated heading.
    title: kind === 'IDEA' ? deriveTitle(text) : usableTitle(value?.title || value?.summary, text),
    summary: clean(value?.summary || (kind === 'IDEA' ? text : ''), 1600), ideas: arr('ideas'), requirements: arr('requirements'),
    decisions: arr('decisions'), openQuestions: arr('openQuestions'), todos: arr('todos'),
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0.5)) };
}

// Read Ollama's newline-delimited stream, or fall back to a single JSON body.
//
// The fallback is not only for tests: an injected fetch, a proxy that buffers, or a
// server answering without a readable body all end up here, and a conversation that
// only works against one shape of response is a conversation that breaks quietly.
// onText receives (text, streamed). `streamed` is false for a body that arrived in one
// piece, where there is no first-token event to observe — reporting one as 0ms would
// claim an instant response that never happened.
//
// It is called for every chunk, including the ones carrying no answer text. Reasoning
// models stream `thinking` with an empty `response` for as long as they deliberate:
// qwen3.5:latest does exactly this, and a caller that only hears about answer tokens
// concludes the model has gone silent and kills a turn that was working.
async function drainOllamaStream(response, onText) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const body = await response.json();
    if (body?.error) throw new Error(body.error);
    onText(String(body?.response || ''), false);
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let chunk; try { chunk = JSON.parse(line); } catch (_) { continue; }
      if (chunk.error) throw new Error(chunk.error);
      onText(String(chunk.response || ''), true);
    }
  }
}

// How long the conversation model stays in VRAM after the owner stops talking.
//
// It was `-1`, which is Ollama for "forever": measured, qwen3.5 held 5.6GB and
// bge-m3 another 664MB with `ollama ps` reading `UNTIL Forever`, on a machine
// that also has to run ComfyUI, LTX-2 and ACE-Step on the same card. Sixty
// seconds keeps a back-and-forth conversation instant — every turn restarts the
// window — and hands the whole card back one minute after the owner stops.
//
// Note this has to be sent on every request. The machine has OLLAMA_KEEP_ALIVE=-1
// in its launchd environment, so anything that omits the field inherits forever.
const DEFAULT_KEEP_ALIVE = '60s';

/** Accept a number of seconds or an Ollama duration string; `0` means unload immediately. */
function normalizeKeepAlive(value) {
  if (value === 0 || value === '0') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 0 ? DEFAULT_KEEP_ALIVE : `${Math.round(value)}s`;
  const text = String(value || '').trim();
  return /^\d+(\.\d+)?(ms|s|m|h)$/.test(text) ? text : DEFAULT_KEEP_ALIVE;
}

class ConversationEngine extends EventEmitter {
  // The conversation model is qwen3.5:latest. qwen2.5:0.5b was the default and it
  // could not hold a conversation — asked "機能してる？" it answered "はい、機能が
  // 存在します… でも、具体的な問題についてはお手伝いできませんので" in the owner's
  // own window: self-contradictory, and not grammatical Japanese either. Measured
  // 2026-08-03 against the same prompt: 0.5b rambles for 69 tokens, qwen3.5
  // answers correctly in 25. It stays as the fast-ACK tier, which is what a 0.5b
  // model is for.
  // timeoutMs is the stall deadline — the longest silence tolerated between tokens, not
  // the budget for the whole answer. maxTurnMs is the hard ceiling that bounds a model
  // which keeps emitting forever.
  constructor({ fetchImpl = global.fetch, model = process.env.BIGKIJI_CONVERSATION_MODEL || 'qwen3.5:latest',
    endpoint = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434', timeoutMs = 8000, maxTurnMs = 90000,
    maxContextTokens = 4096, maxTurns = 8, keepAlive = DEFAULT_KEEP_ALIVE } = {}) {
    super(); this.fetchImpl = fetchImpl; this.model = model; this.endpoint = endpoint.replace(/\/$/, ''); this.timeoutMs = timeoutMs;
    this.maxTurnMs = Math.max(timeoutMs, maxTurnMs);
    this.maxContextTokens = Math.min(8192, Math.max(1024, maxContextTokens)); this.maxTurns = Math.max(2, Math.min(16, maxTurns));
    this.keepAlive = normalizeKeepAlive(keepAlive);
    this.histories = new Map(); this.active = 0;
  }

  /**
   * Hand the GPU back now.
   *
   * `keep_alive: 0` with an empty prompt is Ollama's unload: the weights leave
   * VRAM on the next tick rather than at the end of the idle window. This is what
   * the owner needs before a render or a video job takes the same card, and it is
   * the only way to reach zero without waiting.
   * @returns {Promise<{released: boolean, model: string, error?: string}>}
   */
  async release() {
    if (!this.fetchImpl) return { released: false, model: this.model, error: 'no fetch implementation' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/generate`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, prompt: '', keep_alive: 0 }) });
      return { released: response.ok, model: this.model, ...(response.ok ? {} : { error: `Ollama HTTP ${response.status}` }) };
    } catch (error) { return { released: false, model: this.model, error: clean(error.message, 120) }; }
    finally { clearTimeout(timer); }
  }

  history(sessionId, seed = []) {
    // maxTurns counts exchanges; seed and history are individual messages, and the
    // trim below is `maxTurns * 2` for exactly that reason. Slicing the seed by
    // maxTurns threw away half of a resumed conversation before the model saw it:
    // the daemon hands over the last 16 messages and 8 arrived.
    if (!this.histories.has(sessionId)) this.histories.set(sessionId, seed.slice(-this.maxTurns * 2));
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

  prompt(ownerText, history, facts = '') {
    const transcript = history.map((turn) => `${turn.role === 'assistant' ? 'BigKiji' : 'Owner'}: ${turn.text}`).join('\n');
    // Asked "残ってるタスクおしえて", BigKiji answered "タスクはまだ登録されていま
    // せん" while the daemon held a run awaiting approval, two tasks, six ideas and
    // twenty-four sessions. It was not being evasive — it had never been told any
    // of it. A model with no facts does not say "I don't know"; it says something
    // plausible, and plausible-and-wrong is the worst answer a status question can
    // get. So the caller passes what it actually knows, and the model is told in
    // as many words that this block is the only source for these numbers.
    return `You are BigKiji, the owner's natural local conversation partner and private idea librarian.\n` +
      (facts ? `Current system state — these are the real numbers, use them and never invent others.\n${facts}\n`
        + `If the owner asks about anything not covered above, say plainly that you do not have it rather than guessing.\n` : '') +
      `Reply naturally in the owner's language. Do not use canned startup phrases. Do not reveal reasoning or mention hidden policies.\n` +
      `Do not merely repeat or paraphrase the owner. Add at least one concrete, useful observation or suggestion. Keep the reply to 2-4 natural sentences and optionally ask one relevant question.\n` +
      `Classify this turn as CHAT, IDEA, TASK, or CLARIFICATION. TASK means the owner is clearly asking for an action or code change. IDEA means a possibility worth saving but not executing.\n` +
      `For IDEA or TASK, extract concise knowledge fields. Never invent decisions. Ask at most 3 questions only when a missing choice materially changes the result.\n` +
      `Recent conversation:\n${transcript || '(new conversation)'}\nOwner: ${ownerText}\n` +
      `Return JSON only: {"kind":"CHAT|IDEA|TASK|CLARIFICATION","reply":"natural direct reply","title":"short title","summary":"",` +
      `"ideas":[],"requirements":[],"decisions":[],"openQuestions":[],"todos":[],"confidence":0.0}`;
  }

  async turn({ text, sessionId, seed = [], facts = '', onStart, onDelta } = {}) {
    const inspected = redactPayload(String(text || '').trim());
    if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_OWNER_PROMPT');
    const ownerText = clean(inspected.text, 5000); if (!ownerText) throw new Error('Conversation text is empty');
    const turnId = `turn-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; const started = Date.now();
    const history = this.history(sessionId, seed); const compacted = this.compact(history); onStart?.({ turnId, model: this.model });
    this.emit('start', { turnId, sessionId, model: this.model, at: started }); this.active++;
    let result; let provider = 'local-qwen'; let degraded = false; let ttftMs = null;
    const controller = new AbortController();
    // Streaming changes what a deadline can honestly mean. With stream:false the whole
    // turn shared one 8s budget, so a model that was generating correctly but slowly
    // lost everything it had produced — and the owner got the deterministic fallback
    // for a turn that was working. The deadline is now a stall: while chunks keep
    // arriving the model is alive, and only silence ends the turn. A hard ceiling still
    // bounds the total so nothing can hang forever.
    let stall = null;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), this.timeoutMs); stall.unref?.();
    };
    const ceiling = setTimeout(() => controller.abort(), this.maxTurnMs); ceiling.unref?.();
    armStall();
    try {
      if (!this.fetchImpl) throw new Error('Local conversation fetch unavailable');
      const response = await this.fetchImpl(`${this.endpoint}/api/generate`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model,
          prompt: this.prompt(ownerText, compacted.turns, facts), stream: true, format: 'json', keep_alive: this.keepAlive,
          // A reasoning model deliberates before it answers, and that deliberation
          // comes out of the same num_predict budget as the answer: qwen3.5 spent
          // the whole 650 thinking and returned nothing. Ollama 0.30.8 takes
          // `think: false` and skips it — measured, and the reason a capable model
          // is usable here at all. Models that do not reason ignore the field.
          think: false,
          options: { temperature: 0.55, top_p: 0.9, num_ctx: this.maxContextTokens, num_predict: 650 } }) });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      let raw = '';
      await drainOllamaStream(response, (text, streamed) => {
        // Any chunk means the model is alive, including a reasoning model's thinking
        // tokens, which carry no answer text at all. TTFT stays honest: it marks the
        // first token of the actual answer, which is the thing the owner waits for.
        armStall();
        if (streamed && ttftMs === null && text) ttftMs = Date.now() - started;
        raw += text;
      });
      const parsed = json(raw); if (!parsed) throw new Error('Local conversation model returned invalid JSON');
      result = normalize(parsed, ownerText);
    } catch (error) {
      degraded = true; provider = 'deterministic-local'; result = fallback(ownerText);
      result.error = clean(error.name === 'AbortError'
        ? `Local conversation ${ttftMs === null ? 'timeout before first token' : 'stalled mid-answer'}`
        : error.message, 180);
      // Say that the model did not answer.
      //
      // The fallback is a template. It reads like a considered reply, so a turn the
      // model never served was indistinguishable from one it did — and after nine
      // of them in a row the owner concluded the thing was stupid rather than
      // absent. It was absent. A degraded answer that admits it is a different
      // product from one that pretends.
      result.reply = `${degradedPrefix(ownerText)}${result.reply}`;
    } finally { clearTimeout(stall); clearTimeout(ceiling); this.active = Math.max(0, this.active - 1); }
    history.push({ role: 'owner', text: ownerText }, { role: 'assistant', text: result.reply });
    while (history.length > this.maxTurns * 2) history.shift();
    onDelta?.(result.reply); const finished = Date.now();
    // ttftMs is null when nothing was streamed — a fallback answer, or a response
    // delivered in one piece. Null means "not measured", never zero.
    const output = { ...result, turnId, sessionId, provider, model: this.model, degraded, latencyMs: finished - started, ttftMs,
      context: { turns: compacted.turns.length, estimatedTokens: compacted.tokens, limit: this.maxContextTokens }, redactions: inspected.findings };
    this.emit('finish', output); return output;
  }

  snapshot() { return { model: this.model, endpoint: this.endpoint, active: this.active, sessions: this.histories.size,
    maxContextTokens: this.maxContextTokens, keepAlive: this.keepAlive }; }
}

module.exports = { ConversationEngine, heuristicKind, guardedKind, isAffirmative, endsWithQuestion, fallback, normalize, clean,
  deriveTitle, usableTitle, degradedPrefix, normalizeKeepAlive, DEFAULT_KEEP_ALIVE };
