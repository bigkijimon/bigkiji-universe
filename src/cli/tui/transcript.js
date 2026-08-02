'use strict';

// Transcript rendering for the BigKiji CLI.
//
// Structure is borrowed from Claude Code; the colours stay BigKiji's warm brown
// kijitora palette. The rules this module implements:
//
//   1. No box drawing. Hierarchy is a narrow left gutter plus indentation, so
//      the full terminal width belongs to the content.
//   2. One gutter glyph per line kind — a filled bullet opens a turn or a tool
//      call, an elbow marks that line's result, indented underneath it.
//   3. A tool call is a single line, `Tool(short argument)`; its result is
//      folded to a few lines with an explicit `… +N lines` marker.
//   4. Truncation is aggressive but honest: the remaining count is the real
//      number of source lines that were withheld.
//   5. One accent colour. Bold marks only the thing currently happening; dim
//      carries timestamps, counts and paths.
//   6. Diffs render as diffs — line numbers, +/- prefixes, tone per kind.
//   7. Task lists show done items struck through and dim, the active one in the
//      accent, pending ones plain.
//   8. Width awareness everywhere: continuation lines hang at the content
//      column, and nothing is ever allowed to exceed the terminal width.
//
// Everything here is pure: strings in, strings out. No I/O, no timers, no
// terminal state — so it can be asserted line by line in a self test.

const { NO_COLOR, themeFor, stripAnsi } = require('../../domain/terminal/cli-theme');

const SGR_STRIKE = NO_COLOR ? '' : '\x1b[9m';
const DASH = '—';

// The owner asked (2026-08-03) for every character BigKiji paints to be
// lowercase. Two helpers, because the two cases differ:
//
//   lower()  — for values that are still identifiers after folding: paths,
//              model ids. Underscores survive, because `my_file.js` is a name.
//   phrase() — for status words BigKiji only ever displays. AWAITING_APPROVAL
//              is a protocol value; on screen it should read as a phrase, so
//              underscores become spaces.
//
// Neither is applied to transcript content — the owner's own words, diffs and
// file contents keep their case, because folding those would change meaning.
const lower = (value) => String(value ?? '').toLowerCase();
const phrase = (value) => String(value ?? '').replace(/_+/g, ' ').toLowerCase();

// ---------------------------------------------------------------------------
// Display width
// ---------------------------------------------------------------------------

// East Asian Wide / Fullwidth blocks. The owner writes Japanese, so measuring
// with String#length would silently overflow every line by up to 2x.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const ZERO_RANGES = [[0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]];
const inRanges = (code, ranges) => ranges.some(([low, high]) => code >= low && code <= high);

