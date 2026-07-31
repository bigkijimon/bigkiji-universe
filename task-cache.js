'use strict';
// v12 Swarm合意形成＋JSONナレッジキャッシュ（スペックD）
// 分類: direct(短文・非タスク=即送信) / cache(既知パターン=プレイブック注入・議論トークン0)
//       / swarm(未知タスク=2レンズ軽量議論→合意計画を注入)。
// 成功パターンは task_knowledge_base.json へ自動保存＝使うほど議論コストが0に近づく。
// 未知タスクの事前議論はローカル Ollama の JSON 応答だけで行う。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'with', 'at',
  'it', 'this', 'that', 'you', 'i', 'we', 'me', 'my', 'your', 'please', 'from', 'into', 'about',
]);
const TASK_WORDS = /作成|実装|構築|調査|分析|修正|設計|生成|レポート|まとめ|移行|検証|テスト|リファクタ|自動化|build|implement|creat|research|analy|fix|design|generat|report|refactor|migrat|test|audit|writ|develop|automat/i;

let cfg = null; // { kbPath, C, emit:{liveComment,broadcast}, model, knowledge }
let pendingSwarm = null; // 実行中swarm→成功時にKBへ保存（同時1件）

function init(options) {
  cfg = { model: 'qwen3.5:35b-a3b', ...options };
  return api;
}

function loadKB() {
  try {
    const kb = JSON.parse(fs.readFileSync(cfg.kbPath, 'utf8'));
    if (Array.isArray(kb.patterns)) return kb;
  } catch (_) {}
  return { patterns: [] };
}
function saveKB(kb) {
  try {
    fs.mkdirSync(path.dirname(cfg.kbPath), { recursive: true });
    fs.writeFileSync(cfg.kbPath, JSON.stringify(kb, null, 2));
  } catch (_) {}
}

function keywords(text) {
  const words = String(text).toLowerCase().split(/[^a-z0-9぀-ヿ一-鿿]+/).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (out.size >= 40) break;
    if (STOP.has(w)) continue;
    if (/^[a-z0-9]+$/.test(w)) { if (w.length >= 3) out.add(w); continue; }
    for (let i = 0; i < w.length - 1 && out.size < 40; i++) out.add(w.slice(i, i + 2)); // CJKはbigram
  }
  return [...out];
}
function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / ((A.size + B.size - inter) || 1);
}

async function llmJson(prompt) {
  const started = Date.now();
  const res = await fetch(
    'http://127.0.0.1:11434/api/generate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model || 'qwen3.5:35b-a3b',
        prompt: `${prompt}\nReturn JSON only.`,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 500 },
        keep_alive: '30m',
      }),
    },
  );
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || `ollama ${res.status}`);
  const text = String(j.response || '').trim();
  return { data: JSON.parse(text), tok: 0, local: true, ms: Date.now() - started };
}

const LENSES = [
  ['architect', 'You are the ARCHITECT lens: optimize for correct decomposition, dependency order (DAG) and verification steps.'],
  ['researcher', 'You are the RESEARCHER lens: optimize for unknowns to look up first and which agent is fastest for each part.'],
];

async function swarmDiscuss(text, kw, dispatch) {
  pendingSwarm = { t0: Date.now() };
  cfg.emit.liveComment(cfg.C.swarmStart(), 'info');
  cfg.emit.broadcast('bk:swarm', { mode: 'consensus', phase: 'start' });
  const ask = ([lens, persona]) => llmJson(
    `${persona}\nTask from the owner: """${String(text).slice(0, 1200)}"""\n` +
    'Available agents: claude-code (approved heavy execution), glm (approved paid helper), biglama (local free planning/bulk work).\n' +
    'Reply ONLY as JSON: {"roles":{"<agent>":{"role":"<short role>","note":"<1 line>"}},"steps":["step 1","step 2",...]} with 3-6 imperative steps in DAG order.',
  ).then((r) => {
    cfg.emit.broadcast('bk:swarm', { mode: 'consensus', phase: 'proposal', lens });
    cfg.emit.liveComment(cfg.C.swarmPhase('Proposal in', `${lens} lens`), 'info');
    return r;
  });
  let proposals;
  try {
    proposals = await Promise.all(LENSES.map(ask));
  } catch (err) {
    cfg.emit.liveComment(`🐝 [SWARM] discussion unavailable (${String(err.message).slice(0, 60)}) — executing directly`, 'warn');
    cfg.emit.broadcast('bk:swarm', { mode: 'consensus', phase: 'abort' });
    pendingSwarm = null;
    dispatch(String(text));
    return;
  }
  // コードでマージ（トークン0）: steps=A案を骨格にB案の非重複stepを追補 / roles=和集合
  const [a, b] = proposals.map((p) => p.data || {});
  const roles = { ...(b.roles || {}), ...(a.roles || {}) };
  const steps = [...(a.steps || [])];
  for (const s of (b.steps || [])) {
    if (!steps.some((x) => jaccard(keywords(x), keywords(s)) > 0.4)) steps.push(s);
  }
  const discTok = proposals.reduce((n, p) => n + (p.tok || 0), 0); // Ollama cost is 0
  const ms = Date.now() - pendingSwarm.t0;
  cfg.emit.broadcast('bk:swarm', { mode: 'consensus', phase: 'merge', steps: steps.length, tok: discTok });
  cfg.emit.liveComment(cfg.C.swarmPhase('Consensus reached', `${steps.length} steps · ${discTok} tok · ${(ms / 1000).toFixed(1)}s`), 'ok');
  pendingSwarm = { text: String(text), kw, discTok, roles, steps, t0: pendingSwarm.t0 };
  const roleLine = Object.entries(roles).map(([k, v]) => `${k}=${(v && v.role) || '?'}`).join(', ');
  const plan = `[SWARM PLAN] Two agent lenses reached consensus. Roles: ${roleLine || 'core'}. ` +
    `Steps: ${steps.join(' → ')}. Execute this plan.\n\n`;
  if (cfg.knowledge) {
    try { cfg.knowledge.rememberPlan(cfg.knowledge.createTask(text, 'preflight'), plan, steps); } catch (_) {}
  }
  dispatch(plan + text);
}

