'use strict';

// Pluggable loading animation for the BigKiji CLI footer.
//
// A frame set is plain data so it can be swapped for video-derived pixel art
// (retro chubby winged tabby cat) without touching the renderer or the footer:
//
//   { id, label, rows, width, frameMs, frames: [string, ...] }
//
// Rules a frame set must follow:
//   - every frame contains exactly `rows` lines separated by '\n'
//   - every line is exactly `width` display columns (pad with spaces)
//   - frames carry no ANSI colour; the footer paints them
//
// The footer reserves `rows` terminal rows for the art, so a 2 row set simply
// makes the footer one row taller. Nothing else has to change.

// Default: 1 row so the footer matches the requested 6 row layout exactly.
// Wings flap up -> mid -> down -> mid, with a blink on the last frame.
const WINGED_CAT_ASCII = Object.freeze({
  id: 'winged-cat-ascii',
  label: 'Chubby winged tabby — hand drawn placeholder (1 row)',
  rows: 1,
  width: 11,
  frameMs: 120,
  frames: Object.freeze([
    '/\\(=^ω^=)/\\',
    '<>(=^ω^=)<>',
    '\\/(=^ω^=)\\/',
    '<>(=^-^=)<>',
  ]),
});

// Alternative: 2 rows, so the body can actually bob between wing beats.
// Selectable today, and the shape the video derived pixel frames will take.
const WINGED_CAT_BOB = Object.freeze({
  id: 'winged-cat-bob',
  label: 'Chubby winged tabby — flapping + bobbing (2 rows)',
  rows: 2,
  width: 11,
  frameMs: 120,
  frames: Object.freeze([
    '/\\       /\\\n  (=^ω^=)  ',
    '           \n<>(=^ω^=)<>',
    '  (=^ω^=)  \n\\/       \\/',
    '           \n<>(=^-^=)<>',
  ]),
});

const FRAME_SETS = Object.freeze({
  [WINGED_CAT_ASCII.id]: WINGED_CAT_ASCII,
  [WINGED_CAT_BOB.id]: WINGED_CAT_BOB,
});
const DEFAULT_FRAME_SET_ID = WINGED_CAT_ASCII.id;
const LOADING_TEXT = 'LOADING...';

function loadingFrames(id = DEFAULT_FRAME_SET_ID) { return FRAME_SETS[id] || FRAME_SETS[DEFAULT_FRAME_SET_ID]; }

function frameAt(index = 0, set = loadingFrames()) {
  const frames = set?.frames?.length ? set.frames : [''];
  const size = frames.length; const position = Math.trunc(Number(index) || 0);
  return frames[((position % size) + size) % size];
}

// Returns exactly `set.rows` lines, each padded to `set.width` columns.
function frameRows(index = 0, set = loadingFrames()) {
  const rows = Math.max(1, Number(set?.rows) || 1);
  const width = Math.max(1, Number(set?.width) || 1);
  const lines = String(frameAt(index, set)).split('\n');
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows).map((line) => (line.length >= width ? line.slice(0, width) : line + ' '.repeat(width - line.length)));
}

module.exports = { FRAME_SETS, DEFAULT_FRAME_SET_ID, LOADING_TEXT, loadingFrames, frameAt, frameRows };
