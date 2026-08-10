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

/**
 * One half-block row from two pixel rows.
 *
 * A transparent pixel has to be transparent, and getting that wrong is visible: this
 * emitted U+2580 (upper half block) for every cell, so a cell whose UPPER pixel was
 * transparent still painted its top half — in the terminal's DEFAULT foreground, which
 * on a dark theme is near-white. Four cells of the header mark were in that state, and
 * they are the white squares sitting on the cat's ears in the owner's screenshot.
 *
 * Which glyph to use is decided per cell instead:
 *   both opaque    ▀  upper pixel as foreground, lower as background
 *   upper only     ▀  upper as foreground, background left alone
 *   lower only     ▄  lower as foreground, background left alone
 *   neither        a space
 */
function halfBlockRow(upper = [], lower = [], palette = []) {
  let out = '';
  const width = Math.max(upper.length, lower.length);
  for (let x = 0; x < width; x += 1) {
    const top = palette[upper[x] || 0] || null;
    const bottom = palette[lower[x] || 0] || null;
    if (!top && !bottom) out += '\x1b[39m\x1b[49m ';
    else if (!top) out += `${fg(bottom)}\x1b[49m▄`;
    else if (!bottom) out += `${fg(top)}\x1b[49m${HALF_BLOCK}`;
    else out += `${fg(top)}${bg(bottom)}${HALF_BLOCK}`;
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

// Which two pixel rows to draw when there is only one terminal row for the cat.
//
// The face was the obvious choice and it was wrong, visibly so on the owner's screen:
// a face row is almost entirely opaque, so every half-block comes out foreground over
// background in the same brown and the "cat" renders as a filled rectangle. A row that
// is nearly all ink cannot carry a silhouette, whatever is drawn in it.
//
// The ears can. In the redrawn sprite they are pixel rows 0-1 — the apex is one pixel
// and the base is three — so the row is a shape rather than a bar, and it is the part
// that moves, which makes the loading animation read as animation.
//
// This is the crop for the one-row *sprite* sets, which are 16 columns wide. The
// footer's default is not one of them: it is `kijitora-face` below, drawn at five
// columns, because sixteen columns of cat crowds the one line the owner reads.
const EAR_ROWS = [0, 1];
// The header mark gets three rows: ears, eyes, nose.
//
// It had two, cropping pixel rows 2-5, and on the owner's screen that was a brown
// rectangle with a pink dot in it — photographed, then rendered again by
// `tools/preview-kijitora.js`, which draws the actual half-block cells rather than
// the sprite. Rows 2-5 of this cat are skull, forehead, and the eyes; the ears are
// rows 0-1, and without the ears there is nothing in the shape that says cat. Two
// terminal rows cannot hold ears AND eyes, so the mark costs three.
//
// The sprite is drawn so that this crop is a whole face: tools/draw-kijitora.py keeps
// everything above pixel row 6 — ears, eyes, nose — inside these six rows.
const HEAD_ROWS = [0, 1, 2, 3, 4, 5];

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
  const single = grids.map((grid) => halfBlockRow(grid[EAR_ROWS[0]] || [], grid[EAR_ROWS[1]] || [], palette));
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
  // Silhouette, not shading: the ear row is mostly transparent, so which pixels
  // exist is exactly the information that matters. Shading it would flatten the
  // gap between the ears into another band of grey.
  const single = grids.map((grid) => monoHalfBlockRow(grid[EAR_ROWS[0]] || [], grid[EAR_ROWS[1]] || []));
  return {
    'pixel-cat-mono': Object.freeze({ id: 'pixel-cat-mono', label: 'Pixel kijitora — colourless silhouette (8 rows)',
      rows: Math.max(1, Math.floor((grids[0].length || 16) / 2)), width, frameMs: 67, frames: Object.freeze(panel) }),
    'pixel-cat-mono-row': Object.freeze({ id: 'pixel-cat-mono-row', label: 'Pixel kijitora — colourless face row (1 row)',
      rows: 1, width, frameMs: 67, frames: Object.freeze(single) }),
  };
}

// One cell. The owner asked for "a dot, small, that blinks or moves", pointing at
// Claude Code's single-glyph spinner.
//
// The 16x16 sprite could not be sampled down to this. A terminal row is two pixel
// rows and a column is one pixel, so the sprite is 16 columns wide by
// construction; squeezing it to one loses the silhouette entirely — the same
// reason the first attempt at a one-row cat came out as a brown bar. So the cat is
// drawn directly in the glyph instead of derived from the sprite.
//
// Braille packs 2x4 dots into a single cell — four times the vertical resolution of a
// half-block, which is why this and not `▀`. Written as a grid rather than as literal
// code points, because the literal characters are what made the sprite unreviewable:
// nobody can see a cat in `⠻`, and every mistake in this file so far has been one
// that was invisible in the source and obvious on screen.
//
// The rows are the same anatomy as the big sprite, one dot row each:
//
//     row 0   ears        row 2   eyes — a HOLE, not ink
//     row 1   head        row 3   chin
//
// Eyes as holes is from the private reference-analysis note (not in this repo) §1: the reference bat is strictly
// 1-bit and punches its two eyes out of the silhouette in every frame. On a 2x4 canvas
// that is the only way an eye can exist at all.
//
// Braille is East Asian Width neutral, so it measures one column, and it is present in
// every monospace font that already renders the box drawing this CLI uses. NO_COLOR is
// irrelevant here: the shape carries it, not the colour.
const BRAILLE_DOTS = Object.freeze([[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]);
/** A 2-wide, 4-tall dot grid as one braille cell. */
function brailleCell(grid) {
  let value = 0;
  for (let row = 0; row < 4; row += 1) {
    if (grid[row][0]) value |= BRAILLE_DOTS[row][0];
    if (grid[row][1]) value |= BRAILLE_DOTS[row][1];
  }
  return String.fromCharCode(0x2800 + value);
}
// Six poses on a 400ms loop, the reference's cadence. It holds the resting pose, blinks
// once, dips, and flicks each ear — the same beats the 16x16 sprite animates, so the
// header cat and the footer dot are never doing different things at the same moment.
const DOT_CAT_POSES = Object.freeze([
  [[1, 1], [1, 1], [0, 0], [1, 1]],   // rest: ears, head, eye holes, chin
  [[1, 1], [1, 1], [0, 0], [1, 1]],   // held, so the blink reads as a blink not a flicker
  [[1, 1], [1, 1], [0, 0], [0, 0]],   // blink — the head lifts and the chin goes
  [[0, 0], [1, 1], [1, 1], [1, 1]],   // dip: the whole animal drops one dot row
  [[1, 0], [1, 1], [0, 0], [1, 1]],   // left ear flicks down
  [[0, 1], [1, 1], [0, 0], [1, 1]],   // right ear
]);
const DOT_CAT = Object.freeze({
  id: 'dot-cat',
  label: 'One-cell braille cat — ears, blink, dip, ear flick',
  rows: 1,
  width: 1,
  frameMs: 67,
  frames: Object.freeze(DOT_CAT_POSES.map(brailleCell)),
});
// Two beats and a rest. The spinner the owner asked for, modelled on Claude Code's.
//
// What was taken from it is the *property*, not the shape: it does not rotate. It swells
// in place and settles, so there is no direction for the eye to follow, which is why a
// mark you see several hundred times a day stops being tiring. Claude Code does this with
// sparkles; this does it with density, and ends on two held frames so the loop breathes
// instead of running — a cat asleep on the desk rather than a wheel.
//
// Braille is not a taste. `charWidth` (transcript.js:62) counts East Asian Ambiguous
// characters as one column, and ○ ● ◇ ◆ · ∘ are all Ambiguous — a terminal set to render
// them wide draws two cells where this measures one, and the footer row overflows by one
// per frame on the owner's Japanese-configured terminal. U+2800–28FF is Narrow, with no
// ambiguity to get wrong, and it is what the previous default already used here.
//
// 110ms rather than 67: this interval is also the footer's repaint tick, so a calmer
// pulse costs less. See the ticker in bigkiji-cli.js, which already cites pi issue #3881
// — a permanent spinner raising CPU in proportion to transcript size.
const HEARTBEAT = Object.freeze({
  id: 'heartbeat',
  label: 'Two beats and a rest — the calm pulse (1 cell)',
  rows: 1,
  width: 1,
  frameMs: 110,
  frames: Object.freeze([
    '⠒',   // in
    '⠶',   // and up
    '⣿',   // full
    '⠶',   // out
    '⠒',   // and down
    '⠒',   // held — the rest, which is what makes the other five read as a pulse
  ]),
});
const RETIRED_DOT_CAT = Object.freeze({
  id: 'dot-cat-flat',
  label: 'One-cell braille cat — the 2026-08-03 poses, kept selectable',
  rows: 1,
  width: 1,
  frameMs: 67,
  frames: Object.freeze([
    '⠛',   // ears up, eyes open
    '⠛',   // held, so the blink reads as a blink and not a flicker
    '⠉',   // blink
    '⠛',   // open
    '⠶',   // head dips
    '⠛',   // back up
  ]),
});

// Five cells. A cat face, not a cat.
//
// The owner asked for something small that moves and got the braille cell above; then
// they looked at the screen and said the cat does not look like a cat at all, which it
// does not — `⠛` is two dots. The sprite cannot be squeezed to this size, because a
// terminal column is one pixel and the ears of a 16 pixel cat are twelve columns apart
// (this was measured, twice, and is why the one-row crops of the sprite kept coming out
// as bars). So the face is drawn directly at the size it is used:
//
//     row 0   ear   fur   fur   fur   ear        top half of each cell
//     row 1   fur   eye   nose  eye   fur        bottom half of each cell
//
// which a half-block renders as dark ear-corners over a brown face with two dark eyes
// and a rose nose under them. Five columns instead of sixteen, and it still has the
// three features that say cat. The colours come from the sprite's own palette, so the
// footer face and the header mark can never drift apart.
const FACE_ROWS = Object.freeze([
  // [ears, eyes] per frame: enough to blink and to twitch one ear.
  { ears: [2, 2], eyes: [1, 1] },
  { ears: [2, 2], eyes: [1, 1] },
  { ears: [2, 2], eyes: [0, 0] },   // blink
  { ears: [2, 2], eyes: [1, 1] },
  { ears: [3, 2], eyes: [1, 1] },   // left ear twitches down into the fur
  { ears: [2, 3], eyes: [1, 1] },   // right ear
]);

function buildFaceFrameSets() {
  const palette = readPalette();
  if (!palette.length || NO_COLOR) return {};
  const FUR = 3; const NOSE = 6; const CHEEK = 3;
  const frames = FACE_ROWS.map(({ ears, eyes }) => halfBlockRow(
    [ears[0], FUR, FUR, FUR, ears[1]],
    [CHEEK, eyes[0] || FUR, NOSE, eyes[1] || FUR, CHEEK],
    palette));
  return {
    'kijitora-face': Object.freeze({ id: 'kijitora-face', label: 'Kijitora face — five cells, blinks and twitches',
      rows: 1, width: 5, frameMs: 67, colored: true, frames: Object.freeze(frames) }),
  };
}

// No art at all. A single frame means the ticker can advance forever and the
// footer never changes, so this is also the setting for a screen reader —
// gcloud, GitHub CLI and Gemini CLI all ship the same escape hatch, because a
// spinner read aloud is noise. Selected with BIGKIJI_CLI_CAT=none.
const NO_ART = Object.freeze({ id: 'none', label: 'No mascot — plain status text', rows: 1, width: 1, frameMs: 1000, frames: Object.freeze([' ']) });

const FRAME_SETS = Object.freeze({
  [HEARTBEAT.id]: HEARTBEAT,
  [DOT_CAT.id]: DOT_CAT,
  [RETIRED_DOT_CAT.id]: RETIRED_DOT_CAT,
  [WINGED_CAT_ASCII.id]: WINGED_CAT_ASCII,
  [WINGED_CAT_BOB.id]: WINGED_CAT_BOB,
  ...buildPixelFrameSets(),
  ...buildMonoFrameSets(),
  ...buildFaceFrameSets(),
  [NO_ART.id]: NO_ART,
});

// The owner retired the kaomoji on 2026-08-03: the default is the pixel cat,
// in colour where there is colour and as a silhouette where there is not. The
// kaomoji sets are still reachable by name, they are simply no longer what you
// get by default. If the sprite files are missing entirely we fall through to
// no art rather than back to a face, because the instruction was to stop
// drawing faces, not to draw them when convenient.
// 2026-08-03, second pass: the pixel cat was correct but 16 columns wide, which
// crowds the one line the owner actually reads. The default became the one-cell
// braille cat. The sprite sets are untouched and still selectable by name.
// 2026-08-04, third pass: the braille cell is two dots and the owner said so — "the
// cat does not look like a cat at all". The default is the five-cell face, which is
// four columns more than the braille and is actually a cat. `dot-cat` is still there
// by name, and NO_COLOR still falls through to the colourless silhouette.
// 2026-08-10, fourth pass: the owner asked for a spinner rather than a mascot, modelled
// on Claude Code's. Four attempts at drawing a cat in one or five cells is enough
// evidence that the cell is too small to be a cat; what it CAN be is a pulse. Every
// earlier set is still selectable by name — the default moves, nothing is deleted.
function defaultFrameSetId() {
  const requested = String(process.env.BIGKIJI_CLI_CAT || '');
  if (FRAME_SETS[requested]) return requested;
  return HEARTBEAT.id;
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
/**
 * The head as an array of terminal rows. Empty when the sprite files are missing.
 *
 * `frame` animates it. The cat was a still here and a dot in the footer, which is
 * backwards: the footer has one row and cannot hold a cat, and the panel has three
 * rows and was holding a photograph of one. the private reference-analysis note (not in this repo) §1 measures the
 * reference at six frames on a 400 ms loop with poses that differ a lot; all six exist
 * in the sprite already and nothing was drawing them here.
 */
function catMark({ colored = !NO_COLOR, frame = 0 } = {}) {
  const index = Math.trunc(Number(frame) || 0);
  const key = `${colored ? 'colour' : 'mono'}:${index}`;
  if (MARKS.has(key)) return MARKS.get(key);
  const mark = buildCatMark(colored, index);
  MARKS.set(key, mark);
  return mark;
}
/** How many distinct poses catMark() can draw. */
function catMarkFrames() { return readGrids().length || 1; }

// A cat's head, three terminal rows tall: ears, eyes, nose.
//
// The crop is measured on frame 0 and then applied to every frame, deliberately. Taking
// each frame's own bounding box would make the mark a different width when the ears
// twitch, and the panel is laid out around it — the box would breathe once per 400 ms
// and every fact beside it would slide. The sprite is drawn so that no pose leaves the
// frame-0 columns, which is a property of tools/draw-kijitora.py, checked below.
function buildCatMark(colored, frame = 0) {
  const grids = readGrids();
  if (!grids.length) return [];
  const grid = grids[((frame % grids.length) + grids.length) % grids.length];
  // Crop relative to the top of the animal, not to the top of the sprite.
  //
  // Half the frames bob the whole cat down a pixel (the private reference-analysis note §1 — the bat
  // bobs in anti-phase with its wings, baked into the art). Cropping at fixed sprite
  // rows meant the bob slid the face through the window: three of the six poses lost
  // the nose off the bottom and gained a blank row at the top, so the mark stopped
  // being a face for half of every loop. Rendered and looked at, which is the only way
  // that was ever going to be caught. The bob still animates where the whole body is
  // visible — the GUI sprite and the 8-row panel set.
  const topOf = (rows) => Math.max(0, rows.findIndex((row) => row.some(Boolean)));
  const offset = topOf(grid);
  const base = HEAD_ROWS.map((index) => grids[0][topOf(grids[0]) + index] || []);
  const rows = HEAD_ROWS.map((index) => grid[offset + index] || []);
  const width = Math.max(...base.map((row) => row.length), 0);
  let first = -1; let last = -1;
  for (let x = 0; x < width; x += 1) {
    if (!base.some((row) => row[x])) continue;
    if (first < 0) first = x;
    last = x;
  }
  if (first < 0) return [];
  const palette = readPalette();
  const crop = (row) => row.slice(first, last + 1);
  const out = [];
  for (let pair = 0; pair + 1 < rows.length; pair += 2) {
    out.push(colored && palette.length
      ? halfBlockRow(crop(rows[pair]), crop(rows[pair + 1]), palette)
      : monoHalfBlockRow(crop(rows[pair]), crop(rows[pair + 1])));
  }
  return out;
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
  halfBlockRow, monoHalfBlockRow, monoShadeRow, shadeMap, buildPixelFrameSets, buildMonoFrameSets, catMark, catMarkFrames };
