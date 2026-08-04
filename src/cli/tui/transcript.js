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
const { formatCost, formatContext } = require('../../domain/pi-agent/pricing');

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
  // The critique thread. One cell wide, East Asian Width neutral, and distinct
  // from the result elbow — a reply to a result is not a result.
  reply: '⤷',
  // Something the owner has to see before deciding: a question the plan asked and
  // nobody answered, or a step that cannot be undone.
  warn: '⚠',
  done: '☑', active: '▸', pending: '☐', ellipsis: '…', rule: '─',
});
// TERM=dumb rarely has the box-drawing elbow or the ballot boxes.
const ASCII_GLYPHS = Object.freeze({
  turn: '*', result: '\\', user: '>', note: '.',
  reply: '->',
  warn: '!',
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
// Tools whose target is a filesystem path, so it can be folded to `~/…/dir/file`.
// Everything else — a command, a pattern, a url — is shown as written.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Delete']);

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

/**
 * `HH:MM:SS` in local time, or '' for a timestamp we were not given.
 *
 * A transcript without clocks cannot answer "is this from now or from this morning?".
 * Measured 2026-08-04: two runs had been waiting eleven hours and their block on screen
 * was indistinguishable from one submitted a second ago.
 */
function clockOf(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const two = (part) => String(part).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** `● Bash(npm test)` — one line, name bold, argument dim, optional clock at the right edge. */
function renderToolCall(name, input, options = {}) {
  // `glyph` overrides the gutter. The critique thread needs a mark that reads as a
  // reply rather than as a new turn — the same shape at two indents is a wall.
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), indent = 0, glyph = null, at = '' } = options;
  const label = String(name || 'tool');
  // The clock is reserved out of the width before the argument is measured, so a long
  // path is ellipsised rather than pushing the time off the edge.
  const clock = clockOf(at);
  const reserve = clock ? stringWidth(clock) + 2 : 0;
  const argWidth = Math.max(8, width - indent - stringWidth(label) - 6 - reserve);
  const arg = typeof input === 'string' ? truncateToWidth(input, argWidth) : summarizeToolInput(label, input, { width: argWidth });
  const head = `${theme.bold}${theme.ink}${label}${theme.reset}${theme.muted}(${arg})${theme.reset}`;
  const plainHead = `${label}(${arg})`;
  const gutter = glyph || mark.turn;
  const column = indent + stringWidth(gutter) + 1;
  const room = Math.max(4, width - column - reserve);
  const shown = stringWidth(plainHead) > room ? truncateToWidth(plainHead, room) : head;
  // stringWidth strips ANSI, so this measures the painted and the plain branch alike.
  const gap = clock ? ' '.repeat(Math.max(1, width - column - stringWidth(shown) - stringWidth(clock))) : '';
  return [`${' '.repeat(indent)}${theme.accent}${gutter}${theme.reset} ${shown}${clock ? `${gap}${theme.dim}${clock}${theme.reset}` : ''}`];
}

/** `  ⎿  …` — the result of the line above, folded and indented under it. */
function renderToolResult(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), maxLines = 4, indent = 2, tone = theme.muted, isError = false } = options;
  // isRoutineToolNoise() was written, exported, and called from nowhere.
  //
  // Measured 2026-08-05: one turn painted `added 6 packages`, `1 package is looking
  // for funding`, `found 0 vulnerabilities` and `npm notice New major version` twenty
  // times, in the error colour, above the one line that was actually about the task.
  // The patterns were right the whole time; nothing ran them. `npm notice` also
  // arrives with several notices concatenated onto one physical line, so the test is
  // applied to what npm sends rather than only to the start of a tidy line.
  const kept = String(text ?? '').split('\n').filter((line) => !isRoutineToolNoise(line));
  const body = (kept.length ? kept.join('\n') : String(text ?? '')).replace(/\s+$/, '');
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

/**
 * One row per assignment: who, on what model, allowed to write or not, doing what.
 *
 * This used to be `title · provider`, which answered none of the questions the owner
 * asks at an approval gate. The coordinator has already decided the role, the agent,
 * the exact model tier and whether the task may write — all of it sitting in the run
 * object, none of it on screen (measured 2026-08-04, where the whole visible plan was
 * two lines of title and a provider name).
 *
 * Nothing is inferred. A field the coordinator did not set is left out rather than
 * defaulted: `write` absent is not `write` false, and printing either would be a claim
 * about permissions we were never told.
 */