function charWidth(codePoint) {
  if (codePoint === 0x00) return 0;
  if (inRanges(codePoint, ZERO_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** Display width of `text` in terminal cells, ignoring any ANSI it carries. */
function stringWidth(text) {
  const plain = stripAnsi(text === 0 ? '0' : text);
  let width = 0;
  for (const char of plain) width += charWidth(char.codePointAt(0));
  return width;
}

/** Take at most `width` display columns from the head of `text` (plain result). */
function sliceToWidth(text, width) {
  const plain = stripAnsi(text === 0 ? '0' : text);
  if (width <= 0) return '';
  let out = ''; let used = 0;
  for (const char of plain) {
    const size = charWidth(char.codePointAt(0));
    if (used + size > width) break;
    out += char; used += size;
  }
  return out;
}

/** Ellipsise a single line at `width` columns. Returns plain text. */
function truncateToWidth(text, width, ellipsis = '…') {
  const plain = stripAnsi(text === 0 ? '0' : text);
  if (width <= 0) return '';
  if (stringWidth(plain) <= width) return plain;
  const mark = stringWidth(ellipsis) <= width ? ellipsis : '';
  return sliceToWidth(plain, width - stringWidth(mark)) + mark;
}

/** Pad a plain string out to `width` display columns. */
function padToWidth(text, width) {
  const clipped = truncateToWidth(text, width);
  return clipped + ' '.repeat(Math.max(0, width - stringWidth(clipped)));
}

/**
 * Greedy word wrap that is safe for CJK: words wider than the line are broken
 * at the column rather than allowed to overflow.
 * @returns {string[]} plain lines, none wider than `width`
 */
function wrapToWidth(text, width) {
  const limit = Math.max(1, Math.trunc(width) || 1);
  const source = stripAnsi(text).replace(/\t/g, '  ');
  const out = [];
  for (const rawLine of source.split('\n')) {
    let line = ''; let lineWidth = 0; let emitted = 0;
    const flush = () => { out.push(line); emitted += 1; line = ''; lineWidth = 0; };
    for (const word of rawLine.split(' ')) {
      // A token wider than the whole line is hard-split at the column. This is
      // also the path every unspaced Japanese sentence takes, which is correct:
      // Japanese breaks anywhere, and it must never overflow the terminal.
      if (stringWidth(word) > limit) {
        if (lineWidth) flush();
        let rest = word;
        while (stringWidth(rest) > limit) {
          let head = sliceToWidth(rest, limit);
          if (!head) head = [...rest][0] || ''; // limit narrower than one wide char
          if (!head) break;
          out.push(head); emitted += 1;
          rest = rest.slice(head.length);
        }
        line = rest; lineWidth = stringWidth(rest);
        continue;
      }
      const need = stringWidth(word) + (lineWidth ? 1 : 0);
      if (lineWidth + need > limit) flush();
      line += (lineWidth ? ' ' : '') + word;
      lineWidth += need;
    }
    if (lineWidth || emitted === 0) flush();
  }
  return out.length ? out : [''];
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const UNICODE_GLYPHS = Object.freeze({
  turn: '●', result: '⎿', user: '>', note: '·',
  done: '☑', active: '▸', pending: '☐', ellipsis: '…', rule: '─',
});
// TERM=dumb rarely has the box-drawing elbow or the ballot boxes.
const ASCII_GLYPHS = Object.freeze({
  turn: '*', result: '\\', user: '>', note: '.',
  done: '[x]', active: '>', pending: '[ ]', ellipsis: '...', rule: '-',
});

function glyphs({ ascii = process.env.TERM === 'dumb' || process.env.BIGKIJI_CLI_ASCII === '1' } = {}) {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * Keep the first `maxLines` source lines and report how many were really
 * withheld. The count is the true remainder — never an estimate.
 * @returns {{lines: string[], hidden: number}}
 */
function foldLines(lines, maxLines) {
  const all = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const limit = Math.trunc(Number(maxLines) || 0);
  if (limit <= 0 || all.length <= limit) return { lines: all.slice(), hidden: 0 };
  return { lines: all.slice(0, limit), hidden: all.length - limit };
}

/** The marker a fold leaves behind, e.g. `… +15 lines`. */
function foldMarker(hidden, mark = UNICODE_GLYPHS.ellipsis) {
  if (!hidden) return '';
  return `${mark} +${hidden} ${hidden === 1 ? 'line' : 'lines'}`;
}

// ---------------------------------------------------------------------------
// The gutter
// ---------------------------------------------------------------------------

/**
 * Render `text` behind a gutter glyph with a hanging indent: the first line
 * carries the glyph, every continuation line is padded to the content column so
 * the eye can follow the gutter. Nothing exceeds `width`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.width=80]     terminal columns
 * @param {string} [options.glyph='●']    gutter glyph
 * @param {number} [options.indent=0]     spaces before the glyph
 * @param {number} [options.gap=1]        spaces between glyph and content
 * @param {number} [options.maxLines=0]   0 = unlimited; else fold + marker
 * @param {string} [options.tone='']      ANSI applied to the content
 * @param {string} [options.glyphTone=''] ANSI applied to the glyph
 * @param {string} [options.reset='']     ANSI reset
 * @param {string} [options.ellipsis='…']
 * @returns {string[]}
 */
function gutterLines(text, options = {}) {
  const { width = 80, glyph = UNICODE_GLYPHS.turn, indent = 0, gap = 1, maxLines = 0,
    tone = '', glyphTone = '', reset = '', ellipsis = UNICODE_GLYPHS.ellipsis, markerTone = '' } = options;
  const lead = ' '.repeat(Math.max(0, indent));
  const column = Math.max(0, indent) + stringWidth(glyph) + Math.max(0, gap);
  const hang = ' '.repeat(column);
  const room = Math.max(4, Math.trunc(width) - column);

  const { lines: kept, hidden } = foldLines(String(text ?? '').split('\n'), maxLines);
  const wrapped = [];
  for (const line of kept) for (const piece of wrapToWidth(line, room)) wrapped.push(piece);
  if (!wrapped.length) wrapped.push('');

  const out = wrapped.map((line, index) => (index === 0
    ? `${lead}${glyphTone}${glyph}${reset}${' '.repeat(Math.max(0, gap))}${tone}${line}${reset}`
    : `${hang}${tone}${line}${reset}`));
  if (hidden) out.push(`${hang}${markerTone || tone}${truncateToWidth(foldMarker(hidden, ellipsis), room)}${reset}`);
  return out;
}

// ---------------------------------------------------------------------------
// Honest metrics
// ---------------------------------------------------------------------------

/**
 * A *measurement* we never took renders as an em dash, never as 0. Tokens and
 * latency only ever reach us as positive observations, so a missing or zero
 * value means "the daemon never reported one" — printing 0 would invent it.
 */
function metric(value, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DASH;
  return `${number}${suffix}`;
}

/**
 * A *cardinality*, which is a different kind of claim: an empty list really is
 * zero and saying so is honest, but a list we were never handed is unknown.
 */
function count(list) {
  if (Array.isArray(list)) return String(list.length);
  if (list === null || list === undefined || list === '') return DASH; // Number(null) is 0 — do not let that through
  const number = Number(list);
  return Number.isFinite(number) && number >= 0 ? String(number) : DASH;
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];

/** Shorten an absolute path the way a status line should: `~/…/dir/file.js`. */
function shortenPath(value, home = process.env.HOME || '') {
  let text = String(value || '');
  if (home && text.startsWith(home)) text = `~${text.slice(home.length)}`;
  const parts = text.split('/');
  if (parts.length <= 3) return text;
  return `${parts[0] || ''}/${UNICODE_GLYPHS.ellipsis}/${parts.slice(-2).join('/')}`.replace(/^\//, '~/');
}

/**
 * The single short argument shown inside `Tool(...)`. Mirrors the vocabulary a
 * real transcript carries: a command for Bash, a path for the file tools, a
 * pattern for the search tools, a description for a delegated agent.
 */
function summarizeToolInput(name, input = {}, { width = 48 } = {}) {
  const tool = String(name || '');
  const data = input && typeof input === 'object' ? input : {};
  const pick = (key) => (typeof data[key] === 'string' ? data[key] : '');
  let value = '';
  if (/^bash$/i.test(tool)) value = pick('command').split('\n')[0];
  else if (/^(grep|glob|search)/i.test(tool)) value = pick('pattern') || pick('query');
  else if (/^(task|agent|subagent)/i.test(tool)) value = pick('description') || pick('prompt').split('\n')[0];
  else if (/^web(fetch|search)/i.test(tool)) value = pick('url') || pick('query');
  if (!value) { const key = PATH_KEYS.find((item) => pick(item)); if (key) value = shortenPath(data[key]); }
  if (!value) {
    const key = Object.keys(data).find((item) => typeof data[item] === 'string' && data[item]);
    value = key ? String(data[key]).split('\n')[0] : '';
  }
  return truncateToWidth(String(value).replace(/\s+/g, ' ').trim(), Math.max(8, width));
}

/** `● Bash(npm test)` — one line, name bold, argument dim. */
function renderToolCall(name, input, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), indent = 0 } = options;
  const label = String(name || 'tool');
  const argWidth = Math.max(8, width - indent - stringWidth(label) - 6);
  const arg = typeof input === 'string' ? truncateToWidth(input, argWidth) : summarizeToolInput(label, input, { width: argWidth });
  const head = `${theme.bold}${theme.ink}${label}${theme.reset}${theme.muted}(${arg})${theme.reset}`;
  const plainHead = `${label}(${arg})`;
  const column = indent + stringWidth(mark.turn) + 1;
  return [`${' '.repeat(indent)}${theme.accent}${mark.turn}${theme.reset} ${
    stringWidth(plainHead) > width - column ? truncateToWidth(plainHead, width - column) : head}`];
}

/** `  ⎿  …` — the result of the line above, folded and indented under it. */
function renderToolResult(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), maxLines = 4, indent = 2, tone = theme.muted, isError = false } = options;
  const body = String(text ?? '').replace(/\s+$/, '');
  return gutterLines(body || '(no output)', {
    width, glyph: mark.result, indent, gap: 2, maxLines,
    tone: isError ? theme.error : tone, glyphTone: theme.brown, reset: theme.reset,
    markerTone: theme.dim, ellipsis: mark.ellipsis,
  });
}

/** `> what the owner typed` */
function renderUserTurn(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs() } = options;
  return gutterLines(String(text ?? ''), {
    width, glyph: mark.user, indent: 0, gap: 1,
    tone: theme.strong, glyphTone: theme.prompt, reset: theme.reset, ellipsis: mark.ellipsis,
  });
}

/** `● what BigKiji said` */
function renderAssistantText(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), maxLines = 0 } = options;
  return gutterLines(String(text ?? ''), {
    width, glyph: mark.turn, indent: 0, gap: 1, maxLines,
    tone: theme.ink, glyphTone: theme.accent, reset: theme.reset,
    markerTone: theme.dim, ellipsis: mark.ellipsis,
  });
}

