'use strict';

const { EventEmitter } = require('events');
const knowledge = require('./pi-knowledge-orchestrator');
const { ModelCapabilityRegistry } = require('./model-capability-registry');
const { aggregateDisclosureHash } = require('../pi-core/security/disclosure-manifest');
const { SkillRegistry } = require('./skill-registry');
const { resolveModel } = require('./model-router');
const { CircuitBreaker } = require('./circuit-breaker');
const { reviewResult } = require('./critique');
const { costOf, contextUse } = require('./pricing');
const { isolate, collectDiff, release } = require('./worktree');
const deliberate = require('./deliberation');

const ROLE_BLUEPRINT = Object.freeze([
  // GLM, not Gemini. Gemini's quota is limit:0 — a billing plan, not a key — so this
  // role could never actually run, and every run silently fell through the chain to
  // fill it. GLM-5.2 is the cheapest paid provider on the fleet ($1.4/$4.4) and this
  // role is read-only, which is the right shape for it.
  { role: 'facilitator', agent: 'Facilitator-Pi', provider: 'glm', title: 'Requirements and acceptance trace', write: false },
  { role: 'leader', agent: 'Lead-Pi', provider: 'claude-code', title: 'Architecture, system implementation and integration', write: true },
  { role: 'ui', agent: 'Design-Pi', provider: 'codex', title: 'UI/UX and interactive frontend implementation', write: true },
  // The owner asked for debugging to be owned by a model that is good at debugging.
  // It was on GLM, which ran with --no-tools: it could not read a file or run a test,
  // so "diagnostics, tests and failure analysis" was being done from the prompt text
  // alone. Claude Code has Read/Bash/Grep and is pinned to the Fable tier in
  // model-router.js for this role.
  { role: 'debug', agent: 'Debug-Pi', provider: 'claude-code', title: 'Diagnostics, tests and failure analysis', write: false },
  { role: 'context', agent: 'Context-Pi', provider: 'qwen', title: 'Local context pruning and continuity check', write: false },
]);

// Which roles survive when maxAgents is smaller than the selection. The independent
// checker outranks the specialists, because a run that verifies nothing is not a
// cheaper run — it is an unverified one.
const ROLE_PRIORITY = Object.freeze(['leader', 'debug', 'ui', 'facilitator', 'context']);

// Every chain ends local, and only local. The owner's rule: when billing limits a
// provider another paid one takes over, and only when none of them work does the
// work fall to Pi and Ollama.
//
// Two chains used to run the other way. `qwen: ['glm']` escalated a failure of the
// free local model to a paid one — a local failure is the floor, not a reason to
// spend. And `gemini: ['qwen', 'glm', 'codex']` tried local first and then climbed
// back up to paid, so an exhausted Gemini quota ended on Codex.
const FALLBACKS = Object.freeze({
  'claude-code': ['glm', 'codex', 'qwen'],
  codex: ['claude-code', 'glm', 'qwen'],
  gemini: ['glm', 'codex', 'qwen'],
  glm: ['codex', 'qwen'],
  qwen: [], // the floor: there is nothing cheaper or more available to climb to
});

// The provider that needs no key, no quota and no network.
const LOCAL_PROVIDER = 'qwen';
const PAID_PROVIDERS = new Set(['claude', 'claude-code', 'codex', 'gemini', 'glm']);

// The owner's working budget for one run, and how often it reports once it is past.
// Thirty minutes is a checkpoint, not a kill: see _reportProgress.
const RUN_BUDGET_MS = 30 * 60 * 1000;
const CHECKPOINT_MS = 10 * 60 * 1000;

// How long a plan is worth approving. The code it was planned against moves.
const APPROVAL_TTL_MS = 60 * 60 * 1000;

/**
 * Two ways of typing the same request compare equal.
 *
 * Whitespace goes entirely rather than collapsing: the owner writes Japanese, where
 * a stray space between words is the most likely difference between two attempts at
 * the same sentence, and "READMEのタイポを直して" against "README のタイポを 直して"
 * is one request asked twice.
 */
function normalizeRequest(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '').replace(/[。、.,!?！？]/g, '');
}

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

