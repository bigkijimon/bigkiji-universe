// Folding the task:step stream into the list the owner reads.
//
// The parser upstream reports facts as they happen: a start when a tool is invoked, an end
// when it returns, correlated by tool_use_id. This turns that into an ordered list of
// steps with a status each, which is what a timeline is.
//
// Presentation lives here rather than in the parser, deliberately — `added: 12` crosses
// the IPC boundary, and '+12' is decided at the point of display.

/** A step that has started but not returned is running; that is the only 'running' state. */
export function foldSteps(steps, events) {
  let next = steps;
  for (const event of events) {
    if (!event || !event.taskId) continue;
    if (event.phase === 'start') {
      next = next.concat({
        key: `${event.taskId}:${event.toolUseId || event.seq}`,
        taskId: event.taskId,
        provider: event.provider,
        tool: event.tool || 'Tool',
        target: event.target || '',
        added: event.added || 0,
        removed: event.removed || 0,
        status: 'running',
        startedAt: event.at,
      });
      continue;
    }
    if (event.phase === 'end') {
      const key = `${event.taskId}:${event.toolUseId || ''}`;
      let matched = false;
      next = next.map((step) => {
        // Match the most recent still-running step with this id. An end with no matching
        // start is dropped rather than invented — a step nobody watched begin is not
        // something to draw.
        if (matched || step.key !== key || step.status !== 'running') return step;
        matched = true;
        return {
          ...step,
          status: event.ok === false ? 'error' : 'ok',
          errorText: event.errorText || '',
          endedAt: event.at,
          durationMs: step.startedAt && event.at
            ? Math.max(0, new Date(event.at).getTime() - new Date(step.startedAt).getTime())
            : null,
        };
      });
    }
  }
  return next;
}

/** Steps belonging to one run, in the order they started. */
export function stepsForRun(steps, run) {
  if (!run?.assignments?.length) return steps;
  const wanted = new Set(run.assignments.map((item) => item.taskId));
  return steps.filter((step) => wanted.has(step.taskId));
}

/**
 * Progress, expressed against what is actually known.
 *
 * `total` is the number of steps seen so far, not a prediction — the provider does not
 * announce how many tools it will use, and inventing a denominator would be a progress bar
 * that lies. What this does give the owner is a count that never starts at a bare zero:
 * planning genuinely ran before the first tool, so it is shown as a completed step.
 */
export function progressOf(steps) {
  const done = steps.filter((step) => step.status !== 'running').length;
  const running = steps.find((step) => step.status === 'running') || null;
  const failed = steps.filter((step) => step.status === 'error').length;
  const totals = steps.reduce((acc, step) => ({
    added: acc.added + (step.status === 'ok' ? step.added : 0),
    removed: acc.removed + (step.status === 'ok' ? step.removed : 0),
  }), { added: 0, removed: 0 });
  return { done, total: steps.length, running, failed, ...totals };
}

const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Files this run actually changed, newest first — the honest input to an artifacts list. */
export function changedFiles(steps) {
  const seen = new Map();
  for (const step of steps) {
    if (!WRITERS.has(step.tool) || step.status !== 'ok' || !step.target) continue;
    const previous = seen.get(step.target) || { path: step.target, added: 0, removed: 0, edits: 0 };
    seen.set(step.target, {
      path: step.target,
      added: previous.added + step.added,
      removed: previous.removed + step.removed,
      edits: previous.edits + 1,
      at: step.endedAt || step.startedAt,
    });
  }
  return [...seen.values()].reverse();
}
