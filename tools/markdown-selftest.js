'use strict';
// A model's reply is untrusted input.
//
// It quotes the owner's source files, tool output, and text found on disk. The
// conversation window renders it into a renderer that holds the whole bigkiji IPC
// surface, so the first half of this file is about what must never survive rendering,
// and the second half is about the formatting actually worth having.

const assert = require('assert');
const { renderMarkdown, escapeHtml, safeHref } = require('../src/components/UI/markdown');

// ---- injection: escape first, mark up second -------------------------------
const attack = renderMarkdown('Look at <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
assert(!attack.includes('<img'), 'a tag from model output must never reach the DOM as a tag');
assert(!attack.includes('<script'), 'nor a script element');
assert(attack.includes('&lt;img'), 'it is shown as text instead');
assert(attack.includes('onerror'), 'and shown in full — escaping is not censoring');

// The same payload hidden inside the constructs that build HTML of their own.
assert(!renderMarkdown('# <b>heading</b>').includes('<b>'), 'headings escape too');
assert(!renderMarkdown('| <b>x</b> |\n| --- |\n| y |').includes('<b>'), 'so do table cells');
assert(!renderMarkdown('```\n<script>alert(1)</script>\n```').includes('<script>'), 'and code blocks');
assert(!renderMarkdown('- <img src=x>').includes('<img'), 'and list items');

// A link is an injection vector one indirection later.
assert.strictEqual(safeHref('javascript:alert(1)'), '');
assert.strictEqual(safeHref('data:text/html,<script>'), '');
assert.strictEqual(safeHref('file:///etc/passwd'), '', 'not even a local file');
assert.strictEqual(safeHref('https://example.com/x'), 'https://example.com/x');
const jsLink = renderMarkdown('[click](javascript:alert(1))');
assert(!jsLink.includes('href'), 'a refused scheme produces no anchor at all');
assert(jsLink.includes('click'), 'but the text still shows, so nothing silently vanishes');

// ---- the placeholder must not eat ordinary prose ----------------------------
// An earlier version parked code spans behind a bare number and would rewrite any
// sentence containing one. This is the regression that caught it.
const prose = renderMarkdown('Use `npm test` — it runs 31 checks in 12 seconds, up from 7 last week.');
assert(prose.includes('<code>npm test</code>'));
assert(prose.includes('31 checks'), 'numbers in prose after a code span survive intact');
assert(prose.includes('12 seconds'));
assert(prose.includes('7 last week'));
assert(!/<CODE\d+>/.test(prose), 'no placeholder leaks into the output');

// Two spans in one line, and a number between them.
const two = renderMarkdown('`a` 0 `b`');
assert.strictEqual((two.match(/<code>/g) || []).length, 2);
assert(two.includes(' 0 '), 'a literal zero is not placeholder index zero');

// ---- the formatting that is actually used -----------------------------------
assert(renderMarkdown('## Section').includes('<h2>Section</h2>'));
assert(renderMarkdown('**bold**').includes('<strong>bold</strong>'));
assert(renderMarkdown('*soft*').includes('<em>soft</em>'));
assert(renderMarkdown('~~gone~~').includes('<del>gone</del>'));
assert(renderMarkdown('---').includes('<hr>'));

const code = renderMarkdown('```js\nconst x = 1 < 2;\n```');
assert(code.includes('<figcaption><span>js</span>'), 'the language is labelled');
assert(code.includes('data-copy'), 'and the block can be copied');
assert(code.includes('const x = 1 &lt; 2;'), 'the body is escaped, not interpreted');
assert(renderMarkdown('```\nplain\n```').includes('<span>text</span>'), 'an unlabelled fence still says what it is');

// An unterminated fence is what a stream looks like mid-answer. It must render, not
// swallow the rest of the reply or loop.
const partial = renderMarkdown('```js\nconst a = 1;');
assert(partial.includes('const a = 1;'), 'an unclosed fence still renders its body');

const table = renderMarkdown('| Component | Result |\n| --- | --- |\n| UX | pass |\n| Perf | pass |');
assert(table.includes('<th>Component</th>'));
assert.strictEqual((table.match(/<tr>/g) || []).length, 3, 'one header row and two body rows');
assert(!renderMarkdown('a | b and nothing else').includes('<table>'),
  'pipes in a sentence are not a table — the divider row is what makes one');

const ordered = renderMarkdown('1. first\n2. second');
assert(ordered.includes('<ol>') && (ordered.match(/<li>/g) || []).length === 2);
const bullets = renderMarkdown('- one\n- two\n- three');
assert(bullets.includes('<ul>') && (bullets.match(/<li>/g) || []).length === 3);

assert(renderMarkdown('> quoted\n> lines').includes('<blockquote>'));
assert(renderMarkdown('[Docs](https://example.com)').includes('<a href="https://example.com" data-external="1">Docs</a>'));

// ---- degenerate input does not hang or throw --------------------------------
for (const value of ['', null, undefined, '\n\n\n', '```', '|', '#', '> ', '- ']) {
  assert.doesNotThrow(() => renderMarkdown(value), `renderMarkdown(${JSON.stringify(value)}) must not throw`);
}
assert.strictEqual(renderMarkdown(''), '');
assert.strictEqual(escapeHtml(null), '');

console.log('markdown selftest: PASS · model output is escaped before it is marked up · refused link schemes drop the href but keep the text · code-span placeholder cannot eat prose · unclosed fence still renders');
