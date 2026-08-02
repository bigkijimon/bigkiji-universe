'use strict';
// Rendering what a model wrote, without letting it write HTML.
//
// Everything here escapes first and marks up second. A model's reply is untrusted
// input: it quotes the owner's files, the output of tools, and sometimes text it found
// on disk. If any of that reached innerHTML unescaped, a stray `<img onerror>` in a
// source file would execute inside a renderer holding the whole bigkiji IPC surface.
// So the order is never negotiable — escape, then build.
//
// Deliberately small. This covers what the conversation actually produces — headings,
// emphasis, fenced code, lists, tables, links, quotes, rules — and stops there rather
// than growing into a CommonMark implementation nobody asked for.

const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]); }

// Only http(s) and mailto survive. `javascript:` in a link is the same injection as raw
// HTML, one indirection later.
function safeHref(url) {
  const value = String(url || '').trim();
  return /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i.test(value) ? value : '';
}

function inline(text) {
  let out = escapeHtml(text);
  // Code spans are lifted out first so emphasis markers inside them stay literal.
  //
  // The placeholder contains a raw `<`, which is what makes it collision-proof: escaping
  // has already turned every `<` in the model's text into `&lt;`, so a bare `<` at this
  // point can only be one this function inserted. An earlier version used a bare number
  // as the marker and would happily rewrite any prose that contained one.
  const spans = [];
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<CODE${spans.push(`<code>${code}</code>`) - 1}>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" data-external="1">${label}</a>` : match;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/<CODE(\d+)>/g, (_m, index) => spans[Number(index)]);
}

function tableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;

  const listBlock = (ordered) => {
    const items = [];
    const marker = ordered ? /^\s*\d{1,3}[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    while (index < lines.length) {
      const match = lines[index].match(marker);
      if (!match) break;
      items.push(`<li>${inline(match[1])}</li>`);
      index += 1;
    }
    html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) { index += 1; continue; }

    // Fenced code. The language label and the copy affordance are part of the block,
    // because a code answer the owner cannot copy is a screenshot.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1; // closing fence, or end of input
      html.push(
        `<figure class="code"><figcaption><span>${escapeHtml(lang || 'text')}</span>`
        + '<button type="button" class="copy" data-copy aria-label="Copy code">Copy</button></figcaption>'
        + `<pre><code>${escapeHtml(body.join('\n'))}</code></pre></figure>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1; continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) { html.push('<hr>'); index += 1; continue; }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // A table needs its divider row to be a table at all; without it these are just
    // sentences that happen to contain pipes.
    if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
      const head = tableRow(line);
      index += 2;
      const body = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        body.push(tableRow(lines[index])); index += 1;
      }
      html.push(
        '<table><thead><tr>' + head.map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>',
      );
      continue;
    }

    if (/^\s*\d{1,3}[.)]\s+/.test(line)) { listBlock(true); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { listBlock(false); continue; }

    const paragraph = [];
    while (index < lines.length && lines[index].trim()
      && !/^\s*(?:```|#{1,6}\s|>|---|\*\*\*|___)/.test(lines[index])
      && !/^\s*(?:\d{1,3}[.)]|[-*+])\s+/.test(lines[index])) {
      paragraph.push(lines[index]); index += 1;
    }
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    else index += 1;
  }

  return html.join('');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown, escapeHtml, safeHref };
if (typeof window !== 'undefined') window.BKMarkdown = { renderMarkdown, escapeHtml, safeHref };
