'use strict';

// A price nobody verified reads exactly like a measurement.
//
// The owner's stated reason this project exists is one CLI that manages usage and
// billing across every model, and nothing in it showed a figure in dollars. The danger
// in adding one is not that it is missing — it is that a guessed price, or a context
// window inferred from a model's name, produces a number that looks authoritative and is
// wrong. This project has shipped exactly that mistake once already, as `saved 5,774,005`.
//
// So: priced only where there is a source, zero only where zero is a fact, and a dash
// everywhere else.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { costOf, contextUse, formatCost, formatContext, PRICES, WINDOWS } = require('../src/domain/pi-agent/pricing');

let failures = 0;
const ok = (name, body) => {
  try { body(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
};

ok('a known model is priced from its measured tokens', () => {
  // 21,000 in and 324 out on Opus at $5/$25 per million.
  const cost = costOf('claude-code', 'claude-opus-5', { input: 21000, output: 324 });
  assert.ok(Math.abs(cost - (21000 * 5 + 324 * 25) / 1e6) < 1e-12);
  assert.strictEqual(formatCost(cost), '$0.11');
  // And the tier really is twice the price, which is the whole reason debug pinning
  // to Fable was worth saying out loud.
  assert.strictEqual(PRICES['claude-fable-5'].input / PRICES['claude-opus-5'].input, 2);
});

ok('an unpriced model is a dash, never a zero', () => {
  // gpt-5.6-sol and gemini are deliberately absent from the table: not verified.
  assert.strictEqual(costOf('codex', 'gpt-5.6-sol', { input: 21324, output: 400 }), null);
  assert.strictEqual(formatCost(null), '—');
  assert.strictEqual(costOf('gemini', 'gemini-3-pro', { input: 100, output: 10 }), null);
  assert.ok(!PRICES['gpt-5.6-sol'] && !PRICES['glm-4.7-flash'],
    'a price is in this table only with a source; adding one without is the failure mode');
});

ok('a provider that reported nothing did not spend nothing', () => {
  assert.strictEqual(costOf('claude-code', 'claude-opus-5', {}), null,
    'no usage reported is not zero usage — this is the mistake that shipped once already');
  assert.strictEqual(costOf('claude-code', 'claude-opus-5', { input: 0, output: 0 }), null);
});

ok('local is free, and that is a fact rather than a guess', () => {
  assert.strictEqual(costOf('qwen', 'qwen3.5:latest', { input: 900000, output: 40000 }), 0);
  assert.strictEqual(costOf('ollama', 'qwen3.5:35b-a3b', {}), 0, 'free even when nothing was reported');
  assert.strictEqual(formatCost(0), '$0.00');
});

ok('a cheap run is not rounded away to free', () => {
  const tiny = costOf('glm', 'glm-5.2', { input: 400, output: 40 });
  assert.ok(tiny > 0 && tiny < 0.01);
  assert.strictEqual(formatCost(tiny), '$0.0007', 'two decimals would print $0.00 and read as free');
});

ok('context is how full it got, not how big it was configured', () => {
  // The header said `4k ctx` — the configured size — which told the owner nothing about
  // whether a run was about to run out of room.
  const use = contextUse('claude-opus-5', { input: 21000, output: 324 });
  assert.strictEqual(use.window, 200000);
  assert.strictEqual(use.percent, 11);
  assert.strictEqual(formatContext(use), '11%/200k');
});

ok('a window that is not known is not invented from the model name', () => {
  const unknown = contextUse('some-new-model-5', { input: 5000, output: 100 });
  assert.strictEqual(unknown.window, null);
  assert.strictEqual(unknown.percent, null, 'a percentage against a guessed window is a fabricated measurement');
  assert.strictEqual(formatContext(unknown), '5k', 'the tokens are still real, so they are still shown');
  assert.strictEqual(formatContext(contextUse('claude-opus-5', {})), '—');
  assert.ok(!Object.keys(WINDOWS).some((key) => /^claude-(?!fable-5$|opus-5$)/.test(key)),
    'no model family is extrapolated into this table');
});

ok('every price and window in the table carries its source', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'pricing.js'), 'utf8');
  const priceBlock = source.slice(source.indexOf('// USD per million'), source.indexOf('const FREE_PROVIDERS'));
  assert.match(priceBlock, /re-verify/, 'the table has to say it is not an invoice');
  const windowBlock = source.slice(source.indexOf('// Context window'), source.indexOf('const WINDOWS'));
  for (const model of Object.keys(WINDOWS)) {
    const family = model.split(/[:-]/)[0];
    assert.ok(windowBlock.includes(family), `${model} has no stated source`);
  }
});

ok('the report carries both, and the transcript prints them', () => {
  const coordinator = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'core-execution-coordinator.js'), 'utf8');
  assert.match(coordinator, /cost: costOf\(assignment\.provider, assignment\.model, tokens\)/);
  assert.match(coordinator, /context: contextUse\(assignment\.model, tokens\)/);
  assert.match(coordinator, /skills: assignment\.skills \|\| \[\]/, 'and which skills steered it');
  const transcript = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'tui', 'transcript.js'), 'utf8');
  assert.match(transcript, /formatCost\(row\.cost\), formatContext\(row\.context\)/);
  assert.match(transcript, /skills: \$\{row\.skills\.join/);
});

if (failures) { console.error(`pricing selftest: ${failures} FAILED`); process.exit(1); }
console.log('pricing selftest: PASS · priced only with a source · unpriced is a dash · unreported is not zero · local is genuinely free · a sub-cent run is not $0.00 · context is usage not configuration · no window inferred from a name');
