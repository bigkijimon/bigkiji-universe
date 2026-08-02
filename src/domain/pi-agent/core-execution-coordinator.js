'use strict';

const { EventEmitter } = require('events');
const knowledge = require('./pi-knowledge-orchestrator');
const { ModelCapabilityRegistry } = require('./model-capability-registry');
const { aggregateDisclosureHash } = require('../pi-core/security/disclosure-manifest');
const { SkillRegistry } = require('./skill-registry');
const { resolveModel } = require('./model-router');
const { CircuitBreaker } = require('./circuit-breaker');
const deliberate = require('./deliberation');

const ROLE_BLUEPRINT = Object.freeze([
  { role: 'facilitator', agent: 'Facilitator-Pi', provider: 'gemini', title: 'Requirements and acceptance trace', write: false },
  { role: 'leader', agent: 'Lead-Pi', provider: 'claude-code', title: 'Architecture, system implementation and integration', write: true },
  { role: 'ui', agent: 'Design-Pi', provider: 'codex', title: 'UI/UX and interactive frontend implementation', write: true },
  { role: 'debug', agent: 'Debug-Pi', provider: 'glm', title: 'Diagnostics, tests and failure analysis', write: false },
  { role: 'context', agent: 'Context-Pi', provider: 'qwen', title: 'Local context pruning and continuity check', write: false },
]);

