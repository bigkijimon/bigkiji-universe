'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliPreferences } = require('../src/domain/terminal/cli-preferences');
const { normalizeMode, transportMode, themeFor, rainbow, stripAnsi } = require('../src/domain/terminal/cli-theme');

assert.equal(normalizeMode('ask'), 'ask'); assert.equal(normalizeMode('auto'), 'auto-edit'); assert.equal(normalizeMode('manual'), 'auto-edit');
assert.equal(transportMode('ask'), 'plan'); assert.equal(transportMode('auto-edit'), 'auto');
if (process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb') {
  assert.notEqual(themeFor('ask').accent, themeFor('plan').accent); assert.notEqual(themeFor('auto-edit').border, themeFor('ask').border);
  assert.match(rainbow(20, 'plan'), /\x1b\[/);
}
assert.ok(stripAnsi(rainbow(20, 'plan')).length >= 20);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-cli-theme-')); const prefs = new CliPreferences({ root });
assert.equal(prefs.get().mode, 'plan'); assert.equal(prefs.update({ mode: 'ask', contrast: 'high' }).mode, 'ask');
assert.equal(new CliPreferences({ root }).get().contrast, 'high'); assert.equal(new CliPreferences({ root }).get().theme, 'warm-brown');
console.log('cli theme selftest: PASS · warm brown/orange palette · mode accents · persistent preferences');