/** A muted aside — timestamps, phases, counts. Never bold, never accented. */
function renderNote(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), indent = 2 } = options;
  return gutterLines(String(text ?? ''), {
    width, glyph: mark.result, indent, gap: 2,
    tone: theme.dim, glyphTone: theme.brown, reset: theme.reset, ellipsis: mark.ellipsis,
  });
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into `{ kind, line, text }` records. `kind` is one of
 * `add` / `del` / `ctx`; `line` is the number the record belongs to in the file
 * after the edit (before the edit, for removals).
 */
function parseUnifiedDiff(patch) {
  const out = [];
  let oldLine = 0; let newLine = 0;
  const source = String(patch ?? '').split('\n');
  if (source.length > 1 && source[source.length - 1] === '') source.pop(); // trailing newline is not a line
  for (const raw of source) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (/^(---|\+\+\+|diff |index )/.test(raw)) continue;
    if (raw.startsWith('+')) { out.push({ kind: 'add', line: newLine, text: raw.slice(1) }); newLine += 1; continue; }
    if (raw.startsWith('-')) { out.push({ kind: 'del', line: oldLine, text: raw.slice(1) }); oldLine += 1; continue; }
    if (raw.startsWith('\\')) continue;
    out.push({ kind: 'ctx', line: newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw });
    oldLine += 1; newLine += 1;
  }
  return out;
}

