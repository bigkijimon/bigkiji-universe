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
// footer uses the 1 row variant — `pixel-cat-16-row`, the two most legible
// pixel rows of the cat's face — which is the default as of 2026-08-03.

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

// Two ways to draw the cat without colour, because the two shapes need
// different things.
//
// The whole sprite reads as a *silhouette*: at eight rows the ears, body and
// tail are recognisable purely from which pixels exist, and half-blocks keep
// the full vertical resolution.
//
// One row of the face does not. Every pixel in the face is opaque, so the
// silhouette of it is a solid bar — measured, not assumed. That row needs
// *shading* instead: one character per pixel, chosen by how light the colour
// is, which makes the eyes show as gaps in a lighter face. It costs half the
// vertical resolution, which a single row was never using.

/** Presence, not colour: a pixel is either there or it is not. */
function monoHalfBlockRow(upper = [], lower = []) {
  let out = '';
  const width = Math.max(upper.length, lower.length);
  for (let x = 0; x < width; x += 1) {
    const top = Boolean(upper[x]); const bottom = Boolean(lower[x]);
    out += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
  }
  return out;
}

const SHADES = ['░', '▒', '▓', '█'];
const luminance = (rgb) => rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;

// Rank rather than absolute brightness: the palette is five warm browns with no
// pure white, so mapping luminance directly would crowd every colour into two
// shades. Ranking guarantees each opaque colour gets a distinct character, and
// keeps doing so if the palette is ever redrawn.
function shadeMap(palette = []) {
  const opaque = palette.map((rgb, index) => ({ index, rgb })).filter((entry) => entry.rgb);
  const map = [];
  [...opaque].sort((a, b) => luminance(a.rgb) - luminance(b.rgb))
    .forEach((entry, rank) => { map[entry.index] = SHADES[Math.min(SHADES.length - 1, Math.floor(rank * SHADES.length / Math.max(1, opaque.length)))]; });
  return map;
}

/** One character per pixel, shaded by lightness. Transparent stays a space. */
function monoShadeRow(row = [], palette = []) {
  const shades = shadeMap(palette);
  return row.map((index) => shades[index] || ' ').join('');
}

// The face sits around pixel rows 6..7 in every frame; that pair reads as a
// recognisable cat in a single terminal row.
const FACE_ROWS = [6, 7];

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
  const single = grids.map((grid) => halfBlockRow(grid[FACE_ROWS[0]] || [], grid[FACE_ROWS[1]] || [], palette));
  return {
    'pixel-cat-16': Object.freeze({ id: 'pixel-cat-16', label: 'Pixel kijitora — 16x16 sprite as half-blocks (8 rows)',
      rows: Math.max(1, Math.floor((grids[0].length || 16) / 2)), width, frameMs: 67, colored: true, frames: Object.freeze(panel) }),
    'pixel-cat-16-row': Object.freeze({ id: 'pixel-cat-16-row', label: 'Pixel kijitora — face row only (1 row)',
      rows: 1, width, frameMs: 67, colored: true, frames: Object.freeze(single) }),
  };
}

// The same sprite with the colour taken away. This exists so that a terminal
// which cannot show colour still shows a cat: without it, NO_COLOR and
// TERM=dumb would fall through to the ASCII kaomoji the owner asked us to
// retire, and "no more kaomoji" would only be true on colour terminals.
function buildMonoFrameSets() {
  const grids = readGrids();
  if (!grids.length) return {};
  const palette = readPalette();
  const width = grids[0][0]?.length || 16;
  const panel = grids.map((grid) => {
    const rows = [];
    for (let y = 0; y + 1 < grid.length; y += 2) rows.push(monoHalfBlockRow(grid[y], grid[y + 1]));
    return rows.join('\n');
  });
  const single = grids.map((grid) => monoShadeRow(grid[FACE_ROWS[0]] || [], palette));
  return {
    'pixel-cat-mono': Object.freeze({ id: 'pixel-cat-mono', label: 'Pixel kijitora — colourless silhouette (8 rows)',
      rows: Math.max(1, Math.floor((grids[0].length || 16) / 2)), width, frameMs: 67, frames: Object.freeze(panel) }),
    'pixel-cat-mono-row': Object.freeze({ id: 'pixel-cat-mono-row', label: 'Pixel kijitora — colourless face row (1 row)',
      rows: 1, width, frameMs: 67, frames: Object.freeze(single) }),
  };
}

