'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HANDLE, KEYS } = require('../src/core/cmux-bridge');
assert(HANDLE.test('surface:4')); assert(HANDLE.test('d572933d-4dd5-4939-b031-54cdb22a12aa'));
assert(!HANDLE.test('surface:4; rm -rf /'));
for (const key of ['enter', 'escape', 'backspace', 'up', 'down']) assert(KEYS.has(key));
const mirror = fs.readFileSync(path.join(__dirname, '../src/domain/terminal/components/cmux-terminal-mirror.js'), 'utf8');
assert.match(mirror, /cmuxOpenNative/); assert.match(mirror, /cmuxAction\('split'/); assert.match(mirror, /fallbackInput/);
console.log('cmux bridge selftest: PASS');
