// Provider output is raw CLI text. Two things must be true before any of it is shown.
//
// 1. Escape sequences are stripped. They are control codes for a terminal, not content,
//    and the specialist panes are ordinary DOM rather than an emulator.
// 2. The log is bounded. A long run must not grow the DOM without limit — this used to be
//    LOG_LINES + removeChild(log.firstChild) in console.js and is the same rule here.
//
// The text itself is always set as text, never parsed. That happens at the call site; the
// job of this module is only to make the string safe to look at and finite in length.

export const LOG_LINES = 400;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI, '');
}

/**
 * A fixed-capacity line buffer. Push returns the new contents rather than mutating a
 * caller-visible array, so React state updates stay a plain replacement.
 */
export function appendBounded(lines, text, limit = LOG_LINES) {
  const next = lines.concat(stripAnsi(text));
  return next.length > limit ? next.slice(next.length - limit) : next;
}
