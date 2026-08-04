'use strict';

// Draw what the terminal draws, as a PNG, so the cat can be LOOKED at.
//
// Every previous attempt at this sprite was judged from a grid of digits or from a
// scaled-up picture of the pixels, and both hid the actual failure: the CLI does not
// paint pixels, it paints half-block CHARACTERS, one per cell, with the upper pixel as
// the foreground colour and the lower pixel as the background. A cell is roughly twice
// as tall as it is wide, so what the owner sees is the sprite squeezed horizontally —
// and a shape that survives that is not the same as a shape that looks good at 16x16.
//
// So this takes the real ANSI strings the CLI would emit — from loading-frames.js, not
// from a copy of its logic — and rasterises them on a terminal-shaped grid.
//
//   node tools/preview-kijitora.js /tmp/preview.png
//
// It is a development tool, not part of the app or of `npm test`. It exists so that
// "does it read as a cat" is answered by looking, which is the only way that question
// has ever been answerable.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { catMark, loadingFrames, frameRows, FRAME_SETS } = require('../src/cli/tui/loading-frames');

const CELL_W = 11;   // a 22px monospace cell is about 11px wide — measured off Menlo
const CELL_H = 22;
const PAD = 10;
// The CLI's own background, so the contrast in the preview is the contrast on screen.
const TERMINAL_BG = [30, 27, 24];

/** Parse one ANSI-carrying line into cells of { glyph, fg, bg }. */
function cells(line) {
  const out = [];
  let fg = null; let bg = null;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0; let match;
  const push = (text) => { for (const glyph of text) out.push({ glyph, fg, bg }); };
  while ((match = re.exec(line)) !== null) {
    push(line.slice(last, match.index));
    last = re.lastIndex;
    const codes = match[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      if (codes[i] === 38 && codes[i + 1] === 2) { fg = [codes[i + 2], codes[i + 3], codes[i + 4]]; i += 4; }
      else if (codes[i] === 48 && codes[i + 1] === 2) { bg = [codes[i + 2], codes[i + 3], codes[i + 4]]; i += 4; }
      else if (codes[i] === 39) fg = null;
      else if (codes[i] === 49) bg = null;
      else if (codes[i] === 0) { fg = null; bg = null; }
    }
  }
  push(line.slice(last));
  return out;
}

function pngBytes(width, height, rows) {
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
  const chunk = (tag, payload) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(tag), payload]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c; }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Rasterise blocks of terminal lines, one block under the next. */
function render(blocks, file) {
  const width = Math.max(...blocks.flat().map((line) => cells(line).length));
  const rowCount = blocks.reduce((total, block) => total + block.length + 1, 0);
  const W = width * CELL_W + PAD * 2;
  const H = rowCount * CELL_H + PAD * 2;
  const rows = Array.from({ length: H }, () => {
    const row = Buffer.alloc(W * 3);
    for (let x = 0; x < W; x += 1) { row[x * 3] = TERMINAL_BG[0]; row[x * 3 + 1] = TERMINAL_BG[1]; row[x * 3 + 2] = TERMINAL_BG[2]; }
    return row;
  });
  const paint = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y += 1) {
      if (y < 0 || y >= H) continue;
      for (let x = x0; x < x1; x += 1) {
        if (x < 0 || x >= W) continue;
        rows[y][x * 3] = rgb[0]; rows[y][x * 3 + 1] = rgb[1]; rows[y][x * 3 + 2] = rgb[2];
      }
    }
  };
  let row = 0;
  for (const block of blocks) {
    for (const line of block) {
      cells(line).forEach((cell, column) => {
        const x = PAD + column * CELL_W; const y = PAD + row * CELL_H;
        const half = Math.round(CELL_H / 2);
        if (cell.glyph === '▀') {
          if (cell.fg) paint(x, y, x + CELL_W, y + half, cell.fg);
          if (cell.bg) paint(x, y + half, x + CELL_W, y + CELL_H, cell.bg);
        } else if (cell.glyph === '▄') {
          if (cell.bg) paint(x, y, x + CELL_W, y + half, cell.bg);
          if (cell.fg) paint(x, y + half, x + CELL_W, y + CELL_H, cell.fg);
        } else if (cell.glyph === '█') {
          if (cell.fg) paint(x, y, x + CELL_W, y + CELL_H, cell.fg);
        }
      });
      row += 1;
    }
    row += 1;
  }
  fs.writeFileSync(file, pngBytes(W, H, rows));
  return { W, H };
}

const out = process.argv[2] || path.join(require('os').tmpdir(), 'kijitora-preview.png');
// Every pose of the header mark, stacked, so the animation can be judged as an
// animation rather than as one still. A pose that leaves the frame-0 crop shows up
// here immediately as a clipped ear.
const { catMarkFrames } = require('../src/cli/tui/loading-frames');
const blocks = Array.from({ length: catMarkFrames() }, (_, frame) => catMark({ frame }));
const set = FRAME_SETS['pixel-cat-16'];
if (set) blocks.push(frameRows(0, set).length ? set.frames[0].split('\n') : []);
const footer = loadingFrames();
blocks.push(frameRows(0, footer));
const size = render(blocks.filter((block) => block.length), out);
console.log(`wrote ${out} ${size.W}x${size.H} — header mark (${catMark().length} rows), full sprite, footer set "${footer.id}"`);
