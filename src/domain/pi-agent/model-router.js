'use strict';
// v13 ハイブリッドモデル・オーケストレーター（Task Dispatcher / Auto-Fallback基盤）
// キーの実在を検知して「可用ティアだけ」で動的フォールバックチェーンを構築する。
// 課金許可モデルはGLMのみ。Claude Codeは確定計画後に外部CLIで起動し、
// Qwenは事前計画・要約・知識再利用専用。Gemini/Kimi/OpenRouterは意図的に除外する。
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODELS_JSON = path.join(os.homedir(), '.pi', 'agent', 'models.json');

// 役割定義（スペック§1①）。上から品質順に試し、429/沈黙で即降格
const TIERS = [
  { id: 'zai/glm-4.7-flash', need: 'zai', role: 'approved paid execution · fast tooling', tag: 'GLM' },
  { id: 'ollama/qwen3.5:35b-a3b', need: 'ollama', role: 'local ¥0 · planning · private', tag: 'LOCAL' },
];

function realKey(v) {
  return typeof v === 'string' && v.length > 8 && !v.startsWith('REPLACE_WITH');
}

// models.json＋envからプロバイダ可用性を判定（プレースホルダは不在扱い）
function loadProviders() {
  const avail = {
    ollama: true, // 実疎通はollamaHealth()で別途確認
  };
  if (realKey(process.env.ZAI_API_KEY)) avail.zai = true;
  try {
    const conf = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
    for (const [name, p] of Object.entries(conf.providers || {})) {
      if (name === 'ollama') continue;
      if (p && realKey(p.apiKey)) avail[name] = true;
    }
  } catch (_) {}
  return avail;
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
const STATE_PATH = path.join(__dirname, '..', 'Knowledge', 'task_state.json');
function saveTaskState(state) {
  try {
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
  TIERS, loadProviders, buildChain, tierOf, pickStart,
  ERROR_PATTERN, MODEL_UNAVAILABLE_PATTERN, FALLBACK_ERROR_PATTERN,
  handoffSummary, saveTaskState, loadTaskState, STATE_PATH, ollamaHealth, ollamaWarmup, ollamaKickstart,
};
