'use strict';

// One residency window for every local model BigKiji loads. A default of -1 here
// meant any caller that did not pass one pinned the model in VRAM forever.
const { DEFAULT_KEEP_ALIVE: KEEP_ALIVE } = require('../pi-core/conversation-engine');
// v13 ハイブリッドモデル・オーケストレーター（Task Dispatcher / Auto-Fallback基盤）
// キーの実在を検知して「可用ティアだけ」で動的フォールバックチェーンを構築する。
// 課金許可モデルはGLMのみ。Claude Codeは確定計画後に外部CLIで起動し、
// Qwenは事前計画・要約・知識再利用専用。Gemini/Kimi/OpenRouterは意図的に除外する。
const fs = require('fs');
const os = require('os');
const path = require('path');

// GLMモデルIDの唯一の正本（オーナー方針: GLMは常に最新を使う）。
// 更新時はここだけを書き換える。2026-08-02時点の現行:
//   flagship = glm-5.2（2026-06-13リリース・743B MoE・1M文脈）
//   flash    = glm-4.7-flash（glm-4.5-flashは2026-01-30廃止。5.2にflash派生は未発売）
const GLM_MODELS = Object.freeze({
  flagship: process.env.BIGKIJI_GLM_MODEL || 'glm-5.2',
  flash: process.env.BIGKIJI_GLM_FLASH_MODEL || 'glm-4.7-flash',
});

// Claude model IDs, in the same single-source-of-truth shape as GLM_MODELS.
// Owner rule: prose, design and large redesigns go to Fable; ordinary engineering
// stays on Opus. Only these two tiers are wired — no model is used here that the
// owner has not asked for.
const CLAUDE_MODELS = Object.freeze({
  design: process.env.BIGKIJI_CLAUDE_DESIGN_MODEL || 'claude-fable-5',
  general: process.env.BIGKIJI_CLAUDE_MODEL || 'claude-opus-5',
});

const DESIGN_SIGNALS = /(?:markdown|readme|\.md\b|docs?\b|documentation|design|ux\b|ui\b|visual|layout|css|animation|typography|copy(?:writing)?|デザイン|レイアウト|見た目|文章|資料|文書|記事)/i;
const COMPLEX_SIGNALS = /(?:architect|refactor|migrat|redesign|rebuild|overhaul|end-to-end|複雑|設計|再構築|作り直|全面)/i;

// Which brain, not which vendor. Provider selection happens first (capability
// registry); this only decides the tier once the provider is already Claude, so a
// fallback to GLM cannot silently discard the decision.
// Role to tier, in one place, decided before any text is read.
//
// The tier used to be inferred from a string that included the role's own title,
// and `leader`'s title is "Architecture, system implementation and integration".
// COMPLEX_SIGNALS matches /architect/, so every leader assignment resolved to the
// design tier whatever the owner had asked for: measured 2026-08-03, 9 of 9
// claude-code assignments went to claude-fable-5 at $10/$50 instead of Opus 5 at
// $5/$25. The signals still decide for anything not pinned here, but they are only
// ever shown the owner's own words.
// Only `ui` is pinned: it is design work whatever the owner typed. Every other role
// is decided by the owner's own words, because the standing rule is that prose,
// design and large redesigns go to Fable regardless of which role carries them —
// pinning leader to Opus would quietly cancel that rule for the role most likely to
// be handed a redesign.
const ROLE_TIER = Object.freeze({ ui: 'design' });

function pickModelTier(text, role = '') {
  const pinned = ROLE_TIER[String(role || '')];
  if (pinned) return pinned;
  const value = String(text || '');
  if (DESIGN_SIGNALS.test(value) || COMPLEX_SIGNALS.test(value) || value.length > 6000) return 'design';
  return 'general';
}

// '' means "the adapter already pins the model" (GLM) or "there is nothing to pin"
// (local Ollama), which keeps the disclosure manifest honest rather than inventing an id.
function resolveModel(provider, text, role = '') {
  if (provider !== 'claude' && provider !== 'claude-code') return '';
  return CLAUDE_MODELS[pickModelTier(text, role)];
}

// 役割定義（スペック§1①）。2段階モデル構造：
// - 会話モデル（常駐）: qwen2.5:0.5b（keep_alive: 60秒＝会話が続く間だけ常駐）
// - 思考モデル（オンデマンド）: qwen3.5:35b-a3b（PiAgent起動時のみ）
const TIERS = [
  { id: 'ollama/qwen2.5:0.5b', need: 'ollama', role: '常駐 · Fast ACK · 会話', tag: 'CHAT', keepAlive: KEEP_ALIVE },
  { id: `zai/${GLM_MODELS.flagship}`, need: 'zai', role: 'approved paid execution · reasoning', tag: 'GLM' },
  { id: 'ollama/qwen3.5:35b-a3b', need: 'ollama', role: 'PiAgentオンデマンド · 思考', tag: 'PIAGENT', keepAlive: 0 },
];

// The planning router is local-only. It must not inspect external-provider
// credential stores merely to guess availability; paid execution is resolved
// after an owner-approved disclosure manifest in TaskRunner.
function loadProviders() {
  return { ollama: true }; //実疎通は ollamaHealth() で別途確認
}