/** The readable handle for a run — its first two segments, the way git shows a short SHA. */
function shortRunId(id) {
  const text = lower(id || '');
  const parts = text.split('-');
  return parts.length > 2 ? parts.slice(0, 2).join('-') : text;
}

function runAssignments(run = {}) {
  const rows = (run.assignments || []).map((item) => {
    // The role is the job; the agent is the hat worn for this run. `leader` alone does
    // not say that this one is the architect lens, and both are one word each.
    const who = [lower(item.role || ''), lower(item.agent || '')].filter(Boolean).join(' · ');
    // The tier that will answer, not just the vendor: two assignments on one provider
    // routinely run different models and cost different money. The vendor is dropped
    // when the model id already opens with it, because `qwen qwen3.5:35b-a3b` reads as
    // a stutter rather than as two facts.
    const provider = lower(item.provider || '');
    const model = lower(item.model || '');
    const engine = model ? (provider && !model.startsWith(provider) ? `${provider} ${model}` : model) : provider;
    return { who, engine, access: typeof item.write === 'boolean' ? (item.write ? 'write' : 'read') : '',
      title: String(item.title || item.taskId || ''),
      status: RUN_TASK_STATE[String(item.status || '').toLowerCase()] || 'pending' };
  });
  // Columns, because the point of this block is comparing the rows to each other:
  // ragged text makes the owner re-read each line to find which one may write.
  const widest = (key) => rows.reduce((max, row) => Math.max(max, stringWidth(row[key])), 0);
  const whoWidth = widest('who'); const engineWidth = widest('engine'); const accessWidth = widest('access');
  return rows.map((row) => ({
    status: row.status,
    text: [row.who && padToWidth(row.who, whoWidth), row.engine && padToWidth(row.engine, engineWidth),
      row.access && padToWidth(row.access, accessWidth), row.title].filter(Boolean).join('  '),
  }));
}

/**
 * What the plan is for, and what it still wants answered.
 *
 * Every line here already travelled to the CLI inside the run object and was thrown
 * away by the renderer. The one that matters most is the last: `promptSpec.questions`
 * is the plan asking the owner something, and on 2026-08-04 a run sat for eleven hours
 * with an unanswered question in it that never reached a screen.
 * @returns {string[]}
 */
function runBrief(run = {}, options = {}) {
  const { mark = glyphs() } = options;
  const spec = run.promptSpec || {};
  const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const list = (value) => (Array.isArray(value) ? value.map(flat).filter(Boolean) : []);
  const rows = [];
  if (flat(spec.goal)) rows.push(`goal: ${flat(spec.goal)}`);
  const constraints = list(spec.constraints);
  if (constraints.length) rows.push(`constraints: ${constraints.join(' / ')}`);
  const questions = list(spec.questions);
  for (const question of questions) rows.push(`${mark.warn} unanswered: ${question}`);
  // A question with no way to answer it is what produced the eleven-hour wait. The
  // CLI offered approve, reject and later; none of those is an answer, so approving
  // sent the plan back to asking the same thing. `/answer` rewrites the spec from
  // the reply and re-plans on it.
  if (questions.length) rows.push(`/answer ${run.id || '<id>'} <your answer> — rewrites the plan from it`);
  if (!rows.length) return [];
  return renderToolResult(rows.join('\n'), { ...options, indent: 2, maxLines: 8 });
}

const READS_SHOWN = 4;

/**
 * Which files the agents will actually open, from the disclosure the owner is approving.
 *
 * The disclosure is the thing the approval hash is sealed against, so this is not a
 * summary of the plan — it is the plan, in the same bytes the coordinator will check.
 *
 * Identical lists are merged. The context pruner scores files per prompt, not per
 * provider, so three assignments on one request routinely get the same slice — printed
 * once each that was three wrapped copies of the same six paths, which is how a block
 * meant to inform an approval turns into something nobody reads.
 * @returns {string[]}
 */
