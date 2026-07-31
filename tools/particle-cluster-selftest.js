'use strict';
const assert = require('assert');
assert.equal(/buildAgentHole|全AI＝ブラックホール/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'synapse.js'), 'utf8')), false);
console.log('particle cluster policy selftest: PASS');
