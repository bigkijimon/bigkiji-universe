'use strict';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
const raw = (code) => NO_COLOR ? '' : `\x1b[${code}m`;
const RESET = raw('0');

const PALETTE = Object.freeze({
  black: raw('38;2;11;9;8'), brownDeep: raw('38;2;42;24;16'), brown: raw('38;2;107;66;38'),
  brownLight: raw('38;2;166;106;63'), orange: raw('38;2;242;140;40'), orangeBright: raw('38;2;255;179;71'),
  warning: raw('38;2;192;86;33'), error: raw('38;2;184;58;24'), ink: raw('38;2;243;232;216'),
  muted: raw('38;2;185;161;141'), dim: raw('2'), bold: raw('1'), reset: RESET,
});

const MODE_COLORS = Object.freeze({
  ask: { accent: PALETTE.orange, strong: PALETTE.orangeBright, border: PALETTE.brown, prompt: PALETTE.brownLight },
  'auto-edit': { accent: PALETTE.orangeBright, strong: PALETTE.orange, border: PALETTE.warning, prompt: PALETTE.warning },
  plan: { accent: raw('38;2;217;119;6'), strong: PALETTE.orangeBright, border: PALETTE.brownLight, prompt: PALETTE.brownLight },
});

function normalizeMode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === 'auto' || mode === 'manual' || mode === 'auto-edit' || mode === 'shell') return 'auto-edit';
  return mode === 'ask' ? 'ask' : 'plan';
}
function transportMode(mode) { return normalizeMode(mode) === 'auto-edit' ? 'auto' : 'plan'; }
function themeFor(mode) { return { ...PALETTE, ...MODE_COLORS[normalizeMode(mode)] }; }
function paint(text, color = PALETTE.ink) { return `${color}${String(text)}${RESET}`; }
function stripAnsi(value) { return String(value || '').replace(/\x1b\[[0-9;]*m/g, ''); }
function rainbow(width, mode = 'plan') {
  const colors = [themeFor(mode).brownDeep, themeFor(mode).brown, themeFor(mode).accent, themeFor(mode).orangeBright, themeFor(mode).brown];
  return Array.from({ length: Math.max(1, width) }, (_, index) => `${colors[index % colors.length]}━`).join('') + RESET;
}

module.exports = { NO_COLOR, PALETTE, MODE_COLORS, normalizeMode, transportMode, themeFor, paint, stripAnsi, rainbow };
