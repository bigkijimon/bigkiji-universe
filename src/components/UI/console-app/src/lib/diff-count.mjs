// How much of the workspace a run has actually changed.
//
// Lifted verbatim out of console.js, where it lived inside the window's IIFE and could
// only be tested by slicing the source text and rebuilding it with new Function(). It is
// the same arithmetic; the only change is that it is now importable, so the test calls it
// the way the app does.
//
// This is a counter, not a second diff renderer: one number for added lines and one for
// removed, so "approve" is not a blind yes. A provider only starts being counted once it
// emits a hunk header, because a bare '+' at the start of a line is ordinary prose far
// more often than it is a patch.
//
// KNOWN, MEASURED LIMITATION — read before trusting the output.
//   The text this is fed arrives via task:log, and task-runner.js:172 passes every stdout
//   chunk through knowledge.cleanText(), whose body is `.replace(/\s+/g, ' ')`. Newlines
//   are gone by the time the renderer sees anything, so split('\n') yields a single
//   element and /^@@ / almost never matches. In practice this counter has reported 0/0
//   since the window was built.
//   The fix is not here: it is to count from the structured task:step events, which are
//   parsed from the raw stdout buffer before cleanText() flattens it. This module and its
//   tests are kept because the arithmetic is correct and the six cases it pins are real
//   patch-vs-prose distinctions that the step-based counter must also get right.

const HUNK = /^@@ /;
const FILE_START = /^(diff --git |Index: )/;
const FILE_META = /^(\+\+\+ |--- |index |new file |deleted file |old mode |new mode |similarity |rename |Binary files )/;

export function createDiffCounter() {
  const diffs = new Map(); // taskId -> { added, removed, patching, inHunk }

  function countDiff(taskId, text) {
    const seen = diffs.get(taskId) || { added: 0, removed: 0, patching: false, inHunk: false };
    for (const line of String(text).split('\n')) {
      if (HUNK.test(line)) { seen.patching = true; seen.inHunk = true; continue; }
      if (FILE_START.test(line)) { seen.patching = true; seen.inHunk = false; continue; }
      if (!seen.patching) continue;
      // Between `diff --git` and the first `@@` come the file headers. Inside a hunk
      // those same prefixes are content: `+++i;` is a line somebody added, and a removed
      // markdown rule is `----`. Only skip them where they can actually be headers.
      if (!seen.inHunk) { if (FILE_META.test(line)) continue; }
      if (line.startsWith('+')) { seen.added += 1; continue; }
      if (line.startsWith('-')) { seen.removed += 1; continue; }
      if (line === '' || line.startsWith(' ') || line.startsWith('\\')) continue; // context
      // A hunk runs until something that is not diff-shaped. Without this the first patch
      // put the task into counting mode forever, and every "- ran tests" the provider
      // wrote afterwards was tallied as a deleted line.
      seen.patching = false; seen.inHunk = false;
    }
    diffs.set(taskId, seen);
    return seen;
  }

  function totals() {
    let added = 0; let removed = 0;
    for (const entry of diffs.values()) { added += entry.added; removed += entry.removed; }
    return { added, removed };
  }

  // A new run starts a new count. Carrying the previous run's tally forward would make
  // the number the owner approves against wrong in the one direction that matters —
  // larger than what is about to happen.
  function clear() { diffs.clear(); }

  return { countDiff, totals, clear, diffs };
}
