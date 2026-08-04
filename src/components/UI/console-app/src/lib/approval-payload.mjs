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