function route(text, dispatch) {
  if (!cfg || process.env.BIGKIJI_SWARM === '0') { dispatch(String(text)); return; }
  if (pendingSwarm && Date.now() - pendingSwarm.t0 > 600000) pendingSwarm = null; // スタック保険
  const kw = keywords(text);
  if (String(text).length < 120 && !TASK_WORDS.test(text)) { dispatch(String(text)); return; } // direct=雑談・短指示
  const kb = loadKB();
  let best = null; let bestScore = 0;
  for (const p of kb.patterns) {
    const s = jaccard(kw, p.intent_keywords || []);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best && bestScore >= 0.5) { // A route: キャッシュ即実行（議論トークン0）
    best.hits = (best.hits || 0) + 1;
    best.last_used = new Date().toISOString();
    saveKB(kb);
    const saved = (best.token_cost_history && best.token_cost_history.initial_discussion) || '?';
    cfg.emit.liveComment(cfg.C.cacheHit(best.task_description, saved), 'ok');
    cfg.emit.broadcast('bk:swarm', { mode: 'cache', hash: best.task_pattern_hash, score: +bestScore.toFixed(2) });
    const roles = Object.entries(best.agent_roles || {}).map(([k, v]) => `${k}=${(v && v.role) || '?'}`).join(', ');
    const playbook = `[CACHED PLAYBOOK ${best.task_pattern_hash}] Proven plan for a similar task ` +
      `(similarity ${(bestScore * 100) | 0}%). Roles: ${roles || 'core'}. ` +
      `Steps: ${(best.execution_graph || []).join(' → ')}. Follow it directly; do not re-plan unless it clearly misfits.\n\n`;
    if (cfg.knowledge) {
      try { cfg.knowledge.rememberPlan(cfg.knowledge.createTask(text, 'cached'), playbook, best.execution_graph || []); } catch (_) {}
    }
    dispatch(playbook + text);
    return;
  }
  if (pendingSwarm) { dispatch(String(text)); return; } // 議論は同時1件
  swarmDiscuss(text, kw, dispatch); // B route（非同期・合意後にdispatchされる）
}

// ターン完了時に呼ぶ: swarm実行が成功(toolエラー0)ならKBへ自動保存
function turnDone({ ok, tokens }) {
  const p = pendingSwarm;
  if (!p || !p.steps) { return; }
  pendingSwarm = null;
  if (!ok) return;
  const kb = loadKB();
  const hash = crypto.createHash('sha1').update(p.kw.join(',')).digest('hex').slice(0, 12);
  if (kb.patterns.some((x) => x.task_pattern_hash === hash)) return;
  kb.patterns.push({
    task_pattern_hash: hash,
    task_description: p.text.replace(/\s+/g, ' ').slice(0, 120),
    intent_keywords: p.kw,
    agent_roles: Object.fromEntries(Object.entries(p.roles).map(([k, v]) => [k, {
      role: (v && v.role) || '?', system_prompt_override: (v && v.note) || '',
    }])),
    execution_graph: p.steps,
    token_cost_history: {
      initial_discussion: p.discTok, // 実測（usageMetadata）
      cached_execution: tokens ? (tokens.input || 0) + (tokens.output || 0) : 0, // 実測（pi:stats）
    },
    created: new Date().toISOString(),
    hits: 0,
  });
  if (kb.patterns.length > 200) kb.patterns = kb.patterns.slice(-200);
  saveKB(kb);
  cfg.emit.liveComment(cfg.C.cacheStore(p.text.replace(/\s+/g, ' ').slice(0, 60)), 'ok');
  cfg.emit.broadcast('bk:swarm', { mode: 'stored', hash });
}

const api = { init, route, turnDone, keywords, jaccard };
module.exports = api;
