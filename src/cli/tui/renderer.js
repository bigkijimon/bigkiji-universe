'use strict';

const { themeFor } = require('../../domain/terminal/cli-theme');
const {
  DASH, count, glyphs, lower, metric, padToWidth, phrase, renderNote, renderToolCall, shortenPath, stringWidth,
  truncateToWidth,
} = require('./transcript');
const { catMark } = require('./loading-frames');
const APP_VERSION = require('../../../package.json').version;

const ESC = '\x1b';
// Home, then erase forward — not ESC[2J.
//
// ED2 ("erase the whole display") is specified as erasing, but xterm.js and
// several native terminals push the erased lines into scrollback first, so every
// resize left another copy of the header sitting above the live one. Scrolling up
// after a few resizes in a split pane shows a stack of them, which is what the
// owner photographed. ED0 from the home position clears exactly the same cells and
// never touches scrollback.
const WIPE = `${ESC}[H${ESC}[J`;
// How many printed lines are kept so the screen can be rebuilt after a wipe.
//
// The transcript used to disappear, and the owner photographed it: an empty window with
// the header still on top and the footer row printed twice. Both halves of that picture
// are the same bug.
//
// The screen is wiped and re-laid out whenever the terminal resizes OR the footer changes
// height — and the footer changes height by itself. `footerHeightFor()` reserves a row per
// running agent and the CLI calls `setFooterHeight()` on every footer tick, so starting or
// finishing one piece of work wipes the screen. Nothing kept a copy of what had been
// printed, so `layout()` redrew the header and the footer onto an empty region.
//
// The terminal's own scrollback does not save it either. Output goes into a DECSTBM
// region, and lines that scroll off the top of a scroll region are discarded rather than
// pushed into scrollback. That is the price of a header and footer that stay put, and it
// means this buffer is the only copy there is.
const SCROLLBACK_LINES = 4000;
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
//
// AWAITING_APPROVAL is 0, and that is the whole point of this line.
//
// It was 25. A run that is waiting for the owner has executed nothing — no file read,
// no command run, no token spent on the work itself — and the meter said a quarter of
// it was done. Measured 2026-08-04: two runs sat at AWAITING_APPROVAL for eleven hours
// with the bar showing 25% the entire time, while the owner asked four times whether
// anything was happening. A quarter of nothing is nothing. Waiting is not progress.
const keywordProgress = (phase) => {
  const text = phaseName(phase).toUpperCase();
  return text.includes('COMPLETED') ? 100 : text.includes('VERIFY') ? 88 : text.includes('EXEC') || text.includes('REPAIR') ? 58
    : text.includes('AWAIT') ? 0 : text.includes('PREFLIGHT') || text.includes('PLANNING') ? 12 : 0;
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

function phaseChip(name, current, index, C = themeFor('plan'), { compact = false, done = false } = {}) {
  const normalized = phaseName(current).toUpperCase();
  const active = (PHASE_STEMS[name] || [name]).some((stem) => normalized.includes(stem));
  // `name` stays the uppercase table key. PHASE_STEMS is keyed on it, so folding
  // the argument instead of the label would make every lookup miss and leave all
  // three chips dark for the whole of every run — the exact bug the comment above
  // records being fixed once already.
  const text = compact ? String(index) : `${index} ${phrase(name)}`;
  if (active) return `${C.strong}●${text}${C.reset}`;
  // A step the run has already passed is not the same as one it has not reached, and
  // both rendered as the same grey ○. `done` is only ever set by phaseChips() below,
  // from the position of the live step — never guessed from a percentage.
  if (done) return `${C.success}✓${text}${C.reset}`;
  return `${C.muted}○${text}${C.reset}`;
}

const PHASE_ORDER = Object.freeze(['PREFLIGHT', 'EXECUTE', 'VERIFY']);
/** Which of the three steps is live, or -1 when the daemon is idle. */
function activePhaseIndex(current) {
  const normalized = phaseName(current).toUpperCase();
  return PHASE_ORDER.findIndex((name) => (PHASE_STEMS[name] || [name]).some((stem) => normalized.includes(stem)));
}
/** The three chips, with everything before the live one marked done. */
function phaseChips(current, C = themeFor('plan'), { compact = false } = {}) {
  const active = activePhaseIndex(current);
  return PHASE_ORDER.map((name, index) => phaseChip(name, current, index + 1, C, { compact, done: active > index }));
}

// The one box in the whole CLI.
//
// Everything else here is deliberately de-boxed — hierarchy comes from a left
// gutter, so the full terminal width belongs to the content, and the self test
// asserts that no framing glyph reaches the transcript. The owner asked on
// 2026-08-03 for the model information at the top to be enclosed, and enclosing
// one fixed-size fact panel is a different thing from framing flowing content:
// it never reflows, never wraps, and never competes with a line of prose for
// width. The self test keeps forbidding boxes everywhere else.
//
// Nothing in here is invented. The model and the context window come from the
// daemon's `conversation` snapshot, the counts from its fleet; a field the
// daemon did not send renders as '—' rather than a plausible default.
function modelPanel(state = {}, options = {}) {
  const { width = 80, theme = themeFor('plan'), label = ' model ', frame = 0 } = options;
  const conversation = state.conversation || {};
  const fleet = state?.models?.models || state?.models || [];
  const bits = [lower(conversation.model) || DASH];
  const ctx = Number(conversation.maxContextTokens);
  if (Number.isFinite(ctx) && ctx > 0) bits.push(`${ctx >= 1000 ? `${Math.round(ctx / 1000)}k` : ctx} ctx`);
  // `connected` means "has a task running right now", so this read 1/6 with every
  // provider authenticated and ready — which the owner reasonably took to mean five
  // of them were broken. What the header is answering is "how many could work".
  if (fleet.length) bits.push(`${fleet.filter((model) => model.available ?? model.connected).length}/${fleet.length} ready`);
  // The local tools the owner routes work to — ComfyUI, Ollama, n8n, Obsidian,
  // graphify. Detection and health checks for all nine existed and were wired to
  // nothing, so there was no way to see from here whether they were up.
  const tools = state?.tools;
  if (tools?.tools?.length) bits.push(`${tools.connected}/${tools.tools.length} tools`);
  // Row three. The cat is three terminal rows now (it was two, and two rows of this
  // sprite is a brown rectangle — see loading-frames.js HEAD_ROWS), so the panel has a
  // row it did not have before. Claude Code's header spends the equivalent row on the
  // working directory, and so does this: which directory the engine is pointed at is
  // the fact most worth having beside the model, and it was previously muted text
  // below the box where it read as chrome.
  const where = state.workspace ? lower(shortenPath(state.workspace)) : '';

  // The cat is pixels, and pixels are colour. `truncateToWidth` returns plain
  // text — it strips ANSI even when it has nothing to trim — so the mark is
  // measured and concatenated, never passed through it. Only the facts, which
  // are plain, get ellipsised.
  //
  // Two rows, because one was not a cat. A single terminal row is two pixel
  // rows, and the two that carry the face are almost entirely opaque, so the
  // mark rendered as a brown rectangle on the owner's screen. Rows 2-5 of the
  // sprite are ears over eyes, and that reads.
  const mark = catMark({ frame });
  const markWidth = mark.length ? stringWidth(mark[0]) + 2 : 0;
  const room = Math.max(8, width - 2);
  // The label rides the top border, so it has to fit the terminal too. It is
  // built from APP_VERSION by the caller, and a prerelease string was enough to
  // push a 40 column panel out to 48.
  const heading = truncateToWidth(label, Math.max(3, room - 2));
  // The model is the fact worth reading first, so it gets the row beside the
  // ears; everything else follows underneath.
  const factRoom = Math.max(1, room - 2 - markWidth);
  const facts = [truncateToWidth(bits[0], factRoom), truncateToWidth(bits.slice(1).join(' · '), factRoom),
    truncateToWidth(where, factRoom)];
  const rows = Math.max(mark.length, 1);
  const bodyWidth = Math.max(...facts.map((line) => markWidth + stringWidth(line)));
  const inner = Math.min(room, Math.max(stringWidth(heading) + 1, bodyWidth + 2));

  const out = [`${theme.border}╭─${theme.reset}${theme.muted}${heading}${theme.reset}${theme.border}${'─'.repeat(Math.max(0, inner - stringWidth(heading) - 1))}╮${theme.reset}`];
  // Three facts, three weights. Flat `ink` on every row made the panel one block of
  // text where the model, the readiness counts and the directory all looked equally
  // important; the model is the one you read first, so it is the one that is bright.
  const tones = [`${theme.bold}${theme.ink}`, theme.muted, theme.dim];
  for (let index = 0; index < rows; index += 1) {
    const art = mark[index] ? `${mark[index]}  ` : ' '.repeat(markWidth);
    const text = facts[index] || '';
    const used = markWidth + stringWidth(text);
    out.push(`${theme.border}│${theme.reset} ${art}${tones[index] || theme.ink}${text}${theme.reset}${' '.repeat(Math.max(0, inner - used - 2))} ${theme.border}│${theme.reset}`);
  }
  out.push(`${theme.border}╰${'─'.repeat(inner)}╯${theme.reset}`);
  return out;
}

/** Join a left and a right segment inside `width` columns, measuring display width. */
function spread(left, right, width) {
  const room = width - stringWidth(left) - stringWidth(right);
  if (room < 1) return truncateToWidth(left, width);
  return `${left}${' '.repeat(room)}${right}`;
}

// Full screen monitor (`bigkiji monitor`).
//
//   Sticky Top    = title + model panel + phase vector + fleet (fixed header)
//   Middle        = live agent relay (DECSTBM scroll region)
//   Sticky Bottom = key hints (always last row)
//
// No dependencies, no curses — DECSTBM (\x1b[top;bottom r) and absolute cursor
// addressing only. Hierarchy comes from the left gutter and indentation, which
// gives every column back to the content and lets the layout survive a 60
// column terminal. The single exception is `modelPanel` — see the note there.
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

    // Title — name and version on the left, daemon facts dim on the right. The
    // kaomoji that used to sit here is gone; the cat now lives in the model
    // panel below as pixels, which say the same thing in a third of the width.
    const title = `${C.bold}${C.ink}bigkiji universe v${APP_VERSION}${C.reset}`;
    const facts = `${C.dim}core 8777 ${mark.note} pid ${state.pid || DASH}${C.reset}`;
    const header = [
      narrow ? truncateToWidth(`bigkiji v${APP_VERSION}`, width) : spread(title, facts, width),
      `${C.muted}${truncateToWidth(`pi-orchestrator ${mark.note} ${lower(mode)} ${mark.note} models wake only when assigned`, width)}${C.reset}`,
      // The panel costs five rows — border, three facts, border — and the relay's floor
      // is three. Below 19 rows there is not enough screen for both: the sections came
      // to 17 on a 16 row terminal, draw() wrote a relay line into the footer's row,
      // and the footer's own ESC[2K erased it. On a short screen the live relay is
      // worth more than a restatement of facts /status can print on demand.
      //
      // The threshold moved 18 -> 19 when the cat went from two rows to three. It is
      // the panel's height plus the rest of the sections, so it has to move with it;
      // leaving it at 18 put 19 rows on an 18 row terminal, which the self test caught.
      ...(rows >= 19 ? modelPanel(state, { width, theme: C }) : []),
      '',
    ];

    // Phase — one headline line, the vector and the meter folded underneath it.
    header.push(...renderToolCall('phase', `${phrase(phaseName(phase))} ${mark.note} ${pct}%`, { width, theme: C, mark }));
    // The chip row is the one line here that was a fixed 40 columns whatever the
    // terminal was, so it ran off the right edge below 45 columns — measured, and
    // true before this file was last touched. Under pressure the names go and the
    // numbered dots stay, because which step is lit is the part worth keeping.
    const chipRow = (compact) => phaseChips(phase, C, { compact }).join('  ');
    const chips = stringWidth(chipRow(false)) + 5 <= width ? chipRow(false) : chipRow(true);
    const meterWidth = Math.max(8, Math.min(24, width - 46));
    header.push(`     ${chips}${narrow ? '' : `   ${C.accent}${bar(pct, meterWidth)}${C.reset} ${C.strong}${String(pct).padStart(3)}%${C.reset}`}`);
    header.push('');

    // Fleet — the accent is reserved for models that are actually connected.
    header.push(...renderToolCall('models', `${count(connected)} connected of ${count(fleet)}`, { width, theme: C, mark }));
    const modelCapacity = Math.max(0, Math.min(6, rows - header.length - 8));
    const nameWidth = Math.max(10, Math.min(20, width - 44));
    for (const model of fleet.slice(0, modelCapacity)) {
      const status = String(model.status || 'IDLE').toUpperCase();
      const label = phrase(status);
      const tone = status === 'ERROR' ? C.error : model.connected ? C.accent : C.muted;
      const m = model.metrics || {};
      // Unmeasured metrics are '—'. A model that never ran did not use 0 tokens;
      // we simply do not know, and printing 0 would be a fabricated number.
      const detail = narrow ? label
        : `${pad(label, 9)} ${C.dim}${pad(`${metric(m.tokensUsed)} tok`, 11)}${pad(`${metric(m.tokensSaved)} saved`, 13)}${pad(metric(m.latencyMs, 'ms'), 8)}${C.reset}`;
      header.push(`  ${tone}${mark.turn}${C.reset} ${C.ink}${pad(lower(model.displayName || model.id), nameWidth)}${C.reset} ${tone}${detail}${C.reset}`);
    }
    header.push('');
    header.push(...renderToolCall('relay', `${count(relay)} ${relay.length === 1 ? 'event' : 'events'}`, { width, theme: C, mark }));

    const footer = ['', `${C.muted}${truncateToWidth(
      `q quit ${mark.note} r reload ${mark.note} a accept ${mark.note} x reject ${mark.note} ↑↓ session ${mark.note} shift+tab mode ${mark.note} h hud`,
      width)}${C.reset}`];

    // Relay — one line per event so the region stays dense: dim clock, accent
    // source, then the text ellipsised at the width. Never a wrapped dump.
    const middleRows = Math.max(3, rows - header.length - footer.length);
    const logs = relay.slice(-middleRows);
    const sourceWidth = narrow ? 0 : 14;
    const middle = logs.map((entry) => {
      const time = pad(entry.time || '--:--:--', 8);
      const source = sourceWidth ? `${C.accent}${pad(phrase(entry.source || entry.event || 'system'), sourceWidth)}${C.reset} ` : '';
      const room = Math.max(6, width - 5 - 8 - 1 - (sourceWidth ? sourceWidth + 1 : 0));
      return `  ${C.brown}${mark.result}${C.reset}  ${C.dim}${time}${C.reset} ${source}${C.ink}${clip(entry.text || entry.status || '', room)}${C.reset}`;
    });
    if (!middle.length) middle.push(...renderNote('no transmissions — standing by', { width, theme: C, mark }));
    while (middle.length < middleRows) middle.push('');
    return { header, middle: middle.slice(0, middleRows), footer, rows, width };
  }

  frame(state = {}, relay = []) { const { header, middle, footer } = this.sections(state, relay); return [...header, ...middle, ...footer].join('\n'); }

  phase(name, current, index, C = themeFor('plan'), options = {}) { return phaseChip(name, current, index, C, options); }
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
    this.output = output; this.header = []; this.headerFn = null; this.footer = []; this.active = false; this.onLayout = null; this._resize = null;
    this.used = 0; this.laidOutRows = 0;
    // Everything print() has been given, so a wipe is a repaint and not a loss.
    this.buffer = [];
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
    this.footerHeight = next; if (this.active) { this.output.write(WIPE); this.layout(); }
    return true;
  }
  // `header` may be a function of the column count.
  //
  // It could only be an array, resolved once, and layout() repainted that same array
  // forever. Resize a pane narrower and the header still held lines measured for the
  // old width: the model panel's box and the command hints were both wider than the
  // terminal, so the terminal wrapped them itself, mid-token. That is the split-pane
  // screenshot the owner sent. A function is re-evaluated on every layout, which is
  // exactly when the width can have changed.
  start({ header = [], footer = [], footerHeight, onLayout } = {}) {
    if (!this.output.isTTY) return false;
    if (footerHeight !== undefined) this.footerHeight = Math.max(1, Math.trunc(Number(footerHeight) || 1));
    this.headerFn = typeof header === 'function' ? header : null;
    this.header = this.headerFn ? (this.headerFn(this.cols) || []) : header;
    this.footer = footer; this.onLayout = onLayout || null; this.active = true;
    this.columns = this.cols; this.lines = this.rows;
    this.output.write(WIPE); this.layout();
    this._resize = () => { if (!this.active) return; this.columns = this.cols; this.lines = this.rows; this.output.write(WIPE); this.layout(); };
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
  /**
   * Repaint the header in place, same contract as restoreFooter().
   *
   * The header is not decoration that gets drawn once: it holds the cat, and a cat
   * that never moves is a photograph. It lives outside the scroll region and is
   * addressed absolutely, exactly like the footer, so repainting it costs the same as
   * repainting the footer and cannot damage the transcript.
   */
  restoreHeader() {
    if (!this.active || !this.headerFn) return '';
    this.header = this.headerFn(this.cols) || [];
    let out = '';
    this.header.slice(0, this.top - 1).forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    return out ? `${ESC}7${out}${ESC}8` : '';
  }
  /** How many terminal rows one logical line occupies at the current width. */
  rowsFor(line) {
    const width = stringWidth(String(line ?? ''));
    return width <= 0 ? 1 : Math.max(1, Math.ceil(width / this.cols));
  }

  /** Keep what was printed, newest last, bounded. */
  remember(lines) {
    for (const line of lines) this.buffer.push(String(line));
    const over = this.buffer.length - SCROLLBACK_LINES;
    if (over > 0) this.buffer.splice(0, over);
  }

  /**
   * The tail of the buffer that fits in the scroll region, as one positioned block.
   *
   * Measured in rows rather than lines. A Japanese sentence at 40 columns is three rows,
   * and counting it as one is how a narrowing resize used to push output over the footer.
   * Sets `used` as a side effect so print() knows where the next free row is.
   */
  repaint() {
    const capacity = Math.max(1, this.bottom - this.top + 1);
    const tail = []; let height = 0;
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const rows = this.rowsFor(this.buffer[index]);
      // The newest line goes in even if it alone is taller than the region — showing the
      // top of it beats showing nothing.
      if (tail.length && height + rows > capacity) break;
      tail.unshift(this.buffer[index]); height += rows;
    }
    this.used = Math.min(capacity, height);
    return tail.length ? `${ESC}[${this.top};1H${tail.join('\r\n')}` : '';
  }

  layout() {
    if (this.headerFn) this.header = this.headerFn(this.cols) || [];
    let out = `${ESC}[r${ESC}[H`;
    this.header.slice(0, this.top - 1).forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    out += this.footerPaint();
    // The region has to be set before anything is written into it, or a tall repaint
    // scrolls the header away instead of the region.
    out += `${ESC}[${this.top};${this.bottom}r`;
    this.used = 0;
    // Put the transcript back. Every caller of layout() has just wiped the screen, and
    // before this line that wipe was permanent — see SCROLLBACK_LINES.
    out += this.repaint();
    out += `${ESC}[${Math.min(this.bottom, this.top + this.used)};1H`;
    this.output.write(out);
    this.laidOutRows = this.rows;
    this.onLayout?.();
  }

  /**
   * Write into the scrolling region.
   *
   * It fills from the top and only scrolls once it is full. Jumping straight to
   * the last row and emitting newlines — which is what this did — meant that on
   * a fifty row terminal the first answer appeared at the bottom with a
   * screenful of blank above it. Nothing was broken and it looked entirely
   * broken, which for a terminal is the same thing.
   *
   * `bottom` is derived from the terminal's live row count while the DECSTBM
   * region is only re-set by layout(). If those two disagree — a resize event
   * that has not been handled yet — the cursor lands below the region, the
   * newline does not scroll, and the write lands on top of the footer instead.
   * So a size change re-lays out before anything else happens.
   */
  print(text) {
    const lines = String(text).split('\n');
    if (!this.active) { this.output.write(`${String(text)}\n`); return; }
    this.remember(lines);
    // A size change re-lays out first, and layout() now paints the buffer — which already
    // contains these lines. Writing them again below would double them.
    if (this.rows !== this.laidOutRows) { this.output.write(WIPE); this.layout(); return; }
    const capacity = Math.max(1, this.bottom - this.top + 1);
    const used = Number(this.used) || 0;
    const height = lines.reduce((sum, line) => sum + this.rowsFor(line), 0);
    if (used + height <= capacity) {
      // Still room: place the block at the next free row, no scrolling at all.
      let out = ''; let row = this.top + used;
      lines.forEach((line) => { out += `${ESC}[${row};1H${ESC}[2K${line}`; row += this.rowsFor(line); });
      this.output.write(out);
      this.used = used + height;
      return;
    }
    this.used = capacity;
    this.output.write(`${ESC}[${this.bottom};1H${lines.map((line) => `\n\r${line}`).join('')}`);
  }
  /** `/clear` — the owner asking for an empty screen, so the copy goes too. */
  clear() { this.buffer = []; if (this.active) { this.output.write(WIPE); this.layout(); } }
  suspend() { if (!this.active) return; this.active = false; this.output.write(`${ESC}[r${WIPE}`); }
  resume() { if (!this.output.isTTY) return; this.active = true; this.output.write(WIPE); this.layout(); }
  stop() {
    if (this._resize) { this.output.off('resize', this._resize); this._resize = null; }
    if (!this.active) return; this.active = false;
    this.output.write(`${ESC}[r${ESC}[${this.rows};1H\n`);
  }
}

module.exports = { TUIRenderer, StickyScreen, clip, pad, bar, phaseName, phaseChip, phaseChips, activePhaseIndex, progressOf, keywordProgress, modelPanel, APP_VERSION };
