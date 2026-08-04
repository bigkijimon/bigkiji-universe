// The approval gate, as arithmetic rather than as DOM.
//
// Nothing that can mutate anything starts without passing through here, and the hashes
// have to be echoed back exactly — core-execution-coordinator.js approve() throws
// STALE_RUN_REVISION / STALE_PLAN_HASH / STALE_DISCLOSURE_HASH rather than running
// something the owner did not see. An approval button that always fails is worse than no
// approval button, so the payload is built by a pure function and tested directly instead
// of being grepped for out of a render tree.
//
// The rule these functions encode: echo the run object you were handed, never a value
// reassembled from component state. Anything that lets a revision go stale between the
// render and the click is a bug in the caller, not something to paper over here.

const WAITING = 'AWAITING_APPROVAL';
const BLOCKED = 'SECURITY_BLOCKED';

/** Is this run asking the owner for a decision at all? */
export function isAwaitingDecision(run) {
  return !!run && (run.status === WAITING || run.status === BLOCKED);
}

/** The sandbox refused part of the run. Surfaced, but not approvable. */
export function isBlocked(run) {
  return !!run && run.status === BLOCKED;
}

/**
 * The exact object sent to run:approve, or null when this run must not be approved.
 * Returning null rather than a payload is deliberate: a blocked run has no valid
 * approval, and the caller cannot accidentally send one by ignoring a boolean.
 */
export function buildApprovalPayload(run) {
  if (!isAwaitingDecision(run) || isBlocked(run)) return null;
  return {
    id: run.id,
    revision: run.revision,
    planHash: run.planHash,
    disclosureHash: run.disclosureHash,
    // So a double click is not a double start. Keyed by revision as well as id: a new
    // revision is a genuinely different thing to approve.
    idempotencyKey: `console-${run.id}-${run.revision}`,
  };
}

/**
 * What the owner is actually being asked to approve.
 *
 * The run object carries the goal, the constraints, the questions the plan could not
 * answer, every assignment's role / agent / model / write permission, and the exact
 * files each one will open — and this window used to show two strings: a count of
 * specialists and a row of hash prefixes. Measured 2026-08-04, on a run whose plan
 * contained an unanswered question for the owner that no surface ever displayed.
 *
 * Same shape of answer as the CLI's run block, deliberately: two surfaces disagreeing
 * about what a plan says is worse than either of them being terse.
 *
 * Nothing is inferred. `write` absent is not `write` false — an assignment the
 * coordinator did not mark gets no access badge rather than a guessed one.
 */
export function approvalPlan(run) {
  if (!isAwaitingDecision(run)) return null;
  const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const list = (value) => (Array.isArray(value) ? value.map(flat).filter(Boolean) : []);
  const spec = run.promptSpec || {};
  const assignments = Array.isArray(run.assignments) ? run.assignments : [];
  return {
    goal: flat(spec.goal),
    constraints: list(spec.constraints),
    questions: list(spec.questions),
    stage: flat(run.stage),
    // What the groundwork produced, or did not. `null` when this run never had a
    // deliberation stage — which is not the same as a deliberation that produced nothing,
    // and must not render as a warning.
    groundwork: run.groundwork ? {
      lenses: Number(run.groundwork.lenses) || 0,
      completed: Number(run.groundwork.completed) || 0,
      steps: Number(run.groundwork.steps) || 0,
      failures: (Array.isArray(run.groundwork.failures) ? run.groundwork.failures : []).map((item) => ({
        who: flat(item.title || item.lens),
        engine: flat(item.model || item.provider),
        reason: flat(item.reason) || flat(item.status),
      })),
    } : null,
    writes: assignments.length ? assignments.some((item) => item.write !== false) : null,
    rows: assignments.map((item) => {
      const provider = flat(item.provider).toLowerCase();
      const model = flat(item.model).toLowerCase();
      return {
        key: item.taskId || `${provider}-${flat(item.title)}`,
        who: [flat(item.role), flat(item.agent)].filter(Boolean).join(' · '),
        engine: model ? (provider && !model.startsWith(provider) ? `${provider} ${model}` : model) : provider,
        access: typeof item.write === 'boolean' ? (item.write ? 'write' : 'read') : '',
        title: flat(item.title),
        status: flat(item.status),
      };
    }),
    reads: (Array.isArray(run.disclosures) ? run.disclosures : []).map((disclosure) => ({
      provider: flat(disclosure.provider).toLowerCase(),
      files: (Array.isArray(disclosure.files) ? disclosure.files : [])
        .filter((file) => file && file.path).map((file) => flat(file.path)),
    })).filter((entry) => entry.files.length),
  };
}

/** What the gate says about itself, so the copy is testable too. */
export function approvalSummary(run) {
  if (!isAwaitingDecision(run)) return null;
  const count = run.assignments?.length || 0;
  return {
    blocked: isBlocked(run),
    title: isBlocked(run)
      ? 'The sandbox refused part of this run'
      : `${count} specialist${count === 1 ? '' : 's'} ready · your approval starts them`,
    detail: `plan ${String(run.planHash || '').slice(0, 12)} · disclosure ${String(run.disclosureHash || '').slice(0, 12)} · rev ${run.revision}`,
  };
}