// npm's routine chatter, which is not news about the task.
//
// The owner watched a run where `added 4 packages`, `2 packages are looking for
// funding` and `npm notice New major version of npm available` took a dozen lines of
// the live stream, in the same treatment as real output. None of it says anything
// about the work; the funding and version notices are not even about this project.
//
// Only lines that carry NO information about the task. A real npm failure — `npm ERR!`,
// a peer-dependency conflict, an audit finding with a severity — is not here and must
// never be: silencing a failure is a worse defect than printing noise, and it is the
// exact shape of the defect this whole session has been removing.
const NPM_NOISE = [
  /^added \d+ packages?(, and )?/i,
  /^removed \d+ packages?/i,
  /^changed \d+ packages?/i,
  /^up to date(,| in )/i,
  /^\d+ packages? (are|is) looking for funding/i,
  /^\s*run `npm fund` for details/i,
  /^found \d+ vulnerabilities$/i,
  // npm sends several notices on one physical line, so this cannot be anchored:
  //   "npm notice npm notice New major version of npm available! ... npm notice"
  /npm notice/i,
  /^\s*run `npm fund`/i,
  /^audited \d+ packages?/i,
];

/**
 * True when a line is npm saying something about npm rather than about the task.
 * @param {string} text
 * @returns {boolean}
 */
function isRoutineToolNoise(text) {
  const line = String(text || '').trim();
  if (!line) return false;
  // An error is never noise, whatever else it matches.
  if (/npm ERR!|ERR!|\bERROR\b/.test(line)) return false;
  return NPM_NOISE.some((pattern) => pattern.test(line));
}

