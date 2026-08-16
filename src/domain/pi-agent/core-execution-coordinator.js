'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');
const { ModelCapabilityRegistry } = require('./model-capability-registry');
const { aggregateDisclosureHash } = require('../pi-core/security/disclosure-manifest');
const { SkillRegistry } = require('./skill-registry');
const { resolveModel } = require('./model-router');
const { CircuitBreaker } = require('./circuit-breaker');
const { reviewResult } = require('./critique');
const { costOf, contextUse } = require('./pricing');
const { isolate, collectDiff, release, sweepAbandoned, repoRoot } = require('./worktree');
const { RunLedger } = require('./run-ledger');
const deliberate = require('./deliberation');
const { FailureMemory, signatureOf } = require('./failure-memory');
const { canonical } = require('./provider-readiness');

// Whether a repair waits for the owner. False in every mode by the owner's decision of
// 2026-08-05 — one word to change back if `plan` should ever stop again.
const REPAIR_RUNS_UNATTENDED = true;

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

// The provider that needs no key, no quota and no network.
const LOCAL_PROVIDER = 'qwen';

// When a limit takes a provider out, who covers — one order, decided by the owner
// (2026-08-15): **GLM → Codex → Claude → Gemini → Qwen**.
//
// This reverses the head of the 2026-08-05 order (Claude → Codex → GLM → …). The owner
// re-cast the roles: Claude Code is the commander — analysis, prompt authoring, quality
// control and sign-off — and is not the hand that produces. Generation starts at GLM,
// falls to Codex, and reaches Claude only when both have failed. Putting Claude first
// meant the reviewer became the author on the first hiccup, and nobody was left to check
// the work. Gemini stays where it is because its role is translation, not generation.
//
// Written once, as a list, rather than as five hand-maintained chains. The chains it
// replaces disagreed with each other about the same question: `claude-code` tried GLM
// before Codex while `codex` tried Claude before GLM, and neither reached Gemini at
// all, so an exhausted Claude *and* Codex went straight past a working Gemini to the
// local model. Derived chains cannot drift apart like that.
//
// Two rules from before this order still hold, and the derivation preserves both:
//
//   - Every chain ends local, and only local. When billing limits a provider another
//     paid one takes over, and only when none of them work does the work fall to Pi
//     and Ollama. Qwen is last in the owner's order, so this comes out for free.
//   - `qwen: []` — a local failure is the floor, not a reason to spend (2026-08-03,
//     owner). Escalating the free model to a paid one is the wrong direction, so the
//     floor keeps its empty chain rather than inheriting the list.
const PROVIDER_PRIORITY = Object.freeze(['glm', 'codex', 'claude-code', 'gemini', LOCAL_PROVIDER]);
const FALLBACKS = Object.freeze(Object.fromEntries(PROVIDER_PRIORITY.map((provider) => [
  provider,
  provider === LOCAL_PROVIDER ? [] : PROVIDER_PRIORITY.filter((other) => other !== provider),
])));
const PAID_PROVIDERS = new Set(['claude', 'claude-code', 'codex', 'gemini', 'glm']);

/**
 * The leader the owner named, or '' for "let the fleet decide".
 *
 * The settings window has offered a "Session leader" since it was written, and picking
 * one changed nothing that ran. `run.leader` was set from it and then used only as a
 * label: eight `knowledge.recordEvent(..., provider: run.leader)` calls and one line of
 * HUD text. The provider that actually did the work was chosen by
 * `registry.choose(role, startable)` — learned scores over every startable provider —
 * so the roster's own `claude-code` was no more binding than the owner's choice was.
 * Traced 2026-08-10; the owner asked for the choice to mean something.
 *
 * Empty means auto, and auto keeps the learner. That is the honest split: a setting left
 * on Auto is the owner declining to decide, and overriding measured performance with a
 * hardcoded name in that case would be worse routing, not more obedient routing. A named
 * leader is a human overruling the heuristic, and it wins — see `_pick`'s `honourOrder`.
 *
 * `qwen` is not a leader at any setting. The role writes (ROLE_BLUEPRINT, write: true)
 * and the local provider has no tool layer, which is the failure the roster records for
 * GLM owning debugging while running `--no-tools`.
 *
 * @param {{sessionLeader?: string}} routing
 * @returns {string} a provider id from PROVIDER_PRIORITY, or '' for auto
 */
function leaderProvider(routing = {}) {
  const wanted = String(routing?.sessionLeader || '');
  return PROVIDER_PRIORITY.includes(wanted) && wanted !== LOCAL_PROVIDER ? wanted : '';
}

