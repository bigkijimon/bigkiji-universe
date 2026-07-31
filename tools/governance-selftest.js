#!/usr/bin/env node
'use strict';
const assert = require('assert');
const g = require('../governance');

assert.equal(g.isSubstantiveTask('こんにちは'), false);
assert.equal(g.isSubstantiveTask('BigKiji Universeのモデル降格処理を実装して検証してください。'), true);
const task = g.startTask('モデル降格処理を実装して検証してください。');
assert.match(g.makeMakerPrompt(task.ownerText, task.id), /MAKER CONTRACT/);
const state = g.makeState(task, { answer: '実装しました。', model: 'ollama/qwen', touched: ['biglama'], turn: { input: 1, output: 2 }, toolErrors: 0 });
assert.match(g.makeResumeContext(state), /D1 CONTINUITY SNAPSHOT/);
assert.match(g.makeCheckerPrompt(state), /CHECKER CONTRACT/);
console.log('governance selftest: PASS');
