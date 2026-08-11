'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliPreferences } = require('../src/domain/terminal/cli-preferences');
const { normalizeMode, transportMode, MODE_CYCLE, nextMode, themeFor, rainbow, stripAnsi } = require('../src/domain/terminal/cli-theme');

assert.equal(normalizeMode('ask'), 'ask'); assert.equal(normalizeMode('auto'), 'auto-edit'); assert.equal(normalizeMode('manual'), 'auto-edit');
// Three modes, three values on the wire.
//
// `ask` used to be sent as 'plan', which was invisible while the daemon flattened every
// mode to 'plan' anyway. Now the mode decides whether a writing run waits for the owner,
// so collapsing two of them here would silently take one of the three away.
assert.equal(transportMode('plan'), 'plan');
assert.equal(transportMode('ask'), 'ask');
assert.equal(transportMode('auto-edit'), 'auto');
assert.equal(transportMode('nonsense'), 'plan', 'an unknown mode is the one that waits');
// shift+tab, and the fact that it comes back to where it started.
//
// The REPL had no shift+tab at all until 2026-08-10 while renderer.js advertised one, and
// the monitor view held the only cycle as a literal array inside its key handler. One
// exported list is the fix; these assertions are what stop a second one from appearing.
assert.deepEqual(MODE_CYCLE, ['ask', 'plan', 'auto-edit', 'demo'], 'ascending by what the fleet may do unasked');
assert.equal(nextMode('ask'), 'plan');
assert.equal(nextMode('plan'), 'auto-edit');
assert.equal(nextMode('auto-edit'), 'demo');
assert.equal(nextMode('demo'), 'ask', 'the only jump backwards is the wrap, and it lands on the tightest mode');
// Four presses is a round trip, from every starting point. A cycle that drops a mode is
// a mode the owner can only reach by typing, and they would have no way to know which.
for (const start of MODE_CYCLE) {
  const seen = [nextMode(start), nextMode(nextMode(start)), nextMode(nextMode(nextMode(start))), nextMode(nextMode(nextMode(nextMode(start))))];
  assert.equal(seen[3], start, `four presses from ${start} must come home`);
  assert.equal(new Set(seen).size, 4, `every mode reachable from ${start}`);
}
// The synonyms settle before the cycle moves, so `auto` (what settings.json spells it)
// advances to demo rather than restarting at ask.
assert.equal(nextMode('auto'), 'demo', 'the wire spelling normalises before it advances');
assert.equal(nextMode('manual'), 'demo');
// An unrecognised value is `plan` by the time the cycle sees it — the same rule
// `transportMode` uses two lines above — so it advances from there rather than being a
// fourth, secret starting point.
assert.equal(nextMode('nonsense'), 'auto-edit');
assert.equal(nextMode(''), 'auto-edit');
assert.equal(nextMode(undefined), 'auto-edit');

