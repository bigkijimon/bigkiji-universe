'use strict';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
const raw = (code) => NO_COLOR ? '' : `\x1b[${code}m`;
const RESET = raw('0');

// Warm browns and orange are the identity — they match the app's accent and the pixel
// cat's fur, and they are not up for negotiation. What was missing was everything else:
// the whole CLI painted status, success, failure and mode in the same brown, so the
// only way to tell a connected model from a broken one was to read the word. The owner
// asked for more colour on 2026-08-04, comparing this against Claude Code, which uses
// yellow for a warning, red for a failure and violet for the mode it is running in.
//
// `success` / `info` / `violet` are added for exactly that, and only that. They are
// semantic: a colour here means a state, never decoration. `warning` and `error` were
// also lifted — #C05621 and #B83A18 are dark oranges that sit at roughly 3:1 on a dark
// terminal, which is under the 4.5:1 a body-text colour needs, and they were the two
// colours that most needed to be seen.
// Two palettes, because this CLI writes TRUECOLOR.
//
// `ink` is #f3e8d8 — very nearly white. Every line BigKiji prints about itself asks the
// terminal for that exact RGB, so on a light background BigKiji's own output is the one
// thing on screen that cannot be read. xterm.js's `minimumContrastRatio` rescues the
// windows inside the app, but nothing rescues a real terminal, and this is the CLI the
// owner actually lives in. A second palette is the only fix that reaches it.
//
// Selected by BIGKIJI_COLOR_SCHEME (light | dark | auto). `auto` and anything else mean
// dark, which is what every existing invocation gets, so this changes nothing until it
// is asked for. main.js passes the app's resolved scheme into the pty environment.
//
// The light values are not the dark ones lightened: they are darkened until each one
// clears its ratio against #faf9f5, which is the light background the app's own console
// uses. tools/contrast-selftest.js measures them.
const DARK_PALETTE = Object.freeze({
  black: raw('38;2;11;9;8'), brownDeep: raw('38;2;42;24;16'), brown: raw('38;2;150;96;58'),
  brownLight: raw('38;2;166;106;63'), orange: raw('38;2;242;140;40'), orangeBright: raw('38;2;255;179;71'),
  warning: raw('38;2;235;158;62'), error: raw('38;2;232;104;78'), ink: raw('38;2;243;232;216'),
  success: raw('38;2;122;196;140'), info: raw('38;2;136;180;222'), violet: raw('38;2;178;155;250'),
  muted: raw('38;2;185;161;141'), planAccent: raw('38;2;217;119;6'), dim: raw('2'), bold: raw('1'), reset: RESET,
});
const LIGHT_PALETTE = Object.freeze({
  black: raw('38;2;11;9;8'), brownDeep: raw('38;2;36;24;16'), brown: raw('38;2;120;84;54'),
  brownLight: raw('38;2;146;108;74'), orange: raw('38;2;168;82;6'), orangeBright: raw('38;2;138;66;4'),
  warning: raw('38;2;140;76;10'), error: raw('38;2;170;42;24'), ink: raw('38;2;41;38;27'),
  success: raw('38;2;22;110;62'), info: raw('38;2;26;92;150'), violet: raw('38;2;93;62;190'),
  muted: raw('38;2;108;96;82'), planAccent: raw('38;2;150;74;6'), dim: raw('2'), bold: raw('1'), reset: RESET,
});
function schemeName(env = process.env) {
  const value = String(env.BIGKIJI_COLOR_SCHEME || '').toLowerCase();
  return value === 'light' ? 'light' : 'dark';
}
const PALETTE = schemeName() === 'light' ? LIGHT_PALETTE : DARK_PALETTE;

const MODE_COLORS = Object.freeze({
  ask: { accent: PALETTE.orange, strong: PALETTE.orangeBright, border: PALETTE.brown, prompt: PALETTE.brownLight },
  'auto-edit': { accent: PALETTE.orangeBright, strong: PALETTE.orange, border: PALETTE.warning, prompt: PALETTE.warning },
  plan: { accent: PALETTE.planAccent, strong: PALETTE.orangeBright, border: PALETTE.brownLight, prompt: PALETTE.brownLight },
  // Hands-off. Warning-coloured on purpose: nothing will stop to ask, so the mode line
  // has to be the thing the owner notices before typing.
  demo: { accent: PALETTE.warning, strong: PALETTE.orangeBright, border: PALETTE.warning, prompt: PALETTE.warning },
});