const DIFF_HEAD = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;

/** True when a tool result is really a patch, so it can be shown as one. */
function looksLikeDiff(text) { return DIFF_HEAD.test(String(text ?? '')); }

const DIFF_SIGN = Object.freeze({ add: '+', del: '-', ctx: ' ' });

/**
 * Render a diff as a diff: right-aligned dim line numbers, a `+`/`-`/space sign
 * column, added lines in the accent, removed lines in the error tone, context
 * dim. Long lines are ellipsised at the width; the block folds like any other.
 * @returns {string[]}
 */
function formatDiff(patch, options = {}) {
  const { width = 80, theme = themeFor('plan'), indent = 2, maxLines = 0, mark = glyphs(), numberWidth = 4 } = options;
  const records = Array.isArray(patch) ? patch : parseUnifiedDiff(patch);
  const { lines: kept, hidden } = foldLines(records, maxLines);
  const lead = ' '.repeat(Math.max(0, indent));
  const column = indent + numberWidth + 3; // number + space + sign + space
  const room = Math.max(4, Math.trunc(width) - column);
  const out = kept.map((record) => {
    const sign = DIFF_SIGN[record.kind] || ' ';
    const tone = record.kind === 'add' ? theme.accent : record.kind === 'del' ? theme.error : theme.dim;
    const number = String(record.line ?? '').padStart(numberWidth);
    const body = truncateToWidth(record.text ?? '', room);
    return `${lead}${theme.dim}${number}${theme.reset} ${tone}${sign} ${body}${theme.reset}`;
  });
  if (hidden) out.push(`${' '.repeat(column)}${theme.dim}${foldMarker(hidden, mark.ellipsis)}${theme.reset}`);
  return out;
}

