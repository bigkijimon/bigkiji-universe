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

const { actionTier } = require('./conversation-engine');

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
  // Action language wins — but only the explicit kind.
  //
  // This read `heuristicKind(value) === 'TASK'`, and on 2026-08-09 that lexicon grew a
  // second tier so that 「確認して」「調べて」 could start work at all. 確認 and 調査 are
  // also the verbs a status question is built from, so sharing the widened test would
  // have handed 「進捗を確認して」 to a model — undoing the whole point of this file.
  // `actionTier` is still the conversation engine's own function, so the two cannot
  // drift; what is shared now is the strong tier rather than the union of both.
  if (actionTier(value) === 'strong') return false;
  return ASKS.some((pattern) => pattern.test(value));
}

// 「課金トークンのリミット解除されてるか確認して欲しいす」 — the owner's own line, 2026-08-09.
//
// This is a question with an exact answer sitting in two files (circuit-breaker.json and
// model_performance.json) and it reached neither. Before that day it was classified CHAT
// and answered by a 3B model guessing; after the lexicon was widened it classified as a
// TASK, which is worse — it would spend a paid run to look up a rate limit. So it is
// intercepted here, ahead of the action lexicon, for the same reason a status question is:
// the true answer is already known and a model can only make it up.
//
// Narrower than ASKS on purpose. It must name a limit or an AI; 「制限を外す実装をして」 is
// real work and does not match, because 実装 is not one of the words that follows.
const PROVIDER_ASKS = [
  /(?:リミット|レートリミット|レート制限|クォータ|トークン|上限|制限)[^。\n]{0,14}(?:解除|戻っ|回復|残っ|空い|大丈夫|使え|効いて|かかって|きれて|切れて|状況|どう|確認|チェック)/,
  /(?:どの|どれ|何|なん|いくつ)[^。\n]{0,8}(?:ai|ＡＩ|モデル|プロバイダ|エージェント|課金)[^。\n]{0,10}(?:使え|動く|生きて|空いて|available)/i,
  /(?:claude|codex|gemini|glm|qwen|クロード|コーデックス|ジェミニ)[^。\n]{0,12}(?:使え|動く|生きて|available|working|ok\b)/i,
  /\b(?:rate|token|quota)\s*limits?\b[^.\n]{0,20}(?:lifted|reset|clear|left|ok|status)?/i,
  /\bwhich\s+(?:ai|model|provider)s?\b[^.\n]{0,20}\b(?:can|are|is|available|usable)\b/i,
];
// Longer than a status question: 「課金トークンのリミット解除されてるか確認して欲しいす」 is 28
// characters and a bilingual phrasing runs longer still. Bounded all the same, so a
// paragraph that happens to mention a quota is not swallowed.
const PROVIDER_MAX_LENGTH = 90;

/**
 * True when the owner is asking which AI can be used, or whether a limit is still on.
 * @param {string} text
 * @returns {boolean}
 */
function isProviderQuestion(text) {
  const value = String(text || '').trim();
  if (!value || value.length > PROVIDER_MAX_LENGTH) return false;
  return PROVIDER_ASKS.some((pattern) => pattern.test(value));
}

/**
 * Which providers can run work, assembled from the breaker rather than described.
 *
 * @param {object} facts   from Daemon#providerFacts()
 * @param {object} [options]
 * @param {string} [options.text]  the owner's question, used only to pick a language
 * @returns {string}
 */
function providerReport(facts = {}, { text = '' } = {}) {
  const japanese = JAPANESE.test(String(text || ''));
  const list = (value) => (Array.isArray(value) ? value : []);
  const usable = list(facts.usable); const cooling = list(facts.cooling);
  const busy = list(facts.busy); const throttled = list(facts.throttled); const unreachable = list(facts.unreachable);
  const frozen = list(facts.frozen);
  const lines = [];

  lines.push(usable.length
    ? (japanese ? `いま使えるのは ${usable.join(' / ')} の ${usable.length} 社です。` : `${usable.length} usable right now: ${usable.join(', ')}.`)
    : (japanese ? 'いま外部に出せるプロバイダはありません。ローカルの作業だけ動きます。' : 'No external provider can run work right now — local only.'));

  for (const item of cooling) {
    const seconds = Math.max(1, Math.round(Number(item.retryInMs || 0) / 1000));
    const wait = seconds >= 3600 ? `${Math.round(seconds / 3600)}${japanese ? '時間' : 'h'}`
      : seconds >= 60 ? `${Math.round(seconds / 60)}${japanese ? '分' : 'm'}` : `${seconds}${japanese ? '秒' : 's'}`;
    lines.push(japanese
      ? `  ${item.provider}  クールダウン中 あと${wait}${item.reason ? `（${item.reason}）` : ''}`
      : `  ${item.provider}  cooling down, ${wait} left${item.reason ? ` (${item.reason})` : ''}`);
  }
  // Named with its reason rather than left out of the usable list in silence.
  //
  // Before this, a question asked during a render was answered 「いま使えるのは …
  // local-qwen … の6社です」 while `ps` showed that process in state T — the app
  // announcing a model it could not reach. Dropping it quietly would have been the
  // other half of the same mistake: the owner would see five providers, none of them
  // local, and no explanation of where it went.
  for (const item of frozen) {
    lines.push(item.orphaned
      ? (japanese
        ? `  ${item.provider}  停止中（GPUロックは無いので、誰も解凍しません。手動で再開が要ります）`
        : `  ${item.provider}  stopped, and no lock is held — nothing will thaw it; it needs a hand`)
      : (japanese
        ? `  ${item.provider}  停止中（GPUを「${item.holder || '生成ジョブ'}」が${item.since ? `${item.since}から` : ''}使用中。終われば戻ります）`
        : `  ${item.provider}  stopped — the GPU is held by “${item.holder || 'a generation job'}”`
          + `${item.since ? ` since ${item.since}` : ''}; it returns when that finishes`));
  }
  for (const item of throttled) {
    lines.push(japanese
      ? `  ${item.provider}  直近で ${item.reason} を踏みました${item.at ? `（${item.at}）` : ''}。いまは通ります`
      : `  ${item.provider}  hit ${item.reason} earlier${item.at ? ` (${item.at})` : ''}; it goes through now`);
  }
  for (const id of unreachable) {
    lines.push(japanese ? `  ${id}  未接続（認証か起動が済んでいません）` : `  ${id}  not reachable (not authenticated or not started)`);
  }
  if (busy.length) {
    lines.push(japanese ? `いま作業中: ${busy.join(' / ')}` : `Working right now: ${busy.join(', ')}`);
  }
  if (!cooling.length) {
    lines.push(japanese ? 'クールダウン中のプロバイダはありません。' : 'Nothing is on a cooldown.');
  }
  return lines.join('\n');
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

module.exports = { isStatusQuestion, statusReport, since, ASKS, MAX_LENGTH,
  isProviderQuestion, providerReport, PROVIDER_ASKS, PROVIDER_MAX_LENGTH };
