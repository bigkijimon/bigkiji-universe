'use strict';

// D1/D2: Pi Coreの作業状態を短く持ち、MakerとCheckerの責務を分離する。
// 状態はモデルの会話履歴ではなくファイルに残すので、モデル降格・再起動後にも使える。
const crypto = require('crypto');

const TASK_PATTERN = /作成|実装|構築|調査|分析|修正|設計|生成|レポート|まとめ|移行|検証|テスト|リファクタ|自動化|build|implement|creat|research|analy|fix|design|generat|report|refactor|migrat|test|audit|writ|develop|automat/i;

function isSubstantiveTask(text) {
  // 短い「実装して」「調査して」も統治対象。挨拶などの極短文は除外する。
  return String(text || '').trim().length >= 12 && TASK_PATTERN.test(String(text));
}

function taskId(text) {
  return crypto.createHash('sha1').update(`${Date.now()}:${text}`).digest('hex').slice(0, 12);
}

function makeMakerPrompt(ownerText, id) {
  return `[MAKER CONTRACT id=${id}]
You are the Maker. Complete the owner's task with the minimum necessary changes.
Before acting, state: (1) purpose/background, (2) authoritative map or source to inspect, (3) deliverable path, (4) verification method, and (5) concise final report format.
Do not publish, spend money, expose secrets, or make destructive changes without the owner's explicit approval.
At completion, report: conclusion, evidence (paths/commands/results), residual risks, and next action. Do not claim success without evidence.
[/MAKER CONTRACT]

${ownerText}`;
}

function startTask(ownerText, kind = 'maker') {
  const id = taskId(ownerText);
  return { id, kind, ownerText: String(ownerText), startedAt: new Date().toISOString() };
}

function compact(text, limit = 700) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
}

function inferNextAction({ answer, toolErrors, checked }) {
  if (toolErrors > 0) return 'Resolve the recorded tool errors before treating this task as complete.';
  if (checked) return 'Present the checker result to the owner and wait for a decision on any residual risk.';
  return 'Run the independent Checker review; do not publish or make further changes until it reports evidence.';
}

function makeState(task, result) {
  return {
    version: 1,
    taskId: task.id,
    kind: task.kind,
    task: compact(task.ownerText, 900),
    answer: compact(result.answer, 900),
    model: result.model,
    touched: [...new Set(result.touched || [])],
    tokens: result.turn || null,
    toolErrors: result.toolErrors || 0,
    completedAt: new Date().toISOString(),
    nextAction: inferNextAction({ ...result, checked: task.kind === 'checker' }),
  };
}

function makeResumeContext(state) {
  if (!state || !state.task) return '';
  return `[D1 CONTINUITY SNAPSHOT]
Previous task: ${compact(state.task, 700)}
Previous result: ${compact(state.answer, 700)}
Next action: ${compact(state.nextAction, 300)}
Continue only the unfinished work. Do not repeat completed work.
[/D1 CONTINUITY SNAPSHOT]

`;
}

function makeCheckerPrompt(state) {
  return `[CHECKER CONTRACT task=${state.taskId}]
You are the independent Checker, not the Maker. Inspect the Maker's claimed result below.
Use read-only inspection and safe verification commands only. Do NOT edit files, publish, spend money, or change configuration.
Return exactly: conclusion; evidence with paths/commands/results; blockers or residual risks; and the next action.
Mark the work VERIFIED only if the evidence independently supports the claim.

Maker task: ${state.task}
Maker result: ${state.answer}
Touched roles: ${(state.touched || []).join(', ') || 'none'}
Tool errors: ${state.toolErrors || 0}
[/CHECKER CONTRACT]`;
}

module.exports = {
  isSubstantiveTask, makeMakerPrompt, startTask, makeState, makeResumeContext, makeCheckerPrompt,
};