// ---------------------------------------------------------------------------
// Task lists
// ---------------------------------------------------------------------------

const TASK_STATE = Object.freeze({
  completed: 'completed', done: 'completed', complete: 'completed', ok: 'completed',
  active: 'active', in_progress: 'active', running: 'active', executing: 'active',
  pending: 'pending', queued: 'pending', planned: 'pending', blocked: 'pending',
});

/**
 * Completed items are struck through and dim, the active one is bold accent,
 * pending ones are plain — so progress is legible at a glance without counting.
 * @returns {string[]}
 */
function formatTaskList(tasks = [], options = {}) {
  const { width = 80, theme = themeFor('plan'), indent = 2, mark = glyphs(), maxLines = 0 } = options;
  const { lines: kept, hidden } = foldLines(tasks, maxLines);
  const out = [];
  for (const task of kept) {
    const state = TASK_STATE[String(task?.status || 'pending').toLowerCase()] || 'pending';
    const glyph = state === 'completed' ? mark.done : state === 'active' ? mark.active : mark.pending;
    const tone = state === 'completed' ? `${theme.dim}${SGR_STRIKE}` : state === 'active' ? `${theme.bold}${theme.accent}` : theme.ink;
    for (const line of gutterLines(String(task?.text ?? task ?? ''), {
      width, glyph, indent, gap: 1, tone, glyphTone: state === 'active' ? theme.accent : theme.muted,
      reset: theme.reset, ellipsis: mark.ellipsis,
    })) out.push(line);
  }
  if (hidden) out.push(`${' '.repeat(indent + stringWidth(mark.pending) + 1)}${theme.dim}${foldMarker(hidden, mark.ellipsis)}${theme.reset}`);
  return out;
}

// ---------------------------------------------------------------------------
// The BigKiji daemon event vocabulary
// ---------------------------------------------------------------------------

const RUN_TASK_STATE = Object.freeze({
  completed: 'completed', failed: 'completed', blocked: 'pending',
  running: 'active', executing: 'active', dispatching: 'active',
});

function runAssignments(run = {}) {
  return (run.assignments || []).map((item) => ({
    text: `${item.title || item.role || item.taskId} ${item.provider ? `· ${item.provider}` : ''}`.trim(),
    status: RUN_TASK_STATE[String(item.status || '').toLowerCase()] || 'pending',
  }));
}

/**
 * Map one daemon event onto transcript lines. Returns `[]` for events the
 * transcript deliberately does not carry — phase progress lives in the sticky
 * footer, and echoing the owner's own prompt back is pure noise.
 * @returns {string[]}
 */
