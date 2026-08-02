'use strict';
// Deciding what a burst of filesystem events becomes.
//
// Pure Node and side-effect free so it can be tested without Electron: the caller owns
// the queue, the clock and the rescan. Everything here is one decision — how much of the
// backlog to drain this tick, and when the backlog stops being worth draining at all.
//
// The rule this replaced took the first six paths and cleared the queue, so a branch
// switch or a build reported six files and silently dropped the rest. The map then
// disagreed with the disk until the five-minute full rescan happened to catch up.

// Each queued path costs one stat on flush, so the per-tick ceiling keeps a burst off
// the main thread. It is not a judgement about which changes matter.
const DEFAULTS = Object.freeze({ min: 6, max: 120, rescanThreshold: 600, share: 4 });

function backlogOf(queue) {
  let total = 0;
  for (const names of queue.values()) total += names.size;
  return total;
}

// Drains `queue` in place and returns what the caller should do with this tick.
//
// `rescan` means the backlog is large enough that a full walk answers faster than the
// queue can drain — the caller rescans and the queue is emptied. `incremental` carries
// the paths taken this tick; whatever did not fit stays queued for the next one.
function drainTouchQueue(queue, options = {}) {
  const { min, max, rescanThreshold, share } = { ...DEFAULTS, ...options };
  const backlog = backlogOf(queue);
  if (!backlog) return { mode: 'idle', backlog: 0, taken: 0, byRoot: new Map() };
  if (backlog > rescanThreshold) {
    queue.clear();
    return { mode: 'rescan', backlog, taken: 0, byRoot: new Map() };
  }
  let budget = Math.min(max, Math.max(min, Math.ceil(backlog / share)));
  const byRoot = new Map();
  let taken = 0;
  for (const [key, names] of queue) {
    if (budget <= 0) break;
    const batch = [];
    // Deleting an already-visited entry mid-iteration is defined behaviour for a Set,
    // and doing it here is what makes the remainder survive into the next tick.
    for (const name of names) {
      if (budget <= 0) break;
      batch.push(name); names.delete(name); budget -= 1;
    }
    if (batch.length) { byRoot.set(key, batch); taken += batch.length; }
  }
  for (const [key, names] of queue) if (!names.size) queue.delete(key);
  return { mode: 'incremental', backlog, taken, byRoot, remaining: backlogOf(queue) };
}

module.exports = { drainTouchQueue, backlogOf, WATCH_DEFAULTS: DEFAULTS };
