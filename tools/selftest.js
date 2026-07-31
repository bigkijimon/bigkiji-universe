#!/usr/bin/env node
'use strict';
// BIGKIJI selftest（v11）— Piの主要ツール（read/list/write/bash）を小タスクで実走し pass/fail を実測する。
// 使い方: node tools/selftest.js
//   モデル上書き: SELFTEST_MODEL=ollama/qwen3.5:35b-a3b node tools/selftest.js （既定=ローカルQwen）
// 各テストは `pi -p` のワンショット（cwd=Vault・グローバルsandbox適用）。証跡: tools/selftest-result-<日付>.json
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VAULT = '/Users/yuma/Documents/CEOBigKiji';
const PI = fs.existsSync('/Users/yuma/.npm-global/bin/pi') ? '/Users/yuma/.npm-global/bin/pi' : 'pi';
const MODEL = process.env.SELFTEST_MODEL || 'ollama/qwen3.5:35b-a3b';
const STAMP = Date.now();
const TMP = path.join(VAULT, 'Executive_Office', 'CompanyApp', 'BIGKIJI', 'Knowledge', `selftest-${STAMP}.txt`);

const TESTS = [
  { id: 'read', expect: /正典|BigKiji|canon|#/i,
    prompt: 'Use your file read tool to read the first 3 lines of 正典.md in the current directory and output them verbatim.' },
  { id: 'list', expect: /Executive_Office|Creative_Media|English_School/,
    prompt: 'Use your directory listing tool on the current directory and output the entry names.' },
  { id: 'write', expect: /SELFTEST_OK/,
    prompt: `Use your file write tool to create ${TMP} containing exactly "SELFTEST_OK ${STAMP}". Then output SELFTEST_OK if the write succeeded.` },
  { id: 'bash', expect: new RegExp(`BKST_${STAMP}`),
    prompt: `Run this shell command with your bash tool and output its stdout verbatim: echo BKST_${STAMP}` },
];

const results = [];
for (const t of TESTS) {
  const t0 = Date.now();
  let out = '', pass = false, err = '';
  try {
    out = execFileSync(PI, ['-p', '--model', MODEL, t.prompt], { cwd: VAULT, timeout: 240000, encoding: 'utf8' });
    pass = t.expect.test(out);
  } catch (e) { err = String(e.message || e).slice(0, 300); }
  results.push({ id: t.id, pass, ms: Date.now() - t0, err: err || undefined, sample: out.replace(/\s+/g, ' ').slice(0, 160) });
  console.log(`${pass ? '✅' : '❌'} ${t.id} (${Date.now() - t0}ms)`);
}
try { fs.unlinkSync(TMP); } catch (_) {} // 後片付け（write検証の一時ファイル）
const file = path.join(__dirname, `selftest-result-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify({ model: MODEL, ts: STAMP, results }, null, 2));
console.log('result →', file, results.every((r) => r.pass) ? 'ALL PASS' : 'HAS FAIL');
process.exit(results.every((r) => r.pass) ? 0 : 1);
