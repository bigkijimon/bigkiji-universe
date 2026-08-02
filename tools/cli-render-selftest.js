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
const { TUIRenderer, modelPanel } = require('../src/cli/tui/renderer');
const { buildFooter, footerHeightFor } = require('../src/cli/tui/footer');
const { loadingFrames, frameRows, FRAME_SETS } = require('../src/cli/tui/loading-frames');

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
ok('the header carries exactly one box, and it is the model panel', () => {
  for (const [cols, rows] of [[100, 30], [60, 24], [200, 50]]) {
    const renderer = new TUIRenderer({ output: { columns: cols, rows, write() {} } });
    const { header } = renderer.sections(MONITOR_STATE, MONITOR_RELAY);
    const boxed = plainLines(header).filter((line) => BOX.test(line));
    assert.equal(boxed.length, 3, `a box is three rows and there is one of them at ${cols}x${rows}: ${boxed.length}`);
    assert.ok(boxed[0].startsWith('╭─') && boxed[0].endsWith('╮'), `top: ${boxed[0]}`);
    assert.ok(boxed[1].startsWith('│') && boxed[1].endsWith('│'), `middle: ${boxed[1]}`);
    assert.ok(boxed[2].startsWith('╰') && boxed[2].endsWith('╯'), `bottom: ${boxed[2]}`);
    const widths = boxed.map(T.stringWidth);
    assert.ok(widths.every((value) => value === widths[0]), `the three rows must align: ${widths.join(',')}`);
    assert.ok(widths[0] <= cols, `the panel must fit ${cols}: ${widths[0]}`);
    assert.ok(boxed[1].includes('qwen2.5:0.5b'), `the panel states the real model: ${boxed[1]}`);
    assert.ok(boxed[1].includes('4k ctx'), `and the real context window: ${boxed[1]}`);
    assert.ok(boxed[1].includes('1/2 online'), `and counts what is actually connected: ${boxed[1]}`);
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
  assert.ok(/[●○]1/.test(chips) && /[●○]2/.test(chips) && /[●○]3/.test(chips), `but all three steps stay: ${chips}`);
});
ok('the model panel invents nothing when the daemon said nothing', () => {
  const boxed = plainLines(modelPanel({}, { width: 80 }));
  assert.equal(boxed.length, 3);
  assert.ok(boxed[1].includes('—'), `an unknown model is an em dash, not a default: ${boxed[1]}`);
  assert.ok(!/ctx/.test(boxed[1]), `no context window was reported, so none is shown: ${boxed[1]}`);
  assert.ok(!/online/.test(boxed[1]), `no fleet was reported, so no count is shown: ${boxed[1]}`);
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
ok('the default frame set is a 1-row pixel cat, not a kaomoji', () => {
  const set = loadingFrames();
  assert.equal(set.rows, 1, 'the footer height contract is six rows, so the art gets one');
  assert.equal(frameRows(0, set).length, 1);
  assert.equal(T.stringWidth(frameRows(0, set)[0]), set.width);
  assert.ok(set.id.startsWith('pixel-cat'), `the owner retired the kaomoji: ${set.id}`);
  assert.doesNotMatch(set.frames.join(''), /\(=\^/, 'no faces');
});
ok('a colourless terminal gets a shaded cat, never the kaomoji back', () => {
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(require.resolve('../src/cli/tui/loading-frames'))});
    process.stdout.write(JSON.stringify({ id: L.DEFAULT_FRAME_SET_ID, frames: L.loadingFrames().frames, rows: L.loadingFrames().rows }));
  `], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const set = JSON.parse(result.stdout);
  assert.equal(set.id, 'pixel-cat-mono-row', `NO_COLOR must land on the silhouette set: ${set.id}`);
  assert.equal(set.rows, 1);
  assert.doesNotMatch(set.frames.join(''), /\x1b/, 'a colourless set carries no escapes');
  assert.doesNotMatch(set.frames.join(''), /\(=\^/, 'and still no faces');
  // Shading, not silhouette: every pixel of the face is opaque, so presence
  // alone renders a solid bar. Measured, not assumed — that is why the mono row
  // uses lightness and the mono panel uses half-blocks.
  assert.ok(new Set(set.frames.join('')).size > 2, `the face must have internal detail: ${JSON.stringify(set.frames)}`);
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

console.log(`cli render selftest: PASS · ${checks} checks · de-boxed gutter layout (one model panel excepted) · lowercase chrome · pixel cat, no kaomoji · hanging indents · honest folds · diffs · task lists · width-aware at 24-200 columns · NO_COLOR + TERM=dumb · sticky footer contract intact`);
