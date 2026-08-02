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

// ---------------------------------------------------------------------------
// Pixel kijitora, rendered from the real 16x16 sprite grids
// ---------------------------------------------------------------------------
//
// src/components/UI/assets/pixel/frames16/frame-N.txt hold 16x16 palette-index
// grids (0 = transparent) and palette.json holds the colours. Drawn with ANSI
// half-blocks — '▀' with the upper pixel as foreground and the lower pixel as
// background — a frame is 16 columns by 8 rows.
//
// Eight rows is too tall for the footer: the sticky footer is a fixed six row
// contract (art · phase vector · rule · input · rule · status) and an eight row
// cat would eat a third of a 24 row terminal and push the transcript out of
// sight. So the 8 row set is offered as a standalone "thinking" panel, and the
// footer keeps a 1 row variant — `pixel-cat-16-row`, the two most legible pixel
// rows of the cat's face — with the hand drawn ASCII cat staying the default so
// the frozen footer layout is untouched unless the owner opts in via
// BIGKIJI_CLI_CAT.

const fs = require('fs');
const path = require('path');
const { NO_COLOR } = require('../../domain/terminal/cli-theme');
const { sliceToWidth, stringWidth } = require('./transcript');

const PIXEL_DIR = path.resolve(__dirname, '..', '..', 'components', 'UI', 'assets', 'pixel');
const HALF_BLOCK = '▀';

function readPalette() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PIXEL_DIR, 'palette.json'), 'utf8'));
    return (raw.colors || []).map((entry) => (Array.isArray(entry.rgba) && entry.rgba[3] ? entry.rgba.slice(0, 3) : null));
  } catch (_) { return []; }
}

function readGrids(dir = path.join(PIXEL_DIR, 'frames16')) {
  try {
    return fs.readdirSync(dir).filter((name) => /^frame-\d+\.txt$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => [...line].map(Number)));
  } catch (_) { return []; }
}

const fg = (rgb) => (rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[39m');
const bg = (rgb) => (rgb ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '\x1b[49m');

/** One half-block row from two pixel rows. Transparent pixels fall back to the terminal default. */
function halfBlockRow(upper = [], lower = [], palette = []) {
  let out = '';
  const width = Math.max(upper.length, lower.length);
  for (let x = 0; x < width; x += 1) {
    const top = palette[upper[x] || 0] || null;
    const bottom = palette[lower[x] || 0] || null;
    if (!top && !bottom) { out += '\x1b[39m\x1b[49m '; continue; }
    out += `${fg(top)}${bg(bottom)}${HALF_BLOCK}`;
  }
  return `${out}\x1b[39m\x1b[49m`;
}

function buildPixelFrameSets() {
  const palette = readPalette();
  const grids = readGrids();
  if (!grids.length || !palette.length || NO_COLOR) return {}; // half-blocks are meaningless without colour
  const width = grids[0][0]?.length || 16;
  const panel = grids.map((grid) => {
    const rows = [];
    for (let y = 0; y + 1 < grid.length; y += 2) rows.push(halfBlockRow(grid[y], grid[y + 1], palette));
    return rows.join('\n');
  });
  // The face sits around pixel rows 6..7 in every frame; that pair reads as a
  // recognisable cat in a single terminal row.
  const single = grids.map((grid) => halfBlockRow(grid[6] || [], grid[7] || [], palette));
  return {
    'pixel-cat-16': Object.freeze({ id: 'pixel-cat-16', label: 'Pixel kijitora — 16x16 sprite as half-blocks (8 rows)',
      rows: Math.max(1, Math.floor((grids[0].length || 16) / 2)), width, frameMs: 67, colored: true, frames: Object.freeze(panel) }),
    'pixel-cat-16-row': Object.freeze({ id: 'pixel-cat-16-row', label: 'Pixel kijitora — face row only (1 row)',
      rows: 1, width, frameMs: 67, colored: true, frames: Object.freeze(single) }),
  };
}

const FRAME_SETS = Object.freeze({
  [WINGED_CAT_ASCII.id]: WINGED_CAT_ASCII,
  [WINGED_CAT_BOB.id]: WINGED_CAT_BOB,
  ...buildPixelFrameSets(),
});
// The default stays the hand drawn 1 row cat: the sticky footer's height is a
// fixed contract and must not move without the owner asking for it.
const DEFAULT_FRAME_SET_ID = FRAME_SETS[String(process.env.BIGKIJI_CLI_CAT || '')] ? String(process.env.BIGKIJI_CLI_CAT) : WINGED_CAT_ASCII.id;
const LOADING_TEXT = 'LOADING...';

function loadingFrames(id = DEFAULT_FRAME_SET_ID) { return FRAME_SETS[id] || FRAME_SETS[WINGED_CAT_ASCII.id]; }

function frameAt(index = 0, set = loadingFrames()) {
  const frames = set?.frames?.length ? set.frames : [''];
  const size = frames.length; const position = Math.trunc(Number(index) || 0);
  return frames[((position % size) + size) % size];
}

// Returns exactly `set.rows` lines, each padded to `set.width` *display* columns.
// Measured with stringWidth so a coloured (pixel) frame set, whose lines carry
// ANSI, still pads to the right number of cells.
function frameRows(index = 0, set = loadingFrames()) {
  const rows = Math.max(1, Number(set?.rows) || 1);
  const width = Math.max(1, Number(set?.width) || 1);
  const lines = String(frameAt(index, set)).split('\n');
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows).map((line) => {
    const size = stringWidth(line);
    if (size === width) return line;
    return size > width ? sliceToWidth(line, width) : line + ' '.repeat(width - size);
  });
}

module.exports = { FRAME_SETS, DEFAULT_FRAME_SET_ID, LOADING_TEXT, loadingFrames, frameAt, frameRows, halfBlockRow, buildPixelFrameSets };
