'use strict';
// "Is it actually working?" — answered from measurements, never by a model.
//
// WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED
//
// The daemon already hands the conversation model a block of true facts before every
// turn (daemon.js facts()), including the two numbers that matter here:
//
//     - runs awaiting your approval: 2
//     - runs in progress: 0
//
// On 2026-08-04 the owner asked four times in one session — 「仕事できてる？」「進んでる？」
// 「さぎょうが遅くない？」「ほんとに動いてる？」— and got "順調に進んでいます" four times,
// while two runs sat untouched for eleven hours. Re-measured the same day against
// qwen3.5:latest with those exact facts in the prompt: two questions, two fabrications.
//
// Prompting harder was tried and measured too. With a hard rule ("if runs in progress is
// 0 you MUST say no work is running") the verdict flips, but the sentence arrives broken:
//
//     はい、システムは待機状態で作業中ではありません。現在進行中の実行が 2 つあるため…
//     …/approve を入力いただければ…ね。”}title=
//
// — self-contradictory in the first case, leaking raw JSON in the second. A model asked
// to report state will sooner or later report a state that is not there. So for this one
// class of question the model is not consulted at all: the reply below is assembled from
// the coordinator's own snapshot, which means a false progress report is not unlikely,
// it is unrepresentable.
//
// WHAT IT IS ALLOWED TO SAY
//
// Only counts and timestamps that were handed to it. A run whose start time we never
// recorded gets no elapsed clause rather than a plausible one; a total of zero is stated
// as zero because an empty list really is empty. Nothing here is rounded up, softened, or
// turned into an assurance.

const { heuristicKind } = require('./conversation-engine');

const JAPANESE = /[぀-ヿ㐀-鿿]/;

// Deliberately narrow. This intercepts a question before the model sees it, so a false
// positive costs the owner a real conversation — the expensive mistake here is grabbing
// a sentence that was not a status question, not missing one.
const ASKS = [
  /動いて(る|いる|ます|い(ます|る)か)/, /稼働/, /進んで(る|いる|ます)/, /進捗/,
  /仕事.{0,3}(でき|して)/, /どうなって/, /どこまで/,
  // 「さぎょうが遅くない？」 — one of the four the owner actually asked on 2026-08-04.
  // It has to be 遅い *about the work*: a bare /遅(い|く|れ)/ was tried and it swallowed
  // 「ページの表示が遅い問題を調査して」, which is a real request about a real bug and
  // must reach the model. Kana as well as kanji, because it was typed in kana.
  /(作業|さぎょう).{0,4}(でき|して|中|進|遅)/,
  /状況/, /ステータス/, /何[をも]?して(る|いる|ます)/, /終わ(った|ってる|りました)/,
  // 「承認待ちはありますか？」 — measured 2026-08-05 driving the real CLI: this one fell
  // through to the model, and it is the question whose true answer the daemon already
  // has to hand (`/runs` answers it exactly). Asking a model whether something is
  // waiting for the owner's approval is the same bet that produced 「順調に進んでいます」
  // over two untouched runs. The 待ち/待って is required, so 「承認画面を作って」 —
  // real work — does not match; heuristicKind and MAX_LENGTH bound it further.
  /承認.{0,3}(待ち|待って)/,
  /\b(anything|any\s+runs?)\s+(waiting|pending)\b/i, /\bwaiting\s+for\s+(my\s+)?approval\b/i,
  /\b(is|are)\s+(it|you|they)\s+(working|running|going|doing)/i,
  /\bstill\s+(running|working|going)\b/i,
  /\bany\s+progress\b/i,
  /\bwhat(?:'|’| i)?s\s+(?:the\s+)?(?:status|progress)\b/i,
  /\bwhat\s+are\s+you\s+doing\b/i,
  /\bdone\s+yet\b/i,
  /^\s*(?:status|progress)\s*\??\s*$/i,
];

// A status question is short. "予約フローの進捗管理機能を作ってください" contains 進捗 and is
// a work request; the length bound plus the TASK check below keep it out.
const MAX_LENGTH = 60;

/**
 * True when the owner is asking about the state of the machine rather than talking to it.
 * @param {string} text
 * @returns {boolean}
 */
function isStatusQuestion(text) {
  const value = String(text || '').trim();
  if (!value || value.length > MAX_LENGTH) return false;
  // Action language wins. `heuristicKind` is the same lexicon the conversation engine
  // uses to decide a turn is work, shared rather than copied so the two cannot drift.
  if (heuristicKind(value) === 'TASK') return false;
  return ASKS.some((pattern) => pattern.test(value));
}

/** How long ago, in the owner's language. '' when we were never told when. */
function since(at, now, japanese) {
  const started = new Date(at).getTime();
  if (!Number.isFinite(started)) return '';
  const ms = now - started;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) { const days = Math.floor(hours / 24); return japanese ? `${days}日` : `${days}d`; }
  if (hours >= 1) return japanese ? `${hours}時間` : `${hours}h`;
  if (minutes >= 1) return japanese ? `${minutes}分` : `${minutes}m`;
  return japanese ? '1分未満' : 'under a minute';
}

function runLine(run, now, japanese, waiting) {
  const total = Number(run.total) || 0;
  const done = Number(run.done) || 0;
  const age = since(waiting ? run.createdAt : run.startedAt, now, japanese);
  const parts = [run.id];
  if (age) parts.push(japanese ? `${age}${waiting ? '待機' : '経過'}` : `${age} ${waiting ? 'waiting' : 'elapsed'}`);
  if (total) parts.push(waiting ? (japanese ? `${total}件` : `${total} assignments`) : `${done}/${total}`);
  if (run.stage) parts.push(String(run.stage));
  // Whether anything can write is the fact that decides how much the owner cares.
  if (waiting && typeof run.writes === 'boolean') {
    parts.push(run.writes ? (japanese ? '書き込みあり' : 'writes') : (japanese ? '読み取りのみ' : 'read-only'));
  }
  return `  ${parts.join('  ')}`;
}

/**
 * The reply itself. Counts first, then one line per run, then what to do next.
 *
 * @param {object} facts   from Daemon#statusFacts()
 * @param {object} [options]
 * @param {string} [options.text]  the owner's question, used only to pick a language
 * @param {number} [options.now]   injected so this stays testable
 * @returns {string}
 */
function statusReport(facts = {}, { text = '', now = Date.now() } = {}) {
  const japanese = JAPANESE.test(String(text || ''));
  const running = Array.isArray(facts.running) ? facts.running : [];
  const waiting = Array.isArray(facts.waiting) ? facts.waiting : [];
  const lines = [];

  lines.push(japanese
    ? `実行中 ${running.length} 件 · 承認待ち ${waiting.length} 件。`
    : `${running.length} running · ${waiting.length} waiting for you.`);

  if (!running.length) {
    lines.push(japanese ? '今この瞬間、動いているものはありません。' : 'Nothing is executing right now.');
  }
  for (const run of running) lines.push(runLine(run, now, japanese, false));
  for (const run of waiting) lines.push(runLine(run, now, japanese, true));

  if (waiting.length) {
    const first = waiting[0].id;
    lines.push(japanese
      ? `/approve ${first} で開始します。/runs で全部見られます。`
      : `/approve ${first} starts it. /runs lists them all.`);
  } else if (!running.length) {
    lines.push(japanese
      ? 'まだ依頼を受けていません。やってほしいことを書いてください。'
      : 'Nothing has been asked of me yet — tell me what to do.');
  }
  return lines.join('\n');
}

module.exports = { isStatusQuestion, statusReport, since, ASKS, MAX_LENGTH };
