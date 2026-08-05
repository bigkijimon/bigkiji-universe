'use strict';

// Self test for the pure CLI rendering functions.
//
// Everything asserted here is a property the owner asked for by name: hanging
// indents at the content column, honest truncation counts, diffs that look like
// diffs, task lists that show progress at a glance, and output that never
// exceeds the terminal width — including at 60 columns and with Japanese, where
// a character costs two cells.
//
// Two of those instructions were revised on 2026-08-03 and both revisions are
// asserted below rather than assumed:
//   - "no box drawing" now means no box around *flowing* content. One panel of
//     fixed facts at the top of the header is enclosed, by request.
//   - every character BigKiji paints is lowercase, and the kaomoji is retired
//     in every environment including NO_COLOR and TERM=dumb.
//
// Run: node tools/cli-render-selftest.js

const assert = require('assert');
const { stripAnsi } = require('../src/domain/terminal/cli-theme');
const T = require('../src/cli/tui/transcript');
const { TUIRenderer, StickyScreen, modelPanel } = require('../src/cli/tui/renderer');
const { buildFooter, footerHeightFor } = require('../src/cli/tui/footer');
const { loadingFrames, frameRows, FRAME_SETS, SHADES, catMark, catMarkFrames } = require('../src/cli/tui/loading-frames');

// The corners and tees named in the brief, plus every other framing glyph and
// the vertical bar that used to cost two columns on every single line.
// U+2500 '─' is deliberately NOT here: it is the progress meter's empty track
// and the two rules the sticky footer draws around the input row — a horizontal
// rule is a separator, not a frame around a region.
const CORNERS = /[╭╮╰╯├┤]/;
const BOX = /[╭╮╰╯├┤┌┐└┘┬┴┼│]/;
const plainLines = (lines) => lines.map(stripAnsi);
const widest = (lines) => Math.max(0, ...plainLines(lines).map(T.stringWidth));

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; if (process.env.VERBOSE) console.log(`  ok  ${label}`); };

// ---------------------------------------------------------------------------
// 1. Display width — the foundation every other assertion rests on
// ---------------------------------------------------------------------------
ok('ascii width equals length', () => {
  assert.equal(T.stringWidth('hello'), 5);
});
ok('CJK characters cost two columns', () => {
  assert.equal(T.stringWidth('日本語'), 6);
  assert.equal(T.stringWidth('日本語'.length === 3 ? '日本語' : ''), 6);
});
ok('ANSI does not count toward width', () => {
  assert.equal(T.stringWidth('\x1b[31mred\x1b[0m'), 3);
});
ok('truncateToWidth respects the column budget', () => {
  assert.equal(T.truncateToWidth('abcdefghij', 5), 'abcd…');
  assert.equal(T.stringWidth(T.truncateToWidth('abcdefghij', 5)), 5);
  assert.equal(T.truncateToWidth('short', 20), 'short');
  assert.equal(T.truncateToWidth('anything', 0), '');
});
ok('truncateToWidth never splits a wide character across the edge', () => {
  const cut = T.truncateToWidth('日本語です', 5);
  assert.ok(T.stringWidth(cut) <= 5, `width ${T.stringWidth(cut)} > 5`);
});

// ---------------------------------------------------------------------------
// 2. Hanging-indent wrapping at a given width
// ---------------------------------------------------------------------------
ok('wrapToWidth never exceeds the width and keeps words whole', () => {
  const lines = T.wrapToWidth('the quick brown fox jumps over the lazy dog', 12);
  assert.deepStrictEqual(lines, ['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog']);
  for (const line of lines) assert.ok(T.stringWidth(line) <= 12);
});
ok('wrapToWidth hard-breaks unspaced Japanese instead of overflowing', () => {
  const lines = T.wrapToWidth('これはとても長い日本語の文章です', 10);
  for (const line of lines) assert.ok(T.stringWidth(line) <= 10, `"${line}" is ${T.stringWidth(line)} wide`);
  assert.equal(lines.join(''), 'これはとても長い日本語の文章です'); // nothing lost
});
ok('wrapToWidth survives a width narrower than one wide character', () => {
  assert.deepStrictEqual(T.wrapToWidth('日本語', 1), ['日', '本', '語']);
});
ok('gutterLines hangs continuations at the content column, not column 0', () => {
  const lines = plainLines(T.gutterLines('the quick brown fox jumps over the lazy dog', { width: 20 }));
  assert.equal(lines[0], '● the quick brown');
  assert.ok(lines.length > 1, 'expected the text to wrap');
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('  '), `continuation "${line}" fell back to column 0`);
    assert.ok(!line.startsWith('   '), `continuation "${line}" is not at the content column`);
  }
  for (const line of lines) assert.ok(T.stringWidth(line) <= 20);
});
ok('a result gutter hangs at column 5 under its tool call', () => {
  const lines = plainLines(T.renderToolResult('alpha beta gamma delta epsilon zeta eta theta', { width: 24, maxLines: 0 }));
  assert.equal(lines[0].slice(0, 5), '  ⎿  ');
  for (const line of lines.slice(1)) assert.equal(line.slice(0, 5), '     ');
  for (const line of lines) assert.ok(T.stringWidth(line) <= 24);
});

// ---------------------------------------------------------------------------
// 3. Truncation reports the REAL remaining count
// ---------------------------------------------------------------------------
ok('foldLines keeps maxLines and reports the true remainder', () => {
  const source = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const folded = T.foldLines(source, 5);
  assert.equal(folded.lines.length, 5);
  assert.equal(folded.hidden, 15);
  assert.equal(folded.lines[4], 'line 5');
  assert.equal(T.foldLines(source, 0).hidden, 0);
  assert.equal(T.foldLines(source, 40).hidden, 0);
});
ok('the fold marker states the real number, singular when it is one', () => {
  assert.equal(T.foldMarker(15), '… +15 lines');
  assert.equal(T.foldMarker(1), '… +1 line');
  assert.equal(T.foldMarker(0), '');
});
ok('a folded tool result ends with the real +N lines marker', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const lines = plainLines(T.renderToolResult(body, { width: 40, maxLines: 4 }));
  assert.equal(lines.length, 5, 'four content lines plus the marker');
  assert.equal(lines[lines.length - 1].trim(), '… +16 lines');
  assert.ok(lines[0].includes('line 1'));
  assert.ok(lines[3].includes('line 4'));
});
ok('a result short enough to fit is not folded at all', () => {
  const lines = plainLines(T.renderToolResult('one\ntwo', { width: 40, maxLines: 4 }));
  assert.equal(lines.length, 2);
  assert.ok(!lines.join('\n').includes('+'), 'nothing should be hidden');
});
ok('wrapping does not inflate the hidden count — it counts source lines', () => {
  const body = ['a'.repeat(100), 'b', 'c', 'd', 'e'].join('\n');
  const lines = plainLines(T.renderToolResult(body, { width: 30, maxLines: 2 }));
  assert.equal(lines[lines.length - 1].trim(), '… +3 lines'); // b/c/d/e minus the one shown
});