function renderEvent(event, data = {}, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), resultLines = 4 } = options;
  const base = { width, theme, mark };
  const text = String(data?.text || '').trim();

  switch (event) {
    case 'commentary': {
      if (!text) return [];
      const source = lower(data.source || 'bigkiji');
      const lines = renderToolCall(source, truncateToWidth(phrase(data.status || 'note'), 18), base);
      return [...lines, ...renderToolResult(text, { ...base, maxLines: resultLines })];
    }
    case 'tasklog': {
      if (!text) return [];
      // A provider that printed a patch gets a patch: line numbers and +/-
      // prefixes, not an anonymous wall of text under an elbow.
      if (looksLikeDiff(text)) return formatDiff(text, { ...base, indent: 5, maxLines: Math.max(resultLines, 8) });
      return renderToolResult(text, { ...base, maxLines: resultLines, isError: data.stream === 'stderr' });
    }
    case 'task': {
      const title = data?.metadata?.title || data?.metadata?.role || data.id || 'task';
      const head = renderToolCall(lower(data.provider || 'agent'), String(title), base);
      const status = String(data.status || '').toUpperCase();
      if (!status) return head;
      return [...head, ...renderNote(phrase(status), base)];
    }
    case 'run': {
      const head = renderToolCall('run', `${lower(data.id) || DASH} · ${phrase(data.status) || DASH}`, base);
      const list = formatTaskList(runAssignments(data), { ...base, indent: 2, maxLines: 8 });
      return [...head, ...list];
    }
    case 'idea': {
      const title = data?.draft?.title || data.ideaId || data.id || '';
      if (!data.action) return [];
      return renderToolCall('idea', `${lower(data.action)}${title ? ` · ${title}` : ''}`, base);
    }
    case 'conversation':
      // turn_start repeats the prompt the owner just typed; turn_complete is
      // already printed by the awaited call. Both are footer material only.
      return [];
    case 'phase':
      return [];
    case 'error': {
      const message = String(data.error || text || 'unknown error');
      return renderToolResult(message, { ...base, maxLines: resultLines, isError: true });
    }
    default:
      if (!text) return [];
      return renderAssistantText(text, { ...base, maxLines: resultLines });
  }
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

/**
 * The fleet, de-boxed. Aligned columns, one accent, dim everywhere else, and
 * unmeasured metrics as `—`. Degrades to a single narrow column at 60 columns.
 * @returns {string[]}
 */
function renderStatus(state = {}, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs() } = options;
  const fleet = state?.models?.models || state?.models || [];
  const connected = fleet.filter((model) => model.connected).length;
  const out = [];

  const counts = [
    `phase ${phrase(state.phase || 'IDLE')}`,
    `sessions ${count(state.sessions)}`,
    `runs ${count(state.runs)}`,
    `files ${count(state.inventory?.files)}${state.inventory?.truncated ? '+' : ''}`,
  ].join(`  ${mark.note}  `);
  out.push(...renderToolCall('status', counts, { width, theme, mark }));

  const nameWidth = Math.max(10, Math.min(20, width - 44));
  for (const model of fleet) {
    // The comparison stays uppercase — that is the value the daemon publishes.
    // Only `label` reaches the screen.
    const status = String(model.status || 'IDLE').toUpperCase();
    const label = phrase(status);
    const tone = status === 'ERROR' ? theme.error : model.connected ? theme.accent : theme.muted;
    const metrics = model.metrics || {};
    const name = padToWidth(lower(model.displayName || model.id || '?'), nameWidth);
    const detail = width < 76
      ? `${label}`
      : `${padToWidth(label, 9)} ${theme.dim}${padToWidth(`${metric(metrics.tokensUsed)} tok`, 11)}${padToWidth(`${metric(metrics.latencyMs, 'ms')}`, 8)}${theme.reset}`;
    out.push(`  ${tone}${mark.turn}${theme.reset} ${theme.ink}${name}${theme.reset} ${tone}${detail}${theme.reset}`);
  }
  out.push(...renderNote(`${count(connected)} connected of ${count(fleet)}`, { width, theme, mark }));
  return out;
}

module.exports = {
  DASH, UNICODE_GLYPHS, ASCII_GLYPHS, glyphs, lower, phrase,
  charWidth, stringWidth, sliceToWidth, truncateToWidth, padToWidth, wrapToWidth,
  foldLines, foldMarker, gutterLines, metric, count,
  shortenPath, summarizeToolInput, renderToolCall, renderToolResult,
  renderUserTurn, renderAssistantText, renderNote,
  parseUnifiedDiff, formatDiff, formatTaskList, looksLikeDiff,
  renderEvent, renderStatus, runAssignments,
};