function buildChain(avail = loadProviders(), { allowPaid = false } = {}) {
  const chain = TIERS.filter((t) => avail[t.need] && (allowPaid || t.need === 'ollama'));
  return chain.length ? chain : [TIERS[TIERS.length - 1]];
}
function tierOf(modelId) {
  return TIERS.find((t) => t.id === modelId) || null;
}

// タスク特性からの開始ティア選択（役割分担ディスパッチ）
function pickStart(chain, text) {
  const s = String(text || '');
  const idx = (need) => chain.findIndex((t) => t.need === need);
  // 機密/ローカル指定 → ローカルQwen直行（トークン無制限・秘密保持）
  if (/機密|秘密|社外秘|private|confidential|ローカルだけ|ローカルのみ|local only/i.test(s)) {
    const i = idx('ollama');
    if (i >= 0) return i;
  }
  // 軽量・定型・高速系 → GLM（可用時）
  if (s.length < 400 && /整形|変換|翻訳|要約|リネーム|一括|format|convert|translate|summariz|rename/i.test(s)) {
    const i = idx('zai');
    if (i >= 0) return i;
  }
  return idx('ollama') >= 0 ? idx('ollama') : 0;
}

// レートリミット/課金系エラーの検知パターン（pi stderr・RPC errorイベント用）
//
// One regular expression used to cover both, and for choosing a fallback that is
// fine — either way this provider cannot serve the next request. But the router
// also *remembers* failures, and there the two are different facts:
//
//   rate limit — "not now". The provider works; there were too many requests in
//                too short a window. It will work again in seconds or minutes.
//   quota      — "not today". The plan's allowance is spent, or the model is not
//                on this tier at all. A different provider is needed, but this
//                one is not broken either.
//
// Neither is a statement about how well the provider does its job, so neither
// may reach the penalty table — see model-capability-registry.record().
//
// A single response can match both: Gemini answers an exhausted free-tier
// allowance with HTTP 429 *and* "Quota exceeded". Quota is checked first,
// because the recovery time is the thing that differs and the longer one wins.
//
// These have to be tight, because what they are matched against is not an error
// line — it is `task.error`, the last 8000 characters of everything the provider
// wrote to stderr. A loose word costs a real defect its penalty: matching bare
// `exceeded` turns "Maximum call stack size exceeded" into an exhausted quota,
// and bare `429` turns "AssertionError at src/foo.js:429" into a rate limit. So
// 429 only counts beside a status/code key or the phrase it belongs to, and
// `exceeded`/`billing` only count in the company of the word they qualify.
const RATE_LIMIT_PATTERN = new RegExp([
  '\\brate[ _-]?limit',
  'too many requests',
  'RESOURCE_EXHAUSTED',
  '\\boverloaded', // Anthropic sends {"type":"overloaded_error"}, so no trailing boundary
  'slow[ _]?down',
  '\\b(?:status|statuscode|status_code|code|httpcode)\\b\\W{0,8}429\\b', // {"code": 429}
  '\\bhttp/?[\\d.]*\\s+429\\b',                                          // HTTP/1.1 429
  '\\b429\\b\\W{0,4}(?:too many|rate|client error)',                     // 429 Too Many Requests
].join('|'), 'i');
const QUOTA_PATTERN = new RegExp([
  'insufficient_quota',
  'quota[ _-]?(?:exceeded|exhausted)',
  'exceeded[^\\n]{0,40}\\bquota\\b',
  '\\bquota\\b[^\\n]{0,60}\\b(?:exceeded|exhausted|reached|limit: ?0)\\b',
  'out of (?:credit|quota)',
  'billing details',
  '\\bbilling\\b[^\\n]{0,40}\\b(?:required|enable|upgrade)\\b',
].join('|'), 'i');

// UNCHANGED from before the classification split, deliberately. pi-bridge.js:72
// drives the local Pi fallback chain off this, and narrowing it would silently
// change which stderr lines demote a model — a different feature, on a different
// day, with its own reasons. The precise patterns above are for the router's
// memory; this one is for that fallback, exactly as it was.
const ERROR_PATTERN = /(\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED|insufficient_quota|exceeded|overloaded|billing)/i;

/**
 * Why a provider failed, when the reason is one the provider is not to blame for.
 * Returns '' for an ordinary failure — a crash, a bad patch, a timeout — which is
 * exactly the kind of failure the router *should* learn from.
 * @returns {'quota'|'rate-limit'|'model-unavailable'|''}
 */
function classifyFailure(text) {
  const value = String(text || '');
  if (!value) return '';
  if (QUOTA_PATTERN.test(value)) return 'quota';
  if (RATE_LIMIT_PATTERN.test(value)) return 'rate-limit';
  if (MODEL_UNAVAILABLE_PATTERN.test(value)) return 'model-unavailable';
  return '';
}