// Which roles survive when maxAgents is smaller than the selection. The independent
// checker outranks the specialists, because a run that verifies nothing is not a
// cheaper run — it is an unverified one.
const ROLE_PRIORITY = Object.freeze(['leader', 'debug', 'ui', 'facilitator', 'context']);

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
    skills = new SkillRegistry(), memory = new deliberate.DeliberationMemory({ root: knowledge.ROOT }),
    available = null, breaker = new CircuitBreaker() } = {}) {
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
    this.memory = memory;
    // Scoring never knew whether a provider could actually start. A provider with no
    // credential still won its role and then died at spawn, which costs a full
    // plan-approve-fail-repair cycle to discover something knowable up front.
    this.isAvailable = typeof available === 'function' ? available : () => true;
    // A provider that has just said "not now" is skipped for the length of its
    // cooldown instead of being re-offered by every assignment in the run. It
    // changes who gets proposed and nothing else: the approval gate below is
    // untouched, and a run whose provider was swapped still stops and waits for
    // the owner exactly as it did before.
    this.breaker = breaker;
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
    run.maxAgents = Math.max(1, Math.min(5, Number(routing.maxAgents || 3)));
    run.roleContext = { ...routing, qualityGate: settings.quality?.gate, facilitationComplete: !!promptSpec };
    run.explicitPlanHash = planHash || null;
    this.runs.set(run.id, run);

    // Think before spending. A recalled plan skips the discussion entirely, which is
    // the owner's deduplication rule applied before any money moves rather than after.
    const lenses = Math.max(0, Math.min(deliberate.LENSES.length, Number(routing.deliberationLenses ?? 2)));
    const recalled = lenses >= 2 ? this.memory.lookup(text) : null;
    if (recalled) run.deliberation = recalled;
    if (!recalled && deliberate.needed(text, { lenses })) this._planDeliberation(run, lenses);
    else this._planExecution(run);

    this._emit(run, 'planned');
    knowledge.recordEvent(run.id, { type: 'run-planned', status: run.status, provider: run.leader,
      evidence: `${run.stage}: ${run.assignments.length} assignments${recalled ? ` · plan recalled (${recalled.similarity} similar)` : ''}` });
    return publicRun(run);
  }

  // Independent proposals, read-only, one provider each. They are approved like any
  // other work: a discussion still costs tokens, so it does not happen behind the
  // owner's back.
  _planDeliberation(run, lenses) {
    run.stage = 'deliberation';
    const used = new Set();
    const chosen = deliberate.LENSES.slice(0, lenses).map((lens) => {
      const candidates = [lens.provider, ...(FALLBACKS[lens.provider] || [])].filter((item) => !used.has(item));
      const provider = this._pick(lens.role, candidates.length ? candidates : [lens.provider]);
      used.add(provider);
      return { ...lens, provider, model: resolveModel(provider, `${run.prompt} ${lens.title}`, lens.role) };
    });
    run.planHash = knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision, stage: 'deliberation',
      lenses: chosen.map(({ id, provider, model }) => ({ id, provider, model })) }));
    run.assignments = chosen.map((lens, index) => {
      const task = this.taskRunner.plan({
        id: `${run.id}-lens-${lens.id}`, provider: lens.provider, model: lens.model, cwd: run.cwd, planHash: run.planHash,
        prompt: this._lensPrompt(run, lens),
        metadata: { runId: run.id, role: lens.role, agent: `${lens.id}-lens`, title: lens.title, write: false, order: index, lens: lens.id },
      });
      this.taskToRun.set(task.id, run.id);
      return { taskId: task.id, role: lens.role, agent: `${lens.id}-lens`, provider: lens.provider, model: lens.model,
        title: lens.title, write: false, lens: lens.id, status: task.status, fallbackIndex: 0,
        disclosureHash: task.disclosure?.disclosureHash || '' };
    });
    this._seal(run);
  }

  _planExecution(run) {
    run.stage = 'execution';
    const selectedRoles = selectRoles(run.prompt, run.roleContext);
    // maxAgents used to cut in declaration order, so the read-only checker that strict
    // mode adds unconditionally was the first thing dropped when the cap bit. Keep by
    // importance; emit in declaration order.
    const kept = new Set(ROLE_BLUEPRINT.filter((item) => selectedRoles.has(item.role))
      .sort((a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role))
      .slice(0, run.maxAgents).map((item) => item.role));
    const blueprint = ROLE_BLUEPRINT.filter((item) => kept.has(item.role)).map((item) => {
      // Provider first, then tier. Doing it in this order means a fallback to GLM
      // cannot carry a Claude model id along with it.
      const provider = this._pick(item.role, [item.provider, ...(FALLBACKS[item.provider] || [])]);
      return { ...item, provider, model: resolveModel(provider, `${run.prompt} ${item.title}`, item.role) };
    });
    run.planHash = (run.explicitPlanHash && run.revision === 1) ? run.explicitPlanHash
      : knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision, deliberation: run.deliberation?.steps || [],
        assignments: blueprint.map(({ role, provider, model, write, title }) => ({ role, provider, model, write, title })) }));
    run.assignments = blueprint.map((item, index) => {
      const task = this.taskRunner.plan({
        id: `${run.id}-${item.role}`,
        provider: item.provider,
        model: item.model,
        prompt: this._assignmentPrompt(run, item),
        cwd: run.cwd,
        planHash: run.planHash,
        metadata: { runId: run.id, role: item.role, agent: item.agent, title: item.title, write: item.write, order: index },
      });
      this.taskToRun.set(task.id, run.id);
      return { taskId: task.id, role: item.role, agent: item.agent, provider: item.provider, model: item.model, title: item.title,
        write: item.write, status: task.status, fallbackIndex: 0, disclosureHash: task.disclosure?.disclosureHash || '' };
    });
    this._seal(run);
  }

  // Prefer a provider that can actually start. If none of the candidates can, fall back
  // to scoring alone rather than refusing to plan — an unstartable assignment that
  // fails loudly is more useful than a run that never appears.
  _pick(role, candidates) {
    const startable = candidates.filter((provider) => this.isAvailable(provider));
    return this.registry.choose(role, startable.length ? startable : candidates) || candidates[0];
  }

  _seal(run) {
    run.disclosures = run.assignments.map((assignment) => this.taskRunner.get(assignment.taskId)?.disclosure).filter(Boolean);
    run.disclosureHash = aggregateDisclosureHash(run.disclosures);
    // Owner policy is intentionally stronger than executionMode: every mutation-capable run waits here.
    run.status = run.assignments.some((item) => item.status === 'blocked') ? 'SECURITY_BLOCKED' : 'AWAITING_APPROVAL';
    run.updatedAt = new Date().toISOString();
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
    // taskRunner.abort() emits 'task' synchronously, so _ingestTask runs mid-loop. On the
    // last assignment the run looks terminal, and a deliberation stage would conclude —
    // planning a fresh set of execution tasks and broadcasting an approval prompt for the
    // run the owner just killed. Mark the intent before touching any task.
    run.aborting = true;
    for (const assignment of run.assignments) {
      const task = this.taskRunner.get(assignment.taskId);
      if (task && ['running', 'queued', 'awaiting_approval'].includes(task.status)) this.taskRunner.abort(task.id);
    }
    run.status = 'FAILED'; run.error = 'aborted by owner'; run.updatedAt = new Date().toISOString();
    this._emit(run, 'abort'); return publicRun(run);
  }

  _lensPrompt(run, lens) {
    let skillBrief = '';
    try { skillBrief = this.skills.brief(`${run.prompt} ${lens.title}`); } catch (_) {}
    return `BIGKIJI DELIBERATION ${run.id}\nOwner goal: ${run.prompt}\n` +
      `You are the ${lens.id.toUpperCase()} lens. ${lens.instruction}\n` +
      'This is read-only. Do not edit files, run builds, or start anything. Other lenses are answering the same question ' +
      'independently and you cannot see them — do not hedge toward what you think they will say.\n' +
      'Answer as a numbered list of 3-6 imperative steps, one line each, and nothing else.' +
      (skillBrief ? `\n\n${skillBrief}\n` : '');
  }

  _assignmentPrompt(run, item) {
    // Text only. This injects guidance, never filesystem access, so the sandbox
    // boundary is exactly what it was before the skill registry existed.
    let skillBrief = '';
    try { skillBrief = this.skills.brief(`${run.prompt} ${item.title}`); } catch (_) {}
    const plan = deliberate.brief(run.deliberation);
    const suffix = `${plan ? `\n\n${plan}\n` : ''}${skillBrief ? `\n\n${skillBrief}\n` : ''}`;
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
    assignment.status = task.status; assignment.provider = task.provider; assignment.model = task.model || '';
    assignment.updatedAt = task.updatedAt;
    if (task.error) assignment.error = task.error;
    // Only work that actually ran teaches the router anything. `blocked` is a security
    // decision or an owner abort — the sandbox refused it, a credential was missing, or
    // the owner killed the run — and none of that is a fact about how well the provider
    // does its job. Recording it as a failure is what left this registry holding 207
    // samples with zero successes and zero latency: every provider drifted toward the
    // penalty cap, and the router was choosing between numbers that measured nothing.
    // `learned` is set only when something is recorded, so a blocked task that is later
    // retried still contributes its real result.
    if (['completed', 'failed'].includes(task.status) && !assignment.learned) {
      assignment.learned = true;
      const durationMs = task.startedAt ? Math.max(0, new Date(task.finishedAt || task.updatedAt).getTime() - new Date(task.startedAt).getTime()) : 0;
      const ok = task.status === 'completed';
      const reason = ok ? '' : String(task.failureReason || '');
      const tripped = this.breaker.record(task.provider, { ok, reason, retryAfterMs: task.retryAfterMs || 0 });
      if (tripped?.opened) {
        assignment.throttled = reason;
        knowledge.recordEvent(run.id, { type: 'provider-cooldown', status: run.status, provider: task.provider,
          evidence: `${reason} — skipping ${task.provider} for ${Math.round(tripped.cooldownMs / 1000)}s` });
        this.emit('cooldown', { runId: run.id, ...tripped });
      }
      const lesson = this.registry.record({ provider: task.provider, model: task.model, role: assignment.role,
        ok: task.status === 'completed', durationMs, tokens: task.tokens, reason });
      // Surface what PiAgent learned. A routing change the owner cannot see is
      // indistinguishable from the router being erratic.
      if (lesson) {
        run.lessons = [...(run.lessons || []), lesson].slice(-12);
        knowledge.recordEvent(run.id, { type: lesson.throttled ? 'routing-throttled' : 'routing-lesson', status: run.status, provider: task.provider,
          evidence: lesson.throttled
            ? `${lesson.role}: ${lesson.note}`
            : `${lesson.role}: ${lesson.reason} → penalty ${lesson.previous} → ${lesson.penalty}` });
        this.emit('lesson', { runId: run.id, ...lesson });
      }
    }
    run.updatedAt = new Date().toISOString();
    const terminal = run.assignments.every((item) => ['completed', 'failed', 'blocked'].includes(item.status));
    if (!terminal) { this._emit(run, 'assignment'); return; }
    if (run.aborting || ['FAILED', 'COMPLETED'].includes(run.status)) { this._emit(run, 'assignment'); return; }
    if (run.stage === 'deliberation') { this._concludeDeliberation(run); return; }
    const failed = run.assignments.filter((item) => item.status !== 'completed');
    if (failed.length && run.repairCycle < run.maxRepairCycles) {
      run.status = 'REPAIRING'; run.repairCycle += 1; this._emit(run, 'repair');
      let restarted = 0;
      for (const item of failed) restarted += this._fallback(run, item) ? 1 : 0;
      if (restarted) {
        run.revision += 1;
        run.planHash = knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision,
          assignments: run.assignments.map(({ role, provider, model, write, title }) => ({ role, provider, model, write, title })) }));
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

  // Merge the proposals and move to the real work. A discussion that produced nothing
  // usable degrades to executing without it — the owner asked for a better plan, not
  // for a gate that can strand the task.
  _concludeDeliberation(run) {
    const proposals = run.assignments.map((assignment) => {
      const task = this.taskRunner.get(assignment.taskId);
      return task?.status === 'completed' && task.output ? { lens: assignment.lens, provider: assignment.provider, text: task.output } : null;
    }).filter(Boolean);
    const plan = deliberate.consolidate(proposals);
    if (plan.steps.length) {
      run.deliberation = { ...plan, source: 'live' };
      this.memory.store(run.prompt, plan);
    } else {
      run.deliberation = null;
      run.notes = [...(run.notes || []), `Deliberation returned no usable steps from ${run.assignments.length} lenses; proceeding without it.`];
    }
    run.revision += 1;
    knowledge.recordEvent(run.id, { type: 'deliberated', status: run.status, provider: run.leader,
      evidence: plan.steps.length ? `${plan.steps.length} merged steps from ${plan.lenses} lenses` : 'no usable proposals' });
    this._planExecution(run);
    this._emit(run, 'deliberated');
  }

  _fallback(run, assignment) {
    const candidates = FALLBACKS[assignment.provider] || [];
    // Walk past anyone in cooldown. Without this, three assignments failing on
    // the same exhausted quota each propose the same next provider, the owner
    // approves three repairs, and all three hit the same wall — which is what
    // today's Gemini outage looked like from the inside.
    //
    // `fallbackIndex` only advances when a provider is actually taken. Advancing
    // it past one that was merely cooling burned the position permanently: with a
    // one-entry chain, a sixty second cooldown meant the assignment could never be
    // repaired again, even an hour later.
    let next = null; const skipped = [];
    for (let index = assignment.fallbackIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!this.breaker.allow(candidate)) {
        skipped.push(`${candidate} (${Math.round(this.breaker.retryInMs(candidate) / 1000)}s)`);
        continue;
      }
      next = candidate; assignment.fallbackIndex = index + 1; break;
    }
    if (skipped.length) {
      knowledge.recordEvent(run.id, { type: 'fallback-skipped', status: run.status, provider: assignment.provider,
        evidence: `in cooldown: ${skipped.join(', ')}` });
    }
    if (!next) return false;
    const oldTask = this.taskRunner.get(assignment.taskId);
    const model = resolveModel(next, `${run.prompt} ${assignment.title}`, assignment.role);
    const task = this.taskRunner.plan({
      id: `${assignment.taskId}-repair-${run.repairCycle}`,
      provider: next, model, cwd: run.cwd, planHash: run.planHash,
      prompt: `${oldTask?.prompt || run.prompt}\nPrevious provider failed: ${knowledge.cleanText(oldTask?.error, 500)}\nContinue only unfinished work and verify the repair.`,
      metadata: { ...(oldTask?.metadata || {}), runId: run.id, repairCycle: run.repairCycle, fallbackFrom: assignment.provider },
    });
    this.taskToRun.set(task.id, run.id); assignment.taskId = task.id; assignment.provider = next; assignment.model = model; assignment.status = task.status;
    assignment.disclosureHash = task.disclosure?.disclosureHash || '';
    // The replacement provider has to be judged on its own result; leaving this set
    // meant every fallback ran unrecorded, so the registry only ever learned about
    // first attempts.
    assignment.learned = false;
    return true;
  }

  _emit(run, kind) { this.emit('run', { kind, ...publicRun(run) }); }
}

module.exports = { CoreExecutionCoordinator, ROLE_BLUEPRINT, FALLBACKS, selectRoles };
