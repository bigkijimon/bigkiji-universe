'use strict';
const assert = require('assert');
const router = require('../fast-api-router');
assert.deepStrictEqual(router.PRIORITY, ['claude-code', 'codex', 'glm', 'kimi']);
assert.deepStrictEqual(router.availableOrder({ 'claude-code': true, codex: true, glm: false, kimi: true }), ['claude-code', 'codex', 'kimi']);
assert.deepStrictEqual(router.availableOrder({}), []);
console.log('fast router selftest: PASS');
