'use strict';

// Markdown, drawn for a terminal.
//
// Every model this fleet talks to writes markdown — headings, `- ` bullets, `**bold**`,
// fenced code — and until now the CLI printed the characters. The owner asked for the
// Claude Code treatment: the structure shown as structure, so a plan reads as a plan
// instead of as a paragraph with asterisks in it.
//
// Three rules, taken from the transcript this draws into:
//
//   1. No boxes. Structure is indentation and one accent, because the transcript is
//      unboxed by the owner's own instruction (see transcript.js `review`).
//   2. Nothing exceeds the width, ever — including a heading, a table row, or a line
//      of code. Prose wraps; code and table rows are ellipsised, because wrapping
//      either one changes what it says.
//   3. Colour means structure here and nothing else. No hue is invented for emphasis
//      that the palette does not already carry.
//
// Inline emphasis is painted **after** wrapping, not before: `wrapToWidth` strips ANSI
// to measure, so a line painted first and wrapped second loses its colours at every
// break. The text is therefore cut into `{ text, tone }` spans and the wrap runs over
// the spans — which is also the only way a `**bold phrase**` that straddles a line
// break stays bold on both halves.

const { themeFor } = require('../../domain/terminal/cli-theme');
const { glyphs, stringWidth, sliceToWidth, truncateToWidth, foldLines, foldMarker } = require('./text');

// A fence opener/closer: three or more backticks or tildes, optional language.
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;

/**
 * True when this text is worth running through the markdown renderer.
 *
 * Deliberately conservative. A one-sentence answer has no structure to find, and
 * routing it through here would cost a parse to produce the same line — so the plain
 * path stays the default and this is the exception.
 */
function looksLikeMarkdown(text) {
  const value = String(text ?? '');
  if (!value.includes('\n') && !/[`*_]/.test(value)) return false;
  return value.split('\n').some((line) => HEADING.test(line) || BULLET.test(line) || ORDERED.test(line)
    || FENCE.test(line) || RULE.test(line) || TABLE_ROW.test(line))
    || /\*\*[^*\n]+\*\*|`[^`\n]+`/.test(value);
}

/**
 * Cut one line of markdown into `{ text, tone }` spans.
 *
 * `tone` is the ANSI prefix for that span; '' means the block's own tone. The markers
 * themselves are dropped — this is a renderer, not an echo.
 */
function inlineSpans(text, theme) {
  const source = String(text ?? '');
  const spans = [];
  // One pass, longest constructs first: `**` before `*`, so `**bold**` is never read
  // as an empty emphasis wrapping a bold one.
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\)|(?<![\w*])\*(?!\s)[^*\n]+?(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)[^_\n]+?(?<!\s)_(?![\w_]))/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) spans.push({ text: source.slice(last, match.index), tone: '' });
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ text: token.slice(2, -2), tone: theme.bold });
    } else if (token.startsWith('`')) {
      // Inline code takes the one accent this palette has. It is the only span kind
      // whose exact characters matter, so it has to be the one that stands out.
      spans.push({ text: token.slice(1, -1), tone: theme.accent });
    } else if (token.startsWith('[')) {
      // The url is kept. In a terminal it is the clickable part, and hiding it behind
      // link text would remove the only way to follow it.
      const cut = token.indexOf('](');
      const label = token.slice(1, cut);
      const href = token.slice(cut + 2, -1);
      if (label) spans.push({ text: label, tone: theme.bold });
      spans.push({ text: `${label ? ' ' : ''}${href}`, tone: theme.dim });
    } else {
      spans.push({ text: token.slice(1, -1), tone: theme.dim });
    }
    last = match.index + token.length;
  }
  if (last < source.length) spans.push({ text: source.slice(last), tone: '' });
  return spans.length ? spans : [{ text: '', tone: '' }];
}

