'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliPreferences } = require('../src/domain/terminal/cli-preferences');
const { normalizeMode, transportMode, themeFor, rainbow, stripAnsi } = require('../src/domain/terminal/cli-theme');

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
console.log('cli theme selftest: PASS · warm brown/orange palette · mode accents · persistent preferences · three transport modes · ask migration runs once and never fights the owner');