// One colour per AI, so a glance at the running block says who is working.
//
// The owner asked for this after watching four specialists share one brown: the only
// way to tell codex from glm was to read the word, which defeats the point of a status
// row you are meant to take in without reading. Hues are chosen to stay inside the warm
// identity where they can (codex, claude) and to leave it only where distinctness
// matters more than harmony (gemini, qwen) — a palette nobody can tell apart is not a
// palette. NO_COLOR strips every one of them through raw().
// The three the GUI already had keep the GUI's exact values. multi-terminal-manager.js
// has coloured providers in the window for as long as it has existed — #d97757 for
// claude-code, #8b5cf6 for glm, #34d399 for everyone else — and shipping a second
// palette here would have meant the same model wearing two colours depending on which
// surface the owner happened to be looking at. That file is a browser IIFE and cannot
// require this module, so the two are kept in step by value and by this note; change
// one, change the other.
const PROVIDER_COLORS = Object.freeze({
  'claude-code': raw('38;2;217;119;87'), claude: raw('38;2;217;119;87'),   // #d97757
  glm: raw('38;2;139;92;246'),                                            // #8b5cf6
  qwen: raw('38;2;52;211;153'), ollama: raw('38;2;52;211;153'),           // #34d399
  'local-qwen': raw('38;2;52;211;153'), 'pi-agent-core': raw('38;2;52;211;153'),
  // The rest the GUI never distinguished; these are new and stay inside the warm
  // identity where they can.
  codex: raw('38;2;255;179;71'),
  gemini: raw('38;2;110;168;254'),
  diagnosis: raw('38;2;185;161;141'),
});
/** The colour for a provider id, or the muted default for one nobody has coloured. */
function providerColor(provider) {
  const id = String(provider || '').toLowerCase();
  return PROVIDER_COLORS[id] || PALETTE.muted;
}

function normalizeMode(value) {
  const mode = String(value || '').toLowerCase();
  // One instruction in, a finished thing to look at. Kept distinct from auto-edit
  // because auto-edit still asks the owner the open questions and this one does not.
  if (mode === 'demo' || mode === 'hands-off' || mode === 'auto-pilot') return 'demo';
  if (mode === 'auto' || mode === 'manual' || mode === 'auto-edit' || mode === 'shell') return 'auto-edit';
  return mode === 'ask' ? 'ask' : 'plan';
}
// What the daemon is told. Three values, because there are three modes.
//
// This collapsed `ask` into `plan` and sent two values, which was fine while the daemon
// flattened both to 'plan' anyway. Now that the mode decides whether a writing run waits,
// the wire has to be able to say which of the three the owner chose. 'plan' and 'ask'
// both still wait — the difference is how the CLI asks — and only 'auto' releases.
const TRANSPORT = Object.freeze({ 'auto-edit': 'auto', ask: 'ask', plan: 'plan', demo: 'demo' });
function transportMode(mode) { return TRANSPORT[normalizeMode(mode)] || 'plan'; }
function themeFor(mode) { return { ...PALETTE, ...MODE_COLORS[normalizeMode(mode)] }; }
function paint(text, color = PALETTE.ink) { return `${color}${String(text)}${RESET}`; }
function stripAnsi(value) { return String(value || '').replace(/\x1b\[[0-9;]*m/g, ''); }
function rainbow(width, mode = 'plan') {
  const colors = [themeFor(mode).brownDeep, themeFor(mode).brown, themeFor(mode).accent, themeFor(mode).orangeBright, themeFor(mode).brown];
  return Array.from({ length: Math.max(1, width) }, (_, index) => `${colors[index % colors.length]}━`).join('') + RESET;
}

module.exports = { NO_COLOR, PROVIDER_COLORS, providerColor, PALETTE, DARK_PALETTE, LIGHT_PALETTE, schemeName, MODE_COLORS, normalizeMode, transportMode, themeFor, paint, stripAnsi, rainbow };
