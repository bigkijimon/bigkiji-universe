'use strict';
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
function pickModelTier(text, role = '') {
  const value = String(text || '');
  if (role === 'ui' || DESIGN_SIGNALS.test(value) || COMPLEX_SIGNALS.test(value) || value.length > 6000) return 'design';
  return 'general';
}

// '' means "the adapter already pins the model" (GLM) or "there is nothing to pin"
// (local Ollama), which keeps the disclosure manifest honest rather than inventing an id.
function resolveModel(provider, text, role = '') {
  if (provider !== 'claude' && provider !== 'claude-code') return '';
  return CLAUDE_MODELS[pickModelTier(text, role)];
}

// 役割定義（スペック§1①）。2段階モデル構造：
// - 会話モデル（常駐）: qwen2.5:0.5b（keep_alive: -1）
// - 思考モデル（オンデマンド）: qwen3.5:35b-a3b（PiAgent起動時のみ）
const TIERS = [
  { id: 'ollama/qwen2.5:0.5b', need: 'ollama', role: '常駐 · Fast ACK · 会話', tag: 'CHAT', keepAlive: -1 },
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
const ERROR_PATTERN = /(\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED|insufficient_quota|exceeded|overloaded|billing)/i;
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
// コールドスタート防止のwarmup（サーバはKEEP_ALIVE=-1常駐だが保険で30m指定）
function ollamaWarmup(model = 'qwen3.5:35b-a3b') {
  fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }),
  }).catch(() => {});
}
function ollamaKickstart() { // 不応時の再起動（GUIアプリのlaunchdラベル）
  try {
    require('child_process').execFile('launchctl',
      ['kickstart', '-k', `gui/${process.getuid()}/com.ollama.ollama`], () => {});
  } catch (_) {}
}

module.exports = {
  GLM_MODELS, CLAUDE_MODELS, pickModelTier, resolveModel, TIERS, loadProviders, buildChain, tierOf, pickStart,
  ERROR_PATTERN, MODEL_UNAVAILABLE_PATTERN, FALLBACK_ERROR_PATTERN,
  handoffSummary, saveTaskState, loadTaskState, STATE_PATH, ollamaHealth, ollamaWarmup, ollamaKickstart,
};
