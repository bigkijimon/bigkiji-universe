'use strict';

// Terminal text primitives: display width, folding, glyphs.
//
// These lived inside transcript.js, which was fine while transcript.js was the only
// thing that drew. cli-markdown.js draws too, and it measures the same Japanese the
// transcript does — so either the two share this file or the codebase grows a second
// opinion about how wide 「英語教室」 is. A second opinion is how a line that measures
// as 40 columns paints as 60 and the sticky footer scrolls away.
//
// Everything here is pure: strings in, strings out. transcript.js re-exports the lot,
// so every existing caller keeps importing them from where it always did.

const { stripAnsi } = require('../../domain/terminal/cli-theme');

const DASH = '—';

// ---------------------------------------------------------------------------
// Display width
// ---------------------------------------------------------------------------

// East Asian Wide / Fullwidth blocks. The owner writes Japanese, so measuring
// with String#length would silently overflow every line by up to 2x.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const ZERO_RANGES = [[0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]];
const inRanges = (code, ranges) => ranges.some(([low, high]) => code >= low && code <= high);

function charWidth(codePoint) {
  if (codePoint === 0x00) return 0;
  if (inRanges(codePoint, ZERO_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** Display width of `text` in terminal cells, ignoring any ANSI it carries. */
function stringWidth(text) {
  const plain = stripAnsi(text === 0 ? '0' : text);
  let width = 0;
  for (const char of plain) width += charWidth(char.codePointAt(0));
  return width;
}

/** Take at most `width` display columns from the head of `text` (plain result). */
function sliceToWidth(text, width) {
  const plain = stripAnsi(text === 0 ? '0' : text);
  if (width <= 0) return '';
  let out = ''; let used = 0;
  for (const char of plain) {
    const size = charWidth(char.codePointAt(0));
    if (used + size > width) break;
    out += char; used += size;
  }
  return out;
}

/** Ellipsise a single line at `width` columns. Returns plain text. */
function truncateToWidth(text, width, ellipsis = '…') {
  const plain = stripAnsi(text === 0 ? '0' : text);
  if (width <= 0) return '';
  if (stringWidth(plain) <= width) return plain;
  const mark = stringWidth(ellipsis) <= width ? ellipsis : '';
  return sliceToWidth(plain, width - stringWidth(mark)) + mark;
}

/** Pad a plain string out to `width` display columns. */
function padToWidth(text, width) {
  const clipped = truncateToWidth(text, width);
  return clipped + ' '.repeat(Math.max(0, width - stringWidth(clipped)));
}

/**
 * Greedy word wrap that is safe for CJK: words wider than the line are broken
 * at the column rather than allowed to overflow.
 * @returns {string[]} plain lines, none wider than `width`
 */
function wrapToWidth(text, width) {
  const limit = Math.max(1, Math.trunc(width) || 1);
  const source = stripAnsi(text).replace(/\t/g, '  ');
  const out = [];
  for (const rawLine of source.split('\n')) {
    let line = ''; let lineWidth = 0; let emitted = 0;
    const flush = () => { out.push(line); emitted += 1; line = ''; lineWidth = 0; };
    for (const word of rawLine.split(' ')) {
      // A token wider than the whole line is hard-split at the column. This is
      // also the path every unspaced Japanese sentence takes, which is correct:
      // Japanese breaks anywhere, and it must never overflow the terminal.
      if (stringWidth(word) > limit) {
        if (lineWidth) flush();
        let rest = word;
        while (stringWidth(rest) > limit) {
          let head = sliceToWidth(rest, limit);
          if (!head) head = [...rest][0] || ''; // limit narrower than one wide char
          if (!head) break;
          out.push(head); emitted += 1;
          rest = rest.slice(head.length);
        }
        line = rest; lineWidth = stringWidth(rest);
        continue;
      }
      const need = stringWidth(word) + (lineWidth ? 1 : 0);
      if (lineWidth + need > limit) flush();
      line += (lineWidth ? ' ' : '') + word;
      lineWidth += need;
    }
    if (lineWidth || emitted === 0) flush();
  }
  return out.length ? out : [''];
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const UNICODE_GLYPHS = Object.freeze({
  turn: '●', result: '⎿', user: '>', note: '·',
  // The critique thread. One cell wide, East Asian Width neutral, and distinct
  // from the result elbow — a reply to a result is not a result.
  reply: '⤷',
  // Something the owner has to see before deciding: a question the plan asked and
  // nobody answered, or a step that cannot be undone.
  warn: '⚠',
  done: '☑', active: '▸', pending: '☐', ellipsis: '…', rule: '─',
});
// TERM=dumb rarely has the box-drawing elbow or the ballot boxes.
const ASCII_GLYPHS = Object.freeze({
  turn: '*', result: '\\', user: '>', note: '.',
  reply: '->',
  warn: '!',
  done: '[x]', active: '>', pending: '[ ]', ellipsis: '...', rule: '-',
});

function glyphs({ ascii = process.env.TERM === 'dumb' || process.env.BIGKIJI_CLI_ASCII === '1' } = {}) {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * Keep the first `maxLines` source lines and report how many were really
 * withheld. The count is the true remainder — never an estimate.
 * @returns {{lines: string[], hidden: number}}
 */
function foldLines(lines, maxLines) {
  const all = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const limit = Math.trunc(Number(maxLines) || 0);
  if (limit <= 0 || all.length <= limit) return { lines: all.slice(), hidden: 0 };
  return { lines: all.slice(0, limit), hidden: all.length - limit };
}

/** The marker a fold leaves behind, e.g. `… +15 lines`. */
function foldMarker(hidden, mark = UNICODE_GLYPHS.ellipsis) {
  if (!hidden) return '';
  return `${mark} +${hidden} ${hidden === 1 ? 'line' : 'lines'}`;
}

module.exports = {
  DASH, WIDE_RANGES, charWidth, stringWidth, sliceToWidth, truncateToWidth, padToWidth, wrapToWidth,
  UNICODE_GLYPHS, ASCII_GLYPHS, glyphs, foldLines, foldMarker,
};
