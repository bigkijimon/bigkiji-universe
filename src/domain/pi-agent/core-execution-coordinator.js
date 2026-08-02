'use strict';

const { EventEmitter } = require('events');
const knowledge = require('./pi-knowledge-orchestrator');
const { ModelCapabilityRegistry } = require('./model-capability-registry');
const { aggregateDisclosureHash } = require('../pi-core/security/disclosure-manifest');
const { SkillRegistry } = require('./skill-registry');

const ROLE_BLUEPRINT = Object.freeze([
  { role: 'facilitator', agent: 'Facilitator-Pi', provider: 'gemini', title: 'Requirements and acceptance trace', write: false },
  { role: 'leader', agent: 'Lead-Pi', provider: 'claude-code', title: 'Architecture, system implementation and integration', write: true },
  { role: 'ui', agent: 'Design-Pi', provider: 'codex', title: 'UI/UX and interactive frontend implementation', write: true },
  { role: 'debug', agent: 'Debug-Pi', provider: 'glm', title: 'Diagnostics, tests and failure analysis', write: false },
  { role: 'context', agent: 'Context-Pi', provider: 'qwen', title: 'Local context pruning and continuity check', write: false },
]);

const FALLBACKS = Object.freeze({
  'claude-code': ['glm', 'codex', 'qwen'],
  codex: ['gemini', 'claude-code', 'glm', 'qwen'],
  gemini: ['qwen', 'glm', 'codex'],
  glm: ['codex', 'qwen'],
  qwen: ['glm'],
});

function selectRoles(prompt, routing = {}) {
  const text = String(prompt || '').toLowerCase();
  const roles = new Set(['leader']);
  if (/(?:ui|ux|3d|three|canvas|shader|visual|design|hud|css|html|react|画面|表示|デザイン|ゲーム|シューティング)/i.test(text)) roles.add('ui');
  if (/(?:debug|test|verify|quality|regression|build|ipc|routing|デバッグ|検証|品質|修正)/i.test(text)) roles.add('debug');
  if (text.length > 12000 || routing.forceLocalContext === true) roles.add('context');
  if (/(?:research|compare models|requirements interview|調査|要件整理)/i.test(text) && routing.facilitationComplete !== true) roles.add('facilitator');
  // Strict quality uses one independent checker, but never wakes every model by default.
  if ((routing.qualityGate || 'strict') === 'strict') roles.add('debug');
  return roles;
}

function runId(prompt) { return `run-${Date.now().toString(36)}-${knowledge.hash(prompt)}`; }
function publicRun(run) {
  const { prompt, ...safe } = run;
  return { ...safe, promptPreview: String(prompt || '').slice(0, 180) };
}

class CoreExecutionCoordinator extends EventEmitter {
  constructor({ taskRunner, settingsProvider = () => ({}), preview = null, registry = new ModelCapabilityRegistry(),
    skills = new SkillRegistry() } = {}) {
    super();
    if (!taskRunner) throw new Error('CoreExecutionCoordinator requires TaskRunner');
    this.taskRunner = taskRunner;
    // The owner's skills are their record of what already went wrong. Indexing them here
    // means every specialist gets the relevant standing rules instead of rediscovering
    // them: one sub-agent burned 428s of GPU on a workflow the skill file already ruled
    // out, and another was one step from sending audio to a cloud endpoint that a skill
    // file explicitly warns is the misleading default.
    this.skills = skills;
    try { this.skills.scan(); } catch (_) {}
    this.settingsProvider = settingsProvider;
    this.preview = preview;
    this.registry = registry;
    this.runs = new Map();
    this.taskToRun = new Map();
    taskRunner.on('task', (task) => this._ingestTask(task));
  }

  snapshot() { return [...this.runs.values()].map(publicRun); }
  get(id) { const run = this.runs.get(id); return run ? publicRun(run) : null; }

