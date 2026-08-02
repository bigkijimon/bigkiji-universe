'use strict';
// What happens to a burst of file changes.
//
// The old flush took the first six paths and called touchQueue.clear(), so editing a
// branch, running a build, or renaming a folder reported six files and dropped the
// rest. Nothing failed and nothing was logged — the 3D map simply disagreed with the
// disk until the five-minute full rescan happened to notice. That is the failure this
// file exists to prevent, so the first assertion counts every path back out again.

const assert = require('assert');
const { drainTouchQueue, backlogOf, WATCH_DEFAULTS } = require('../src/core/watch-queue');

const queueOf = (entries) => new Map(Object.entries(entries).map(([root, names]) => [root, new Set(names)]));

// ---- nothing queued is not an event ------------------------------------------
assert.strictEqual(drainTouchQueue(new Map()).mode, 'idle');
assert.strictEqual(backlogOf(new Map()), 0);

// ---- a burst drains completely, over as many ticks as it takes ---------------
const many = Array.from({ length: 100 }, (_, i) => `src/file-${i}.js`);
const queue = queueOf({ '/vault': many });
const seen = [];
let ticks = 0;
while (backlogOf(queue) && ticks < 50) {
  const drained = drainTouchQueue(queue);
  ticks += 1;
  assert.strictEqual(drained.mode, 'incremental');
  for (const batch of drained.byRoot.values()) seen.push(...batch);
}
assert.strictEqual(seen.length, 100, 'every queued change has to come back out — this is the regression');
assert.deepStrictEqual([...new Set(seen)].sort(), [...many].sort(), 'and exactly once each, unchanged');
assert(ticks > 1, 'a hundred files is more than one tick of work');
// The flush runs every 900ms, so this bound is the one that matters to the owner: a
// hundred changed files show up within about ten seconds. Draining six per tick — the
// old fixed budget — would have taken seventeen.
assert(ticks <= 11, `a burst has to clear in seconds, not minutes (took ${ticks} ticks ≈ ${(ticks * 0.9).toFixed(1)}s)`);

// ---- the remainder is carried, not dropped -----------------------------------
const carried = queueOf({ '/vault': many });
const first = drainTouchQueue(carried);
assert.strictEqual(first.taken + first.remaining, 100, 'taken plus carried must account for the whole backlog');
assert(first.remaining > 0, 'the point of carrying is that something is left');
assert.strictEqual(backlogOf(carried), first.remaining);

// ---- two roots can hold the same relative path -------------------------------
// Resolving a path against the wrong root silently points at a different file, so the
// batches stay keyed by the root they arrived on.
const split = queueOf({ '/a': ['notes/index.md'], '/b': ['notes/index.md'] });
const both = drainTouchQueue(split);
assert.deepStrictEqual(both.byRoot.get('/a'), ['notes/index.md']);
assert.deepStrictEqual(both.byRoot.get('/b'), ['notes/index.md']);
assert.strictEqual(both.taken, 2);
assert.strictEqual(split.size, 0, 'a root with nothing left queued is removed, not kept as an empty set');

// ---- a small edit still drains in one tick ------------------------------------
const single = queueOf({ '/vault': ['src/core/main.js'] });
const one = drainTouchQueue(single);
assert.strictEqual(one.taken, 1);
assert.strictEqual(one.remaining, 0);

// ---- the per-tick ceiling holds ----------------------------------------------
// Each path costs a stat, so a huge tick would block the main thread. The cap bounds
// the work; it does not decide which changes matter.
const wide = queueOf({ '/vault': Array.from({ length: WATCH_DEFAULTS.rescanThreshold }, (_, i) => `f${i}`) });
const capped = drainTouchQueue(wide);
assert.strictEqual(capped.mode, 'incremental', 'exactly at the threshold is still incremental');
assert(capped.taken <= WATCH_DEFAULTS.max, `never more than ${WATCH_DEFAULTS.max} stats in one tick`);

// ---- past the threshold, rescanning is the honest answer ----------------------
// A branch switch is not six hundred separate edits worth tracking. Draining it path by
// path would lag for minutes, so the caller is told to walk the tree instead — and the
// count is reported rather than quietly discarded.
const bulk = queueOf({ '/vault': Array.from({ length: WATCH_DEFAULTS.rescanThreshold + 1 }, (_, i) => `f${i}`) });
const rescan = drainTouchQueue(bulk);
assert.strictEqual(rescan.mode, 'rescan');
assert.strictEqual(rescan.backlog, WATCH_DEFAULTS.rescanThreshold + 1, 'the caller can say how much it gave up on');
assert.strictEqual(rescan.byRoot.size, 0);
assert.strictEqual(backlogOf(bulk), 0, 'the queue is emptied, because the rescan supersedes it');

// ---- thresholds are arguments, not hard-coded ---------------------------------
const tuned = queueOf({ '/vault': ['a', 'b', 'c'] });
assert.strictEqual(drainTouchQueue(tuned, { rescanThreshold: 2 }).mode, 'rescan');

console.log('watch queue selftest: PASS · a 100-file burst loses nothing · remainder carried, not cleared · per-root keys kept · bulk change degrades to a reported rescan');
