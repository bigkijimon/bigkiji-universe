'use strict';

const { themeFor } = require('../../domain/terminal/cli-theme');
const {
  count, glyphs, metric, padToWidth, renderNote, renderToolCall, stringWidth, truncateToWidth,
} = require('./transcript');
const APP_VERSION = require('../../../package.json').version;

const ESC = '\x1b';
// Width-aware: measuring with String#length silently overflowed every line
// carrying Japanese by up to 2x. ASCII behaviour is unchanged.
const clip = (value, width) => truncateToWidth(value, width);
const pad = (value, width) => padToWidth(value, width);
const bar = (value, width = 12) => { const n = Math.max(0, Math.min(width, Math.round((Number(value) || 0) / 100 * width))); return `${'━'.repeat(n)}${'─'.repeat(width - n)}`; };

// The daemon publishes phase either as a bare string ("EXECUTING") or as the
// SSE payload { phase, status, progress }. Normalise before matching on it.
const phaseName = (value) => {
  if (value && typeof value === 'object') return String(value.phase || value.status || 'IDLE');
  return String(value === undefined || value === null || value === '' ? 'IDLE' : value);
};
// Last resort only: a keyword guess used when nothing real is published.
const keywordProgress = (phase) => {
  const text = phaseName(phase).toUpperCase();
  return text.includes('COMPLETED') ? 100 : text.includes('VERIFY') ? 88 : text.includes('EXEC') || text.includes('REPAIR') ? 58
    : text.includes('AWAIT') ? 25 : text.includes('PREFLIGHT') || text.includes('PLANNING') ? 12 : 0;
};
// Real numbers win over the guess — never invent a percentage the daemon already knows.
function progressOf(state = {}, phase = state?.phase) {
  const real = [phase?.progress, state?.phase?.progress, state?.progress].find((value) => typeof value === 'number' && Number.isFinite(value));
  if (typeof real === 'number') return Math.max(0, Math.min(100, Math.round(real)));
  return keywordProgress(phase);
}
// Which published status lights which step. A substring test looked right and was
// wrong: the daemon publishes EXECUTING, and 'EXECUTING'.includes('EXECUTE') is false
// because the eighth character differs — so the EXECUTE step never lit during a run.
// The stems below are the shared prefixes, which survive both the -ING and the bare form.
const PHASE_STEMS = Object.freeze({
  PREFLIGHT: ['PREFLIGHT', 'PLANNING', 'AWAITING', 'CONVERSATION', 'PRUNING', 'DRAFTED', 'ENHANCED'],
  EXECUTE: ['EXECUT', 'REPAIR', 'RUNNING'],
  VERIFY: ['VERIF', 'COMPLETED', 'ENFORCED'],
});

function phaseChip(name, current, index, C = themeFor('plan')) {
  const normalized = phaseName(current).toUpperCase();
  const active = (PHASE_STEMS[name] || [name]).some((stem) => normalized.includes(stem));
  return active ? `${C.strong}●${index} ${name}${C.reset}` : `${C.muted}○${index} ${name}${C.reset}`;
}

/** Join a left and a right segment inside `width` columns, measuring display width. */
function spread(left, right, width) {
  const room = width - stringWidth(left) - stringWidth(right);
  if (room < 1) return truncateToWidth(left, width);
  return `${left}${' '.repeat(room)}${right}`;
}

// Full screen monitor (`bigkiji monitor`).
//
//   Sticky Top    = kijitora mascot + phase vector + fleet (fixed header)
//   Middle        = live agent relay (DECSTBM scroll region)
//   Sticky Bottom = key hints (always last row)
//
// No dependencies, no curses — DECSTBM (\x1b[top;bottom r) and absolute cursor
// addressing only. There is no box drawing anywhere: hierarchy comes from the
// left gutter and indentation, which gives every column back to the content and
// lets the layout survive a 60 column terminal.
class TUIRenderer {
  constructor({ output = process.stdout } = {}) { this.output = output; }

  metrics() {
    // Use the terminal's real width. The old floor of 72 columns made a 60
    // column terminal wrap every single line and destroyed the layout.
    const width = Math.max(24, Math.min(200, Number(this.output.columns || 100)));
    const rows = Math.max(16, Number(this.output.rows || 30));
    return { width, rows };
  }