  submit({ prompt, planHash = null, promptSpec = null, cwd, mode } = {}) {
    const text = knowledge.cleanText(prompt || promptSpec?.goal, 20000);
    if (!text) throw new Error('Run prompt is required');
    const settings = this.settingsProvider() || {};
    const routing = settings.routing || {};
    const previewGame = /(?:3d|３d).*(?:shoot|シューティング)|(?:shoot|シューティング).*(?:game|ゲーム)/i.test(text);
    const run = {
      id: runId(text), prompt: text, planHash, promptSpec, previewGame,
      cwd: previewGame && this.preview?.root ? this.preview.root : (cwd || this.taskRunner.cwd),
      mode: ['plan', 'auto', 'manual'].includes(mode) ? mode : (routing.executionMode || 'plan'),
      status: 'PLANNING', leader: routing.sessionLeader === 'auto' || !routing.sessionLeader ? 'claude-code' : routing.sessionLeader,
      assignments: [], repairCycle: 0, maxRepairCycles: Number(settings.quality?.maxRepairCycles || 3),
      revision: 1, requestedMode: ['plan', 'auto', 'manual'].includes(mode) ? mode : (routing.executionMode || 'plan'),
      directiveKeys: [],
      quality: { gate: settings.quality?.gate || 'strict', makerCheckerSeparated: true, checks: [] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const maxAgents = Math.max(1, Math.min(5, Number(routing.maxAgents || 3)));
    const selectedRoles = selectRoles(text, { ...routing, qualityGate: settings.quality?.gate, facilitationComplete: !!promptSpec });
    const blueprint = ROLE_BLUEPRINT.filter((item) => selectedRoles.has(item.role)).slice(0, maxAgents).map((item) => ({ ...item,
      provider: this.registry.choose(item.role, [item.provider, ...(FALLBACKS[item.provider] || [])]) || item.provider }));
    run.planHash = planHash || knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision,
      assignments: blueprint.map(({ role, provider, write, title }) => ({ role, provider, write, title })) }));
    run.assignments = blueprint.map((item, index) => {
      const task = this.taskRunner.plan({
        id: `${run.id}-${item.role}`,
        provider: item.provider,
        prompt: this._assignmentPrompt(run, item),
        cwd: run.cwd,
        planHash: run.planHash,
        metadata: { runId: run.id, role: item.role, agent: item.agent, title: item.title, write: item.write, order: index },
      });
      this.taskToRun.set(task.id, run.id);
      return { taskId: task.id, role: item.role, agent: item.agent, provider: item.provider, title: item.title,
        write: item.write, status: task.status, fallbackIndex: 0, disclosureHash: task.disclosure?.disclosureHash || '' };
    });
    run.disclosures = run.assignments.map((assignment) => this.taskRunner.get(assignment.taskId)?.disclosure).filter(Boolean);
    run.disclosureHash = aggregateDisclosureHash(run.disclosures);
    // Owner policy is intentionally stronger than executionMode: every mutation-capable run waits here.
    run.status = run.assignments.some((item) => item.status === 'blocked') ? 'SECURITY_BLOCKED' : 'AWAITING_APPROVAL';
    this.runs.set(run.id, run);
    this._emit(run, 'planned');
    knowledge.recordEvent(run.id, { type: 'run-planned', status: run.status, provider: run.leader, evidence: `${run.assignments.length} specialist assignments` });
    return publicRun(run);
  }

  approve(id, expected = {}) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    if (expected.revision != null && Number(expected.revision) !== run.revision) throw new Error('STALE_RUN_REVISION');
    if (expected.planHash && String(expected.planHash) !== run.planHash) throw new Error('STALE_PLAN_HASH');
    if (!expected.disclosureHash || String(expected.disclosureHash) !== run.disclosureHash) throw new Error('STALE_DISCLOSURE_HASH');
    if (expected.idempotencyKey && run.directiveKeys.includes(String(expected.idempotencyKey))) return publicRun(run);
    if (run.status !== 'AWAITING_APPROVAL') return publicRun(run);
    if (expected.idempotencyKey) run.directiveKeys.push(String(expected.idempotencyKey));
    run.status = 'EXECUTING'; run.startedAt = run.startedAt || new Date().toISOString(); run.updatedAt = new Date().toISOString();
    this._emit(run, 'dispatch');
    for (const assignment of run.assignments) {
      const task = this.taskRunner.get(assignment.taskId);
      if (task?.status === 'awaiting_approval') this.taskRunner.approve(task.id, { disclosureHash: task.disclosure?.disclosureHash });
    }
    return publicRun(run);
  }

  abort(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    if (['FAILED', 'COMPLETED'].includes(run.status)) return publicRun(run);
    for (const assignment of run.assignments) {
      const task = this.taskRunner.get(assignment.taskId);
      if (task && ['running', 'queued', 'awaiting_approval'].includes(task.status)) this.taskRunner.abort(task.id);
    }
    run.status = 'FAILED'; run.error = 'aborted by owner'; run.updatedAt = new Date().toISOString();
    this._emit(run, 'abort'); return publicRun(run);
  }

  _assignmentPrompt(run, item) {
    // Text only. This injects guidance, never filesystem access, so the sandbox
    // boundary is exactly what it was before the skill registry existed.
    let skillBrief = '';
    try { skillBrief = this.skills.brief(`${run.prompt} ${item.title}`); } catch (_) {}
    const suffix = skillBrief ? `\n\n${skillBrief}\n` : '';
    const shared = `BIGKIJI RUN ${run.id}\nOwner goal: ${run.prompt}\n` +
      `You are ${item.agent}, specialist role=${item.role}. ${item.title}.\n` +
      `PiAgent selected this assignment for this run. Work only inside the configured sandbox. Never expose secrets, publish, delete unrelated data, or change billing. Exit immediately after the assignment; do not remain resident.\n`;
    if (!item.write) return `${shared}This is an independent read-only assignment. Return concise findings and evidence; do not edit files.${suffix}`;
    if (item.role === 'ui') return `${shared}Own frontend, interaction, accessibility and visual quality. ${run.previewGame ? 'For this preview game, edit index.html and app.css only; do not edit game.js.' : 'Avoid system/backend files unless explicitly required.'} Run focused verification.${suffix}`;
    return `${shared}Own architecture, IPC, services and integration. ${run.previewGame ? 'For this preview game, edit game.js only; do not edit index.html or app.css.' : 'Avoid visual styling files assigned to Design-Pi.'} Run focused verification.${suffix}`;
  }

  _ingestTask(task) {
    const id = this.taskToRun.get(task.id) || task.metadata?.runId;
    const run = id && this.runs.get(id);
    if (!run) return;
    const assignment = run.assignments.find((item) => item.taskId === task.id);
    if (!assignment) return;
    assignment.status = task.status; assignment.provider = task.provider; assignment.updatedAt = task.updatedAt;
    if (task.error) assignment.error = task.error;
    if (['completed', 'failed', 'blocked'].includes(task.status) && !assignment.learned) {
      assignment.learned = true; this.registry.record({ provider: task.provider, role: assignment.role, ok: task.status === 'completed',
        durationMs: task.startedAt ? Math.max(0, new Date(task.finishedAt || task.updatedAt).getTime() - new Date(task.startedAt).getTime()) : 0,
        tokens: task.tokens });
    }
    run.updatedAt = new Date().toISOString();
    const terminal = run.assignments.every((item) => ['completed', 'failed', 'blocked'].includes(item.status));
    if (!terminal) { this._emit(run, 'assignment'); return; }
    const failed = run.assignments.filter((item) => item.status !== 'completed');
    if (failed.length && run.repairCycle < run.maxRepairCycles) {
      run.status = 'REPAIRING'; run.repairCycle += 1; this._emit(run, 'repair');
      let restarted = 0;
      for (const item of failed) restarted += this._fallback(run, item) ? 1 : 0;
      if (restarted) {
        run.revision += 1;
        run.planHash = knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision,
          assignments: run.assignments.map(({ role, provider, write, title }) => ({ role, provider, write, title })) }));
        run.disclosures = run.assignments.map((assignment) => this.taskRunner.get(assignment.taskId)?.disclosure).filter(Boolean);
        run.disclosureHash = aggregateDisclosureHash(run.disclosures);
        run.status = 'AWAITING_APPROVAL'; this._emit(run, 'repair-awaiting-approval'); return;
      }
    }
    run.status = failed.length ? 'FAILED' : 'VERIFYING';
    run.quality.checks = [
      { id: 'specialists', pass: !failed.length, evidence: `${run.assignments.length - failed.length}/${run.assignments.length} assignments completed` },
      { id: 'maker-checker', pass: run.assignments.some((item) => !item.write && item.status === 'completed'), evidence: 'Independent read-only checker assignment' },
    ];
    const verified = run.quality.checks.every((check) => check.pass);
    run.status = verified ? 'COMPLETED' : 'FAILED'; run.finishedAt = new Date().toISOString();
    knowledge.recordEvent(run.id, { type: 'run-finish', status: run.status, provider: run.leader,
      evidence: run.quality.checks.map((c) => `${c.id}:${c.pass}`).join(', ') });
    this._emit(run, 'finish');
  }

  _fallback(run, assignment) {
    const candidates = FALLBACKS[assignment.provider] || [];
    const next = candidates[assignment.fallbackIndex++] || null;
    if (!next) return false;
    const oldTask = this.taskRunner.get(assignment.taskId);
    const task = this.taskRunner.plan({
      id: `${assignment.taskId}-repair-${run.repairCycle}`,
      provider: next, cwd: run.cwd, planHash: run.planHash,
      prompt: `${oldTask?.prompt || run.prompt}\nPrevious provider failed: ${knowledge.cleanText(oldTask?.error, 500)}\nContinue only unfinished work and verify the repair.`,
      metadata: { ...(oldTask?.metadata || {}), runId: run.id, repairCycle: run.repairCycle, fallbackFrom: assignment.provider },
    });
    this.taskToRun.set(task.id, run.id); assignment.taskId = task.id; assignment.provider = next; assignment.status = task.status;
    assignment.disclosureHash = task.disclosure?.disclosureHash || '';
    return true;
  }

  _emit(run, kind) { this.emit('run', { kind, ...publicRun(run) }); }
}

module.exports = { CoreExecutionCoordinator, ROLE_BLUEPRINT, FALLBACKS, selectRoles };