// Providers say how long to wait in several shapes: Gemini nests
// `"retryDelay": "12s"` in its error body, HTTP uses `Retry-After` in seconds.
// Returns 0 when nothing was stated — the caller then falls back to its own
// backoff rather than inventing a number.
function retryAfterMs(text) {
  const value = String(text || '');
  const seconds = value.match(/"?retry-?(?:after|delay)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s?"?/i);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);
  return 0;
}
// プロバイダのモデルカタログ変更・廃止も「そのティアだけが死んだ」状態。
// 404一般を含めるとツール/Webの404まで誤って降格するので、モデル名を伴う応答だけに絞る。
const MODEL_UNAVAILABLE_PATTERN = /(?:models?\/[^\s"']+.*(?:not found|unsupported)|(?:model|models?)\b.*\b(?:not found|unsupported).*(?:generatecontent|api|version)?|\b404\b.*(?:models?\/|model\b))/i;
const FALLBACK_ERROR_PATTERN = new RegExp(`${ERROR_PATTERN.source}|${MODEL_UNAVAILABLE_PATTERN.source}`, 'i');

// モデル切替時の最小トークン・コンテキスト引き継ぎ（思考の連続性を≤700字で保つ）
function handoffSummary(answerText, tools, fromModel) {
  const a = String(answerText || '').replace(/\s+/g, ' ').trim();
  if (!a && (!tools || !tools.length)) return '';
  const head = a.slice(0, 200);
  const tail = a.length > 700 ? ' … ' + a.slice(-450) : a.slice(200, 700);
  const toolLine = tools && tools.length
    ? ` Tools already executed: ${[...new Set(tools)].slice(0, 8).join(', ')}.` : '';
  return `[HANDOFF from ${fromModel}] Progress before switch: "${head}${tail}".${toolLine} ` +
    'Continue the task from where it stopped; do not restart completed steps.\n\n';
}

// 作業ステートの一次保存（切替・完了時に更新＝復元材料）
const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
const STATE_PATH = path.join(path.resolve(process.env.BIGKIJI_KNOWLEDGE_ROOT || process.env.KNOWLEDGE_ROOT
  || (() => { const data = resolveDataRoot({ userData: defaultUserData() });
    return dataLayout(data.dataRoot, data.overrides).knowledgeRoot; })()), 'runtime_task_state.json');
function saveTaskState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, ts: new Date().toISOString() }, null, 2));
  } catch (_) {}
}
function loadTaskState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return null; }
}

// ---- Ollama Resource Guard ----
async function ollamaHealth(timeoutMs = 4000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}
// Load a model into VRAM before the owner needs it, and say how long it took.
//
// This replaces a fire-and-forget warmup that was written, exported, and never called
// once — so every first turn after launch paid the full cold load. That matters more
// than it sounds: ConversationEngine aborts a turn at 8s and falls back to the
// deterministic reply, so a cold model does not just answer slowly, it answers with
// the degraded path and reports itself as degraded.
//
// An empty prompt is enough to make Ollama load the weights; the answer is discarded.
// The duration is returned rather than logged so the caller can show a real number
// instead of an animation that claims to know something it does not.
//
// `options` must match what the turn will send. Ollama keys a loaded instance on its
// runtime options, so warming with a different num_ctx unloads and reloads the model
// the moment real work arrives — measured here 2026-08-02 on qwen3.5:latest: warming
// without num_ctx left the next num_ctx:4096 request paying 3450ms, while warming with
// the same num_ctx brought it to 254ms. A warmup that ignores this looks like it works
// and does nothing, which is worse than not having one.
async function warmModel(model, { keepAlive = KEEP_ALIVE, timeoutMs = 180000, fetchImpl = global.fetch, options = null,
  endpoint = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434' } = {}) {
  const target = String(model || '').trim();
  if (!target) return { model: '', ok: false, ms: 0, error: 'no model configured' };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/api/generate`, {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: target, prompt: '', keep_alive: keepAlive, ...(options ? { options } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || `Ollama HTTP ${response.status}`);
    return { model: target, ok: true, ms: Date.now() - started, error: '' };
  } catch (error) {
    return { model: target, ok: false, ms: Date.now() - started,
      error: String(error?.name === 'AbortError' ? `warmup timeout after ${timeoutMs}ms` : (error?.message || error)).slice(0, 200) };
  } finally { clearTimeout(timer); }
}
function ollamaKickstart() { // 不応時の再起動（GUIアプリのlaunchdラベル）
  try {
    require('child_process').execFile('launchctl',
      ['kickstart', '-k', `gui/${process.getuid()}/com.ollama.ollama`], () => {});
  } catch (_) {}
}

module.exports = {
  ROLE_TIER,
  GLM_MODELS, CLAUDE_MODELS, pickModelTier, resolveModel, TIERS, loadProviders, buildChain, tierOf, pickStart,
  ERROR_PATTERN, MODEL_UNAVAILABLE_PATTERN, FALLBACK_ERROR_PATTERN, RATE_LIMIT_PATTERN, QUOTA_PATTERN,
  classifyFailure, retryAfterMs,
  handoffSummary, saveTaskState, loadTaskState, STATE_PATH, ollamaHealth, warmModel, ollamaKickstart,
};
