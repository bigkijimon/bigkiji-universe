'use strict';

// Where a function starts and where it stops, without a parser dependency.
//
// ContextPruner sends a specialist the lines around a keyword hit: twenty-four
// before, twenty-five after. That number has nothing to do with the code. A
// forty line function gets padded with its neighbours; a sixty line one arrives
// cut in half, so the model is asked to reason about a body whose signature and
// early returns are missing, and it does — it guesses, and the guess reads as
// confidence. Sending the whole file instead is the other failure: it is what
// the token budget is for.
//
// So: find the enclosing definition and send that. The owner's constraint is no
// new npm dependency (2026-08-03), which rules out tree-sitter and every real
// parser, and this is deliberately not one. It is a brace matcher for the C-like
// languages and an indentation reader for Python, and it says so — `symbolsOf`
// returns [] for anything it does not understand, and the caller falls back to
// the line window that has always been there.
//
// The one thing it does have to get right is not being fooled. A naive brace
// count breaks on the first `}` inside a string or a comment and then every
// boundary after it in the file is wrong — silently, because the output is still
// plausible code. So the text is masked first: comments, string bodies, template
// literals and regular expressions are blanked to spaces (newlines kept, so line
// numbers survive) and the structural pass only ever sees real syntax.

const path = require('path');

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const PY_EXT = new Set(['.py']);

/** 'js' | 'py' | '' — '' means "no structure available, use line windows". */
function languageOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (JS_EXT.has(ext)) return 'js';
  if (PY_EXT.has(ext)) return 'py';
  return '';
}

// A '/' starts a regular expression rather than a division when the last
// meaningful character cannot end an expression. This is the standard heuristic
// and it is wrong for a handful of inputs (`a++ /re/`), none of which change a
// brace count in practice.
const REGEX_PRECEDES = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n', '']);

/**
 * Blank out everything that is not code, keeping length and line breaks so that
 * offsets and line numbers still line up with the original text.
 */
function maskJs(text) {
  const source = String(text || '');
  const out = source.split('');
  const blank = (index) => { if (source[index] !== '\n') out[index] = ' '; };
  const size = source.length;
  let i = 0;
  let prev = ''; // last significant character, for the regex/division decision
  // Each entry is the brace depth at which the enclosing template literal
  // resumes; `${` inside a template is real code and may contain more templates.
  const templates = [];
  let depth = 0;

  while (i < size) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') { while (i < size && source[i] !== '\n') blank(i++); continue; }
    if (c === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < size && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i < size) { blank(i); blank(i + 1); i += 2; }
      prev = ';'; continue;
    }
    if (c === '"' || c === "'") {
      blank(i++);
      while (i < size) {
        if (source[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (source[i] === '\n') break; // an unterminated string ends at the line
        if (source[i] === c) { blank(i++); break; }
        blank(i++);
      }
      prev = 'x'; continue;
    }
    // Inside a template *body* means the brace depth is exactly what it was when
    // that backtick opened. Anything deeper is an interpolation, which is ordinary
    // code and may open templates of its own.
    //
    // Without this distinction the open case below ran for the closing backtick
    // too — it pushed a second template instead of popping the first, `templates`
    // never emptied, and everything after the first template literal in the file
    // was blanked as if it were string content. Measured on footer.js: 1 of 9
    // top-level declarations survived, and symbolsOf returned nothing for every
    // file in this codebase that uses a template string, which is most of them.
    const inTemplateBody = templates.length > 0 && depth === templates[templates.length - 1];
    if (c === '`') {
      if (inTemplateBody) { templates.pop(); blank(i++); prev = 'x'; continue; }
      templates.push(depth); blank(i++); prev = 'x'; continue;
    }
    if (inTemplateBody) {
      // Inside a template literal: blank everything until the closing backtick
      // or the start of an interpolation.
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '$' && next === '{') { blank(i); out[i + 1] = '{'; depth += 1; i += 2; prev = '{'; continue; }
      if (c === '}' && depth === templates[templates.length - 1] + 1) { out[i] = '}'; depth -= 1; i += 1; prev = '}'; continue; }
      if (c === '{' || c === '}') { blank(i++); continue; }
      blank(i++); continue;
    }
    if (c === '/' && REGEX_PRECEDES.has(prev)) {
      let j = i + 1; let inClass = false; let closed = false;
      while (j < size && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) { while (i <= j) blank(i++); while (i < size && /[a-z]/i.test(source[i])) blank(i++); prev = 'x'; continue; }
      // Not a regex after all (no terminator on this line): fall through as '/'.
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (!/\s/.test(c)) prev = c; else if (c === '\n') prev = prev || '\n';
    i += 1;
  }
  return out.join('');
}

// What counts as a definition worth slicing to. Anything that owns a block and
// has a name a person would search for.
const JS_DECL = [
  // function foo(...)  /  async function* foo(...)
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  // class Foo
  /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  // const foo = (...) => {   /   const foo = function   /   const foo = async () =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  // a class or object method: `  foo(a, b) {`, `  async *bar() {`, `  get baz() {`
  /^\s+(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
];

// Control flow reads exactly like a method call followed by a block, so the
// method pattern above matches `if (ok) {` and every one of its relatives. They
// are not definitions and slicing to them would be worse than the line window.
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'try', 'finally',
  'return', 'typeof', 'instanceof', 'delete', 'void', 'new', 'await', 'yield', 'case', 'with', 'throw', 'in', 'of']);

/**
 * The brace that opens a definition's body, given the offset its declaration
 * starts at. Not simply the first `{` on the line: `constructor(options = {})`
 * and `function f({ a } = {})` both put braces in the parameter list, and taking
 * the first one made the definition end on the line it started — which is how
 * this was wrong the first time.
 */
