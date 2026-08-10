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

for (const dir of [root, legacyRoot, chosenRoot]) fs.rmSync(dir, { recursive: true, force: true });
console.log('cli theme selftest: PASS · warm brown/orange palette · mode accents · persistent preferences · three transport modes · one shift+tab cycle that comes home in four · ask migration runs once and never fights the owner');