if (process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb') {
  assert.notEqual(themeFor('ask').accent, themeFor('plan').accent); assert.notEqual(themeFor('auto-edit').border, themeFor('ask').border);
  assert.match(rainbow(20, 'plan'), /\x1b\[/);
}
assert.ok(stripAnsi(rainbow(20, 'plan')).length >= 20);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-cli-theme-')); const prefs = new CliPreferences({ root });
assert.equal(prefs.get().mode, 'ask', 'a fresh install starts in ask');
assert.equal(prefs.update({ mode: 'ask', contrast: 'high' }).mode, 'ask');
assert.equal(new CliPreferences({ root }).get().contrast, 'high'); assert.equal(new CliPreferences({ root }).get().theme, 'warm-brown');

// The migration off `plan`, both directions.
//
// Changing DEFAULTS is not enough and this project has the scar to prove it: normalize()
// is `{...DEFAULTS, ...saved}`, so a saved key always wins, and every machine that has
// ever run this CLI has `"mode": "plan"` on disk. The same shape let a retired 0.5B chat
// model survive in a saved settings.json until it was migrated out by name.
//
// The second half matters as much as the first: migrating once is a fix, migrating every
// time is the tool overriding the owner. A deliberate `plan` has to survive restarts.
const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-cli-legacy-'));
fs.writeFileSync(path.join(legacyRoot, 'config.json'),
  JSON.stringify({ theme: 'warm-brown', modeAccent: 'follow', contrast: 'standard', mode: 'plan', catCommentary: 'low' }));
assert.equal(new CliPreferences({ root: legacyRoot }).get().mode, 'ask', 'a settings file written before the default changed must still move');

const chosenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-cli-chosen-'));
new CliPreferences({ root: chosenRoot }).update({ mode: 'plan' });
assert.equal(new CliPreferences({ root: chosenRoot }).get().mode, 'plan', 'an owner who chose plan keeps plan');
assert.equal(new CliPreferences({ root: chosenRoot }).get().mode, 'plan', 'and keeps it on every later start');

// The up arrow, across restarts.
//
// readline keeps a history in memory and drops it on exit, so every restart of this CLI
// began with an empty up arrow — and it is restarted often. The file is a sibling of
// config.json rather than a key inside it: 200 lines of the owner's typing has no
// business being parsed on every settings read.
{
  const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-cli-history-'));
  const store = new CliPreferences({ root: historyRoot });
  assert.deepEqual(store.history(), [], 'no file yet is an empty history, not a crash');
  store.saveHistory(['/runs', 'いまの進捗は？', '/runs', '', '  ']);
  assert.deepEqual(new CliPreferences({ root: historyRoot }).history(), ['/runs', 'いまの進捗は？'],
    'newest first, no blanks, and the same line is not kept twice');
  // A key pasted into the prompt must not be written to disk because it was typed here.
  //
  // `blocked` is NOT the test and this is the trap: it is only true for a private key,
  // so an API token comes back unblocked and would have been written out verbatim.
  const { keepInHistory } = require('../src/domain/terminal/bigkiji-cli');
  const { redactPayload } = require('../src/domain/pi-core/security/payload-redactor');
  const secret = `use sk-ant-api03-${'x'.repeat(95)} for this`;
  assert.equal(redactPayload(secret).blocked, false, 'an api key is redacted and not blocked — that is why blocked is the wrong test');
  assert.equal(keepInHistory(secret), false, 'and it still must not be kept');
  assert.equal(keepInHistory('AKIAIOSFODNN7EXAMPLE を消して'), false, 'nor an aws key');
  assert.equal(keepInHistory('umamon@proton.me に送って'), true,
    'an address the owner types on purpose is not a credential, and the session log beside this holds it anyway');
  store.saveHistory([secret, '/status'], keepInHistory);
  assert.deepEqual(new CliPreferences({ root: historyRoot }).history(), ['/status'], 'a secret never reaches the history file');
  const mode = fs.statSync(store.historyFile()).mode & 0o777;
  assert.equal(mode, 0o600, `the history is the owner's typing and nobody else's: ${mode.toString(8)}`);
  fs.rmSync(historyRoot, { recursive: true, force: true });
}

// One table, four consumers.
//
// The hint row advertised eight commands, the dispatcher answered to nineteen, and
// nothing checked that they agreed. Measured 2026-08-11 10:55 in the owner's session
// file: `/reaume` went to a model as a conversation turn and cost eight seconds and a
// generation to be told it meant `/resume`.
{
  const cli = require('../src/domain/terminal/bigkiji-cli');
  const source = fs.readFileSync(require.resolve('../src/domain/terminal/bigkiji-cli'), 'utf8');
  // Every command the dispatcher answers to is in the table. This is the drift that
  // produced the typo in the first place, so it is the one asserted mechanically.
  const dispatched = new Set([...source.matchAll(/text === '(\/[a-z]+)'|text\.startsWith\('(\/[a-z]+) /g)]
    .map((match) => match[1] || match[2]));
  for (const name of dispatched) {
    assert.ok(cli.COMMAND_NAMES.includes(name), `${name} is answered by the REPL and is in no list the owner can see`);
  }
  assert.ok(dispatched.size >= 15, `the scan has to find the dispatcher, not two of it: ${dispatched.size}`);
  assert.deepEqual(cli.completeCommand('/ap')[0], ['/approve'], 'tab completes a prefix');
  assert.deepEqual(cli.completeCommand('/re')[0].sort(), ['/reject', '/reload', '/resume'], 'and offers every match');
  assert.deepEqual(cli.completeCommand('/idea plan x')[0], [], 'past the command word there is nothing here to complete');
  assert.deepEqual(cli.completeCommand('こんにちは')[0], [], 'and a sentence is not a command');
  assert.equal(cli.unknownCommand('/reaume').meant, '/resume', 'the typo the owner actually made');
  assert.equal(cli.unknownCommand('/resume'), null, 'a real command is not a typo');
  assert.equal(cli.unknownCommand('/quit'), null, 'nor is an alias');
  assert.equal(cli.unknownCommand('/gpu off'), null, 'nor a command with an argument');
  // The false positive that would cost the owner a sentence: a path is not a command.
  assert.equal(cli.unknownCommand('/Users/yuma/Documents/x.md を読んで'), null);
  assert.equal(cli.unknownCommand('/users/yuma/x'), null);
  assert.equal(cli.unknownCommand('進捗どうですか'), null);
  assert.equal(cli.unknownCommand('/zzzzzzzz').meant, '', 'and nothing near it is not a suggestion');
}

// The resume list, which could select what it was not showing.
//
// Twelve rows were printed and the cursor walked all of them — 103 sessions on the
// owner's machine — so pressing ↑ once from the top selected something off screen.
{
  const cli = require('../src/domain/terminal/bigkiji-cli');
  const now = Date.parse('2026-08-11T12:00:00Z');
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `session-${index}`, updatedAt: new Date(now - index * 3600_000).toISOString(),
    status: index % 2 ? 'CHAT' : 'EXPIRED', promptSummary: `request number ${index}`,
  }));
  const rows = cli.sessionRows(sessions, { index: 20, top: 14, width: 80, now });
  assert.equal(rows.length, cli.SESSION_WINDOW, 'the window is a window');
  assert.equal(rows.filter((row) => row.chosen).length, 1, 'and the selected row is inside it');
  assert.match(rows.find((row) => row.chosen).text, /^› /, 'marked where the eye is looking');
  assert.match(rows[0].text, /14h 00m ago/, 'how long ago, in the vocabulary the footer already uses');
  assert.match(rows[0].text, /request number 14/);
  for (const row of cli.sessionRows(sessions, { index: 0, top: 0, width: 34, now })) {
    assert.ok(row.text.length <= 34, `a narrow pane must not wrap the list: ${row.text}`);
  }
  assert.match(cli.sessionRows([{ updatedAt: new Date(now).toISOString(), promptSummary: '' }], { now })[0].text,
    /\(no first line\)/, 'a session with nothing in it says so rather than printing a blank row');
  // readline has to be stood down while the picker owns the keyboard, or ↑ pulls the
  // last input line back into the prompt and the Enter that resumes also submits it.
  const source = fs.readFileSync(require.resolve('../src/domain/terminal/bigkiji-cli'), 'utf8');
  assert.match(source, /rl\?\.pause\(\)/, 'the picker must pause readline the way askKey does');
  assert.match(source, /rl\?\.resume\(\)/, 'and give it back');
  assert.match(source, /selectSession\(client, \{ rl/, 'and it has to be handed the interface to pause');
}

for (const dir of [root, legacyRoot, chosenRoot]) fs.rmSync(dir, { recursive: true, force: true });
console.log('cli theme selftest: PASS · warm brown/orange palette · mode accents · persistent preferences · three transport modes · one shift+tab cycle that comes home in four · ask migration runs once and never fights the owner · history survives a restart and never keeps a secret · one command table the dispatcher, the hints, tab and the did-you-mean all read · a resume list that cannot select what it is not showing');