  sections(state = {}, relay = []) {
    const { width, rows } = this.metrics();
    const mode = state.preferences?.mode || state.mode || 'plan'; const C = themeFor(mode);
    const mark = glyphs();
    const fleet = state.models?.models || state.models || [];
    const runs = state.runs || []; const current = runs.at(-1); const connected = fleet.filter((model) => model.connected).length;
    const phase = state.phase || current?.status || 'IDLE';
    const pct = this.progress(phase, state);
    const narrow = width < 76;

    // Title — mascot and version on the left, daemon facts dim on the right.
    const title = `${C.bold}${C.ink}(=^･ω･^=)  BigKiji Universe v${APP_VERSION}${C.reset}`;
    const facts = `${C.dim}Core 8777 ${mark.note} PID ${state.pid || '—'}${C.reset}`;
    const header = [
      narrow ? truncateToWidth(`(=^･ω･^=) BigKiji v${APP_VERSION}`, width) : spread(title, facts, width),
      `${C.muted}${truncateToWidth(`Pi-Orchestrator ${mark.note} ${String(mode).toUpperCase()} ${mark.note} models wake only when assigned`, width)}${C.reset}`,
      '',
    ];

    // Phase — one headline line, the vector and the meter folded underneath it.
    header.push(...renderToolCall('Phase', `${phaseName(phase)} ${mark.note} ${pct}%`, { width, theme: C, mark }));
    const chips = `${this.phase('PREFLIGHT', phase, 1, C)}  ${this.phase('EXECUTE', phase, 2, C)}  ${this.phase('VERIFY', phase, 3, C)}`;
    const meterWidth = Math.max(8, Math.min(24, width - 46));
    header.push(`     ${chips}${narrow ? '' : `   ${C.accent}${bar(pct, meterWidth)}${C.reset} ${C.strong}${String(pct).padStart(3)}%${C.reset}`}`);
    header.push('');

    // Fleet — the accent is reserved for models that are actually connected.
    header.push(...renderToolCall('Models', `${count(connected)} connected of ${count(fleet)}`, { width, theme: C, mark }));
    const modelCapacity = Math.max(0, Math.min(6, rows - header.length - 8));
    const nameWidth = Math.max(10, Math.min(20, width - 44));
    for (const model of fleet.slice(0, modelCapacity)) {
      const status = String(model.status || 'IDLE').toUpperCase();
      const tone = status === 'ERROR' ? C.error : model.connected ? C.accent : C.muted;
      const m = model.metrics || {};
      // Unmeasured metrics are '—'. A model that never ran did not use 0 tokens;
      // we simply do not know, and printing 0 would be a fabricated number.
      const detail = narrow ? status
        : `${pad(status, 9)} ${C.dim}${pad(`${metric(m.tokensUsed)} tok`, 11)}${pad(`${metric(m.tokensSaved)} saved`, 13)}${pad(metric(m.latencyMs, 'ms'), 8)}${C.reset}`;
      header.push(`  ${tone}${mark.turn}${C.reset} ${C.ink}${pad(model.displayName || model.id, nameWidth)}${C.reset} ${tone}${detail}${C.reset}`);
    }
    header.push('');
    header.push(...renderToolCall('Relay', `${count(relay)} ${relay.length === 1 ? 'event' : 'events'}`, { width, theme: C, mark }));

    const footer = ['', `${C.muted}${truncateToWidth(
      `q quit ${mark.note} r reload ${mark.note} a accept ${mark.note} x reject ${mark.note} ↑↓ session ${mark.note} Shift+Tab mode ${mark.note} h HUD`,
      width)}${C.reset}`];

    // Relay — one line per event so the region stays dense: dim clock, accent
    // source, then the text ellipsised at the width. Never a wrapped dump.
    const middleRows = Math.max(3, rows - header.length - footer.length);
    const logs = relay.slice(-middleRows);
    const sourceWidth = narrow ? 0 : 14;
    const middle = logs.map((entry) => {
      const time = pad(entry.time || '--:--:--', 8);
      const source = sourceWidth ? `${C.accent}${pad(entry.source || entry.event || 'SYSTEM', sourceWidth)}${C.reset} ` : '';
      const room = Math.max(6, width - 5 - 8 - 1 - (sourceWidth ? sourceWidth + 1 : 0));
      return `  ${C.brown}${mark.result}${C.reset}  ${C.dim}${time}${C.reset} ${source}${C.ink}${clip(entry.text || entry.status || '', room)}${C.reset}`;
    });
    if (!middle.length) middle.push(...renderNote('No transmissions — standing by', { width, theme: C, mark }));
    while (middle.length < middleRows) middle.push('');
    return { header, middle: middle.slice(0, middleRows), footer, rows, width };
  }

  frame(state = {}, relay = []) { const { header, middle, footer } = this.sections(state, relay); return [...header, ...middle, ...footer].join('\n'); }

  phase(name, current, index, C = themeFor('plan')) { return phaseChip(name, current, index, C); }
  progress(phase, state = {}) { return progressOf(state, phase); }

  draw(state, relay) {
    const { header, middle, footer, rows } = this.sections(state, relay);
    const top = header.length + 1; const bottom = rows - footer.length;
    let out = `${ESC}[r${ESC}[H`;
    header.forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    middle.forEach((text, index) => { out += `${ESC}[${top + index};1H${ESC}[2K${text}`; });
    footer.forEach((text, index) => { out += `${ESC}[${bottom + 1 + index};1H${ESC}[2K${text}`; });
    out += `${ESC}[${top};${bottom}r${ESC}[${bottom};1H`;
    this.output.write(out);
  }
}