// No art at all. A single frame means the ticker can advance forever and the
// footer never changes, so this is also the setting for a screen reader —
// gcloud, GitHub CLI and Gemini CLI all ship the same escape hatch, because a
// spinner read aloud is noise. Selected with BIGKIJI_CLI_CAT=none.
const NO_ART = Object.freeze({ id: 'none', label: 'No mascot — plain status text', rows: 1, width: 1, frameMs: 1000, frames: Object.freeze([' ']) });

const FRAME_SETS = Object.freeze({
  [WINGED_CAT_ASCII.id]: WINGED_CAT_ASCII,
  [WINGED_CAT_BOB.id]: WINGED_CAT_BOB,
  ...buildPixelFrameSets(),
  ...buildMonoFrameSets(),
  [NO_ART.id]: NO_ART,
});

// The owner retired the kaomoji on 2026-08-03: the default is the pixel cat,
// in colour where there is colour and as a silhouette where there is not. The
// kaomoji sets are still reachable by name, they are simply no longer what you
// get by default. If the sprite files are missing entirely we fall through to
// no art rather than back to a face, because the instruction was to stop
// drawing faces, not to draw them when convenient.
function defaultFrameSetId() {
  const requested = String(process.env.BIGKIJI_CLI_CAT || '');
  if (FRAME_SETS[requested]) return requested;
  if (FRAME_SETS['pixel-cat-16-row']) return 'pixel-cat-16-row';
  if (FRAME_SETS['pixel-cat-mono-row']) return 'pixel-cat-mono-row';
  return NO_ART.id;
}
const DEFAULT_FRAME_SET_ID = defaultFrameSetId();
const LOADING_TEXT = 'loading...';

// A compact, still cat for the header panel. Frame 2 is the tucked-in pose, so
// it trims to the fewest columns; the all-transparent columns either side are
// dropped so the mark sits tight against the label next to it.
// Memoised on the two inputs that can change it. `bigkiji monitor` redraws the
// whole screen every second and on every event; without this, each redraw read
// seven sprite files off disk to draw eight characters.
const MARKS = new Map();
function catMark({ colored = !NO_COLOR } = {}) {
  const key = colored ? 'colour' : 'mono';
  if (MARKS.has(key)) return MARKS.get(key);
  const mark = buildCatMark(colored);
  MARKS.set(key, mark);
  return mark;
}

function buildCatMark(colored) {
  const grids = readGrids();
  const grid = grids[2] || grids[0];
  if (!grid) return '';
  const upper = grid[FACE_ROWS[0]] || []; const lower = grid[FACE_ROWS[1]] || [];
  const width = Math.max(upper.length, lower.length);
  let first = -1; let last = -1;
  for (let x = 0; x < width; x += 1) {
    if (!upper[x] && !lower[x]) continue;
    if (first < 0) first = x;
    last = x;
  }
  if (first < 0) return '';
  const palette = readPalette();
  if (colored && palette.length) return halfBlockRow(upper.slice(first, last + 1), lower.slice(first, last + 1), palette);
  return monoShadeRow(upper.slice(first, last + 1), palette);
}

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

module.exports = { FRAME_SETS, DEFAULT_FRAME_SET_ID, LOADING_TEXT, NO_ART, SHADES, loadingFrames, frameAt, frameRows,
  halfBlockRow, monoHalfBlockRow, monoShadeRow, shadeMap, buildPixelFrameSets, buildMonoFrameSets, catMark };
