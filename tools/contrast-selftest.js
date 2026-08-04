'use strict';
// Every piece of text in this app has to be readable. This measures it.
//
// The owner's requirement was literal: "make all displayed text readable". That cannot be
// checked by looking at one screenshot on one machine in one theme — the console alone has
// a light and a dark palette, and the terminal carries sixteen ANSI slots on top of its own
// foreground. So the colours are resolved out of the stylesheets and the contrast ratios
// are computed, in both themes, every time the suite runs.
//
// The thresholds are WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for anything
// that is a graphic boundary rather than something you read. Where a value is allowed the
// lower bar, the reason is written next to it — "it is only decoration" is a claim that
// should have to be made explicitly.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tokens = fs.readFileSync(path.join(root, 'src/components/UI/console-app/src/styles/tokens.css'), 'utf8');

// ---- colour ------------------------------------------------------------------
function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function hslToRgb(h, s, l) {
  const S = s / 100; const L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/** Resolve a CSS colour expression against a variable map. Returns [r,g,b] or null. */
function parseColor(value, vars, depth = 0) {
  if (!value || depth > 6) return null;
  const text = String(value).trim();

  let match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (match) {
    const hex = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  match = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (match) return [1, 2, 3].map((i) => Math.round(Number(match[i])));

  // hsl(var(--x)) and hsl(var(--x) / .15) — the shape this codebase uses.
  match = text.match(/^hsl\(\s*var\((--[\w-]+)\)\s*(?:\/\s*([\d.]+))?\s*\)$/i);
  if (match) {
    const triplet = vars[match[1]];
    if (!triplet) return null;
    return parseColor(`hsl(${triplet})`, vars, depth + 1);
  }
  match = text.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/i);
  if (match) return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
  // A bare triplet, as the lamps are stored.
  match = text.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (match) return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^var\((--[\w-]+)\)$/);
  if (match) return parseColor(vars[match[1]], vars, depth + 1);

  return null;
}

// Where the dark media query starts and ends, by brace matching.
//
// This span matters: the block inside it is written `:root`, exactly like the shared block
// at the bottom of the file. Classifying by selector text alone therefore reads the dark
// lamps as if they were shared, and both "themes" end up measuring the same colours — a
// test that passes while checking nothing. Position is what actually distinguishes them.
function darkMediaSpan(css) {
  const start = css.search(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/);
  if (start < 0) return [-1, -1];
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return [start, i]; }
  }
  return [start, css.length];
}
const [darkStart, darkEnd] = darkMediaSpan(tokens);
assert.ok(darkStart >= 0, 'tokens.css must carry a dark theme for this to be measuring anything');