/** The first line a provider wrote, for a report that has to fit on a screen. */
function firstLine(output) {
  const text = String(output || '').split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('{'));
  return text ? text.slice(0, 100) : '';
}

// Two providers writing the same file is the one thing this report exists to catch.
//
// They share one working directory and are separated only by wording in their prompts
// ("index.html and app.css only" / "game.js only"), which is a request, not a boundary.
// When both of them touch a file, the later writer won and nothing said so. Only the
// writers are compared: a role that reads the same file is not a conflict.
function findCollisions(rows) {
  const byPath = new Map();
  for (const row of rows) {
    if (!row.wrote) continue;
    for (const change of row.changed || []) {
      const seen = byPath.get(change.path) || [];
      if (!seen.some((entry) => entry.role === row.role)) seen.push({ role: row.role, provider: row.provider });
      byPath.set(change.path, seen);
    }
  }
  return [...byPath.entries()]
    .filter(([, writers]) => writers.length > 1)
    .map(([path, writers]) => ({ path, writers }));
}

function runId(prompt) { return `run-${Date.now().toString(36)}-${knowledge.hash(prompt)}`; }
function publicRun(run) {
  // deadlineTimer is a live Timeout. Spreading it into a response body serialises a
  // handle, a socket list and the callback's closure — and this object is published
  // over WebSocket and SSE on every run event.
  const { prompt, deadlineTimer, ...safe } = run;
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
    this.expireStaleApprovals();
    // Ask twice, wait once.
    //
    // Every TASK turn submitted a run, so re-phrasing the same request three times
    // produced three identical plans all waiting for the owner. Twenty-one of them
    // accumulated, the GUI showed the first six, and the rest were unreachable. An
    // identical request that is already waiting is that same request.
    const existing = this.findWaitingDuplicate(text, cwd);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.duplicateOf = (existing.duplicateOf || 0) + 1;
      knowledge.recordEvent(existing.id, { type: 'run-deduplicated', status: existing.status, provider: existing.leader,
        evidence: `the same request is already waiting for approval (asked ${existing.duplicateOf + 1} times)` });
      this._emit(existing, 'deduplicated');
      return publicRun(existing);
    }
    const settings = this.settingsProvider() || {};
    const routing = settings.routing || {};
    const previewGame = /(?:3d|３d).*(?:shoot|シューティング)|(?:shoot|シューティング).*(?:game|ゲーム)/i.test(text);
    const run = {
      id: runId(text), prompt: text, planHash, promptSpec, previewGame,
      cwd: previewGame && this.preview?.root ? this.preview.root : (cwd || this.taskRunner.cwd),
      mode: ['plan', 'ask', 'auto', 'manual'].includes(mode) ? mode : (routing.executionMode || 'plan'),
      status: 'PLANNING', leader: routing.sessionLeader === 'auto' || !routing.sessionLeader ? 'claude-code' : routing.sessionLeader,
      assignments: [], repairCycle: 0, maxRepairCycles: Number(settings.quality?.maxRepairCycles || 3),
      revision: 1, requestedMode: ['plan', 'ask', 'auto', 'manual'].includes(mode) ? mode : (routing.executionMode || 'plan'),
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

  // Independent proposals, read-only, one provider each.
  //
  // These used to wait for approval like any other work, on the reasoning that a
  // discussion still costs tokens. Measured on 2026-08-04, that reasoning cost more
  // than it saved: two of these sat for eleven hours, and because the CLI never said
  // they were waiting, the owner spent the morning asking whether anything was
  // happening. `write: false` on every one of them — they read and they argue, and
  // then PiAgent merges what they said. The owner decided that day to let them run
  // and to keep the gate for the writing. `_needsApproval()` is where that lives.
  _planDeliberation(run, lenses) {
    run.stage = 'deliberation';
    const used = new Set();
    const chosen = deliberate.LENSES.slice(0, lenses).map((lens) => {
      const candidates = [lens.provider, ...(FALLBACKS[lens.provider] || [])].filter((item) => !used.has(item));
      const provider = this._pick(lens.role, candidates.length ? candidates : [lens.provider]);
      used.add(provider);
      return { ...lens, provider, model: resolveModel(provider, run.prompt, lens.role, { write: false }) };
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
        title: lens.title, write: false, lens: lens.id, status: task.status, fallbackIndex: 0, homeProvider: lens.provider,
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
      return { ...item, provider, model: resolveModel(provider, run.prompt, item.role, { write: item.write }) };
    });
    run.planHash = (run.explicitPlanHash && run.revision === 1) ? run.explicitPlanHash
      : knowledge.hash(JSON.stringify({ prompt: run.prompt, revision: run.revision, deliberation: run.deliberation?.steps || [],
        assignments: blueprint.map(({ role, provider, model, write, title }) => ({ role, provider, model, write, title })) }));
    run.assignments = blueprint.map((item, index) => {
      // Isolation happens HERE, before plan(), and not later.
      //
      // The disclosure the owner approves is sealed against a policy hash that includes
      // the task's working directory (security-policy.js), and start() refuses a task
      // whose policy no longer hashes the same. Creating a worktree after approval would
      // therefore block every task it was meant to protect. Doing it first means the
      // owner approves the isolated path in the first place.
      //
      // Only writers, and only when the directory is a git repository — which the Vault
      // is not, so today this returns the shared directory and says why. That reason
      // travels into the report rather than being silently dropped.
      const workspace = item.write
        ? isolate({ cwd: run.cwd, runId: run.id, role: item.role })
        : { path: run.cwd, isolated: false, reason: 'read-only role' };
      const task = this.taskRunner.plan({
        id: `${run.id}-${item.role}`,
        provider: item.provider,
        model: item.model,
        prompt: this._assignmentPrompt(run, item),
        cwd: workspace.path,
        planHash: run.planHash,
        metadata: { runId: run.id, role: item.role, agent: item.agent, title: item.title, write: item.write, order: index },
      });
      this.taskToRun.set(task.id, run.id);
      return { taskId: task.id, role: item.role, agent: item.agent, provider: item.provider, model: item.model, title: item.title,
        write: item.write, status: task.status, fallbackIndex: 0, homeProvider: item.provider,
        workspace, skills: item.skills || [],
        disclosureHash: task.disclosure?.disclosureHash || '' };
    });
    this._seal(run);
  }

  // Prefer a provider that can actually start. If none of the candidates can, fall back
  // to scoring alone rather than refusing to plan — an unstartable assignment that
  // fails loudly is more useful than a run that never appears.
  /**
   * The routing decision, for callers outside the run pipeline.
   *
   * Anything that dispatches to a hardcoded provider is a path that cannot be
   * throttled, cannot fall back and cannot be turned off.
   * @returns {string}
   */
  pickProvider(role, candidates) { return this._pick(role, candidates); }

  // Readiness is an exclusion, not a preference.
  //
  // This used to read `startable.length ? startable : candidates`, which threw the
  // gate away the moment nothing passed it: with every paid provider unauthenticated,
  // work was assigned to the provider that had just proved it could not run. When
  // nothing is startable the answer is the local model — no key, no quota, no
  // network — which is the owner's stated last resort.
  _pick(role, candidates) {
    // The owner's paid allowlist is read here and nowhere else. It was a dead
    // setting: forced to a constant on every save, and never consulted by the code
    // that assigns work, so taking an exhausted provider out of rotation was impossible.
    const allowed = this.paidAllowlist();
    const permitted = candidates.filter((provider) => !PAID_PROVIDERS.has(provider) || allowed.has(provider));
    const startable = permitted.filter((provider) => this.isAvailable(provider) && this.breaker.allow(provider));
    if (startable.length) return this.registry.choose(role, startable) || startable[0];
    if (this.isAvailable(LOCAL_PROVIDER)) return LOCAL_PROVIDER;
    return permitted[0] || candidates[0];
  }

  /** The providers the owner still wants paid work sent to. */
  paidAllowlist() {
    const configured = this.settingsProvider()?.routing?.paidAllowlist;
    return new Set(Array.isArray(configured) && configured.length ? configured.map(String) : [...PAID_PROVIDERS]);
  }

  /**
   * Does this run have to stop and wait for the owner?
   *
   * Two rules, in this order.
   *
   * 1. Nothing that writes, no gate — whatever the mode. The line below used to read
   *    "every mutation-capable run waits here" while the code waited for every run
   *    full stop, and the gap between those two sentences is what stranded the owner:
   *    on 2026-08-04 the two runs sitting untouched for eleven hours were a pair of
   *    read-only lenses, `write: false` on both, blocked behind an approval prompt
   *    that never reached a screen. A discussion does cost tokens, and the owner
   *    decided that day that the cost of reading is worth paying without being asked
   *    (see docs/v3 and the plan for that session). Reading changes nothing; it is
   *    the writing that needs a human.
   *
   * 2. Something writes, and then the mode decides. `auto-edit` releases; `plan` and
   *    `ask` wait. This is the first time the mode has had any effect at all — it was
   *    collapsed to 'plan' at the daemon and ignored here, so `/mode` moved a colour
   *    and nothing else.
   *
   * A run with no assignments always waits: an empty plan is a bug, not permission.
   * @returns {boolean}
   */
  _needsApproval(run) {
    const assignments = Array.isArray(run.assignments) ? run.assignments : [];
    if (!assignments.length) return true;
    if (assignments.every((item) => item.write === false)) return false;
    return String(run.mode || 'plan') !== 'auto';
  }

  _seal(run) {
    run.disclosures = run.assignments.map((assignment) => this.taskRunner.get(assignment.taskId)?.disclosure).filter(Boolean);
    run.disclosureHash = aggregateDisclosureHash(run.disclosures);
    // Security first, always. A blocked assignment is not released by any mode and not
    // by the read-only rule either — the check below never sees it.
    if (run.assignments.some((item) => item.status === 'blocked')) {
      run.status = 'SECURITY_BLOCKED'; run.updatedAt = new Date().toISOString(); return;
    }
    run.status = 'AWAITING_APPROVAL';
    run.updatedAt = new Date().toISOString();
    if (!this._needsApproval(run)) this._release(run);
  }

  /**
   * Start the work. The single dispatch path — `approve()` reaches it after checking
   * the hashes, `_seal()` reaches it when there is nothing to check.
   */
  _release(run) {
    run.status = 'EXECUTING'; run.startedAt = run.startedAt || new Date().toISOString(); run.updatedAt = new Date().toISOString();
    run.deadlineAt = new Date(new Date(run.startedAt).getTime() + RUN_BUDGET_MS).toISOString();
    this._armDeadline(run);
    this._emit(run, 'dispatch');
    for (const assignment of run.assignments) {
      const task = this.taskRunner.get(assignment.taskId);
      if (task?.status === 'awaiting_approval') this.taskRunner.approve(task.id, { disclosureHash: task.disclosure?.disclosureHash });
    }
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
    return this._release(run);
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
    // Which of the owner's skills reached this assignment. It was injected silently, so
    // when it fired on the wrong thing — measured: 「READMEを直して」 pulled in
    // token-saver and n8n-binary-and-data — nothing said so and nobody could tell.
    try {
      const matched = this.skills.match(`${run.prompt} ${item.title}`) || [];
      item.skills = matched.map((skill) => skill.id);
      skillBrief = this.skills.brief(`${run.prompt} ${item.title}`);
    } catch (_) {}
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
      // BigKiji's half of the critique loop the owner asked for. Deterministic: a
      // 9B model asked "is this good?" answers yes, so this asks it nothing and
      // checks facts instead. A result with nothing to say about it stays quiet.
      const review = reviewResult({ run, assignment, task });
      assignment.review = review;
      this.emit('review', review);
      if (!review.quiet) {
        knowledge.recordEvent(run.id, { type: 'result-review', status: task.status, provider: task.provider,
          evidence: `${review.role}: ${review.summary}` });
      }
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
      // First 'model-unavailable' from a provider+model in this run is not evidence.
      // A deleted model and a model whose server hiccuped for one call say the same
      // sentence; the difference only shows on the retry below. Measured 2026-08-04:
      // `pi` accepted the exact model name that had just reported "not found", so the
      // failure the owner saw was transient and would have marked the local model down
      // for every routing decision afterwards.
      const transient = !ok && reason === 'model-unavailable' && !assignment.transientSeen;
      if (transient) assignment.transientSeen = true;
      const lesson = this.registry.record({ provider: task.provider, model: task.model, role: assignment.role,
        ok: task.status === 'completed', durationMs, tokens: task.tokens, reason, transient });
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
      // Same model first, a different provider only if that fails too. Falling straight
      // to the fallback chain on a transient outage moves free local work onto a paid
      // provider for a blip that would have cleared on its own.
      for (const item of failed) restarted += (this._retryTransient(run, item) || this._fallback(run, item)) ? 1 : 0;
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
    clearTimeout(run.deadlineTimer); run.deadlineTimer = null;
    run.status = verified ? 'COMPLETED' : 'FAILED'; run.finishedAt = new Date().toISOString();
    run.report = this.buildReport(run);
    knowledge.recordEvent(run.id, { type: 'run-finish', status: run.status, provider: run.leader,
      evidence: run.quality.checks.map((c) => `${c.id}:${c.pass}`).join(', ') });
    this.emit('report', run.report);
    this._emit(run, 'finish');
    this.forgetOldRuns();
  }

  // Merge the proposals and move to the real work. A discussion that produced nothing
  // usable degrades to executing without it — the owner asked for a better plan, not
  // for a gate that can strand the task.
  _concludeDeliberation(run) {
    const outcomes = run.assignments.map((assignment) => {
      const task = this.taskRunner.get(assignment.taskId);
      return { assignment, task, ok: task?.status === 'completed' && !!task.output };
    });
    const proposals = outcomes.filter((item) => item.ok).map(({ assignment, task }) =>
      ({ lens: assignment.lens, provider: assignment.provider, text: task.output }));
    const plan = deliberate.consolidate(proposals);

    // What the groundwork actually produced, kept on the run so the approval screens can
    // say it. The owner watched two lenses die — one model-unavailable, one 429 — and the
    // run still asked for approval as though the plan below had been informed by them.
    // A plan written after zero successful groundwork is a different thing to approve
    // than one written after two, and the screen has to be able to tell them apart.
    run.groundwork = {
      lenses: outcomes.length,
      completed: proposals.length,
      steps: plan.steps.length,
      failures: outcomes.filter((item) => !item.ok).map(({ assignment, task }) => ({
        lens: assignment.lens || assignment.role,
        title: assignment.title || '',
        provider: assignment.provider,
        model: assignment.model,
        status: task?.status || 'missing',
        // The reason as the runner recorded it. Truncated, never rewritten: 'rate-limit'
        // and 'model not found' are different problems with different answers.
        reason: String(task?.error || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      })),
    };

    if (plan.steps.length) {
      run.deliberation = { ...plan, source: 'live' };
      this.memory.store(run.prompt, plan);
    } else {
      run.deliberation = null;
      // Two different facts that used to be reported as one. "The lenses answered and
      // said nothing useful" is a weak plan; "no lens ever ran" is no groundwork at all.
      run.notes = [...(run.notes || []), proposals.length
        ? `Deliberation returned no usable steps from ${outcomes.length} lenses; proceeding without it.`
        : `No groundwork: 0 of ${outcomes.length} lenses completed`
          + `${run.groundwork.failures.length ? ` (${run.groundwork.failures.map((f) => f.reason || f.status).join('; ')})` : ''}`
          + '. The plan below was written without any of it.'];
    }
    run.revision += 1;
    knowledge.recordEvent(run.id, { type: 'deliberated', status: run.status, provider: run.leader,
      evidence: plan.steps.length ? `${plan.steps.length} merged steps from ${plan.lenses} lenses` : 'no usable proposals' });
    this._planExecution(run);
    this._emit(run, 'deliberated');
  }

  /**
   * A run waiting for approval with the same request in the same folder, if any.
   * @returns {object|null}
   */
  findWaitingDuplicate(text, cwd) {
    const key = normalizeRequest(text);
    for (const run of this.runs.values()) {
      if (run.status !== 'AWAITING_APPROVAL') continue;
      if (String(run.cwd || '') !== String(cwd || run.cwd || '')) continue;
      if (normalizeRequest(run.prompt) === key) return run;
    }
    return null;
  }

  /**
   * Retire approvals nobody answered.
   *
   * `this.runs` had no delete in it at all, so a waiting run stayed waiting until
   * the process ended and the map grew for as long as it ran. An hour-old plan is
   * also stale in a way the owner cannot see — the code it was planned against has
   * moved — so approving it later is worse than being asked again.
   */
  expireStaleApprovals(now = Date.now()) {
    const expired = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'AWAITING_APPROVAL') continue;
      const age = now - new Date(run.updatedAt || run.createdAt).getTime();
      if (!Number.isFinite(age) || age < APPROVAL_TTL_MS) continue;
      run.status = 'EXPIRED';
      run.error = `no answer in ${Math.round(APPROVAL_TTL_MS / 60000)} minutes — ask again if it still matters`;
      run.updatedAt = new Date(now).toISOString();
      expired.push(run);
    }
    for (const run of expired) {
      knowledge.recordEvent(run.id, { type: 'run-expired', status: run.status, provider: run.leader, evidence: run.error });
      this._emit(run, 'expired');
      this.forgetRun(run);
    }
    return expired.length;
  }

  /**
   * Stop at the deadline to report, not to kill.
   *
   * The owner's decision, 2026-08-03: thirty minutes is a checkpoint, not a
   * guillotine — "期限で区切って途中経過を出す". Killing work at the half-hour mark
   * throws away whatever it had finished; saying nothing at the half-hour mark is
   * how a run silently eats an afternoon. The run keeps going and the owner is
   * told what is done, what is not, and how far past the mark it is.
   */
  _armDeadline(run) {
    clearTimeout(run.deadlineTimer);
    const remaining = new Date(run.deadlineAt).getTime() - Date.now();
    run.deadlineTimer = setTimeout(() => this._reportProgress(run), Math.max(1000, remaining));
    run.deadlineTimer.unref?.();
  }

  /** What is done and what is not, at the deadline and every checkpoint after it. */
  _reportProgress(run) {
    if (['COMPLETED', 'FAILED', 'EXPIRED'].includes(run.status) || run.aborting) return;
    const done = run.assignments.filter((item) => item.status === 'completed');
    const running = run.assignments.filter((item) => ['running', 'dispatching', 'executing'].includes(String(item.status).toLowerCase()));
    const overdueMs = Date.now() - new Date(run.deadlineAt).getTime();
    const report = {
      runId: run.id, status: run.status,
      completed: done.map((item) => `${item.role} · ${item.provider}`),
      stillRunning: running.map((item) => `${item.role} · ${item.provider}`),
      overdueMinutes: Math.max(0, Math.round(overdueMs / 60000)),
      budgetMinutes: Math.round(RUN_BUDGET_MS / 60000),
    };
    run.progressReports = [...(run.progressReports || []), report].slice(-6);
    knowledge.recordEvent(run.id, { type: 'run-checkpoint', status: run.status, provider: run.leader,
      evidence: `${done.length}/${run.assignments.length} done after ${report.budgetMinutes + report.overdueMinutes} minutes` });
    this.emit('checkpoint', report);
    this._emit(run, 'checkpoint');
    // Keep reporting rather than going quiet again.
    run.deadlineTimer = setTimeout(() => this._reportProgress(run), CHECKPOINT_MS);
    run.deadlineTimer.unref?.();
  }

  /**
   * One report for a finished run — step ⑥ of the owner's workflow.
   *
   * Until now a finished run produced N separate outputs and no summary: the owner
   * read each provider's answer in turn and worked out for themselves whether the
   * thing they asked for had happened. What is here is only what was measured — who
   * ran, whether they finished, how long they took, what they actually consumed, and
   * the first line each of them wrote. Nothing is inferred and nothing is combined:
   * merging several providers' edits automatically has no working precedent, and
   * pretending otherwise would be the most expensive kind of wrong.
   * @returns {object}
   */
  /**
   * Drop a run and the task index entries that pointed at it.
   *
   * `taskToRun` had no delete at all, so every task id this coordinator ever saw
   * stayed in it — including the ones whose run had already been removed, which is a
   * map of dangling pointers that only grows.
   */
  forgetRun(run) {
    for (const assignment of run.assignments || []) {
      this.taskToRun.delete(assignment.taskId);
      // An empty worktree is removed; one with work in it is kept, because that work is
      // the only copy of it and the owner has not looked at it yet. The report names the
      // path so it can be found again.
      const workspace = assignment.workspace;
      if (workspace?.isolated) {
        try { release(workspace, { keep: (collectDiff(workspace).files || 0) > 0 }); } catch (_) {}
      }
    }
    this.runs.delete(run.id);
  }

  /**
   * Keep the finished runs the owner might still ask about, and no more.
   *
   * A finished run stayed in memory for the life of the process together with every
   * assignment, disclosure and report it carried.
   */
  forgetOldRuns(keep = 50) {
    const done = [...this.runs.values()]
      .filter((run) => ['COMPLETED', 'FAILED'].includes(run.status))
      .sort((a, b) => String(a.finishedAt || a.updatedAt || '').localeCompare(String(b.finishedAt || b.updatedAt || '')));
    for (const run of done.slice(0, Math.max(0, done.length - keep))) this.forgetRun(run);
  }

  buildReport(run) {
    const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
    const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    const rows = run.assignments.map((assignment) => {
      const task = this.taskRunner.get(assignment.taskId) || {};
      const tokens = task.tokens || {};
      const measured = Number(tokens.input || 0) + Number(tokens.output || 0);
      const ranMs = task.startedAt ? Math.max(0, new Date(task.finishedAt || task.updatedAt || Date.now()).getTime() - new Date(task.startedAt).getTime()) : null;
      return {
        role: assignment.role, provider: assignment.provider, model: assignment.model || '',
        status: assignment.status, wrote: !!assignment.write,
        // '' rather than 0: a provider whose usage was never reported did not use
        // zero tokens, and this project has already shipped that mistake once.
        tokens: measured || null,
        ms: ranMs,
        headline: firstLine(task.output),
        error: assignment.status === 'completed' ? '' : String(task.failureReason || task.error || '').split('\n')[0].slice(0, 120),
        findings: (assignment.review?.findings || []).map((finding) => finding.id),
        standInFor: assignment.homeProvider && assignment.homeProvider !== assignment.provider ? assignment.homeProvider : '',
        // What this provider actually put on disk, read from its own stream. Line counts
        // are null when the provider does not report them: codex names its files but
        // gives no counts, and a zero there would read as "changed nothing".
        changed: this.taskRunner.changedFiles ? this.taskRunner.changedFiles(task) : [],
        // Null when the price or the window is unknown, or when the provider reported no
        // usage at all. A provider that said nothing did not spend zero.
        // Where this provider actually worked, and if it was not isolated, why not.
        // Silence here would read as "isolated" — which is the one thing it must not do.
        isolated: !!assignment.workspace?.isolated,
        workspacePath: assignment.workspace?.isolated ? assignment.workspace.path : '',
        notIsolated: assignment.write && !assignment.workspace?.isolated ? (assignment.workspace?.reason || 'unknown') : '',
        cost: costOf(assignment.provider, assignment.model, tokens),
        context: contextUse(assignment.model, tokens),
        skills: assignment.skills || [],
      };
    });
    const done = rows.filter((row) => row.status === 'completed');
    const totalTokens = rows.reduce((sum, row) => sum + (row.tokens || 0), 0);
    const collisions = findCollisions(rows);
    return {
      runId: run.id, status: run.status, goal: run.promptSpec?.goal || run.promptPreview || '',
      completed: done.length, total: rows.length,
      ms: started ? finished - started : null,
      tokens: totalTokens || null,
      // Sum of the parts that could be priced; null when none of them could. A partial
      // total is still worth showing — it is a floor, not a guess — and the rows say
      // which providers contributed a dash.
      cost: rows.reduce((sum, row) => (row.cost === null ? sum : (sum || 0) + row.cost), null),
      checks: run.quality.checks.map((check) => ({ id: check.id, pass: check.pass })),
      repairs: run.repairCycle || 0,
      collisions,
      rows,
    };
  }

  _fallback(run, assignment) {
    // A stand-in is temporary.
    //
    // The owner's rule: when billing limits a provider another AI covers for it, and
    // the one covering does not keep the role — it goes back to whoever it belongs
    // to. `fallbackIndex` only ever moved forward, so the first quota outage of the
    // day reassigned the role for the rest of the run and nothing ever undid it.
    const home = assignment.homeProvider;
    if (home && assignment.provider !== home && this.breaker.allow(home) && this.isAvailable(home)) {
      assignment.fallbackIndex = 0;
      knowledge.recordEvent(run.id, { type: 'provider-restored', status: run.status, provider: home,
        evidence: `${assignment.role}: ${assignment.provider} was standing in, ${home} is available again` });
      this.emit('restored', { runId: run.id, role: assignment.role, from: assignment.provider, to: home });
      return this._reassign(run, assignment, home);
    }
    // The chain belongs to the role's own provider, not to whoever is currently
    // standing in. Reading it from the stand-in meant `fallbackIndex` indexed into a
    // different list after every hop — position 2 of claude-code's chain became
    // position 2 of glm's.
    const candidates = FALLBACKS[home || assignment.provider] || [];
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
    return this._reassign(run, assignment, next);
  }

  /**
   * Move an assignment to another provider and plan the replacement task.
   * @returns {boolean}
   */
  /**
   * One more go at the same model, for the one failure that is usually not the model's.
   *
   * `classifyFailure` and `retryAfterMs` have computed 'model-unavailable' all along and
   * nothing consumed it: every failure went straight to `_fallback`, which changes
   * provider. For a rate limit or an exhausted quota that is right — the same provider
   * will keep failing. For 'model-unavailable' it is usually wrong, because the message
   * a deleted model produces and the message a hiccuping local server produces are the
   * same sentence, and the local model is the free, private one.
   *
   * Exactly once per assignment, and only for this reason. A model that really is gone
   * fails the retry, gets its registry penalty, and falls back on the next cycle — one
   * cycle later than before, which is the price of not abandoning the free model over a
   * blip.
   *
   * @returns {boolean} true when a retry was planned and the caller should not fall back
   */
  _retryTransient(run, assignment) {
    const task = this.taskRunner.get(assignment.taskId);
    if (String(task?.failureReason || '') !== 'model-unavailable') return false;
    if (assignment.transientRetried) return false;
    assignment.transientRetried = true;
    const retry = this.taskRunner.plan({
      id: `${assignment.taskId}-retry-${run.repairCycle}`,
      // Provider AND model unchanged — that is the whole point of this path.
      provider: assignment.provider, model: assignment.model, cwd: run.cwd, planHash: run.planHash,
      prompt: task?.prompt || run.prompt,
      metadata: { ...(task?.metadata || {}), runId: run.id, repairCycle: run.repairCycle, transientRetry: true },
    });
    this.taskToRun.set(retry.id, run.id);
    assignment.taskId = retry.id; assignment.status = retry.status;
    assignment.disclosureHash = retry.disclosure?.disclosureHash || '';
    assignment.learned = false;
    knowledge.recordEvent(run.id, { type: 'transient-retry', status: run.status, provider: assignment.provider,
      evidence: `${assignment.role}: ${assignment.model} reported unavailable — retrying the same model once before falling back` });
    this.emit('retry', { runId: run.id, role: assignment.role, provider: assignment.provider, model: assignment.model, reason: 'model-unavailable' });
    return true;
  }

  _reassign(run, assignment, next) {
    const oldTask = this.taskRunner.get(assignment.taskId);
    const model = resolveModel(next, run.prompt, assignment.role, { write: assignment.write });
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