// The owner's working budget for one run, and how often it reports once it is past.
// Thirty minutes is a checkpoint, not a kill: see _reportProgress.
const RUN_BUDGET_MS = 30 * 60 * 1000;
const CHECKPOINT_MS = 10 * 60 * 1000;

// How long a plan is worth approving. The code it was planned against moves.
const APPROVAL_TTL_MS = 60 * 60 * 1000;

// When "report, not kill" has to stop reporting.
//
// _reportProgress is deliberately not a guillotine, and that is still right. What it
// lacked was any way to notice that there was nothing left to report on. Measured on the
// owner's machine 2026-08-09:
//
//   run-mshw0qbn-50f26de5111adc5a   started 2026-08-06T19:07Z, budget 30 min
//   status DIAGNOSING, 1 of 3 assignments done, nothing running
//   244 checkpoints, one every ten minutes, 3260 minutes past the deadline
//
// Its two remaining lenses had failed at dispatch — `Model "ollama/qwen3.5:35b-a3b" not
// found`, gemini quota exhausted — so no assignment would ever change state again. The
// run was not slow. It was over, and nothing said so. Meanwhile those 244 events filled
// the 300-entry ring in task_state.json and evicted every other piece of history before
// 2026-08-07 08:58.
//
// A run with work in flight is never touched by this: `stillRunning` being non-empty
// resets the count, so a genuinely long job keeps its old behaviour of reporting forever.
const STALL_CHECKPOINTS = 6;
const STALL_TTL_MS = 2 * RUN_BUDGET_MS;
// Statuses a run can hold while it is still the owner's current work. Exported because
// daemon.js asks the same question in three places (`facts`, `statusFacts`,
// `currentPhase`) and had three different answers: `facts` omitted DISPATCHING and both
// omitted DIAGNOSING, so a DIAGNOSING run showed in the CLI's phase row while `/status`
// and the conversation model were told "runs in progress: 0" about the same run.
const ACTIVE_RUN = Object.freeze(['PLANNING', 'DISPATCHING', 'EXECUTING', 'DIAGNOSING', 'REPAIRING', 'VERIFYING']);
const TERMINAL_RUN = Object.freeze(['COMPLETED', 'FAILED', 'EXPIRED', 'SECURITY_BLOCKED']);

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
    available = null, breaker = new CircuitBreaker(),
    failures = new FailureMemory({ root: knowledge.ROOT }) } = {}) {
    super();
    if (!taskRunner) throw new Error('CoreExecutionCoordinator requires TaskRunner');
    this.taskRunner = taskRunner;
    // What went wrong before, and what fixed it. The repair loop retried without ever
    // asking why, and nothing remembered the answer, so the same wall was hit three
    // times a run and again on the next one. See failure-memory.js.
    this.failures = failures;
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
    // The English record an external coding agent reads to improve the prompts we
    // generate. Write-only from here, and it swallows its own failures — see
    // run-ledger.js. Nothing in the run path may depend on it.
    this.ledger = new RunLedger();
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

  /**
   * Reconcile the worktree directory against the runs that exist. Called once, at startup.
   *
   * `forgetRun()` is the only thing that releases a worktree and it needs the run to be in
   * `this.runs` — an in-memory Map. So a restart makes every waiting run's directory
   * unattributable: nothing knows what it was, and nothing dares delete it. Measured on
   * the owner's machine 2026-08-10 after five restarts in one evening: 87 directories,
   * 2.2 GB, and not one of them ever written to.
   *
   * `listAbandoned()` has been able to name them since it was written — its own comment
   * says "so a later run can offer to clean them up" — and nothing had ever called it.
   *
   * Work is never deleted. A directory a provider actually wrote in is kept and returned,
   * the same judgement forgetRun() makes and for the same reason: it is the only copy.
   *
   * @returns {{removed: string[], kept: string[]}}
   */
  sweepWorktrees() {
    const repo = repoRoot(this.taskRunner?.cwd || process.cwd());
    if (!repo) return { removed: [], kept: [] };
    // Anything this process is still responsible for is off limits, so the sweep is safe
    // to call at any time rather than only before the first run.
    const live = new Set();
    for (const run of this.runs.values()) {
      for (const assignment of run.assignments || []) {
        if (assignment.workspace?.isolated) live.add(path.basename(assignment.workspace.path));
      }
    }
    try { return sweepAbandoned(repo, { live }); } catch (_) { return { removed: [], kept: [] }; }
  }

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
      mode: ['plan', 'ask', 'auto', 'manual', 'demo'].includes(mode) ? mode : (routing.executionMode || 'plan'),
      status: 'PLANNING', leader: leaderProvider(routing) || 'auto',
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
    // Do not walk into a wall we have already hit.
    //
    // The failure memory is consulted before anything is planned, not only after
    // something has broken. A remedy that has worked before arrives as a constraint on
    // the plan, so the specialists start where the last repair finished instead of
    // rediscovering it — which is the whole of "同じ失敗を繰り返さない". Wording-matched,
    // so a request that has never failed can still be warned.
    const wall = this.failures.lookup({ prompt: text });
    if (wall && wall.fix) {
      run.knownFailure = { signature: wall.signature, cause: wall.cause, fix: wall.fix,
        occurrences: wall.occurrences, resolved: !!wall.resolved };
      run.promptSpec = { ...(run.promptSpec || {}),
        constraints: [...(Array.isArray(run.promptSpec?.constraints) ? run.promptSpec.constraints : []),
          `Known failure here (seen ${wall.occurrences}×): ${wall.cause || 'cause not recorded'} — ${wall.fix}`] };
      knowledge.recordEvent(run.id, { type: 'failure-recalled', status: run.status, provider: run.leader,
        evidence: `${wall.signature} ×${wall.occurrences}: ${wall.fix}` });
    }
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
      //
      // The line that makes "Session leader" mean something. A named leader becomes the
      // head of the chain AND is honoured over the learned score; Auto leaves both
      // alone. Every other role keeps the provider the roster assigns it.
      const pinned = item.role === 'leader' ? leaderProvider(run.roleContext) : '';
      const home = pinned || item.provider;
      const provider = this._pick(item.role, [home, ...(FALLBACKS[home] || [])], { honourOrder: !!pinned });
      return { ...item, provider, model: resolveModel(provider, run.prompt, item.role, { write: item.write }) };
    });
    // Who actually leads, now that it is known. Until this line `run.leader` was the
    // owner's request — 'auto' most of the time — and it is what eight knowledge events
    // and the HUD card report as the run's provider. Recording the intent instead of the
    // outcome is how a run led by GLM went into the record as led by whatever the
    // settings said.
    run.leader = blueprint.find((item) => item.role === 'leader')?.provider || run.leader;
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
  /**
   * @param {string} role
   * @param {string[]} candidates  first is the preferred one; the rest are its chain
   * @param {{honourOrder?: boolean}} options  `honourOrder` takes the first candidate
   *   that can actually start instead of the highest-scoring one. Set only when a human
   *   named the provider: the registry's job is to break ties nobody else has broken,
   *   and an owner picking "Session leader: Codex" has broken it. The exclusions above
   *   still apply, so a named provider that is off the allowlist, unauthenticated or in
   *   cooldown is skipped exactly as it would be otherwise — obeyed does not mean pinned.
   */
  _pick(role, candidates, { honourOrder = false } = {}) {
    // The owner's paid allowlist is read here and nowhere else. It was a dead
    // setting: forced to a constant on every save, and never consulted by the code
    // that assigns work, so taking an exhausted provider out of rotation was impossible.
    const allowed = this.paidAllowlist();
    const permitted = candidates.filter((provider) => !PAID_PROVIDERS.has(provider) || allowed.has(provider));
    const startable = permitted.filter((provider) => this.isAvailable(provider) && this.breaker.allow(provider));
    if (startable.length) return honourOrder ? startable[0] : (this.registry.choose(role, startable) || startable[0]);
    if (this.isAvailable(LOCAL_PROVIDER)) return LOCAL_PROVIDER;
    return permitted[0] || candidates[0];
  }

  /** The providers the owner still wants paid work sent to. */
  paidAllowlist() {
    const configured = this.settingsProvider()?.routing?.paidAllowlist;
    const chosen = Array.isArray(configured) && configured.length ? configured.map(String) : [...PAID_PROVIDERS];
    // Saved settings spell the Claude CLI `claude`; the roster and every fallback chain
    // spell it `claude-code`. provider-readiness has owned that translation since it was
    // written and nothing outside it had ever asked — so a settings file reading
    // ["claude", ...] filtered every claude-code candidate out at _pick() and the leader
    // role fell through to whatever else could start. Both spellings go into the set:
    // canonicalising away the raw id would quietly narrow a list the owner wrote by hand.
    const allowed = new Set();
    for (const id of chosen) { allowed.add(id); allowed.add(canonical(id)); }
    return allowed;
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
    // `demo` is the owner's hands-off mode: one instruction in, a finished thing to
    // look at, and no approval in between. It is exactly as permissive as `auto` and
    // no more — SECURITY_BLOCKED above is checked before this is ever consulted, and
    // an empty plan still waits, because an empty plan is a bug and not permission.
    return !['auto', 'demo'].includes(String(run.mode || 'plan'));
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
    // The decisions nobody asked the owner about.
    //
    // In hands-off mode the front desk settles the open questions so nothing stops
    // mid-run, and one local model choosing alone is a thin basis for "what kind of
    // thing are we building". The lenses are already answering independently and are
    // already merged, so the questions are put in front of them: each takes a position,
    // and the merge is the discussion. Named rather than assumed, so a lens that
    // disagrees can say so instead of quietly planning something else.
    const open = (run.promptSpec?.decidedWithoutOwner || [])
      .map((item) => (typeof item === 'string' ? item : item?.ask))
      .filter(Boolean).slice(0, 4);
    const decide = open.length
      ? `The owner did not specify these, and they were chosen without them — state your own position on each ` +
        `in the first step, and plan for the one you would pick:\n${open.map((ask, i) => `  ${i + 1}. ${ask}`).join('\n')}\n`
      : '';
    return `BIGKIJI DELIBERATION ${run.id}\nOwner goal: ${run.prompt}\n` + decide +
      `You are the ${lens.id.toUpperCase()} lens. ${lens.instruction}\n` +
      'This is read-only. Do not edit files, run builds, or start anything. Other lenses are answering the same question ' +
      'independently and you cannot see them — do not hedge toward what you think they will say.\n' +
      'Answer as a numbered list of 3-6 imperative steps, one line each, and nothing else.' +
      (skillBrief ? `\n\n${skillBrief}\n` : '');
  }

  // Where the specialists leave notes for each other.
  //
  // The gap the owner named: 「それぞれの課金AIがコミュニケーション取れるように」. Each
  // assignment runs in its own git worktree and cannot see the others, so collision
  // avoidance was a static file split — "ui owns index.html, leader owns game.js" — and
  // nothing carried what anyone had actually done.
  //
  // The obvious fix is to rebuild a later assignment's prompt with the earlier results,
  // and it is not available: `createDisclosureManifest` hashes the prepared prompt into
  // `payloadHash`, and `verifyDisclosureManifest` re-checks it at start. Editing a prompt
  // after the owner approved it either fails that check or means re-sealing — which is
  // the approval gate being worked around rather than honoured.
  //
  // So the CHANNEL is what the owner approves, and only its contents are live: the prompt
  // names this directory and says what is in it, which is static text and hashes the same
  // every time. The coordinator writes the notes itself when an assignment finishes,
  // rather than asking a model to remember to — a handoff that depends on the agent
  // choosing to write it is a handoff that is missing exactly when the run went badly.
  //
  // Honest about its reach: assignments dispatched together still start blind. This helps
  // the ones that queue behind `maxParallel`, every repair cycle, and every fallback
  // retry — the cases where somebody has already finished.
  _handoffDir(run) { return path.join(run.cwd || this.taskRunner.cwd, '.bigkiji', 'handoff', String(run.id)); }

  _writeHandoff(run, assignment, task) {
    const dir = this._handoffDir(run);
    const order = String(run.assignments.findIndex((item) => item.taskId === assignment.taskId) + 1).padStart(2, '0');
    const edits = [...(task.edits?.keys?.() || [])].slice(0, 20);
    const body = [
      `# ${assignment.role} — ${task.status}`,
      `provider: ${task.provider}${task.model ? ` · ${task.model}` : ''}`,
      `title: ${assignment.title || ''}`,
      edits.length ? `files: ${edits.join(', ')}` : 'files: (none)',
      task.error ? `error: ${knowledge.cleanText(task.error, 300)}` : '',
      '',
      knowledge.cleanText(String(task.output || ''), 1500) || '(no output)',
      '',
    ].filter((line) => line !== '').join('\n');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${order}-${assignment.role}.md`), body);
      return true;
    } catch (_) {
      // A note nobody could write is not worth failing a run over.
      return false;
    }
  }

  _assignmentPrompt(run, item) {
    // Text only. This injects guidance, never filesystem access, so the sandbox
    // boundary is exactly what it was before the skill registry existed.
    let skillBrief = '';
    // Which of the owner's skills reached this assignment. It was injected silently, so
    // when it fired on the wrong thing — measured: 「READMEを直して」 pulled in
    // token-saver and n8n-binary-and-data — nothing said so and nobody could tell.
    // The owner's request, and only the owner's request.
    //
    // `item.title` is one of five fixed strings from ROLE_BLUEPRINT — the same words on
    // every run — so it carries no information about *this* one and can only ever add the
    // same noise. Measured 2026-08-10 on the request that started this work
    // (「UPCLASSのテキストの続編を…」):
    //
    //   owner prompt alone                                   lesson-video, ollama-qwen
    //   "Architecture, system implementation and integration" using-n8n-mcp-skills, figma-use
    //   both concatenated                                     using-n8n-mcp-skills, figma-use
    //
    // The owner's words did not reach the result at all. A request to list teaching
    // materials was handed ~900 tokens of n8n and Figma instructions because the word
    // "Architecture" is in a role description BigKiji wrote about itself.
    //
    // This exact bug was found and fixed for model tiers on 2026-08-03 — see
    // routing-assignment-selftest "a role title cannot decide the tier", where /architect/
    // in the same string sent every leader assignment to the design tier. The fix reached
    // resolveModel and not this line, which is the third time in this repository that a
    // correction has landed on one of two identical call sites.
    try {
      const matched = this.skills.match(run.prompt) || [];
      item.skills = matched.map((skill) => skill.id);
      skillBrief = this.skills.brief(run.prompt);
    } catch (_) {}
    const plan = deliberate.brief(run.deliberation);
    // Static by construction — the path and the protocol, never the contents. See
    // _handoffDir: the approval covers the channel, the run fills it.
    const handoff = `\n\nHANDOFF ${this._handoffDir(run)}\n`
      + 'The other specialists on this run write one markdown file here as each of them finishes: role, provider, '
      + 'the files they changed, and what they concluded. Read every file in that directory before you edit anything, '
      + 'and read it again before you report. It is normal for it to be empty — that means nobody has finished yet, '
      + 'not that nobody is working. Do not write to it; it is written for you.\n';
    const suffix = `${plan ? `\n\n${plan}\n` : ''}${skillBrief ? `\n\n${skillBrief}\n` : ''}${handoff}`;
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
    // A finished diagnosis belongs to the assignment it was asked about, not to itself.
    if (assignment?.kind === 'diagnosis' && ['completed', 'failed'].includes(task.status)) {
      const target = run.assignments.find((item) => item.taskId === assignment.diagnosisFor);
      const said = String(task.output || '');
      const cause = (said.match(/CAUSE:\s*(.+)/i) || [])[1] || '';
      const fix = (said.match(/FIX:\s*(.+)/i) || [])[1] || '';
      if (target && (cause || fix)) {
        target.diagnosis = { cause: knowledge.cleanText(cause, 400), fix: knowledge.cleanText(fix, 400), provider: task.provider };
        // Remembered now rather than at the end, because a run that dies mid-repair
        // still learned something and the next run should not pay to learn it again.
        this.failures.record({ signature: this._signature(run, target), prompt: run.prompt,
          cause: target.diagnosis.cause, fix: target.diagnosis.fix, runId: run.id, provider: target.provider });
        knowledge.recordEvent(run.id, { type: 'diagnosis', status: task.status, provider: task.provider,
          evidence: `${target.role}: ${target.diagnosis.cause}` });
        this.emit('diagnosis', { runId: run.id, role: target.role, ...target.diagnosis });
      }
    }
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
      // Leave the note first, before anything that can throw. A specialist still queued
      // behind maxParallel, and every repair cycle after this, reads it.
      assignment.handoff = this._writeHandoff(run, assignment, task);
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
    // A diagnosis is not a deliverable. It is read-only, it exists to explain the
    // failures below it, and a diagnosis that itself fails must not become another
    // thing to repair — that is how a repair loop turns into a repair loop about the
    // repair loop.
    const failed = run.assignments.filter((item) => item.status !== 'completed' && item.kind !== 'diagnosis');

    // Ask why, once, before trying anything again.
    //
    // Until now the retry carried the error string and nothing else: a different
    // provider, the same plan, no question asked. So the same wall was hit until
    // maxRepairCycles ran out. This costs one read-only call — local first — and does
    // not spend a repair cycle, because asking is not attempting.
    if (failed.length && !run.diagnosed && run.repairCycle < run.maxRepairCycles) {
      run.diagnosed = true;
      let asked = 0;
      for (const item of failed) asked += this._planDiagnosis(run, item) ? 1 : 0;
      if (asked) { run.status = 'DIAGNOSING'; this._emit(run, 'diagnosis'); return; }
    }

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
        run.status = 'AWAITING_APPROVAL';
        // The repair does not stop to ask (owner decision, 2026-08-05). The first plan
        // is approved as it always was; its repair is the continuation of work already
        // approved, and stopping there was why an unattended run never finished. The
        // safety gates are elsewhere and unchanged: SECURITY_BLOCKED is decided in
        // _seal() before any of this, and an empty plan still waits because an empty
        // plan is a bug and not permission.
        if (REPAIR_RUNS_UNATTENDED || !this._needsApproval(run)) {
          // Not 'repair-awaiting-approval'. It is not waiting, and a status that names
          // a state it is not in is the class of lie this project keeps removing.
          this._emit(run, 'repair-released'); this._release(run); return;
        }
        this._emit(run, 'repair-awaiting-approval'); return;
      }
    }
    run.status = failed.length ? 'FAILED' : 'VERIFYING';
    run.quality.checks = [
      // Diagnoses are not specialists. Counting them would inflate the denominator and,
      // worse, let a completed diagnosis satisfy a run whose real work all failed.
      { id: 'specialists', pass: !failed.length,
        evidence: `${run.assignments.filter((item) => item.kind !== 'diagnosis' && item.status === 'completed').length}/${run.assignments.filter((item) => item.kind !== 'diagnosis').length} assignments completed` },
      { id: 'maker-checker', pass: run.assignments.some((item) => !item.write && item.kind !== 'diagnosis' && item.status === 'completed'),
        evidence: 'Independent read-only checker assignment' },
    ];
    const verified = run.quality.checks.every((check) => check.pass);
    clearTimeout(run.deadlineTimer); run.deadlineTimer = null;
    run.status = verified ? 'COMPLETED' : 'FAILED'; run.finishedAt = new Date().toISOString();
    run.report = this.buildReport(run);
    knowledge.recordEvent(run.id, { type: 'run-finish', status: run.status, provider: run.leader,
      evidence: run.quality.checks.map((c) => `${c.id}:${c.pass}`).join(', ') });
    // …and on the plan record itself, so the task index stops reading `planned` for
    // work that is over. Best-effort: only requests the swarm planner indexed have one.
    knowledge.recordTaskOutcome?.(run.prompt, verified ? 'completed' : 'failed',
      run.quality.checks.filter((c) => !c.pass).map((c) => c.id).join(', ') || run.id);
    // Write the run down in English, with the prompt as given and the gap between what
    // was asked and what shipped, for whoever improves these prompts next.
    // Deliberately not awaited: this is a long-lived daemon and the ledger is not
    // allowed to delay or fail a run.
    this.ledger.record(run);
    // Tell the memory what its plan was worth.
    //
    // store() ran at planning time and nothing ever came back, so a plan that led
    // straight to a failed run was recalled forever with the same confidence as one
    // that shipped. This is the half that makes it a memory rather than a cache: the
    // failing check is named, so the entry carries why rather than only that.
    // And tell the failure memory whether its remedy was any good. record() said the
    // failure happened; without this the file would fill with confident advice that has
    // never once been checked against an outcome.
    for (const item of run.assignments) {
      if (!item.diagnosis || item.kind === 'diagnosis') continue;
      this.failures.resolve({ signature: this._signature(run, item), ok: run.status === 'COMPLETED' });
    }
    this.memory.record(run.prompt, { ok: run.status === 'COMPLETED', runId: run.id,
      reason: run.quality.checks.filter((check) => !check.pass).map((check) => check.id).join(', ') || run.error || '' });
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
    if (TERMINAL_RUN.includes(run.status) || run.aborting) return;
    const done = run.assignments.filter((item) => item.status === 'completed');
    const running = run.assignments.filter((item) => ['running', 'dispatching', 'executing'].includes(String(item.status).toLowerCase()));
    // Nothing running and nothing new finished since the last checkpoint: this run is
    // not slow, it is stuck. Count those in a row; anything moving resets the count.
    if (!running.length && done.length === run.stalledAtDone) run.stalledCheckpoints = (run.stalledCheckpoints || 0) + 1;
    else { run.stalledCheckpoints = 0; run.stalledAtDone = done.length; }
    if (run.stalledCheckpoints >= STALL_CHECKPOINTS) return this._failStalled(run, done);
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
   * End a run that has stopped moving, and stop the clock with it.
   *
   * FAILED rather than EXPIRED: EXPIRED means the owner never answered, and reusing it
   * here would tell them they had ignored something they were never asked. The error
   * says what was and was not finished, because that is the only part still worth
   * knowing — the assignments that never started left no output to keep.
   *
   * The timer is not re-armed. That is the whole point.
   */
  _failStalled(run, done = run.assignments.filter((item) => item.status === 'completed')) {
    clearTimeout(run.deadlineTimer);
    run.deadlineTimer = null;
    run.status = 'FAILED';
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    const stuck = run.assignments.filter((item) => item.status !== 'completed')
      .map((item) => `${item.role} · ${item.provider}`).join(', ');
    run.error = `stalled — ${done.length}/${run.assignments.length} finished and nothing moved for `
      + `${Math.round((STALL_CHECKPOINTS * CHECKPOINT_MS) / 60000)} minutes`
      + `${stuck ? ` (never finished: ${stuck})` : ''}`;
    knowledge.recordEvent(run.id, { type: 'run-stalled', status: run.status, provider: run.leader, evidence: run.error });
    knowledge.recordTaskOutcome?.(run.prompt, 'stalled', run.error);
    this.emit('stalled', { runId: run.id, error: run.error, completed: done.length, total: run.assignments.length });
    this._emit(run, 'stalled');
    return run;
  }

  /**
   * The sweep for runs nobody is waiting on an answer for.
   *
   * `expireStaleApprovals` covers AWAITING_APPROVAL and is called from `submit()`, which
   * means it only runs when the owner starts something new. A run that stalls in a
   * session the owner then walks away from is reached by neither — which is exactly what
   * happened for 54 hours. The daemon calls this on a timer; the coordinator does not own
   * one, so that the class stays testable with an injected clock.
   */
  expireStalledRuns(now = Date.now()) {
    const failed = [];
    for (const run of this.runs.values()) {
      if (TERMINAL_RUN.includes(run.status) || run.status === 'AWAITING_APPROVAL' || run.aborting) continue;
      const moving = run.assignments?.some((item) => ['running', 'dispatching', 'executing'].includes(String(item.status).toLowerCase()));
      if (moving) continue;
      const since = new Date(run.updatedAt || run.startedAt || run.createdAt).getTime();
      if (!Number.isFinite(since) || now - since < STALL_TTL_MS) continue;
      failed.push(this._failStalled(run));
    }
    for (const run of failed) this.forgetRun(run);
    return failed.length;
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
    // The notes were for the specialists, and the specialists are gone. The report has
    // already taken what it needs. Left behind, these accumulate one directory per run
    // forever — which is exactly how 1,446 worktrees and 35 GB happened.
    try { fs.rmSync(this._handoffDir(run), { recursive: true, force: true }); } catch (_) {}
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

  /** One role's patch, bounded. Empty when it wrote nothing or the diff cannot be read. */
  _roleDiff(assignment, { maxLines = 60, maxChars = 6000 } = {}) {
    let patch = '';
    try { patch = String(collectDiff(assignment.workspace)?.patch || ''); } catch (_) { return ''; }
    if (!patch.trim()) return '';
    const lines = patch.split('\n');
    const kept = lines.slice(0, maxLines).join('\n').slice(0, maxChars);
    const dropped = patch.length - kept.length;
    // A report is published to every surface and written into the session file. Say what
    // was cut — a silently truncated patch reads as a complete one, and the owner is
    // deciding whether to merge it.
    return dropped > 0 ? `${kept}\n… ${dropped} more characters — full diff in ${assignment.workspace.path}` : kept;
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
        // The lines this role wrote, so the roles can be read against each other.
        //
        // Gap 2 of the orchestration the owner described. Merging two providers'
        // edits automatically has no track record here and that judgement stands —
        // so this integrates them for a HUMAN instead: one screen, one block per
        // role, the actual diff under each. The merge stays an owner action.
        //
        // Only for an isolated writer, because only a worktree can produce a diff
        // that is this role's alone; a shared directory would attribute everyone's
        // work to whoever is asked last.
        diff: assignment.workspace?.isolated ? this._roleDiff(assignment) : '',
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
    // Cooling is not the only reason a stand-in cannot take the role. `_pick` has
    // always filtered on three things — the breaker, `isAvailable`, and the owner's
    // paid allowlist — and this walk only looked at the first. It could therefore hand
    // an assignment to a provider with no key configured, or to one the owner had
    // deliberately taken out of rotation. That fails, the failure costs a repair cycle,
    // and a repair cycle asks the owner to approve again: the same loop a spent
    // allowance produced before the router learned to recognise one.
    //
    // It went unnoticed while the chains were short and hand-written. The owner's
    // 2026-08-05 order puts Gemini in every chain, and Gemini is the provider most
    // likely to have no key on a given machine, so the gap would have shown up
    // immediately.
    //
    // Unavailable is NOT the same as cooling, and only the second is worth reporting:
    // a cooldown ends by itself and the number of seconds is useful, while "no key" is
    // a standing fact the owner already knows from the settings window.
    const allowed = this.paidAllowlist();
    const permitted = (provider) => (!PAID_PROVIDERS.has(provider) || allowed.has(provider))
      && this.isAvailable(provider);
    let next = null; const skipped = []; const unusable = [];
    for (let index = assignment.fallbackIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!permitted(candidate)) { unusable.push(candidate); continue; }
      if (!this.breaker.allow(candidate)) {
        skipped.push(`${candidate} (${Math.round(this.breaker.retryInMs(candidate) / 1000)}s)`);
        continue;
      }
      next = candidate; assignment.fallbackIndex = index + 1; break;
    }
    if (unusable.length) {
      knowledge.recordEvent(run.id, { type: 'fallback-unavailable', status: run.status, provider: assignment.provider,
        evidence: `no key or not on the paid allowlist: ${unusable.join(', ')}` });
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
  /** How this failure is remembered: its classification plus the check it broke. */
  _signature(run, assignment) {
    const task = this.taskRunner.get(assignment.taskId);
    return signatureOf({ reason: String(task?.failureReason || 'unclassified'), check: assignment.role || '' });
  }

  /**
   * Ask why it failed, before trying it again.
   *
   * Read-only by construction — `write: false`, so a repair can never acquire a
   * permission the original plan did not have. Local first for the same reason the
   * front desk is local: a diagnosis is cheap thinking about text we already hold, and
   * paying a cloud provider to read an error message is how a failed run gets
   * expensive. Anything already known about this signature is handed over, so the
   * second occurrence starts where the first one finished instead of rediscovering it.
   *
   * @returns {boolean} true when a diagnosis was planned
   */
  _planDiagnosis(run, assignment) {
    if (assignment.diagnosis || assignment.diagnosisAsked) return false;
    const failedTask = this.taskRunner.get(assignment.taskId);
    const reason = String(failedTask?.failureReason || 'unclassified');
    const known = this.failures.lookup({ signature: this._signature(run, assignment), prompt: run.prompt });
    const provider = this._pick('debug', ['qwen', 'glm', 'gemini', 'claude-code']);
    if (!provider) return false;
    assignment.diagnosisAsked = true;
    const prompt = `BIGKIJI DIAGNOSIS ${run.id}\nOwner goal: ${run.prompt}\n`
      + `The ${assignment.role} assignment failed on ${assignment.provider} (${assignment.model || 'unknown model'}).\n`
      + `Classified as: ${reason}\n`
      + `Error: ${knowledge.cleanText(failedTask?.error, 800)}\n`
      + (known ? `Seen ${known.occurrences} time(s) before. Recorded cause: ${known.cause || 'none'}. Recorded fix: ${known.fix || 'none'}.\n` : '')
      + 'This is read-only. Do not edit files, run builds, or start anything.\n'
      + 'Answer in exactly two lines and nothing else:\nCAUSE: <one sentence naming the single cause>\nFIX: <one sentence naming the smallest change that would avoid it>';
    const task = this.taskRunner.plan({
      id: `${assignment.taskId}-diagnosis-${run.repairCycle}`,
      provider, model: resolveModel(provider, run.prompt, 'debug', { write: false }), cwd: run.cwd, planHash: run.planHash,
      prompt, metadata: { runId: run.id, kind: 'diagnosis', diagnosisFor: assignment.taskId, write: false },
    });
    this.taskToRun.set(task.id, run.id);
    run.assignments.push({ taskId: task.id, kind: 'diagnosis', role: 'diagnosis', provider, model: task.model,
      write: false, title: `Why the ${assignment.role} assignment failed`, status: task.status,
      disclosureHash: task.disclosure?.disclosureHash || '', diagnosisFor: assignment.taskId });
    return true;
  }

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
      // The diagnosis leads, the error follows. This line used to be the error string
      // alone, which told the replacement provider what happened and nothing about why
      // — so it re-ran the same plan and hit the same wall, three times, by design.
      prompt: `${oldTask?.prompt || run.prompt}\n`
        + (assignment.diagnosis ? `Diagnosis: ${assignment.diagnosis.cause}\nSmallest fix: ${assignment.diagnosis.fix}\n` : '')
        + `Previous provider failed: ${knowledge.cleanText(oldTask?.error, 500)}\nContinue only unfinished work and verify the repair.`,
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

module.exports = { CoreExecutionCoordinator, ROLE_BLUEPRINT, FALLBACKS, selectRoles, leaderProvider,
  ACTIVE_RUN, TERMINAL_RUN, STALL_CHECKPOINTS, STALL_TTL_MS, RUN_BUDGET_MS, CHECKPOINT_MS };