/** Every declaration block, with the position needed to tell the two `:root`s apart. */
function blocks(css) {
  const out = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let block;
  while ((block = blockRe.exec(css))) {
    out.push({
      selector: block[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
      at: block.index,
      vars: Object.fromEntries([...block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
        .map(([, name, value]) => [name, value.replace(/\/\*[\s\S]*?\*\//g, '').trim()])),
    });
  }
  return out;
}

const ALL = blocks(tokens);
const inDark = (b) => b.at > darkStart && b.at < darkEnd;
const merge = (list) => Object.assign({}, ...list.map((b) => b.vars));

// Shared aliases first, then the theme's own values — the order the cascade applies, so
// what is measured is what the browser resolves.
const shared = merge(ALL.filter((b) => !inDark(b) && /^:root$/.test(b.selector)));
const light = merge(ALL.filter((b) => !inDark(b) && /data-theme="light"/.test(b.selector)));
const dark = merge(ALL.filter((b) => inDark(b) || /data-theme="dark"/.test(b.selector)));

const LIGHT = { ...shared, ...light };
const DARK = { ...shared, ...dark };

// Guard against this file quietly breaking again: if the two themes resolve the same
// background, the extraction is wrong, not the design.
assert.notEqual(LIGHT['--bg-100'], DARK['--bg-100'],
  'light and dark resolved to the same lamp — the theme extraction is broken, not the palette');

const failures = [];
const report = [];

function check(theme, vars, fg, bg, min, note) {
  const f = parseColor(vars[fg] ?? fg, vars);
  const b = parseColor(vars[bg] ?? bg, vars);
  if (!f || !b) { failures.push(`${theme}: could not resolve ${fg} on ${bg}`); return; }
  const ratio = contrast(f, b);
  report.push(`  ${theme.padEnd(5)} ${fg.padEnd(16)} on ${bg.padEnd(12)} ${ratio.toFixed(2)}:1  (min ${min})${note ? ` — ${note}` : ''}`);
  if (ratio < min) failures.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below ${min}:1 — ${note || 'text must be readable'}`);
}

for (const [theme, vars] of [['light', LIGHT], ['dark', DARK]]) {
  // Body text, on every surface it is actually drawn on.
  check(theme, vars, '--ink', '--bg', 4.5, 'primary text');
  check(theme, vars, '--ink', '--surface', 4.5, 'primary text on raised surfaces');
  check(theme, vars, '--ink', '--card', 4.5, 'primary text in cards');
  check(theme, vars, '--ink-soft', '--bg', 4.5, 'secondary text is still text');
  check(theme, vars, '--ink-soft', '--card', 4.5, 'secondary text in cards');
  // Timestamps, counts and hints. Small, but the owner reads them, so 3:1 is the floor and
  // anything at the floor is a candidate for darkening rather than a settled answer.
  check(theme, vars, '--ink-faint', '--bg', 3, 'tertiary text: timestamps, counts, hints');
  // The accent carries labels as well as icons.
  check(theme, vars, '--accent', '--bg', 3, 'accent on the window background');
  check(theme, vars, '--ok', '--bg', 3, 'success text');
  check(theme, vars, '--danger', '--bg', 3, 'failure text — the one nobody may miss');
  // The terminal is text and nothing but text.
  check(theme, vars, '--term-fg', '--term-bg', 4.5, 'terminal foreground');
}

// Ordinary ANSI output — git, npm, jest. Slots 0 and 8 are black/bright-black, which are
// backgrounds and dim rules rather than body text, so they are exempt and said to be.
for (const [theme, vars] of [['light', LIGHT], ['dark', DARK]]) {
  for (let index = 1; index <= 15; index += 1) {
    if (index === 8) continue;
    check(theme, vars, `--term-ansi-${index}`, '--term-bg', 3, `ANSI ${index} in shell output`);
  }
}

// ---- the menu-bar window ------------------------------------------------------
// The small window is dark-only, so there is one palette rather than two — but it is the
// surface with the least room, which is exactly where text gets quietly shrunk and dimmed
// until it is decoration. It had a genuinely unreadable state before this pass: the
// SECURITY badge ran past the 350px window edge and was cut to "◇ SECU".
{
  const tray = fs.readFileSync(path.join(root, 'src/components/UI/tray.html'), 'utf8');
  const vars = Object.fromEntries([...tray.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.replace(/\/\*[\s\S]*?\*\//g, '').trim()]));

  check('tray', vars, '--ink', '--bg-100', 4.5, 'primary text on the panel');
  check('tray', vars, '--ink', '--bg-000', 4.5, 'primary text on an elevated card');
  check('tray', vars, '--ink-2', '--bg-100', 4.5, 'secondary text is still text');
  check('tray', vars, '--ink-2', '--bg-000', 4.5, 'secondary text on a card');
  // --ink-4 carries the monospace section labels and the composer placeholder, both small.
  check('tray', vars, '--ink-4', '--bg-100', 3, 'section labels and hints');
  check('tray', vars, '--ink-4', '--bg-200', 3, 'the composer placeholder, in its recessed field');
  check('tray', vars, '--accent', '--bg-100', 3, 'accent labels and counts');
  check('tray', vars, '--accent-strong', '--bg-100', 3, 'the emphasised accent');
}

// ---- the CLI's own truecolor palette -------------------------------------------
//
// The windows are only half of this product; the other half is `bigkiji` in a terminal,
// and that half writes truecolor escapes, which no contrast correction can rescue. Its
// ink was #f3e8d8 with no light variant at all, so on a light terminal the one thing on
// screen that could not be read was BigKiji talking about itself. Both palettes are
// measured here against the ground each is meant for.
{
  const { LIGHT_PALETTE, DARK_PALETTE } = require('../src/domain/terminal/cli-theme');
  const rgbOf = (value) => { const m = String(value).match(/38;2;(\d+);(\d+);(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; };
  // #faf9f5 is the app's own light console ground; #1e1b18 the dark one.
  const GROUNDS = { light: [250, 249, 245], dark: [30, 27, 24] };
  const MINIMUMS = { ink: 4.5, muted: 4.5, error: 4.5, success: 4.5, info: 4.5, violet: 4.5,
    warning: 3, orange: 3, orangeBright: 3, planAccent: 3, brown: 3, brownLight: 3 };
  for (const [scheme, palette] of [['light', LIGHT_PALETTE], ['dark', DARK_PALETTE]]) {
    for (const [name, min] of Object.entries(MINIMUMS)) {
      const fg = rgbOf(palette[name]);
      assert.ok(fg, `cli palette ${scheme} is missing ${name}`);
      const value = contrast(fg, GROUNDS[scheme]);
      const line = `  cli/${scheme.padEnd(5)} ${name.padEnd(13)} ${value.toFixed(2)}:1  (min ${min})`;
      report.push(value >= min ? line : `${line}  FAIL`);
      if (value < min) failures.push(`cli ${scheme} --${name} is ${value.toFixed(2)}:1 against its own terminal ground, needs ${min}`);
    }
  }
}

// ---- every var() actually resolves ---------------------------------------------
//
// A `var(--ink-3)` where no `--ink-3` exists is not a warning and not a fallback: the
// whole declaration is invalid at computed-value time and is thrown away, silently. It
// shipped in this file's own redesign — three rules asked for `--ink-3` in a palette
// that goes --ink, --ink-2, --ink-4 — and the result was a control row that inherited
// its colour from whatever happened to be above it. Nothing failed; it just looked
// slightly wrong, which is the hardest kind of wrong to notice.
//
// Only same-file custom properties are checked. A var() with a comma fallback is fine
// by construction, so those are skipped.
// Grouped, not per-file: the console app deliberately splits its palette (tokens.css)
// from its rules (console.css), so checking either alone reports every token as missing.
// A group is "everything that is loaded together into one document".
const CSS_GROUPS = [
  ['the menu-bar window', ['src/components/UI/tray.html']],
  ['the synapse canvas', ['src/components/UI/main.html']],
  ['the console window', ['src/components/UI/console-app/src/styles/tokens.css',
    'src/components/UI/console-app/src/styles/console.css']],
];
for (const [label, files] of CSS_GROUPS) {
  const sources = files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
  // Declared in CSS, or set at runtime with setProperty — the tray colours its agent
  // bubbles per model that way, so `--c` never appears in a stylesheet and is not a bug.
  const declared = new Set(sources.flatMap(([, css]) => [
    ...[...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name),
    ...[...css.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map(([, name]) => name),
  ]));
  let used = 0;
  for (const [file, css] of sources) {
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      used += 1;
      if (!declared.has(name)) failures.push(`${file}: var(${name}) is used but never declared — the declaration is discarded`);
    }
  }
  report.push(`   ok   ${label} — ${used} var() references against ${declared.size} declared tokens`);
}

console.log(report.join('\n'));
assert.deepStrictEqual(failures, [], `\nUnreadable text:\n  ${failures.join('\n  ')}\n`);
console.log(`\ncontrast selftest: PASS · ${report.length} foreground/background pairs measured across light and dark · `
  + 'body text at 4.5:1, tertiary and ANSI at 3:1 · terminal foreground and every readable ANSI slot checked '
  + 'against its own background');
