'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CmuxBridge, HANDLE, KEYS, COMMAND, DANGEROUS, COMMAND_GROUPS } = require('../src/core/cmux-bridge');
assert(HANDLE.test('surface:4')); assert(HANDLE.test('d572933d-4dd5-4939-b031-54cdb22a12aa'));
assert(!HANDLE.test('surface:4; rm -rf /'));
for (const key of ['enter', 'escape', 'backspace', 'up', 'down']) assert(KEYS.has(key));
assert(COMMAND.test('workspace-action')); assert(DANGEROUS.test('cmux close-window --window window:1'));
assert(COMMAND_GROUPS.some((group) => group.commands.includes('ssh')));
const settingsStore = { get: () => ({ cmux: { enabled: true, cliPath: 'cmux', pollMs: 700, mirrorLines: 100, confirmDangerous: true } }), getSecret: () => '' };
const bridge = new CmuxBridge({ settingsStore });
const calls = []; bridge.run = async (argv) => { calls.push(argv); return 'ok'; }; bridge.refresh = async () => bridge.snapshot();

async function main() {
  const gate = await bridge.command({ argv: ['close-window', '--window', 'window:1'] });
  assert(gate.requiresConfirmation); assert.strictEqual(calls.length, 0);
  const done = await bridge.command({ argv: ['close-window', '--window', 'window:1'], confirmationId: gate.confirmationId });
  assert(done.ok); assert.strictEqual(calls.length, 1);
  const mirror = fs.readFileSync(path.join(__dirname, '../src/domain/terminal/components/cmux-terminal-mirror.js'), 'utf8');
  assert.match(mirror, /cmuxOpenNative/); assert.match(mirror, /cmuxAction\('split'/); assert.match(mirror, /cmuxCommand/); assert.match(mirror, /fallbackInput/);
  console.log('cmux bridge selftest: PASS');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
