'use strict';
// タスク完了レポート（2026-08-02オーナー指示）
// Coreが消滅する前に、直近のrun/タスク/モデル実測だけでレポートを組み立て、
// ~/.bigkiji/reports/report-<ts>.md と同名 .json に保存してレンダラーへ返す。
// 原則: 実データのみ。実測が無い項目は「実測なし」「記録なし」と正直に記す（捏造禁止）。
// Electron外（node直接実行のドライラン）では captureWindow が無い/nullを返すため
// スクリーンショットは自動でスキップされる。
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REPORTS_ROOT = path.join(os.homedir(), '.bigkiji', 'reports');

// 表示順と強調: オーナーが名指しした Claude Code / Codex / GLM5 を先頭・primary に
const REPORT_MODELS = [
  { id: 'claude-code', label: 'Claude Code', primary: true },
  { id: 'codex', label: 'Codex', primary: true },
  { id: 'glm', label: 'GLM5', primary: true },
  { id: 'gemini', label: 'Gemini', primary: false },
  { id: 'pi-agent-core', label: 'PiAgent Engine', primary: false },
  { id: 'local-qwen', label: 'Local Qwen', primary: false },
];

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}分${s % 60}秒` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

// 節約% = saved / (saved + used)。usedが0なら実測なし（nullを返す）
function savedPct(used, saved) {
  if (!(used > 0)) return null;
  return Math.round((saved / (saved + used)) * 1000) / 10;
}

async function safeCall(fn, fallback) {
  if (typeof fn !== 'function') return fallback;
  try { return (await fn()) ?? fallback; } catch (_) { return fallback; }
}

class TaskReportBuilder {
  // deps は全て任意（欠けても正直な空欄レポートを生成する）:
  //   listRuns()/listTasks()/getModelSnapshot()/getIdeas() … async getter
  //   getPreviewStatus() … sync getter / captureWindow() … async → PNG Buffer|null
  //   recordingsRoots … 録画探索ディレクトリの配列 / reportsRoot … 保存先
  constructor(deps = {}) {
    this.deps = deps;
    this.reportsRoot = deps.reportsRoot || DEFAULT_REPORTS_ROOT;
    this.recordingsRoots = Array.isArray(deps.recordingsRoots) ? deps.recordingsRoots : [];
  }

  latestRun(runs) {
    const at = (run) => new Date(run.updatedAt || run.finishedAt || run.createdAt || 0).getTime();
    return [...(runs || [])].sort((a, b) => at(a) - at(b)).at(-1) || null;
  }

  recentIdeaDraft(ideas) {
    const at = (draft) => new Date(draft.updatedAt || draft.createdAt || 0).getTime();
    const latest = [...(ideas || [])].sort((a, b) => at(a) - at(b)).at(-1) || null;
    // 古い下書きを「今回の学び」と偽らない: 直近24時間の記録だけ採用する
    return latest && Date.now() - at(latest) < 86400000 ? latest : null;
  }

  findRecordings(sinceMs) {
    if (!sinceMs) return [];
    const found = [];
    for (const root of this.recordingsRoots) {
      let names = [];
      try { names = fs.readdirSync(root); } catch (_) { continue; }
      for (const name of names) {
        if (!/\.(webm|mp4|mov)$/i.test(name)) continue;
        const file = path.join(root, name);
        try { if (fs.statSync(file).mtimeMs >= sinceMs) found.push(file); } catch (_) {}
      }
    }
    return found.sort().slice(-3);
  }

  buildLearnings({ run, tasks, draft }) {
    const learnings = [];
    if (run) {
      learnings.push(`Run ${run.id} → ${run.status}${run.assignments?.length ? `（${run.assignments.length} specialists）` : ''}`);
      for (const a of run.assignments || []) {
        if (['failed', 'blocked'].includes(String(a.status))) learnings.push(`⚠ ${a.provider || 'specialist'}: assignment ${a.status}`);
      }
    }
    for (const task of (tasks || []).filter((t) => t.error).slice(-4)) {
      learnings.push(`⚠ ${task.provider || 'task'}: ${String(task.error).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    if (draft) {
      const add = (label, list) => (Array.isArray(list) ? list : []).slice(0, 3)
        .forEach((v) => learnings.push(`${label}: ${String(v).replace(/\s+/g, ' ').slice(0, 120)}`));
      add('アイデア', draft.ideas); add('決定', draft.decisions);
      add('未解決', draft.openQuestions); add('TODO', draft.todos);
    }
    return learnings.slice(0, 12);
  }

  toMarkdown(report) {
    const modelRow = (m) => `| ${m.label} | ${m.tokensUsed} | ${m.tokensSaved} | ${m.savedPct == null ? '実測なし' : `${m.savedPct}%`} |`;
    return [
      `# タスク完了レポート — ${report.goal}`,
      '',
      `- 生成: ${report.generatedAt}`,
      `- Run: ${report.run ? `${report.run.id}（${report.run.status}）` : '記録なし'}`,
      '',
      '## ① できたもの（フライヤー）',
      report.screenshotPath ? `- 実際に動いている画面: ![screenshot](${report.screenshotPath})` : '- スクリーンショット: 撮影なし（メインウィンドウ未起動/Electron外）',
      report.previewUrl ? `- 生成物プレビュー（稼働中）: ${report.previewUrl}` : '- 生成物プレビュー: 停止中',
      report.recordings.length ? `- 該当ランの録画: ${report.recordings.join(' , ')}` : '- 録画: 該当ランの録画なし',
      '',
      '## ② かかった時間とトークン消費',
      `- 所要時間: ${report.durationLabel || '実測なし'}`,
      `- 総トークン: used ${report.totals.tokensUsed} / saved ${report.totals.tokensSaved}`,
      `- 総節約%: ${report.totals.savedPct == null ? '実測なし' : `${report.totals.savedPct}%`}`,
      '',
      '## ③ モデル別ユーセージと節約（saved/(saved+used)・used=0は実測なし）',
      '| モデル | used tok | saved tok | 節約% |',
      '| --- | --- | --- | --- |',
      ...report.models.map(modelRow),
      '',
      '## ④ 学んだこと',
      ...(report.learnings.length ? report.learnings.map((l) => `- ${l}`) : ['- 記録なし']),
      '',
    ].join('\n');
  }

  async build(detail = {}) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const shotsDir = path.join(this.reportsRoot, 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });

    const runs = await safeCall(this.deps.listRuns, []);
    const tasks = await safeCall(this.deps.listTasks, []);
    const snapshot = await safeCall(this.deps.getModelSnapshot, null) || { models: [], totals: {} };
    const ideas = await safeCall(this.deps.getIdeas, []);
    let preview = { running: false };
    try { preview = (typeof this.deps.getPreviewStatus === 'function' && this.deps.getPreviewStatus()) || preview; } catch (_) {}

    const run = this.latestRun(runs);
    const startedMs = run?.startedAt ? new Date(run.startedAt).getTime() : 0;
    const endedMs = run?.finishedAt ? new Date(run.finishedAt).getTime()
      : (run?.updatedAt ? new Date(run.updatedAt).getTime() : 0);
    const durationMs = startedMs && endedMs ? Math.max(0, endedMs - startedMs) : 0;
    const goal = String(run?.promptSpec?.goal || run?.prompt || detail.goal || '直近のrun記録なし').replace(/\s+/g, ' ').slice(0, 160);

    // モデル別実測（model-status-store snapshot 由来。無い行は0=実測なし表示）
    const byId = new Map((snapshot.models || []).map((m) => [m.id, m]));
    const models = REPORT_MODELS.map(({ id, label, primary }) => {
      const metrics = byId.get(id)?.metrics || {};
      const used = Number(metrics.tokensUsed || 0);
      const saved = Number(metrics.tokensSaved || 0);
      return { id, label, primary, tokensUsed: used, tokensSaved: saved, savedPct: savedPct(used, saved) };
    });
    const totalsUsed = Number(snapshot.totals?.tokensUsed || 0);
    const totalsSaved = Number(snapshot.totals?.tokensSaved || 0);

    // スクリーンショット（Electron外/ウィンドウ無しでは captureWindow が null → スキップ）
    let screenshotPath = null;
    try {
      const png = typeof this.deps.captureWindow === 'function' ? await this.deps.captureWindow() : null;
      if (png && png.length) {
        screenshotPath = path.join(shotsDir, `shot-${ts}.png`);
        fs.writeFileSync(screenshotPath, png);
      }
    } catch (_) { screenshotPath = null; }

    const report = {
      id: `report-${ts}`,
      generatedAt: now.toISOString(),
      progress: Number(detail.progress || 0) || null,
      goal,
      run: run ? { id: run.id, status: run.status, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
        assignments: (run.assignments || []).map((a) => ({ provider: a.provider, status: a.status })) } : null,
      durationMs: durationMs || null,
      durationLabel: fmtMs(durationMs),
      models,
      totals: { tokensUsed: totalsUsed, tokensSaved: totalsSaved, savedPct: savedPct(totalsUsed, totalsSaved) },
      screenshotPath,
      previewUrl: preview.running && preview.url ? String(preview.url) : null,
      recordings: this.findRecordings(startedMs ? startedMs - 60000 : 0),
      learnings: this.buildLearnings({ run, tasks, draft: this.recentIdeaDraft(ideas) }),
    };
    report.mdPath = path.join(this.reportsRoot, `${report.id}.md`);
    report.jsonPath = path.join(this.reportsRoot, `${report.id}.json`);
    fs.writeFileSync(report.mdPath, this.toMarkdown(report));
    fs.writeFileSync(report.jsonPath, JSON.stringify(report, null, 2));
    return report;
  }
}

module.exports = { TaskReportBuilder };
