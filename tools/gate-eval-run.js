#!/usr/bin/env node
'use strict';

// Run the approval-gate evaluation against a real local model and print the number.
//
// Not part of `npm test`: it loads a model, takes minutes, and answers a question
// about this machine rather than about the code. The dataset and the scoring are
// tested there; this is the measurement.
//
//   node tools/gate-eval-run.js                 # the conversation model
//   node tools/gate-eval-run.js qwen3.6:latest  # any local model

const { CASES, promptFor, verdictOf, score, recommendation } = require('../src/domain/pi-agent/gate-eval');

const MODEL = process.argv[2] || process.env.BIGKIJI_CONVERSATION_MODEL || 'qwen3.5:latest';
const ENDPOINT = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';

async function ask(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(`${ENDPOINT}/api/generate`, {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, format: 'json', think: false,
        keep_alive: '60s', options: { temperature: 0.15, num_predict: 220 } }),
    });
    if (!response.ok) return null;
    return (await response.json())?.response || null;
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

(async () => {
  console.log(`gate evaluation · ${MODEL} · ${CASES.length} cases\n`);
  const results = [];
  for (const testCase of CASES) {
    const started = Date.now();
    const verdict = verdictOf(await ask(promptFor(testCase)));
    const ms = Date.now() - started;
    const right = verdict ? verdict.approve === testCase.approve : false;
    const mark = !verdict ? '  ??' : right ? '  ok' : (testCase.approve ? ' over' : ' MISS');
    console.log(`${mark}  ${testCase.id.padEnd(22)} expected ${testCase.approve ? 'approve' : 'reject '} · got ${
      verdict ? (verdict.approve ? 'approve' : 'reject ') : 'unreadable'} · ${String(ms).padStart(5)}ms`
      + (verdict?.reason && !right ? `\n        said: ${verdict.reason}` : ''));
    results.push({ id: testCase.id, expected: testCase.approve, verdict });
  }

  const summary = score(results);
  const advice = recommendation(summary);
  console.log(`\n  miss rate     ${(summary.missRate * 100).toFixed(1)}%  (approved something that should have been stopped)`);
  console.log(`  over-caution  ${(summary.overCaution * 100).toFixed(1)}%  (stopped something harmless — the cheaper mistake)`);
  console.log(`  unreadable    ${summary.unreadable}/${summary.total}`);
  if (summary.misses.length) console.log(`  missed        ${summary.misses.join(', ')}`);
  if (summary.overCautious.length) console.log(`  over-stopped  ${summary.overCautious.join(', ')}`);
  console.log(`\n  verdict: ${advice.verdict.toUpperCase()} — ${advice.reason}`);
  if (advice.verdict === 'escalate') {
    console.log('  the owner asked for this to fall back to Claude Code when the local model cannot hold the gate.');
  }
})();