/** Spans split into whitespace-separated tokens, each remembering its tone. */
function spanTokens(spans) {
  const tokens = [];
  let space = false;
  for (const span of spans) {
    for (const part of String(span.text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { space = true; continue; }
      tokens.push({ text: part, tone: span.tone, space: space && tokens.length > 0 });
      space = false;
    }
  }
  return tokens;
}

/**
 * Greedy wrap over toned tokens. Same rules as `wrapToWidth` — a token wider than the
 * whole line is broken at the column, which is the path every unspaced Japanese
 * sentence takes — with the tone carried onto each piece.
 * @returns {Array<Array<{text: string, tone: string}>>}
 */
function wrapTokens(tokens, width) {
  const limit = Math.max(1, Math.trunc(width) || 1);
  const lines = []; let line = []; let used = 0;
  const flush = () => { lines.push(line); line = []; used = 0; };
  for (const token of tokens) {
    let rest = token.text;
    while (rest) {
      const gap = token.space && used > 0 ? 1 : 0;
      const room = limit - used - gap;
      if (room <= 0) {
        if (!used) break; // limit narrower than a single cell: nothing can be placed
        flush(); continue;
      }
      if (stringWidth(rest) <= room) {
        line.push({ text: `${gap ? ' ' : ''}${rest}`, tone: token.tone });
        used += gap + stringWidth(rest);
        break;
      }
      // It does not fit here but would fit on a line of its own: move it down whole
      // rather than splitting a word that did not need splitting.
      if (used > 0 && stringWidth(rest) <= limit) { flush(); continue; }
      const head = sliceToWidth(rest, room) || [...rest][0] || '';
      if (!head) { if (!used) break; flush(); continue; }
      line.push({ text: `${gap ? ' ' : ''}${head}`, tone: token.tone });
      rest = rest.slice(head.length);
      flush();
    }
  }
  if (line.length || !lines.length) flush();
  return lines;
}

/** One wrapped line of spans, painted. `base` is the block's own tone. */
function paintSpans(spans, base, reset) {
  return spans.map((span) => `${span.tone || base}${span.text}${reset}`).join('');
}

/**
 * Render markdown into terminal lines.
 *
 * Every returned line begins with exactly `column` literal spaces, so a caller that
 * owns a gutter can splice its glyph onto the first line without re-measuring.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.width=80]   total terminal columns
 * @param {number} [options.column=0]   left column every line starts at
 * @param {number} [options.maxLines=0] 0 = unlimited; else fold with a `… +N lines`
 * @returns {string[]}
 */
function renderMarkdown(text, options = {}) {
  const { width = 80, theme = themeFor('plan'), mark = glyphs(), column = 0, maxLines = 0,
    tone = theme.ink } = options;
  const reset = theme.reset;
  const lead = ' '.repeat(Math.max(0, column));
  const room = Math.max(4, Math.trunc(width) - Math.max(0, column));
  const out = [];
  const push = (indent, painted) => out.push(`${lead}${' '.repeat(indent)}${painted}`);
  // A blank line is spacing, and spacing that lands at the top of a block is a wasted
  // row on a 24-row terminal. Held until something is actually printed after it.
  let pendingBlank = false;
  const blank = () => { if (out.length) pendingBlank = true; };
  const settle = () => { if (pendingBlank) { out.push(''); pendingBlank = false; } };
  const write = (indent, spans, base = tone) => {
    settle();
    for (const line of wrapTokens(spanTokens(spans), Math.max(1, room - indent))) {
      push(indent, paintSpans(line, base, reset));
    }
  };

  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  let fence = ''; let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    write(0, inlineSpans(paragraph.join(' '), theme));
    paragraph = [];
  };

  for (const raw of lines) {
    const fenceMatch = raw.match(FENCE);
    if (fence) {
      // Inside a fence everything is literal, including a line that looks like a
      // heading. Only the matching marker closes it.
      if (fenceMatch && fenceMatch[1][0] === fence[0]) { fence = ''; blank(); continue; }
      settle();
      push(2, `${theme.dim}${truncateToWidth(raw.replace(/\t/g, '  '), Math.max(4, room - 2))}${reset}`);
      continue;
    }
    if (fenceMatch) { flushParagraph(); fence = fenceMatch[1]; blank(); continue; }

    if (!raw.trim()) { flushParagraph(); blank(); continue; }

    const heading = raw.match(HEADING);
    if (heading) {
      flushParagraph(); blank();
      const level = heading[1].length;
      write(0, inlineSpans(heading[2].trim(), theme), level <= 2 ? `${theme.bold}${theme.accent}` : theme.bold);
      continue;
    }
    if (RULE.test(raw)) {
      flushParagraph(); blank(); settle();
      push(0, `${theme.dim}${mark.rule.repeat(Math.max(1, Math.min(room, 24)))}${reset}`);
      continue;
    }
    // A table row keeps its own alignment: the author already padded the columns, and
    // re-wrapping them turns a table into rubble. Too wide is cut, not folded.
    if (TABLE_ROW.test(raw)) {
      flushParagraph(); settle();
      push(0, `${tone}${truncateToWidth(raw.trim(), room)}${reset}`);
      continue;
    }
    const quote = raw.match(QUOTE);
    if (quote) {
      flushParagraph(); settle();
      write(2, inlineSpans(quote[1], theme), theme.dim);
      continue;
    }
    const bullet = raw.match(BULLET);
    const ordered = !bullet && raw.match(ORDERED);
    if (bullet || ordered) {
      flushParagraph();
      const match = bullet || ordered;
      // Two source spaces are one nesting level, which is what every model emits.
      const depth = Math.min(3, Math.floor(match[1].replace(/\t/g, '  ').length / 2));
      const label = bullet ? mark.note : `${ordered[2]}.`;
      const indent = depth * 2;
      const hang = indent + stringWidth(label) + 1;
      const wrapped = wrapTokens(spanTokens(inlineSpans(match[3], theme)), Math.max(1, room - hang));
      settle();
      wrapped.forEach((line, index) => {
        const painted = paintSpans(line, tone, reset);
        push(index === 0 ? indent : hang,
          index === 0 ? `${theme.muted}${label}${reset} ${painted}` : painted);
      });
      continue;
    }
    paragraph.push(raw.trim());
  }
  flushParagraph();

  const { lines: kept, hidden } = foldLines(out, maxLines);
  if (hidden) kept.push(`${lead}${theme.dim}${foldMarker(hidden, mark.ellipsis)}${reset}`);
  return kept;
}

module.exports = { renderMarkdown, looksLikeMarkdown, inlineSpans, spanTokens, wrapTokens };