// REPL 用 Sticky Bottom シェル:
//   最下部 = 固定フッタ（既定1行 = readline 入力。footerHeight を上げると
//            ローディング行/PHASE VECTOR/罫線で囲んだ入力/ステータス行を積める）、
//   上部   = 固定ヘッダ（マスコット）、
//   中間   = DECSTBM スクロール領域（出力はここに流れる）。リサイズにも追従する。
//
// Footer rows are painted absolutely (ESC[row;1H + ESC[2K), exactly like the
// header rows, and live *outside* the scroll region so output never damages
// them. A `null` footer line means "leave that row alone" — used for the
// readline input row, which readline itself owns.
class StickyScreen {
  constructor({ output = process.stdout, footerHeight = 1 } = {}) {
    this.output = output; this.header = []; this.footer = []; this.active = false; this.onLayout = null; this._resize = null;
    this.footerHeight = Math.max(1, Math.trunc(Number(footerHeight) || 1));
    this.columns = this.cols; this.lines = this.rows;
  }
  get rows() { return Math.max(8, Number(this.output.rows || 24)); }
  get cols() { return Math.max(40, Number(this.output.columns || 80)); }
  // Last row of the scrolling region. Never let the footer swallow the whole screen.
  get bottom() { return Math.max(2, this.rows - this.footerHeight); }
  get top() { return Math.max(1, Math.min(this.header.length + 1, this.bottom - 1)); }
  get footerTop() { return this.bottom + 1; }
  setFooterHeight(height) {
    const next = Math.max(1, Math.trunc(Number(height) || 1));
    if (next === this.footerHeight) return false;
    this.footerHeight = next; if (this.active) { this.output.write(`${ESC}[2J`); this.layout(); }
    return true;
  }
  start({ header = [], footer = [], footerHeight, onLayout } = {}) {
    if (!this.output.isTTY) return false;
    if (footerHeight !== undefined) this.footerHeight = Math.max(1, Math.trunc(Number(footerHeight) || 1));
    this.header = header; this.footer = footer; this.onLayout = onLayout || null; this.active = true;
    this.columns = this.cols; this.lines = this.rows;
    this.output.write(`${ESC}[2J`); this.layout();
    this._resize = () => { if (!this.active) return; this.columns = this.cols; this.lines = this.rows; this.output.write(`${ESC}[2J`); this.layout(); };
    this.output.on('resize', this._resize);
    return true;
  }
  // ESC sequence for the footer rows only; `null`/`undefined` rows are skipped.
  footerPaint() {
    const first = this.footerTop; let out = '';
    this.footer.slice(0, this.footerHeight).forEach((text, index) => {
      if (text === null || text === undefined) return;
      const row = first + index; if (row > this.rows) return;
      out += `${ESC}[${row};1H${ESC}[2K${text}`;
    });
    return out;
  }
  // `paint: false` stores the rows without drawing them — callers that hand the
  // input row to readline must draw *after* readline (its refresh emits ESC[0J,
  // which erases every row below the prompt) and then restore the cursor.
  setFooter(lines, { paint = true } = {}) {
    if (Array.isArray(lines)) this.footer = lines;
    if (!this.active || !paint) return false;
    const out = this.footerPaint(); if (out) this.output.write(out);
    return true;
  }
  // Repaint the footer without disturbing wherever the cursor currently is (DECSC/DECRC).
  restoreFooter() {
    if (!this.active) return '';
    const out = this.footerPaint();
    return out ? `${ESC}7${out}${ESC}8` : '';
  }
  layout() {
    let out = `${ESC}[r${ESC}[H`;
    this.header.slice(0, this.top - 1).forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    out += this.footerPaint();
    out += `${ESC}[${this.top};${this.bottom}r${ESC}[${this.bottom};1H`;
    this.output.write(out);
    this.onLayout?.();
  }
  print(text) {
    if (!this.active) { this.output.write(`${String(text)}\n`); return; }
    const lines = String(text).split('\n');
    this.output.write(`${ESC}[${this.bottom};1H${lines.map((line) => `\n\r${line}`).join('')}`);
  }
  clear() { if (this.active) { this.output.write(`${ESC}[2J`); this.layout(); } }
  suspend() { if (!this.active) return; this.active = false; this.output.write(`${ESC}[r${ESC}[2J${ESC}[H`); }
  resume() { if (!this.output.isTTY) return; this.active = true; this.output.write(`${ESC}[2J`); this.layout(); }
  stop() {
    if (this._resize) { this.output.off('resize', this._resize); this._resize = null; }
    if (!this.active) return; this.active = false;
    this.output.write(`${ESC}[r${ESC}[${this.rows};1H\n`);
  }
}

module.exports = { TUIRenderer, StickyScreen, clip, pad, bar, phaseName, phaseChip, progressOf, keywordProgress, APP_VERSION };
