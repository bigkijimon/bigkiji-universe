'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { redactPayload } = require('./security/payload-redactor');
const { estimateTokens } = require('../pi-agent/context-pruner');
const { freezeExplanation, ollamaFrozen } = require('../pi-agent/gpu-lock');

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
// 表記ゆれ。同じ依頼が、漢字で書いたかどうかだけで通ったり落ちたりしていた。
//
// 実測 2026-08-09、オーナーのCLIで同じ意味の2文を打った結果:
//   「課金トークンのリミット解除されてるか確認して欲しいす」 -> CHAT（runなし）
//   「課金トークンのリミットを確認してほしい」               -> TASK（runあり）
// 違いは 欲しい / ほしい の一箇所だけ。語彙を足す前に、まずこれを潰す。
const KANA = [
  [/欲し(い|かった)/g, 'ほし$1'], [/下さい/g, 'ください'], [/出来(る|ます|れ|た|ない)/g, 'でき$1'],
  [/頂(け|き|きたい|けますか)/g, 'いただ$1'], [/貰(え|い|えますか)/g, 'もら$1'],
  [/宜しく/g, 'よろしく'], [/御願い/g, 'お願い'], [/致します/g, 'いたします'],
];
/** 依頼判定のためだけの正規化。原文は書き換えない（保存も表示も原文のまま）。 */
function normalizeRequest(text) {
  let value = String(text || '');
  for (const [pattern, into] of KANA) value = value.replace(pattern, into);
  return value;
}
// 一段目。単体で「やってくれ」を意味する語。ここに当たれば無条件で TASK。
const STRONG_ACTION = /(?:実装|修正|変更|追加|削除|build|implement|fix|refactor|commit|create|作って|直して|してください|してほしい)/i;
// 二段目。作業を指す語だが、単体では雑談にもなる（「確認が取れた」「調査によると」）。
// 依頼の締めと組んだときだけ TASK にする。
const WORK_VERB = /(?:確認|調べ|調査|点検|チェック|検証|見せ|表示|一覧|出力|出し|作成|生成|セットアップ|設定|導入|インストール|整理|更新|同期|移動|コピー|バックアップ|テスト|レビュー|解析|分析|まとめ|教え|検索|探し|再起動|起動|デプロイ|公開|置き換え|書き換え)/;
// 「〜て」「〜てください」「〜てほしい」「〜お願い」——文末に来る依頼の形。
const REQUEST_TAIL = /(?:て|てね|てよ|てください|てほしい|てほしいです|てもらえますか|てもらえる|ていただけますか|ていただけますでしょうか|てくれる|てくれますか|ておいて|といて|をお願いします|をお願い|お願いします)[。．.!！?？\s]*$/;
// 依頼の締めから見て、この文字数までの範囲に作業語があることを要求する。
// 「今日は確認が取れなくて、あとで話して」のような、頭に作業語があるだけの雑談を弾く。
const TAIL_WINDOW = 24;
const EN_WORK = /\b(?:check|show|list|find|look|verify|investigate|inspect|set\s?up|install|update|deploy|run|test|review|search|explain)\b/i;
const EN_REQUEST = /\b(?:please|could you|can you|would you|i(?:'| a)?m asking you to|go ahead and)\b/i;
// 「あなたは何ができるの」は依頼ではない。
//
// 日本語側は REQUEST_TAIL ＋ TAIL_WINDOW で「締めの近くに作業語」を要求しているのに、英語側だけ
// 二つの正規表現を文中どこでも当てていた。だから `how can you run btw` が `can you` ＋ `run` で
// 依頼に化けた（オーナー実コーパス361件・2026-08-09 実測）。`can you check the logs?` は依頼、
// `how can you run` は能力への質問——違いは疑問詞が助動詞の直前に来ているかどうか。
const EN_CAPABILITY = /\b(?:how|what|why|when|where|who)\s+(?:can|could|would|do|does|should|are|is)\s+you(?:r)?\b/i;

/**
 * '' | 'soft' | 'strong'。依頼としての強さ。
 *
 * 'strong' は「明示的な作業指示」。status-answer はこちらだけを見る——語彙を広げた結果
 * 「進捗を確認して」が TASK に化け、状況質問の横取りが効かなくなるのを防ぐため。
 * @returns {''|'soft'|'strong'}
 */
function actionTier(text) {
  const value = normalizeRequest(text);
  if (STRONG_ACTION.test(value)) return 'strong';
  const tail = value.trim().slice(-TAIL_WINDOW);
  if (REQUEST_TAIL.test(value) && WORK_VERB.test(tail)) return 'soft';
  if (EN_REQUEST.test(value) && EN_WORK.test(value) && !EN_CAPABILITY.test(value)) return 'soft';
  return '';
}
// 見るだけの依頼か、直す依頼か。
//
// 2026-08-10、オーナーが「データ見せてください」と打った結果:
//
//   1. どのデータを表示しますか？  a) ユーザーリスト  b) 売上レポート  c) システムログ
//   2. 表示形式はどちらですか？    a) テーブル  b) チャート  c) JSON
//
// 選択肢は3つとも実在しない（このシステムに「売上レポート」は無い）。前受付は
// 「materially important decisions が欠けていたら全部聞け」と指示されていて、6.6B の
// モデルは何を聞かれても欠けていると判断し、知らないものについて選択肢を作る。
//
// 質問の数は「間違えたときの損害」に比例すべきで、前受付はそれを見ていなかった。
// 一覧の並び順を間違えたら1ターンやり直すだけ。フォルダを消す向きを間違えたら戻らない。
// **見るだけの依頼には既定値を選んで進む**——これが答え。
const READ_VERB = /(?:見せ|見して|表示|一覧|出して|出力|教え|確認|調べ|調査|検索|探し|読ん|読み|チェック|レビュー|分析|解析|まとめ|要約|プレビュー|見たい|知りたい|どこ|何が|いくつ|ある[？?か]|あります|存在)/;
const WRITE_VERB = /(?:実装|修正|変更|追加|削除|消して|作って|作成|生成|書いて|書き換え|置き換え|更新|同期|移動|コピー|リネーム|整理|セットアップ|設定|導入|インストール|デプロイ|公開|再起動|起動|停止|バックアップ|直して|なおして|リファクタ)/;
const EN_READ = /\b(?:show|list|display|find|search|read|check|explain|tell|preview|summar\w*|what|which|where|how many)\b/i;
const EN_WRITE = /\b(?:build|implement|fix|refactor|commit|create|write|make|delete|remove|deploy|install|update|move|rename|restart|set\s?up|configure)\b/i;

/** Where a pattern last matches, or -1. */
function lastIndexOfMatch(value, pattern) {
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let last = -1; let match;
  while ((match = scan.exec(value)) !== null) { last = match.index; if (scan.lastIndex === match.index) scan.lastIndex += 1; }
  return last;
}

/**
 * True when the request only looks at something.
 *
 * Decided by which verb comes **last**, not by whether a write word appears at all.
 * Japanese puts the governing verb at the end, and the two readings differ by nothing
 * else:
 *
 *   ログを調べて直して      調べ(read) … 直して(write)   → a change
 *   設定を見せてください     設定(write noun) … 見せ(read) → an inspection
 *   バックアップある？       バックアップ(write noun) … ある？(read) → an inspection
 *   バックアップを取っておいて   no read verb at all         → a change
 *
 * A flat "any write word disqualifies it" test called all four of those changes, because
 * バックアップ・設定・整理 are nouns as readily as verbs. English is governed the same way
 * by its trailing conjunct: `list the files and delete the old ones` is a change.
 */
function isInspection(text) {
  const value = normalizeRequest(text);
  const read = Math.max(lastIndexOfMatch(value, READ_VERB), lastIndexOfMatch(value, EN_READ));
  if (read < 0) return false;
  const write = Math.max(lastIndexOfMatch(value, WRITE_VERB), lastIndexOfMatch(value, EN_WRITE));
  return read > write;
}

function heuristicKind(text) {
  if (actionTier(text)) return 'TASK';
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

// Length, and only length, decides whether a turn gets the short prompt.
//
// `isAffirmative` was the obvious candidate and is the wrong tool: it anchors the
// go-ahead to the END of a line, so 「UPCLASSのテキストを作って、お願いします」 matches it —
// a real request that must not be answered in one sentence. Twelve characters is a
// measure of the question the owner actually typed, and it cannot be fooled by what the
// sentence happens to end with. 「はい」 2, 「sai」 3, 「テキストのデータある？」 11 are in;
// 「CodexとClaudeCodeとGLMです」 24 and everything longer keep the full instruction.
const SMALL_TURN_CHARS = 12;
// Enough for one sentence in either language with the JSON envelope around it, and far
// below the 650 a full answer gets. This is a ceiling, not a target: the prompt above is
// what actually shortens the reply, and this stops a model that ignores it from spending
// twenty seconds proving the point.
const SMALL_TURN_PREDICT = 120;

// A reply ending in a question mark is asking one, whatever the model labelled it.
// Structural on purpose: it must not depend on the model getting `kind` right, since
// that is the part that failed.
function endsWithQuestion(text) { return /[?？]\s*$/.test(String(text || '').trim()); }

/**
 * The kind, and where it came from.
 *
 * This used to end with "a model saying TASK is downgraded to CHAT, full stop", and the
 * reason given was that a small model over-promotes reflective sentences. That reason is
 * real — and it cost more than it saved. Measured on the owner's machine 2026-08-09:
 * every turn logged `model says TASK -> final: CHAT`, so the lexicon was the only door
 * into work, and a request phrased outside its fourteen words started nothing at all.
 * The owner's report was 「まだ一度もまともに使えていない」.
 *
 * The trade the owner chose (2026-08-09) is to let the model open the door and pay for a
 * wrong guess with an approval prompt instead of a lost request: a model-promoted TASK is
 * marked here and the daemon submits it as `plan`, so it waits for /approve even under
 * `auto-edit`. The front desk it passes through on the way runs on local Ollama
 * (fast-api-router.js `runOllama`), so a false promotion costs no paid tokens either.
 *
 * A lexical TASK keeps its own mode: that path is unchanged and was never the problem.
 * @returns {{kind: string, promotedByModel: boolean}}
 */
function classifyKind(modelKind, text) {
  const lexical = heuristicKind(text); const proposed = String(modelKind || '').toUpperCase();
  if (lexical === 'TASK') return { kind: 'TASK', promotedByModel: false };
  if (lexical === 'IDEA') return { kind: 'IDEA', promotedByModel: false };
  // One thing the model still may not promote: a line that is only a go-ahead.
  //
  // 「お願いします」 means "start" when something is waiting to be started and nothing at
  // all when nothing is — which is why the daemon consults `isAffirmative` only while it
  // is holding a request. A model that reads it as TASK on its own would file a plan
  // whose goal is the word "お願いします": junk in the approval queue, and a paid run one
  // careless /approve away. The go-ahead path is where this sentence is answered.
  if (proposed === 'TASK') {
    return isAffirmative(text) ? { kind: 'CHAT', promotedByModel: false } : { kind: 'TASK', promotedByModel: true };
  }
  // IDEA is deliberately not promoted. It writes a draft file for every turn it fires on,
  // and a chat that leaves a saved idea behind on every third sentence is noise the owner
  // has to clean up — the opposite of the failure being fixed here.
  if (proposed === 'IDEA') return { kind: 'CHAT', promotedByModel: false };
  return { kind: ['CHAT', 'CLARIFICATION'].includes(proposed) ? proposed : 'CHAT', promotedByModel: false };
}
function guardedKind(modelKind, text) { return classifyKind(modelKind, text).kind; }
/** Kana or Han in the owner's line \u2014 which language the degraded answers are written in. */
function isJapanese(text) { return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || '')); }
function fallbackReply(text, kind = heuristicKind(text)) {
  const japanese = isJapanese(text);
  if (kind === 'TASK') return { kind, reply: japanese ? `「${deriveTitle(text)}」を実行計画として整理しています。始める前に対象と手順を一緒に確認しましょう。決めておきたい条件はありますか？` : `I am organizing “${deriveTitle(text)}” into an execution plan. Let's review the scope and steps before starting—any constraints you want fixed up front?` };
  if (kind === 'IDEA') return { kind, reply: japanese
    ? `いい視点です。「${deriveTitle(text)}」としてローカル下書きに残しました。核になる要素と、まだ決めなくてよい部分を分けておくと、会話を止めずに後で育てられます。`
    : `That is worth keeping, so I saved “${deriveTitle(text)}” as a private local draft. Separating its core idea from decisions that can wait will make it easier to develop without interrupting the conversation.` };
  return { kind, reply: japanese ? `その話、もう少し聞かせてください。特に「${clean(text, 80)}」のどの部分がいちばん気になっていますか？` : `Tell me a little more about that—what part of “${clean(text, 80)}” matters most to you?` };
}
// "It did not answer" is true and useless. "Your own video job froze it at 10:05" is
// the same fact with the one thing the owner can act on attached: wait, or stop the
// job. When gpu-signal.sh holds the card this says so; otherwise it falls back to the
// admission below, because a cause this module cannot see is not one it should invent.
function degradedHeader(text, explain = freezeExplanation) {
  const japanese = isJapanese(text);
  let hint = '';
  try { hint = explain({ japanese }) || ''; } catch (_) { hint = ''; }
  return hint || degradedPrefix(text);
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
  const { kind, promotedByModel } = classifyKind(value?.kind, text);
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
  return { kind, reply, promotedByModel,
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
  //
  // firstTokenTimeoutMs is the deadline for the first token only, and it exists because
  // loading the weights is not a stall.
  //
  // Measured 2026-08-09 11:20, immediately after a render finished and the watchdog thawed
  // Ollama (qwen3.5:latest, same machine):
  //
  //     cold load (load_duration)          9.2 s
  //     first turn after the thaw          deterministic-local, 8036 ms — degraded
  //     second turn (model warm)           local-qwen, ttft 7233 ms, a real answer
  //
  // So with one 8 s deadline, the first question after any render — and after every
  // 60 s keep_alive window closes — degraded even with the GPU completely free, because
  // loading the weights costs more than the whole budget. A model that has not been
  // loaded yet is silent for the load too, and that silence was charged to the stall.
  // Separating them is the honest reading of what "stall" means. Raising keep_alive
  // instead would hold VRAM against every other job on this machine, which the
  // company-wide GPU rule forbids.
  constructor({ fetchImpl = global.fetch, model = process.env.BIGKIJI_CONVERSATION_MODEL || 'qwen3.5:latest',
    endpoint = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434', timeoutMs = 8000, maxTurnMs = 90000,
    firstTokenTimeoutMs = 20000,
    maxContextTokens = 4096, maxTurns = 8, keepAlive = DEFAULT_KEEP_ALIVE, explainFreeze = freezeExplanation,
    isFrozen = null } = {}) {
    super(); this.fetchImpl = fetchImpl; this.model = model; this.endpoint = endpoint.replace(/\/$/, ''); this.timeoutMs = timeoutMs;
    // Never shorter than the stall deadline: a caller that passes only `timeoutMs` (the
    // reflection engine passes 12000) must not end up with a first-token budget smaller
    // than the silence it already tolerates mid-answer.
    this.firstTokenTimeoutMs = Math.max(timeoutMs, firstTokenTimeoutMs);
    this.maxTurnMs = Math.max(this.firstTokenTimeoutMs, timeoutMs, maxTurnMs);
    this.maxContextTokens = Math.min(8192, Math.max(1024, maxContextTokens)); this.maxTurns = Math.max(2, Math.min(16, maxTurns));
    this.keepAlive = normalizeKeepAlive(keepAlive); this.explainFreeze = explainFreeze;
    // Consult the machine only when this engine is actually talking to the machine.
    //
    // `ollamaFrozen()` reads `ps` — a global fact — but the check exists for one narrow
    // reason: not to spend 8s asking a SIGSTOPped local Ollama. An engine handed its own
    // `fetchImpl` is not talking to that process, and short-circuiting it there made
    // every streaming test degrade whenever the owner's GPU happened to be busy. The
    // suite went from 68 PASS to red mid-render, which is exactly the machine-state
    // dependence conversation-selftest.js was already burned by once.
    //
    // Note the shape: `ollamaFrozen()` returns {frozen, stopped[]}, not a boolean. A
    // `=== true` comparison here was silently always false and saved nothing.
    this.isFrozen = isFrozen || (fetchImpl === global.fetch
      ? () => ollamaFrozen()?.frozen === true
      : () => false);
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

  /**
   * A turn small enough that a paragraph back is the wrong answer.
   *
   * From the owner's own session log, 2026-08-10: 「はい」 cost 4,927ms and 「sai」 —
   * three characters, a typo — cost 8,292ms. Nothing was slow. The model was doing
   * exactly what the prompt above demands of every turn: at least one concrete
   * observation, two to four sentences, optionally a question. Two hundred-odd tokens
   * for an acknowledgement, and the owner waits for every one of them.
   *
   * The measure is the owner's line, not the classification: `kind` is decided by the
   * same call whose length we are trying to bound, so it cannot be an input to it.
   */
  static isSmall(ownerText) {
    const text = String(ownerText || '').trim();
    return text.length > 0 && text.length <= SMALL_TURN_CHARS;
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
      (ConversationEngine.isSmall(ownerText)
        ? `The owner said something short. Answer in one sentence. Do not add an observation, a suggestion or a question.\n`
        : `Do not merely repeat or paraphrase the owner. Add at least one concrete, useful observation or suggestion. Keep the reply to 2-4 natural sentences and optionally ask one relevant question.\n`) +
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
    let result; let provider = 'local-qwen'; let degraded = false; let ttftMs = null; let gpuFrozen = false;
    const controller = new AbortController();
    // Streaming changes what a deadline can honestly mean. With stream:false the whole
    // turn shared one 8s budget, so a model that was generating correctly but slowly
    // lost everything it had produced — and the owner got the deterministic fallback
    // for a turn that was working. The deadline is now a stall: while chunks keep
    // arriving the model is alive, and only silence ends the turn. A hard ceiling still
    // bounds the total so nothing can hang forever.
    // …and until the first chunk arrives, the silence may be the model loading rather
    // than the model stalling. Those are different waits and they get different budgets;
    // see firstTokenTimeoutMs on the constructor for the measurement.
    let stall = null; let streaming = false;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), streaming ? this.timeoutMs : this.firstTokenTimeoutMs);
      stall.unref?.();
    };
    const ceiling = setTimeout(() => controller.abort(), this.maxTurnMs); ceiling.unref?.();
    armStall();
    try {
      if (!this.fetchImpl) throw new Error('Local conversation fetch unavailable');
      // Do not spend eight seconds asking a stopped process.
      //
      // While gpu-signal.sh holds the card it SIGSTOPs both `ollama serve` and
      // `llama-server` (mem-switch.sh freeze_ollama). A SIGSTOPped process accepts the
      // TCP connection and never answers, so every turn paid the full stall deadline
      // before falling back — measured 2026-08-09: latencyMs 8000/8001/8002/8004 on four
      // consecutive turns, and `ollama list` itself hung for over two minutes.
      //
      // The state is knowable before the call: `ollamaFrozen()` reads `ps -Ao stat` and
      // reports the T state. Knowing it and asking anyway is eight seconds of the owner's
      // time per turn, spent to learn something already on the machine. The fallback that
      // follows is the same one, and it already says which job holds the card.
      if (this.isFrozen()) throw new Error('Ollama is stopped — the GPU is held by another job');
      const response = await this.fetchImpl(`${this.endpoint}/api/generate`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model,
          prompt: this.prompt(ownerText, compacted.turns, facts), stream: true, format: 'json', keep_alive: this.keepAlive,
          // A reasoning model deliberates before it answers, and that deliberation
          // comes out of the same num_predict budget as the answer: qwen3.5 spent
          // the whole 650 thinking and returned nothing. Ollama 0.30.8 takes
          // `think: false` and skips it — measured, and the reason a capable model
          // is usable here at all. Models that do not reason ignore the field.
          think: false,
          options: { temperature: 0.55, top_p: 0.9, num_ctx: this.maxContextTokens,
            num_predict: ConversationEngine.isSmall(ownerText) ? SMALL_TURN_PREDICT : 650 } }) });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      let raw = '';
      await drainOllamaStream(response, (text, streamed) => {
        // Any chunk means the model is alive, including a reasoning model's thinking
        // tokens, which carry no answer text at all. TTFT stays honest: it marks the
        // first token of the actual answer, which is the thing the owner waits for.
        //
        // `streaming` is set before arming, so the very first chunk switches the deadline
        // down to the stall budget: once bytes are moving the weights are loaded, and the
        // long first-token allowance has done its job.
        streaming = true;
        armStall();
        if (streamed && ttftMs === null && text) ttftMs = Date.now() - started;
        raw += text;
      });
      const parsed = json(raw); if (!parsed) throw new Error('Local conversation model returned invalid JSON');
      result = normalize(parsed, ownerText);
    } catch (error) {
      degraded = true; provider = 'deterministic-local'; result = fallback(ownerText);
      result.error = clean(error.name === 'AbortError'
        // Which deadline ran out, named, because they mean different things: nothing at
        // all in `firstTokenTimeoutMs` is a model that could not load or a server that is
        // not answering; silence after tokens were flowing is a model that stopped.
        ? (streaming ? 'Local conversation stalled mid-answer'
          : `Local conversation timeout before first token (${this.firstTokenTimeoutMs}ms)`)
        : error.message, 180);
      // Say that the model did not answer.
      //
      // The fallback is a template. It reads like a considered reply, so a turn the
      // model never served was indistinguishable from one it did — and after nine
      // of them in a row the owner concluded the thing was stupid rather than
      // absent. It was absent. A degraded answer that admits it is a different
      // product from one that pretends.
      // …and say why, when the reason is knowable. gpu-signal.sh stops Ollama for the
      // duration of a render; without this the owner reads nine identical "it did not
      // answer" templates and never learns that their own video job is holding the card.
      const header = degradedHeader(ownerText, this.explainFreeze);
      // Whether the degradation had a knowable cause, for the surfaces that show a
      // status word rather than a paragraph. `degradedPrefix` is the no-cause default,
      // so anything else is the GPU explanation.
      gpuFrozen = header !== degradedPrefix(ownerText);
      // Shown, not remembered. `spoken` stays the model's own words.
      //
      // The header is a fact about this minute — 「GPUを『u09-tile-answer』が10:55:51から
      // 使用中のため…」 — and it was being written into the transcript as part of the
      // reply. Measured 2026-08-10 from the owner's own session file: the render exited
      // at 12:00, and at 12:42 a resumed session had the model saying 「GPU が使用中のため
      // 生成は待機中ですが」 twice, to an idle GPU. It was not hallucinating. It was
      // reading the sentence we saved an hour earlier and continuing the pattern.
      //
      // A 6.6B model handed a transcript that says the machine is frozen will keep
      // saying the machine is frozen, and the owner has no way to tell that apart from a
      // live reading. So the notice goes on screen and the record keeps `degraded` and
      // `gpuFrozen` — fields that were added for exactly this and cannot be misread as
      // something the assistant believes.
      result.spoken = result.reply;
      result.reply = `${header}${result.spoken}`;
    } finally { clearTimeout(stall); clearTimeout(ceiling); this.active = Math.max(0, this.active - 1); }
    if (!result.spoken) result.spoken = result.reply;
    history.push({ role: 'owner', text: ownerText }, { role: 'assistant', text: result.spoken });
    while (history.length > this.maxTurns * 2) history.shift();
    onDelta?.(result.reply); const finished = Date.now();
    // ttftMs is null when nothing was streamed — a fallback answer, or a response
    // delivered in one piece. Null means "not measured", never zero.
    const output = { ...result, turnId, sessionId, provider, model: this.model, degraded, gpuFrozen, latencyMs: finished - started, ttftMs,
      context: { turns: compacted.turns.length, estimatedTokens: compacted.tokens, limit: this.maxContextTokens }, redactions: inspected.findings };
    this.emit('finish', output); return output;
  }

  snapshot() { return { model: this.model, endpoint: this.endpoint, active: this.active, sessions: this.histories.size,
    maxContextTokens: this.maxContextTokens, keepAlive: this.keepAlive }; }
}

module.exports = { ConversationEngine, heuristicKind, guardedKind, classifyKind, actionTier, normalizeRequest, isInspection,
  isAffirmative, endsWithQuestion, fallback, normalize, clean,
  deriveTitle, usableTitle, degradedPrefix, degradedHeader, isJapanese, normalizeKeepAlive, DEFAULT_KEEP_ALIVE };