function bodyBrace(masked, from, stop) {
  let parens = 0; let brackets = 0;
  for (let scan = from; scan < stop; scan += 1) {
    const c = masked[scan];
    if (c === '(') parens += 1;
    else if (c === ')') parens -= 1;
    else if (c === '[') brackets += 1;
    else if (c === ']') brackets -= 1;
    else if (c === '{' && parens <= 0 && brackets <= 0) return scan;
    else if (c === ';' && parens <= 0) return -1; // a declaration with no block
    else if (c === '=' && masked[scan + 1] === '>' && parens <= 0) {
      // `=> {` is a body; `=> value` on one line is not worth a symbol.
      let probe = scan + 2;
      while (probe < stop && /\s/.test(masked[probe])) probe += 1;
      return masked[probe] === '{' ? probe : -1;
    }
  }
  return -1;
}

function scanJs(text) {
  const masked = maskJs(text);
  const lines = masked.split('\n');
  const symbols = [];
  // Line offsets into the masked text, so a declaration line can be located.
  const offsets = []; let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const limit = masked.length;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let name = ''; let isClass = false;
    for (const pattern of JS_DECL) {
      const match = pattern.exec(line);
      if (!match || JS_KEYWORDS.has(match[1])) continue;
      name = match[1];
      isClass = /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\b/.test(line);
      break;
    }
    if (!name) continue;
    // A signature may wrap, so allow the body brace to be a few lines down; stop
    // well short of scanning the rest of the file for a declaration that has none.
    const horizon = Math.min(limit, offsets[Math.min(offsets.length - 1, index + 6)] + 400);
    const open = bodyBrace(masked, offsets[index], horizon);
    if (open < 0) continue;

    let depth = 0; let end = -1;
    for (let scan = open; scan < limit; scan += 1) {
      const c = masked[scan];
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = scan; break; } }
    }
    if (end < 0) continue;
    let endLine = index;
    while (endLine + 1 < offsets.length && offsets[endLine + 1] <= end) endLine += 1;
    if (endLine < index) continue;
    symbols.push({ name, kind: isClass ? 'class' : 'function', startLine: index, endLine, language: 'js' });
  }
  return symbols;
}

const PY_DECL = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/;

function scanPy(text) {
  const lines = String(text || '').split('\n');
  const symbols = [];
  // Triple-quoted strings can contain anything, including lines that look like
  // definitions, so they are skipped wholesale.
  const skip = new Array(lines.length).fill(false);
  let fence = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      skip[index] = true;
      if (line.includes(fence)) fence = '';
      continue;
    }
    const open = /("""|''')/.exec(line);
    if (open) {
      const rest = line.slice(open.index + 3);
      if (!rest.includes(open[1])) { fence = open[1]; skip[index] = true; }
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (skip[index]) continue;
    const match = PY_DECL.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    let end = index;
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const line = lines[probe];
      if (!line.trim()) continue; // a blank line does not end a body
      if (skip[probe]) { end = probe; continue; }
      const width = line.length - line.replace(/^\s*/, '').length;
      if (width <= indent) break;
      end = probe;
    }
    symbols.push({ name: match[3], kind: match[2] === 'class' ? 'class' : 'function', startLine: index, endLine: end, language: 'py' });
  }
  return symbols;
}

/**
 * Definitions in a file, outermost first, each with 0-based inclusive line
 * bounds. Returns [] for a language this module does not read — that is the
 * signal for the caller to keep using line windows, not an error.
 */
function symbolsOf(text, file = '') {
  const language = typeof file === 'string' && file.includes('.') ? languageOf(file) : String(file || '');
  if (language === 'js') return scanJs(text);
  if (language === 'py') return scanPy(text);
  return [];
}

/** The smallest definition containing `line`, or null. */
function enclosing(symbols, line) {
  let best = null;
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (!best || (symbol.endLine - symbol.startLine) < (best.endLine - best.startLine)) best = symbol;
  }
  return best;
}

function mergeRanges(ranges) {
  const sorted = [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    // Adjacent as well as overlapping: two ranges a line apart are one range
    // with a pointless "…" between them.
    if (last && start <= last[1] + 1) { last[1] = Math.max(last[1], end); continue; }
    out.push([start, end]);
  }
  return out;
}

/**
 * Turn keyword hits into ranges that respect definitions.
 *
 * A hit inside a definition small enough to afford gets the whole definition,
 * signature included. A hit inside one too large gets a window clamped to that
 * definition's bounds, so the slice never bleeds into the neighbouring function.
 * A hit outside any definition — an import, a constant, a top-level call — gets
 * the plain window, which is the behaviour every file had before.
 *
 * @returns {Array<[number, number]>} half-open [start, end) line ranges
 */
function sliceRanges({ text, hits, file = '', maxRegions = 4, window = 24, maxSymbolLines = 160 }) {
  const lines = String(text || '').split('\n');
  const symbols = symbolsOf(text, file);
  const ranges = [];
  for (const hit of hits.slice(0, maxRegions)) {
    const symbol = enclosing(symbols, hit);
    if (symbol && (symbol.endLine - symbol.startLine) <= maxSymbolLines) {
      ranges.push([symbol.startLine, Math.min(lines.length, symbol.endLine + 1)]);
      continue;
    }
    const floor = symbol ? symbol.startLine : 0;
    const ceiling = symbol ? Math.min(lines.length, symbol.endLine + 1) : lines.length;
    ranges.push([Math.max(floor, hit - window), Math.min(ceiling, hit + window + 1)]);
  }
  return mergeRanges(ranges);
}

module.exports = { symbolsOf, languageOf, enclosing, sliceRanges, mergeRanges, maskJs, scanJs, scanPy };