// ---------------------------------------------------------------------------
// 4. Tool calls are one line
// ---------------------------------------------------------------------------
ok('a tool call renders as Tool(short argument) on exactly one line', () => {
  const lines = plainLines(T.renderToolCall('Bash', { command: 'npm run test:cli-theme', description: 'x' }, { width: 60 }));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '● Bash(npm run test:cli-theme)');
});
ok('a tool call argument is summarised per tool, not dumped', () => {
  assert.equal(T.summarizeToolInput('Bash', { command: 'ls -la\nsecond line' }), 'ls -la');
  assert.equal(T.summarizeToolInput('Grep', { pattern: 'TODO', path: '/tmp' }), 'TODO');
  assert.equal(T.summarizeToolInput('Task', { description: 'audit the fleet', prompt: 'long...' }), 'audit the fleet');
  assert.ok(T.summarizeToolInput('Read', { file_path: '/a/b/c/d/e.js' }).endsWith('d/e.js'));
});
ok('a tool call is clipped to the width rather than wrapped', () => {
  const lines = plainLines(T.renderToolCall('Bash', { command: 'x'.repeat(400) }, { width: 40 }));
  assert.equal(lines.length, 1);
  assert.ok(T.stringWidth(lines[0]) <= 40, `line is ${T.stringWidth(lines[0])} wide`);
});

// ---------------------------------------------------------------------------
// 5. Diffs render as diffs
// ---------------------------------------------------------------------------
const PATCH = '@@ -10,3 +10,4 @@\n ctx line\n-gone\n+added\n ctx2\n';
ok('a unified diff parses into numbered add/del/ctx records', () => {
  assert.deepStrictEqual(T.parseUnifiedDiff(PATCH), [
    { kind: 'ctx', line: 10, text: 'ctx line' },
    { kind: 'del', line: 11, text: 'gone' },
    { kind: 'add', line: 11, text: 'added' },
    { kind: 'ctx', line: 12, text: 'ctx2' },
  ]);
});
ok('formatDiff prints line numbers and +/- prefixes', () => {
  const lines = plainLines(T.formatDiff(PATCH, { width: 40 }));
  assert.deepStrictEqual(lines, [
    '    10   ctx line',
    '    11 - gone',
    '    11 + added',
    '    12   ctx2',
  ]);
});
ok('formatDiff tones added, removed and context differently', () => {
  const theme = require('../src/domain/terminal/cli-theme').themeFor('plan');
  if (!theme.accent) return; // NO_COLOR run: tones are all empty by design
  const coloured = T.formatDiff(PATCH, { width: 40, theme });
  assert.ok(coloured[1].includes(theme.error), 'removed line should carry the error tone');
  assert.ok(coloured[2].includes(theme.accent), 'added line should carry the accent');
  assert.ok(coloured[0].includes(theme.dim), 'context should be dim');
});
ok('a patch is detected in provider output and rendered as a diff, not a wall of text', () => {
  assert.equal(T.looksLikeDiff(PATCH), true);
  assert.equal(T.looksLikeDiff('just some log output\nwith @@ in it'), false);
  const lines = plainLines(T.renderEvent('tasklog', { provider: 'codex', text: PATCH }, { width: 70 }));
  assert.deepStrictEqual(lines, [
    '       10   ctx line',
    '       11 - gone',
    '       11 + added',
    '       12   ctx2',
  ]);
});
ok('formatDiff clips long lines and folds with a real count', () => {
  const long = `@@ -1,1 +1,6 @@\n${['+' + 'z'.repeat(200), '+b', '+c', '+d', '+e'].join('\n')}`;
  const lines = plainLines(T.formatDiff(long, { width: 30, maxLines: 2 }));
  assert.equal(lines[lines.length - 1].trim(), '… +3 lines');
  for (const line of lines) assert.ok(T.stringWidth(line) <= 30);
});

// ---------------------------------------------------------------------------
// 6. Task lists show progress at a glance
// ---------------------------------------------------------------------------
const TASKS = [
  { text: 'read the transcripts', status: 'completed' },
  { text: 'rebuild the renderer', status: 'active' },
  { text: 'capture before and after', status: 'pending' },
];
ok('a task list marks done / active / pending with distinct glyphs', () => {
  const lines = plainLines(T.formatTaskList(TASKS, { width: 60 }));
  assert.deepStrictEqual(lines, [
    '  ☑ read the transcripts',
    '  ▸ rebuild the renderer',
    '  ☐ capture before and after',
  ]);
});
ok('completed items are struck through and dim, the active one is the accent', () => {
  const theme = require('../src/domain/terminal/cli-theme').themeFor('plan');
  if (!theme.accent) return; // NO_COLOR run
  const lines = T.formatTaskList(TASKS, { width: 60, theme });
  assert.ok(lines[0].includes('\x1b[9m'), 'completed item should be struck through');
  assert.ok(lines[0].includes(theme.dim), 'completed item should be dim');
  assert.ok(lines[1].includes(theme.accent), 'active item should carry the accent');
  assert.ok(!lines[2].includes('\x1b[9m'), 'pending item must not be struck through');
});
ok('a run event turns its assignments into a task list', () => {
  const lines = plainLines(T.renderEvent('run', {
    id: 'run-7', status: 'AWAITING_APPROVAL',
    assignments: [{ title: 'Plan', provider: 'claude-code', status: 'completed' },
      { title: 'Execute', provider: 'codex', status: 'running' },
      { title: 'Verify', provider: 'gemini', status: 'queued' }],
  }, { width: 70 }));
  assert.ok(lines[0].startsWith('● run(run-7'), `chrome is lowercase: ${lines[0]}`);
  assert.ok(lines[0].includes('awaiting approval'), `a status reads as a phrase, not a token: ${lines[0]}`);
  assert.ok(lines[1].includes('☑'), 'a completed assignment should be ticked');
  assert.ok(lines[2].includes('▸'), 'a running assignment should be the active marker');
  assert.ok(lines[3].includes('☐'), 'a queued assignment should be pending');
});

// ---------------------------------------------------------------------------
// 7. Honest metrics — never a fabricated 0
// ---------------------------------------------------------------------------
ok('unmeasured metrics render as an em dash, not 0', () => {
  assert.equal(T.metric(undefined), '—');
  assert.equal(T.metric(null), '—');
  assert.equal(T.metric(0), '—');
  assert.equal(T.metric(NaN), '—');
  assert.equal(T.metric(1240), '1240');
  assert.equal(T.metric(88, 'ms'), '88ms');
});
ok('a cardinality of zero is a real answer; a missing list is not', () => {
  assert.equal(T.count([]), '0');
  assert.equal(T.count([1, 2, 3]), '3');
  assert.equal(T.count(undefined), '—');
  assert.equal(T.count(null), '—');
});
ok('/status shows — for a model that never ran, and never a fabricated 0', () => {
  const lines = plainLines(T.renderStatus({
    phase: 'IDLE', sessions: [], runs: [],
    models: { models: [{ id: 'claude', displayName: 'Claude Code', status: 'OFFLINE', connected: false, metrics: {} }] },
  }, { width: 100 }));
  const model = lines.find((line) => line.includes('claude code'));
  assert.ok(model.includes('—'), 'an unmeasured model must show an em dash');
  assert.ok(!/\b0 tok\b/.test(model), `fabricated zero in "${model}"`);
  assert.ok(lines[0].includes('sessions 0'), 'an empty list really is zero');
  assert.ok(lines[0].includes('files —'), 'an inventory we never received is unknown');
});