function runReads(run = {}, options = {}) {
  const { mark = glyphs() } = options;
  const byFiles = new Map();
  for (const disclosure of run.disclosures || []) {
    const files = (disclosure.files || []).filter((file) => file && file.path);
    if (!files.length) continue;
    const labels = files.map((file) => {
      const ranges = Array.isArray(file.ranges) ? file.ranges.join(',') : '';
      return ranges ? `${shortenPath(file.path)} ${ranges}` : shortenPath(file.path);
    });
    // Keyed on the whole list, never on the truncated line. Two agents whose first four
    // files match and whose fifth does not are reading different things, and merging
    // them under one row would say they are not.
    const key = labels.join(' ');
    const entry = byFiles.get(key) || { labels, who: [] };
    const provider = lower(disclosure.provider || 'agent');
    if (!entry.who.includes(provider)) entry.who.push(provider);
    byFiles.set(key, entry);
  }
  const rows = [...byFiles.values()].map(({ labels, who }) => {
    const shown = labels.slice(0, READS_SHOWN);
    const hidden = labels.length - shown.length;
    return `${who.join(', ')} reads: ${shown.join(` ${mark.note} `)}${
      hidden ? ` ${mark.ellipsis} +${hidden} ${hidden === 1 ? 'file' : 'files'}` : ''}`;
  });
  if (!rows.length) return [];
  return renderNote(rows.join('\n'), { ...options, indent: 2 });
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
      // The headline carries the two facts that decide whether this needs reading:
      // which of the two gates it is at, and whether anything can write. There are two
      // approval gates — a read-only deliberation and then the execution — and until
      // now the screen never said which one you were looking at.
      const assignments = data.assignments || [];
      const stage = lower(data.stage || '');
      const writes = assignments.some((item) => item.write !== false);
      const headline = [shortRunId(data.id) || DASH, phrase(data.status) || DASH,
        stage ? `${stage} stage` : '', assignments.length ? (writes ? 'writes' : 'read-only') : '']
        .filter(Boolean).join(' · ');
      const head = renderToolCall('run', headline, { ...base, at: data.updatedAt || data.createdAt || '' });
      const list = formatTaskList(runAssignments(data), { ...base, indent: 2, maxLines: 8 });
      // A failed run rendered as a status word with nothing behind it: the reason
      // travelled all the way from the coordinator and was dropped right here, so
      // the only thing the transcript ever said about a failure was that it failed.
      const failure = String(data.error || data.reason || '').trim();
      // The goal, the questions and the file list exist to inform a decision, so they
      // print where there is a decision to make. A run publishes an event on every
      // status change, and repeating a twenty-line brief each time buries the line that
      // actually changed — measured on a live run 2026-08-04, four identical blocks in
      // as many seconds. Once it is executing, the step feed is the thing worth reading.
      const deciding = data.status === 'AWAITING_APPROVAL' || data.status === 'SECURITY_BLOCKED';
      return [...head, ...(deciding ? runBrief(data, base) : []), ...list, ...(deciding ? runReads(data, base) : []),
        ...(failure ? renderToolResult(failure, { ...base, indent: 2, maxLines: 3, isError: true }) : [])];
    }
    // One tool call by one delegated agent, as it happens.
    //
    // The daemon has published these down `task:step` since the day the stream parser
    // was written, and the CLI's relay list did not carry `step`, so every one of them
    // was dropped at the door: the GUI window had a live work timeline and the terminal
    // had nothing at all. That is most of the answer to "is it working or not" — when
    // something IS running, this is the only thing that says so.
    //
    // `options.label` is who — the caller resolves taskId against the run's assignments,
    // because the step payload knows its provider but not which role it was hired for.
    case 'step': {
      const who = String(options.label || lower(data.provider || 'agent')).trim();
      if (data.phase === 'end') {
        const failed = data.ok === false;
        const said = String(data.errorText || '').trim();
        return renderToolResult(failed ? (said || 'failed') : 'ok',
          { ...base, indent: 2, maxLines: 2, isError: failed });
      }
      if (data.phase !== 'start' || !data.tool) return [];
      const tool = String(data.tool);
      // shortenPath only where the target is a path. A shell command routinely contains
      // slashes and folding it to `~/…/a/b` would be a lie about what ran.
      const target = FILE_TOOLS.has(tool) ? shortenPath(data.target || '') : String(data.target || '');
      const counts = [Number(data.added) > 0 ? `+${data.added}` : '', Number(data.removed) > 0 ? `−${data.removed}` : '']
        .filter(Boolean).join(' ');
      return renderToolCall(`${who} ${mark.note} ${tool}`, [target, counts].filter(Boolean).join('  '),
        { ...base, at: data.at || '' });
    }
    // The critique thread the owner asked for: result, then BigKiji's comment, then
    // the agent's answer, each one step further in. Two levels only — a third
    // collapses on a narrow terminal — and no box, because the owner asked by name
    // for the transcript to stay unboxed.
    case 'review': {
      const who = lower(data.role || data.provider || 'agent');
      // Nothing to say is said in one line. A comment on every result is a comment
      // nobody reads by Thursday.
      if (data.quiet) return [`${' '.repeat(2)}${theme.dim}${mark.reply} bigkiji ${mark.note} ${who} ${mark.note} nothing to add${theme.reset}`];
      const head = renderToolCall('bigkiji', `${who} ${mark.note} ${(data.findings || []).length} to answer`, { ...base, indent: 2, glyph: mark.reply });
      const body = (data.findings || []).map((item) => `${item.id}: ${item.note}`).join('\n');
      return [...head, ...renderToolResult(body, { ...base, indent: 4, maxLines: 4, isError: true })];
    }
    case 'reflection': {
      const who = lower(data.role || data.provider || 'agent');
      const head = renderToolCall(who, data.acknowledged ? 'reflection' : 'disagrees', { ...base, indent: 4, glyph: mark.reply });
      const body = [data.whatWentWrong, `${mark.active} ${data.whatToDoDifferently}`].filter(Boolean).join('\n');
      return [...head, ...renderToolResult(body, { ...base, indent: 6, maxLines: 4 })];
    }
    // Pi's own voice.
    //
    // Only the finished message reaches the transcript: the deltas are what the
    // footer's loading cat is already reporting, and printing a partial answer four
    // times is the same duplication the run block had. Everything else Pi emits —
    // turn_start, message_start, agent_settled — is machinery, not conversation.
    case 'pi': {
      if (data.kind === 'stderr') return renderToolResult(text, { ...base, maxLines: 2, isError: true });
      if (data.kind === 'degraded') return renderNote(`pi fell back to ${lower(data.model || '?')}`, base);
      if (data.kind === 'exhausted') return renderToolResult(`pi has no tier left: ${data.reason || 'unknown'}`, { ...base, maxLines: 2, isError: true });
      if (data.type !== 'message_end' || data.message?.role !== 'assistant') return [];
      const said = (data.message.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('').trim();
      if (!said) return [];
      const model = data.message.model ? ` ${mark.note} ${lower(data.message.model)}` : '';
      return [...renderToolCall('pi', `answered${model}`, base), ...renderAssistantText(said, { ...base, maxLines: resultLines + 4 })];
    }
    // Step ⑥ of the owner's workflow: what happened, in one block.
    //
    // Only measurements. A provider whose usage was never reported shows '—' and not
    // a zero, and nothing here is combined or inferred — merging several providers'
    // edits automatically has no working precedent, and a report that implied
    // otherwise would be the most expensive kind of wrong.
    case 'report': {
      const ok = data.status === 'COMPLETED';
      const took = data.ms ? ` ${mark.note} ${Math.round(data.ms / 1000)}s` : '';
      const tok = data.tokens ? ` ${mark.note} ${data.tokens} tok` : '';
      // The owner's stated reason this project exists is one CLI that manages billing
      // across every model, and until now it showed no figure in dollars anywhere.
      const spend = data.cost === null || data.cost === undefined ? '' : ` ${mark.note} ${formatCost(data.cost)}`;
      const head = renderToolCall('report', `${data.completed}/${data.total} done ${mark.note} ${phrase(data.status)}${took}${tok}${spend}`, base);
      const rows = (data.rows || []).map((row) => {
        const glyph = row.status === 'completed' ? mark.done : mark.pending;
        const cost = [row.ms ? `${Math.round(row.ms / 1000)}s` : DASH, row.tokens ? `${row.tokens} tok` : DASH,
          formatCost(row.cost), formatContext(row.context)].join(' ');
        const stood = row.standInFor ? ` (for ${lower(row.standInFor)})` : '';
        const note = row.error || row.headline || '';
        // What it put on disk. A provider that reports no line counts gets the file
        // count and a dash, never a fabricated 0.
        const files = (row.changed || []).length;
        const lines = (row.changed || []).reduce((acc, change) => ({
          added: change.added === null ? acc.added : (acc.added || 0) + change.added,
          removed: change.removed === null ? acc.removed : (acc.removed || 0) + change.removed,
        }), { added: null, removed: null });
        const wrote = files
          ? `\n   ${files} file${files === 1 ? '' : 's'} ${mark.note} ${lines.added === null ? DASH : `+${lines.added}`} ${lines.removed === null ? DASH : `-${lines.removed}`}`
          : '';
        // Which of the owner's own skills steered this assignment. It used to be
        // injected silently, so when it matched the wrong thing nothing said so.
        const steered = (row.skills || []).length ? `\n   skills: ${row.skills.join(', ')}` : '';
        // A writer that shared the directory with another writer has to say so here,
        // because the collision line below only fires once they have actually clashed.
        const where = row.isolated ? `\n   isolated: ${row.workspacePath}`
          : (row.notIsolated ? `\n   not isolated: ${row.notIsolated}` : '');
        return `${glyph} ${lower(row.role)} ${mark.note} ${lower(row.provider)}${stood} ${mark.note} ${cost}${note ? `\n   ${note}` : ''}${wrote}${steered}${where}`;
      }).join('\n');
      const failed = (data.checks || []).filter((check) => !check.pass).map((check) => check.id);
      const tail = failed.length ? `\nnot verified: ${failed.join(', ')}` : '';
      // Two providers on one file is the thing the owner has to see before anything
      // else in this report: the later writer won and nothing else would say so.
      const clash = (data.collisions || []).length
        ? `\nsame file, two writers: ${(data.collisions || []).map((hit) => `${hit.path} (${hit.writers.map((w) => lower(w.role)).join(' + ')})`).join(', ')}`
        : '';
      const repairs = data.repairs ? `\nrepair cycles: ${data.repairs}` : '';
      return [...head, ...renderToolResult(`${rows}${clash}${tail}${repairs}`, { ...base, maxLines: 16, isError: !ok })];
    }
    case 'checkpoint': {
      // Thirty minutes in, the owner is told where the run is rather than left to
      // guess or find it finished an hour later.
      const elapsed = (data.budgetMinutes || 0) + (data.overdueMinutes || 0);
      const head = renderToolCall('checkpoint', `${data.completed?.length || 0}/${(data.completed?.length || 0) + (data.stillRunning?.length || 0)} done · ${elapsed}m`, base);
      const body = [
        ...(data.completed?.length ? [`done: ${data.completed.join(', ')}`] : []),
        ...(data.stillRunning?.length ? [`still running: ${data.stillRunning.join(', ')}`] : ['nothing is running']),
        'continue, or /abort to stop it',
      ].join('\n');
      return [...head, ...renderToolResult(body, { ...base, maxLines: 4 })];
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
  out.push(...renderNote(`${count(connected)} busy of ${count(fleet)} · ${fleet.filter((model) => model.available ?? model.connected).length} ready`, { width, theme, mark }));

  // The fleet by model, not by provider.
  //
  // The owner asked to manage this per model, and until now there was nothing to
  // manage: three of the four providers ran one pinned model, so a row per provider
  // was a row per model by accident. Now that each task names its own tier, what was
  // measured — how often it worked, how long it took — is per (provider, model), and
  // this is where that becomes visible. Unmeasured stays '—'.
  const perModel = Object.entries(state?.models?.performance?.models || state?.performance?.models || {})
    .filter(([id]) => id.includes('::'))
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => Number(b.samples || 0) - Number(a.samples || 0));
  if (perModel.length) {
    out.push(...renderToolCall('models', `${perModel.length} measured`, { width, theme, mark }));
    const idWidth = Math.max(16, Math.min(30, width - 40));
    for (const row of perModel.slice(0, 10)) {
      const samples = Number(row.samples || 0);
      const rate = samples ? `${Math.round(Number(row.successRate || 0) * 100)}%` : DASH;
      const latency = Number(row.latencySamples || 0) ? `${Math.round(Number(row.ewmaLatencyMs || 0) / 100) / 10}s` : DASH;
      const throttled = Number(row.throttled || 0) ? ` ${mark.note} ${row.throttled} throttled` : '';
      out.push(`  ${theme.accent}${mark.turn}${theme.reset} ${theme.ink}${padToWidth(lower(row.id.replace('::', ' ')), idWidth)}${theme.reset} ${
        theme.muted}${padToWidth(`${samples || DASH} run`, 8)}${padToWidth(rate, 6)}${padToWidth(latency, 7)}${throttled}${theme.reset}`);
    }
  }

  // The local tools. Detection and health checks for all nine have existed since
  // V2.5 and were wired to nothing, so there was no way to see from BigKiji whether
  // the thing you were about to route work to was up. Anything not connected says
  // why in its own words — `found` is installed but unverified, and that is a
  // different fact from missing.
  const tools = state?.tools?.tools || [];
  if (tools.length) {
    out.push(...renderToolCall('tools', `${state.tools.connected}/${tools.length} connected`, { width, theme, mark }));
    const toolName = Math.max(10, Math.min(16, width - 46));
    for (const tool of tools) {
      const up = tool.status === 'connected';
      const tone = up ? theme.accent : theme.muted;
      const detail = width < 76 ? phrase(tool.status) : `${padToWidth(phrase(tool.status), 11)}${theme.dim}${truncateToWidth(tool.detail || '', Math.max(0, width - toolName - 20))}${theme.reset}`;
      out.push(`  ${tone}${up ? mark.done : mark.pending}${theme.reset} ${theme.ink}${padToWidth(lower(tool.id), toolName)}${theme.reset} ${tone}${detail}${theme.reset}`);
    }
  }
  return out;
}

module.exports = {
  DASH, UNICODE_GLYPHS, ASCII_GLYPHS, glyphs, lower, phrase,
  charWidth, stringWidth, sliceToWidth, truncateToWidth, padToWidth, wrapToWidth,
  foldLines, foldMarker, gutterLines, metric, count, clockOf,
  shortenPath, summarizeToolInput, renderToolCall, renderToolResult,
  renderUserTurn, renderAssistantText, renderNote,
  parseUnifiedDiff, formatDiff, formatTaskList, looksLikeDiff,
  renderEvent, renderStatus, runAssignments, runBrief, runReads, shortRunId, FILE_TOOLS,
  isRoutineToolNoise,
};