// ---------------------------------------------------------------------------
// 8. The de-boxed regions really carry no box drawing
// ---------------------------------------------------------------------------
const MONITOR_STATE = {
  pid: 4242, phase: 'EXECUTE',
  conversation: { model: 'qwen2.5:0.5b', maxContextTokens: 4096 },
  models: { models: [
    { id: 'claude', displayName: 'Claude Code', status: 'OFFLINE', connected: false, metrics: {} },
    { id: 'pi', displayName: 'PiAgent Engine', status: 'EXECUTING', connected: true, metrics: { tokensUsed: 1240, tokensSaved: 300, latencyMs: 88 } },
  ] },
  runs: [], sessions: [], inventory: { files: [1, 2, 3] },
};
const MONITOR_RELAY = [{ time: '12:04:31', source: 'PiAgent Engine', text: 'Inspecting sandbox memory and selecting only the required models.' }];

// The owner asked on 2026-08-03 for the model information at the top to be
// enclosed in a box, having asked for no boxes at all when this file was
// written. Both instructions still hold, at different scopes: the model panel is
// three fixed rows of facts, and everything that carries flowing content — the
// relay, the footer, the whole transcript — is still forbidden a frame. So the
// assertion is no longer "no box anywhere" but "exactly one box, and it is that
// panel".
ok('the monitor relay and footer still contain no box drawing at all', () => {
  for (const [cols, rows] of [[100, 30], [60, 24], [200, 50]]) {
    const renderer = new TUIRenderer({ output: { columns: cols, rows, write() {} } });
    const { header, middle, footer } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
    const flowing = plainLines([...middle, ...footer]).join('\n');
    assert.doesNotMatch(flowing, CORNERS, `box corners survived in flowing content at ${cols}x${rows}`);
    assert.doesNotMatch(flowing, BOX, `box drawing survived in flowing content at ${cols}x${rows}`);
    assert.ok(widest([...header, ...middle, ...footer]) <= cols,
      `monitor overflowed ${cols} columns at ${cols}x${rows} (widest ${widest([...header, ...middle, ...footer])})`);
  }
});
ok('the local tools are on screen at all', () => {
  // tool-registry has had detection and health checks for nine tools since V2.5 —
  // ComfyUI, ACE-Step, LTX-2, Ollama, n8n, Obsidian, graphify, the GPU signal — and
  // every one of them was wired to nothing. There was no way to see from BigKiji
  // whether the thing you were about to route work to was up.
  const state = {
    phase: 'IDLE', sessions: [], runs: [], inventory: { files: [] },
    models: { models: [{ id: 'glm', displayName: 'GLM', status: 'IDLE', available: true, connected: false, metrics: {} }] },
    tools: { connected: 2, tools: [
      { id: 'comfyui', status: 'connected', detail: 'ComfyUI 0.25.0 at 127.0.0.1:8000' },
      { id: 'ollama', status: 'connected', detail: '11 local models' },
      { id: 'acestep', status: 'found', detail: 'No answer from 127.0.0.1:8001' },
    ] },
  };
  const plain = T.renderStatus(state, { width: 88 }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const text = plain.join('\n');
  assert.match(text, /tools\(2\/3 connected\)/);
  assert.match(text, /comfyui\s+connected/);
  // `found` is installed but unverified, which is a different fact from missing and
  // has to read differently.
  assert.match(text, /acestep\s+found/);
  assert.ok(!/acestep\s+connected/.test(text));
  for (const line of plain) assert.ok(T.stringWidth(line) <= 88, `overflows: ${JSON.stringify(line)}`);
  // A daemon too old to report tools must not produce an empty heading.
  const without = T.renderStatus({ ...state, tools: undefined }, { width: 88 }).join('\n');
  assert.ok(!/tools\(/.test(without), 'no tools known is no tools section');
  // And the panel counts them without growing a row.
  const panel = modelPanel(state, { width: 60, theme: require('../src/domain/terminal/cli-theme').themeFor('plan'), label: ' bigkiji ' });
  // Five: a border, three content rows and a border. The cat is three terminal rows
  // as of 2026-08-04 — two rows of this sprite rendered as a brown bar with a dot in
  // it, because the ears live in pixel rows 0-1 and a two-row crop cannot hold ears
  // and eyes at once. The third row is not empty: it carries the working directory.
  assert.equal(panel.length, 5, 'the header box is five rows: border, three facts, border');
  assert.match(panel.join(' ').replace(/\x1b\[[0-9;]*m/g, ''), /2\/3 tools/);
});

ok('the header carries exactly one box, and it is the model panel', () => {
  for (const [cols, rows] of [[100, 30], [60, 24], [200, 50]]) {
    const renderer = new TUIRenderer({ output: { columns: cols, rows, write() {} } });
    const { header } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
    const boxed = plainLines(header).filter((line) => BOX.test(line));
    // Five rows: a border, three content rows and a border. The cat needs three —
    // ears, eyes, nose — and two of anything smaller renders as a coloured bar.
    assert.equal(boxed.length, 5, `one box, five rows, at ${cols}x${rows}: ${boxed.length}`);
    assert.ok(boxed[0].startsWith('╭─') && boxed[0].endsWith('╮'), `top: ${boxed[0]}`);
    for (const line of boxed.slice(1, -1)) assert.ok(line.startsWith('│') && line.endsWith('│'), `content: ${line}`);
    assert.ok(boxed.at(-1).startsWith('╰') && boxed.at(-1).endsWith('╯'), `bottom: ${boxed.at(-1)}`);
    const widths = boxed.map(T.stringWidth);
    assert.ok(widths.every((value) => value === widths[0]), `the three rows must align: ${widths.join(',')}`);
    assert.ok(widths[0] <= cols, `the panel must fit ${cols}: ${widths[0]}`);
    const facts = boxed.slice(1, -1).join(' ');
    assert.ok(facts.includes('qwen2.5:0.5b'), `the panel states the real model: ${facts}`);
    assert.ok(facts.includes('4k ctx'), `and the real context window: ${facts}`);
    // This said "1/2 online" and counted `connected`, which means "has a task
    // running right now". With every provider authenticated and idle it read 1/6 on
    // the owner's screen, who reasonably took that to mean five were broken. The
    // header's question is how many could work.
    assert.ok(facts.includes('1/2 ready'), `and counts what could actually work: ${facts}`);
  }
});
ok('nothing overflows between 24 and 200 columns, including the phase chips', () => {
  // The chip row used to be a fixed 40 columns whatever the terminal was, so it
  // ran off the edge on anything under 45 — the monitor clamps to a floor of 24,
  // so that width is supported and was broken. Widths below 45 now drop the step
  // names and keep the numbered dots.
  for (const cols of [24, 30, 40, 45, 50, 60, 80, 100, 140, 200]) {
    const renderer = new TUIRenderer({ output: { columns: cols, rows: 24, write() {} } });
    const { header, middle, footer } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
    const all = [...header, ...middle, ...footer];
    assert.ok(widest(all) <= cols, `monitor overflowed ${cols} columns (widest ${widest(all)})`);
  }
  const narrow = new TUIRenderer({ output: { columns: 24, rows: 24, write() {} } });
  const chips = plainLines(narrow.sections(MONITOR_STATE, MONITOR_RELAY).header).find((line) => /○\d/.test(line));
  assert.ok(chips && !/preflight/.test(chips), `at 24 columns the names go: ${chips}`);
  // ✓ as well as ● and ○ since 2026-08-04: a step the run has already passed reads
  // differently from one it has not reached yet, which is a distinction the row
  // could not make when both were the same grey circle.
  assert.ok(/[●○✓]1/.test(chips) && /[●○✓]2/.test(chips) && /[●○✓]3/.test(chips), `but all three steps stay: ${chips}`);
});
ok('the sections fit the screen vertically too, down to 16 rows', () => {
  // The panel costs three rows and the relay has a floor of three, so on a short
  // screen the sections came to more rows than the terminal had: draw() wrote a
  // relay line into the footer's row and the footer's own ESC[2K erased it.
  for (const rows of [16, 18, 20, 24, 30, 50]) {
    const renderer = new TUIRenderer({ output: { columns: 100, rows, write() {} } });
    const { header, middle, footer } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
    const total = header.length + middle.length + footer.length;
    assert.ok(total <= rows, `${total} rows of sections for a ${rows} row terminal`);
  }
  const short = new TUIRenderer({ output: { columns: 100, rows: 16, write() {} } });
  assert.equal(plainLines(short.sections(MONITOR_STATE, MONITOR_RELAY).header).filter((line) => BOX.test(line)).length, 0,
    'below 18 rows the live relay is worth more than a panel /status can print on demand');
});
ok('a long version string cannot push the panel past the terminal', () => {
  // The label rides the top border and is built from APP_VERSION. It was measured
  // against itself rather than the width, so a prerelease string pushed a 40
  // column panel out to 48.
  for (const cols of [24, 40, 60, 80]) {
    const boxed = plainLines(modelPanel(MONITOR_STATE, { width: cols, label: ' bigkiji universe v2.5.0-rc.1+build.20260803 ' }));
    const widths = boxed.map(T.stringWidth);
    assert.ok(widths.every((value) => value === widths[0]), `rows must align at ${cols}: ${widths.join(',')}`);
    assert.ok(widths[0] <= cols, `panel is ${widths[0]} wide in a ${cols} column terminal`);
  }
});
ok('the loading cat is a shape, not a filled bar, and it fits in one column', () => {
  // Two techniques, two different ways to fail, both of which the owner has
  // already hit once.
  //
  //   sprite sets — the cell *is* the pixel, so a row that is almost all ink is a
  //   solid rectangle. That is exactly what shipped: the two rows carrying the
  //   face are fourteen opaque cells out of sixteen and rendered as a brown bar.
  //
  //   glyph sets — the shape lives inside the cell, so ink ratio says nothing.
  //   What matters is that it occupies one column and that consecutive frames
  //   differ, because the whole point is motion the owner can see.
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(require.resolve('../src/cli/tui/loading-frames'))});
    process.stdout.write(JSON.stringify({ id: L.DEFAULT_FRAME_SET_ID, sets: L.FRAME_SETS, mark: L.catMark() }));
  `], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { id, sets, mark } = JSON.parse(result.stdout);

  // The default is what the owner actually sees, and they asked for one column.
  const active = sets[id];
  assert.equal(active.rows, 1, `the footer reserves rows for this: ${id} claims ${active.rows}`);
  for (const [index, frame] of active.frames.entries()) {
    assert.equal(T.stringWidth(frame), 1,
      `frame ${index} of "${id}" is ${T.stringWidth(frame)} columns wide, not 1: |${frame}|`);
    assert.ok(!/[█⣿]/.test(frame), `frame ${index} is a solid block, which reads as a bar: |${frame}|`);
  }
  assert.ok(new Set(active.frames).size >= 3, `a loading animation has to actually change: ${JSON.stringify(active.frames)}`);

  // The sprite sets stay selectable, and must not regress to the brown bar.
  //
  // Only the single-row ones: in a multi-row sprite the silhouette comes from the
  // stack, so one dense row is the cat's body and is supposed to be dense. A
  // single row has nowhere else to carry the shape, which is the whole reason the
  // one-row set had to move off the face and onto the ears.
  for (const [name, set] of Object.entries(sets)) {
    if (!/^pixel-cat/.test(name)) continue;
    if (set.rows === 1) {
      for (const [index, frame] of set.frames.entries()) {
        const ink = frame.replace(/\s/g, '').length;
        assert.ok(ink <= frame.length * 0.5,
          `${name} frame ${index} is ${ink}/${frame.length} inked — one row that full is a bar: |${frame}|`);
      }
      assert.ok(set.frames.filter((frame) => /\s/.test(frame.trim())).length >= set.frames.length / 2,
        `${name} needs a gap between the ears in most frames`);
    } else {
      assert.ok(new Set(set.frames[0].split('\n')).size > 1,
        `${name} draws every row identically, so it has no silhouette`);
    }
    assert.ok(new Set(set.frames).size >= 2, `${name} does not animate`);
  }

  // The header mark has room for a real head, so it is three rows — ears, eyes,
  // nose — and it must not be one uniform block either. It was two, and two rows of
  // this sprite is a brown rectangle with a dot in it: the ears live in pixel rows
  // 0-1 and a two-row crop starting below them has no shape left to show.
  assert.equal(mark.length, 3, 'the header mark is three rows: ears, eyes, nose');
  assert.ok(/\s/.test(mark[0].trim()), `the ears need a gap: |${mark[0]}|`);

  // Everything above ran under NO_COLOR, where the default falls back to the braille
  // cell. The colour default is a different set and is what the owner actually looks
  // at, so it gets checked too — and it is checked for a DIFFERENT bound, because the
  // owner's complaint changed: "small, one column" became "that does not look like a
  // cat". Five columns is the budget; a cat face does not fit in fewer.
  const colour = require('child_process').spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(require.resolve('../src/cli/tui/loading-frames'))});
    process.stdout.write(JSON.stringify({ id: L.DEFAULT_FRAME_SET_ID, set: L.loadingFrames(), mark: L.catMark() }));
  `], { env: { ...process.env, NO_COLOR: undefined, TERM: 'xterm-256color' }, encoding: 'utf8' });
  assert.equal(colour.status, 0, colour.stderr);
  const painted = JSON.parse(colour.stdout);
  assert.equal(painted.set.rows, 1, 'the footer still reserves exactly one row for the cat');
  for (const [index, frame] of painted.set.frames.entries()) {
    assert.ok(T.stringWidth(frame) <= 5,
      `frame ${index} of "${painted.id}" is ${T.stringWidth(frame)} columns; the footer budget is 5`);
  }
  assert.ok(new Set(painted.set.frames).size >= 2, 'the colour default has to animate too');
  // A transparent pixel must be transparent. Emitting the upper-half glyph for a cell
  // whose upper pixel is transparent paints that half in the terminal's DEFAULT
  // foreground — near-white on a dark theme — which is what put two white squares on
  // the cat's ears in the owner's screenshot.
  const whiteOverColour = /\x1b\[39m\x1b\[48;2;/;
  assert.ok(!whiteOverColour.test(painted.mark.join('')),
    'a transparent upper pixel must not be painted in the default foreground');
});

ok('the header cat animates, and is still a cat in every pose', () => {
  // The mark is drawn once per tick while a turn is in flight, so every pose is on
  // screen for 67ms and every pose has to hold up. Two ways this has already broken:
  //
  //   width drift — cropping each pose to its own bounding box made the box breathe
  //   once per loop and slid every fact beside it sideways.
  //
  //   the bob — half the poses move the whole animal down a pixel (the reference bakes
  //   its bob into the art), and cropping at fixed sprite rows pushed the nose out of
  //   the window and pulled a blank row in at the top. Three of six poses stopped being
  //   a face. Nothing measured it; it was caught by rendering the poses and looking.
  const frames = catMarkFrames();
  assert.ok(frames >= 4, `a loading animation needs poses: ${frames}`);
  const marks = Array.from({ length: frames }, (_, frame) => catMark({ frame }));
  const widths = new Set(marks.map((rows) => T.stringWidth(stripAnsi(rows[0]))));
  assert.equal(widths.size, 1, `every pose must be the same width or the panel jumps: ${[...widths].join(',')}`);
  for (const [index, rows] of marks.entries()) {
    assert.equal(rows.length, 3, `pose ${index} is ${rows.length} rows`);
    // Ears: the top row has to have a gap in it. A pose cropped to the wrong rows
    // arrives here as a solid bar, which is exactly the failure being guarded.
    assert.ok(/\s/.test(stripAnsi(rows[0]).trim()), `pose ${index} has no gap between the ears: |${stripAnsi(rows[0])}|`);
  }
  assert.ok(new Set(marks.map((rows) => rows.join(''))).size >= 3,
    'the poses have to actually differ, or the ticker is repainting a photograph');
});
ok('the transcript fills from the top of the scroll region, not the bottom', () => {
  // What the owner saw: a fifty row terminal with the header at the top, the
  // footer at the bottom, and twenty-seven blank rows in between with the first
  // answer pinned under them. Nothing was broken and it looked entirely broken.
  // print() jumped to the last row of the region and emitted newlines, so the
  // region scrolled up from empty instead of being written into.
  const writes = [];
  const output = { isTTY: true, columns: 80, rows: 50, write: (value) => writes.push(value), on() {}, off() {} };
  const sticky = new StickyScreen({ output, footerHeight: 6 });
  sticky.start({ header: ['h1', 'h2', 'h3'], footer: [] });
  writes.length = 0;
  sticky.print('first answer');
  const rowOf = (value) => { const m = /\x1b\[(\d+);1H/.exec(value); return m ? Number(m[1]) : -1; };
  assert.equal(rowOf(writes.join('')), sticky.top,
    `the first line belongs at the top of the region (row ${sticky.top}), not at row ${rowOf(writes.join(''))}`);
  assert.ok(!writes.join('').includes('\n\r'), 'and it should be placed, not scrolled into view');

  // Consecutive output stacks downward rather than overwriting.
  writes.length = 0;
  sticky.print('second answer');
  assert.equal(rowOf(writes.join('')), sticky.top + 1);

  // Once the region is full it goes back to scrolling, which is the only way to
  // keep showing new output.
  const capacity = sticky.bottom - sticky.top + 1;
  sticky.print(Array.from({ length: capacity }, (_, i) => `line ${i}`).join('\n'));
  writes.length = 0;
  sticky.print('after it is full');
  assert.ok(writes.join('').includes('\n\r'), 'a full region has to scroll');
});
ok('the monitor key hints are lowercase like everything else', () => {
  const renderer = new TUIRenderer({ output: { columns: 100, rows: 30, write() {} } });
  const hints = plainLines(renderer.sections(MONITOR_STATE, MONITOR_RELAY).footer).join('\n');
  assert.ok(/quit/.test(hints), 'the hints should be there at all');
  assert.ok(!/[A-Z]/.test(hints), `every character BigKiji paints is lowercase: ${hints}`);
});
ok('the model panel invents nothing when the daemon said nothing', () => {
  const boxed = plainLines(modelPanel({}, { width: 80 }));
  assert.equal(boxed.length, 5);
  const facts = boxed.slice(1, -1).join(' ');
  assert.ok(facts.includes('—'), `an unknown model is an em dash, not a default: ${facts}`);
  assert.ok(!/ctx/.test(facts), `no context window was reported, so none is shown: ${facts}`);
  assert.ok(!/online/.test(facts), `no fleet was reported, so no count is shown: ${facts}`);
});
ok('no kaomoji survives anywhere in the CLI chrome', () => {
  const renderer = new TUIRenderer({ output: { columns: 100, rows: 30, write() {} } });
  const { header, middle, footer } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
  const { lines } = buildFooter({ cols: 100, mode: 'plan', state: MONITOR_STATE, elapsedMs: 1000 });
  const all = plainLines([...header, ...middle, ...footer, ...lines.map((line) => line || '')]).join('\n');
  assert.doesNotMatch(all, /\(=\^/, `a kaomoji survived: ${all}`);
  assert.doesNotMatch(all, /\^=\)/, `a kaomoji survived: ${all}`);
});
ok('the transcript renderers emit no box drawing either', () => {
  const output = plainLines([
    ...T.renderUserTurn('rebuild the display', { width: 80 }),
    ...T.renderAssistantText('Here is what I changed.', { width: 80 }),
    ...T.renderToolCall('Bash', { command: 'npm test' }, { width: 80 }),
    ...T.renderToolResult('a\nb\nc\nd\ne\nf', { width: 80, maxLines: 3 }),
    ...T.formatTaskList(TASKS, { width: 80 }),
    ...T.formatDiff(PATCH, { width: 80 }),
    ...T.renderStatus({ models: { models: [] } }, { width: 80 }),
  ]).join('\n');
  assert.doesNotMatch(output, CORNERS);
  assert.doesNotMatch(output, /[│┤├╮╯╭╰]/);
});

// ---------------------------------------------------------------------------
// 9. Width awareness end to end, including 60 columns and Japanese
// ---------------------------------------------------------------------------
ok('no renderer exceeds the terminal width, at 60 columns or with Japanese', () => {
  const japanese = 'これはとても長い日本語の説明文で、折り返しが正しく行われるかを確認するためのものです。';
  for (const cols of [60, 80, 100]) {
    const groups = [
      T.renderUserTurn(japanese, { width: cols }),
      T.renderAssistantText(japanese, { width: cols }),
      T.renderToolCall('Bash', { command: japanese }, { width: cols }),
      T.renderToolResult(`${japanese}\n${japanese}\n${japanese}`, { width: cols, maxLines: 2 }),
      T.renderStatus({ models: { models: [{ id: 'x', displayName: '日本語モデル名', status: 'IDLE', connected: true, metrics: {} }] } }, { width: cols }),
      T.formatTaskList([{ text: japanese, status: 'active' }], { width: cols }),
      T.formatDiff(`@@ -1,1 +1,1 @@\n+${japanese}`, { width: cols }),
    ];
    for (const group of groups) {
      for (const line of plainLines(group)) {
        assert.ok(T.stringWidth(line) <= cols, `"${stripAnsi(line)}" is ${T.stringWidth(line)} wide at ${cols} columns`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 10. Noise suppression — the transcript stays quiet where the footer speaks
// ---------------------------------------------------------------------------
ok('phase ticks and the daemon echoing the prompt back are not printed', () => {
  assert.deepStrictEqual(T.renderEvent('phase', { phase: 'EXECUTE', progress: 62 }, { width: 80 }), []);
  assert.deepStrictEqual(T.renderEvent('conversation', { kind: 'turn_start', text: 'hello' }, { width: 80 }), []);
  assert.deepStrictEqual(T.renderEvent('conversation', { kind: 'turn_complete', reply: 'hi' }, { width: 80 }), []);
});
ok('commentary becomes a source headline with a folded result', () => {
  const lines = plainLines(T.renderEvent('commentary', {
    source: 'PiAgent Engine', status: 'PRUNING',
    text: Array.from({ length: 9 }, (_, i) => `detail ${i}`).join('\n'),
  }, { width: 70, resultLines: 3 }));
  assert.equal(lines[0], '● piagent engine(pruning)');
  assert.equal(lines[1].slice(0, 5), '  ⎿  ');
  assert.equal(lines[lines.length - 1].trim(), '… +6 lines');
});
ok('a stderr tasklog is toned as an error but still folded', () => {
  const theme = require('../src/domain/terminal/cli-theme').themeFor('plan');
  const lines = T.renderEvent('tasklog', { stream: 'stderr', text: 'boom\nmore\nmore\nmore\nmore\nmore' }, { width: 60, theme, resultLines: 2 });
  if (theme.error) assert.ok(lines[0].includes(theme.error));
  assert.equal(stripAnsi(lines[lines.length - 1]).trim(), '… +4 lines');
});

// ---------------------------------------------------------------------------
// 11. Degradation: TERM=dumb has no elbow, and NO_COLOR strips every escape
// ---------------------------------------------------------------------------
ok('the ascii glyph set avoids box-drawing and ballot characters', () => {
  const mark = T.glyphs({ ascii: true });
  const output = plainLines([
    ...T.renderToolResult('one\ntwo\nthree', { width: 40, mark, maxLines: 2 }),
    ...T.formatTaskList(TASKS, { width: 40, mark }),
  ]).join('\n');
  assert.doesNotMatch(output, /[⎿☑☐▸…●]/, `non-ascii glyph survived: ${output}`);
  assert.ok(output.includes('...'), 'the ascii ellipsis should be three dots');
});
ok('NO_COLOR output carries no escape sequences at all', () => {
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    process.env.NO_COLOR = '1';
    const T = require(${JSON.stringify(require.resolve('../src/cli/tui/transcript'))});
    const out = [
      ...T.renderUserTurn('hi', { width: 40 }),
      ...T.renderAssistantText('there', { width: 40 }),
      ...T.formatTaskList([{ text: 'done', status: 'completed' }], { width: 40 }),
      ...T.formatDiff('@@ -1,1 +1,1 @@\\n+x', { width: 40 }),
    ].join('\\n');
    if (/\\x1b/.test(out)) { console.error('ESCAPE LEAKED: ' + JSON.stringify(out)); process.exit(1); }
    process.stdout.write(out);
  `], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b/);
});
ok('TERM=dumb still produces readable output with no escapes and no kaomoji', () => {
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    const { TUIRenderer } = require(${JSON.stringify(require.resolve('../src/cli/tui/renderer'))});
    const r = new TUIRenderer({ output: { columns: 60, rows: 24, write() {} } });
    const s = r.sections({ models: { models: [] } }, []);
    process.stdout.write([...s.header, ...s.middle, ...s.footer].join('\\n'));
  `], { env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b/);
  assert.ok(result.stdout.includes('bigkiji'), 'the identity line must survive');
  assert.doesNotMatch(result.stdout, /\(=\^/, 'a colourless terminal must not fall back to a kaomoji');
  // The relay and footer are still frame-free; only the panel draws a border.
  const flowing = result.stdout.split('\n').filter((line) => !BOX.test(line)).join('\n');
  assert.doesNotMatch(flowing, CORNERS);
});

// ---------------------------------------------------------------------------
// 12. The sticky footer contract is untouched
// ---------------------------------------------------------------------------
ok('the footer is still six rows in the owner-specified order', () => {
  const set = loadingFrames();
  assert.equal(footerHeightFor(set), 6);
  const { lines, inputIndex, height } = buildFooter({ cols: 100, mode: 'plan', state: {}, comment: 'note', elapsedMs: 65000 });
  assert.equal(height, 6);
  assert.equal(inputIndex, 3, 'readline owns row index 3');
  assert.strictEqual(lines[3], null, 'the input row must be left to readline');
  const flat = plainLines(lines.map((line) => line || ''));
  assert.ok(/loading|idle/.test(flat[0]) && flat[0].includes('1m 05s'), `row 0: ${flat[0]}`);
  assert.ok(flat[1].includes('phase vector'), `row 1: ${flat[1]}`);
  assert.match(flat[2], /^\s*─+$/, `row 2 should be a rule: ${flat[2]}`);
  assert.match(flat[4], /^\s*─+$/, `row 4 should be a rule: ${flat[4]}`);
  assert.ok(flat[5].includes('mode:') && flat[5].includes('shell:') && flat[5].includes('agent:'), `row 5: ${flat[5]}`);
  assert.ok(!/[A-Z]/.test(flat[1]) && !/[A-Z]/.test(flat[5]),
    `every character BigKiji paints is lowercase: ${flat[1]} / ${flat[5]}`);
});
ok('the footer never overflows, even with a long Japanese comment', () => {
  for (const cols of [60, 80, 100, 140]) {
    const { lines } = buildFooter({ cols, mode: 'plan', state: {},
      comment: 'これはとても長い日本語のコメントで、フッタの幅を超えないことを確認します。'.repeat(2), elapsedMs: 4000 });
    for (const line of lines) {
      if (line === null) continue;
      assert.ok(T.stringWidth(stripAnsi(line)) <= cols, `footer overflowed ${cols}: ${T.stringWidth(stripAnsi(line))}`);
    }
  }
});
ok('unmeasured tokens still render as — in the footer', () => {
  const { lines } = buildFooter({ cols: 100, mode: 'plan', state: { models: { models: [] } } });
  assert.ok(stripAnsi(lines[0]).includes('— tok'), `expected an em dash: ${stripAnsi(lines[0])}`);
});

// ---------------------------------------------------------------------------
// 13. Loading frames — the pixel kijitora is real and the 1-row variant fits
// ---------------------------------------------------------------------------
// 2026-08-03: the owner replaced the 16-column sprite with a one-cell mark,
// pointing at Claude Code's single-glyph spinner — "a dot, small, that blinks or
// moves". The two rules that came before it still hold: one row, and no faces.
ok('the default frame set is one column wide, and still not a kaomoji', () => {
  const set = loadingFrames();
  assert.equal(set.rows, 1, 'the footer height contract is six rows, so the art gets one');
  assert.equal(set.width, 1, `the owner asked for one cell, not ${set.width}`);
  assert.equal(frameRows(0, set).length, 1);
  assert.equal(T.stringWidth(frameRows(0, set)[0]), 1);
  assert.doesNotMatch(set.frames.join(''), /\(=\^/, 'no faces');
  assert.ok(new Set(set.frames).size >= 3, 'it has to move, or it is just a character');
});
ok('a colourless terminal keeps the same mark, and never the kaomoji back', () => {
  // The braille cat carries its shape in the glyph, so unlike the sprite sets it
  // needs no colour at all and NO_COLOR changes nothing. That is the point of
  // moving off half-blocks: there is no second code path to keep in step.
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(require.resolve('../src/cli/tui/loading-frames'))});
    process.stdout.write(JSON.stringify({ id: L.DEFAULT_FRAME_SET_ID, frames: L.loadingFrames().frames, rows: L.loadingFrames().rows, width: L.loadingFrames().width }));
  `], { env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const set = JSON.parse(result.stdout);
  assert.equal(set.rows, 1);
  assert.equal(set.width, 1, `NO_COLOR must not widen the mark: ${set.id}`);
  assert.doesNotMatch(set.frames.join(''), /\x1b/, 'a colourless set carries no escapes');
  assert.doesNotMatch(set.frames.join(''), /\(=\^/, 'and still no faces');
  assert.ok(new Set(set.frames).size >= 3, 'and it still animates without colour');
});
ok('BIGKIJI_CLI_CAT=none turns the mascot off entirely', () => {
  const set = FRAME_SETS.none;
  assert.equal(set.rows, 1, 'still one row, so the footer contract holds');
  assert.equal(set.frames.length, 1, 'one frame means the ticker can never change the footer');
  assert.doesNotMatch(set.frames.join(''), /\S/, 'and nothing is drawn, for a screen reader');
});
ok('every frame of every set pads to exactly the declared geometry', () => {
  for (const set of Object.values(FRAME_SETS)) {
    for (let index = 0; index < set.frames.length; index += 1) {
      const rows = frameRows(index, set);
      assert.equal(rows.length, set.rows, `${set.id} frame ${index} row count`);
      for (const row of rows) assert.equal(T.stringWidth(row), set.width, `${set.id} frame ${index} width`);
    }
  }
});
ok('the pixel sets, when colour is available, are 8 rows and 1 row', () => {
  const panel = FRAME_SETS['pixel-cat-16'];
  const single = FRAME_SETS['pixel-cat-16-row'];
  if (!panel) return; // NO_COLOR / missing sprite: half-blocks are correctly withheld
  assert.equal(panel.rows, 8, 'a 16x16 sprite is 8 half-block rows — too tall for the 6 row footer');
  assert.equal(panel.width, 16);
  assert.equal(single.rows, 1, 'the footer variant must stay one row');
  assert.equal(single.frames.length, panel.frames.length);
  assert.ok(single.frames[0].includes('▀'), 'the 1-row variant should still be half-block pixel art');
});


// ---- phase steps light for the statuses the daemon actually publishes -------
// Regression guard: the old test was a substring match, and the daemon publishes
// EXECUTING while the step is labelled EXECUTE. 'EXECUTING'.includes('EXECUTE') is
// false, so the EXECUTE step stayed dark for the whole of every run.
{
  const { phaseChip } = require('../src/cli/tui/renderer');
  const bare = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const litSteps = (status) => ['PREFLIGHT', 'EXECUTE', 'VERIFY']
    .filter((name, index) => bare(phaseChip(name, status, index + 1)).startsWith('\u25cf'));
  assert.deepStrictEqual(litSteps('EXECUTING'), ['EXECUTE'], 'EXECUTING must light EXECUTE');
  assert.deepStrictEqual(litSteps('REPAIRING'), ['EXECUTE']);
  assert.deepStrictEqual(litSteps('VERIFYING'), ['VERIFY']);
  assert.deepStrictEqual(litSteps('COMPLETED'), ['VERIFY']);
  assert.deepStrictEqual(litSteps('AWAITING_APPROVAL'), ['PREFLIGHT']);
  assert.deepStrictEqual(litSteps('PLANNING'), ['PREFLIGHT']);
  assert.deepStrictEqual(litSteps('IDLE'), [], 'idle lights nothing rather than guessing');
}

{
  // npm's chatter about npm took a dozen lines of the owner's live stream, in the same
  // treatment as real tool output. The rule is narrow on purpose: drop only lines that
  // say nothing about the task, and never drop a failure. Silencing an error would be a
  // worse defect than the noise it replaced.
  const { isRoutineToolNoise } = T;
  const noise = [
    'added 4 packages, and audited 512 packages in 2s',
    'removed 12 packages',
    'up to date, audited 300 packages in 1s',
    '2 packages are looking for funding',
    '  run `npm fund` for details',
    'found 0 vulnerabilities',
    'npm notice New major version of npm available! 10.9.0 -> 11.0.0',
    'audited 512 packages in 3s',
  ];
  for (const line of noise) {
    assert.ok(isRoutineToolNoise(line), `npm chatter must not reach the stream: ${line}`);
    checks += 1;
  }
  const keep = [
    'npm ERR! code ERESOLVE',
    'found 3 vulnerabilities (1 moderate, 2 high)',
    'npm notice',           // bare, but a real error marker below decides
    'Tests: 4 failed, 58 passed',
    'added 4 packages but ERR! something went wrong',
    '',
  ];
  assert.ok(!isRoutineToolNoise('npm ERR! code ERESOLVE'), 'an npm failure is never noise');
  assert.ok(!isRoutineToolNoise('found 3 vulnerabilities (1 moderate, 2 high)'),
    'a vulnerability count with findings is a fact about the project, not chatter');
  assert.ok(!isRoutineToolNoise('added 4 packages but ERR! something went wrong'),
    'an error marker outranks every noise pattern');
  assert.ok(!isRoutineToolNoise('Tests: 4 failed, 58 passed'), 'real output is untouched');
  assert.ok(!isRoutineToolNoise(''), 'an empty line is not a match');
  checks += keep.length;
  // The filter is applied to tool logs only, and only in the live relay.
  const monitor = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'cli', 'tui', 'monitor.js'), 'utf8');
  assert.match(monitor, /event === 'tasklog' && isRoutineToolNoise\(text\)/,
    'the filter is scoped to tool logs — a run or phase line is never dropped');
  checks += 1;
}

// A specialist that answers with a whole file must not bury the report.
//
// maxLines counts source lines, and a whole file arrives as one. Measured 2026-08-05:
// a leader returned the entire game as a single headline, it passed the 16-line fold
// untouched, and wrapping turned it into several hundred rows that buried
// `report(3/3 done · completed)`. The owner could not tell whether the run had ended.
{
  const huge = `Quick note on environment: no live file tools. ${'<!DOCTYPE html><canvas id=c></canvas><script>const W=480,H=272;'.repeat(60)}`;
  const lines = plainLines(T.renderEvent('report', {
    status: 'COMPLETED', completed: 3, total: 3, ms: 253000,
    rows: [{ role: 'leader', provider: 'glm', status: 'completed', ms: 65000, headline: huge,
      changed: [{ added: 120, removed: 4 }], isolated: true, workspacePath: '/x/.bigkiji/worktrees/run-1-leader' },
    { role: 'debug', provider: 'glm', status: 'completed', ms: 15000, headline: 'checks pass' }],
    checks: [{ id: 'tests-pass', pass: true }],
  }, { width: 100 }));
  assert.ok(lines.length <= 20, `a finished run has to be readable in one screen, got ${lines.length} lines`);
  assert.match(lines[0], /report\(3\/3 done/, 'the completion line stays at the top where it can be seen');
  assert.ok(lines.some((line) => /1 file . \+120 -4/.test(line)), 'what it produced');
  assert.ok(lines.some((line) => line.includes('/x/.bigkiji/worktrees/run-1-leader')), 'and where it put it');
  assert.ok(lines.every((line) => line.length <= 120), 'no row may overflow the terminal');
  checks += 5;
}

// npm talking about npm, in the error colour, twenty lines at a time.
//
// The patterns for this were written, exported, and called from nowhere. Measured
// 2026-08-05 on a live turn: `added 6 packages`, `1 package is looking for funding`,
// `found 0 vulnerabilities` and `npm notice New major version` filled the screen above
// the one line that was about the task. npm also concatenates several notices onto one
// physical line, which is why that pattern cannot be anchored to the start.
{
  const noisy = ['added 6 packages, and audited 7 packages in 6s',
    '1 package is looking for funding run `npm fund` for details',
    'found 0 vulnerabilities',
    'npm notice npm notice New major version of npm available! 11.17.0 -> 12.0.2 npm notice',
    'The cooking game scaffold is ready.'].join('\n');
  const out = plainLines(T.renderToolResult(noisy, { width: 100 })).join('\n');
  assert.match(out, /The cooking game scaffold is ready\./, 'the line that is about the task has to survive');
  for (const gone of ['added 6 packages', 'looking for funding', 'found 0 vulnerabilities', 'npm notice']) {
    assert.ok(!out.includes(gone), `npm chatter must not reach the transcript: ${gone}`);
  }
  // Silencing a failure would be a worse defect than printing noise.
  assert.match(plainLines(T.renderToolResult('npm ERR! code ELIFECYCLE', { width: 80 })).join('\n'), /npm ERR!/,
    'an npm failure is never noise');
  assert.match(plainLines(T.renderToolResult('added 6 packages', { width: 80 })).join('\n'), /added 6 packages/,
    'a result that is nothing but chatter still prints — an empty elbow would read as a lost result');
  checks += 4;
}

// A question the owner cannot answer.
//
// `⚠ unanswered` reached the screen on 2026-08-04 and then stopped there: the CLI
// offered approve, reject and later, none of which is an answer, so approving sent
// the plan back to asking the same thing. The way out has to be printed next to the
// question — an affordance nobody can see is one nobody uses.
{
  const lines = plainLines(T.renderEvent('run', {
    id: 'run-msesmjj9', status: 'AWAITING_APPROVAL', assignments: [],
    promptSpec: { goal: '3djsのゲームを作ってください。', constraints: ['genre_definition'],
      questions: ['What genre or scope do you envision?'] },
  }, { width: 100 })).join('\n');
  assert.match(lines, /unanswered: What genre or scope/, 'the question still reaches the screen');
  const handsOff = plainLines(T.renderEvent('run', {
    id: 'run-9', status: 'AWAITING_APPROVAL', assignments: [],
    promptSpec: { goal: 'Build a browser shooter.', constraints: [], questions: [],
      decidedWithoutOwner: [{ ask: 'どのジャンルにしますか？' }] },
  }, { width: 100 })).join('\n');
  assert.match(handsOff, /decided for you: どのジャンルにしますか？/,
    'what hands-off settled without asking has to be visible on the plan');
  // A remedy applied invisibly is indistinguishable from luck.
  const remembered = plainLines(T.renderEvent('run', {
    id: 'run-3', status: 'AWAITING_APPROVAL', assignments: [],
    knownFailure: { fix: 'route to glm before gemini', cause: 'quota spent', occurrences: 2 },
    promptSpec: { goal: 'build a game', constraints: [], questions: [] },
  }, { width: 100 })).join('\n');
  assert.match(remembered, /avoiding a known failure \(seen 2/, 'the owner has to see the wall was remembered, not hit');
  assert.match(remembered, /route to glm before gemini/);
  assert.match(lines, /\/answer run-msesmjj9 <your answer>/, 'and so does the way to answer it');
  const quiet = plainLines(T.renderEvent('run', {
    id: 'run-7', status: 'AWAITING_APPROVAL', assignments: [],
    promptSpec: { goal: 'Ship the thing', constraints: [], questions: [] },
  }, { width: 100 })).join('\n');
  assert.ok(!/\/answer/.test(quiet), 'a plan asking nothing must not advertise an answer command');
  checks += 3;
}

console.log(`cli render selftest: PASS · ${checks} checks · de-boxed gutter layout (one model panel excepted) · lowercase chrome · one-cell cat, no kaomoji · hanging indents · honest folds · diffs · task lists · width-aware at 24-200 columns · NO_COLOR + TERM=dumb · sticky footer contract intact · npm chatter dropped, npm failures never · an unanswered question prints the way to answer it · a whole file in one headline cannot bury the report`);
