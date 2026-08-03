'use strict';

// What a run cost, and how full each model's context got.
//
// The owner's stated reason this project exists is "one CLI that manages usage and
// billing across every model". Until now nothing in it showed a number in dollars, and
// the header said `4k ctx` — which is the CONFIGURED size, not how much was used, so it
// told the owner nothing about whether a run was about to run out of room.
//
// Both numbers are dangerous in the same specific way: they look authoritative. A price
// nobody verified, or a context window guessed from the model's name, produces a figure
// that reads exactly like a measurement. So a model appears in these tables only with a
// source, and everything else returns null and renders as a dash. This project has
// already shipped a fabricated `saved 5,774,005` once; that is the mistake being avoided.

// USD per million tokens. Recorded 2026-08-03 while choosing the role assignments —
// re-verify against the vendor pages before treating a total as an invoice.
//   claude-*  Anthropic published pricing
//   glm-5.2   Z.ai published pricing
//   qwen/*    zero because it runs on the owner's own card, which is a fact, not a guess
// Absent on purpose: gpt-5.6-sol and gemini (not verified), glm-4.7-flash (not verified).
const PRICES = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'glm-5.2': { input: 1.4, output: 4.4 },
});
const FREE_PROVIDERS = new Set(['qwen', 'ollama']);

// Context window in tokens, per model.
//   claude-*        200k, read off a live status bar (claude-fable-5 · 38%/200k)
//   gpt-5.6-sol     372k, same source (openai-codex/gpt-5.6-sol · 0%/372k)
//   qwen3.5:* /
//   qwen3.6:latest  262144, from `ollama show` on this machine
//   glm-5.2         1M, from the model's release notes
const WINDOWS = Object.freeze({
  'claude-fable-5': 200000,
  'claude-opus-5': 200000,
  'gpt-5.6-sol': 372000,
  'glm-5.2': 1000000,
  'qwen3.5:latest': 262144,
  'qwen3.5:35b-a3b': 262144,
  'qwen3.6:latest': 262144,
});

/**
 * What one task cost, in USD.
 * Returns null when the price is unknown OR the usage was never reported — a provider
 * that reported no tokens did not spend zero, it simply did not say.
 */
function costOf(provider, model, tokens = {}) {
  const input = Number(tokens.input || 0);
  const output = Number(tokens.output || 0);
  if (FREE_PROVIDERS.has(provider)) return 0;
  if (!input && !output) return null;
  const price = PRICES[model];
  if (!price) return null;
  return (input * price.input + output * price.output) / 1e6;
}

/** Sum of the parts that are known. Returns null when nothing was priceable. */
function totalCost(rows = []) {
  let total = null;
  for (const row of rows) {
    const one = costOf(row.provider, row.model, row.tokens || {});
    if (one === null) continue;
    total = (total || 0) + one;
  }
  return total;
}

/**
 * How full the context got, as { used, window, percent } — percent null when the window
 * for this model is not known. Never guessed from the model family: a wrong window
 * produces a percentage that reads exactly like a measurement.
 */
function contextUse(model, tokens = {}) {
  const used = Number(tokens.input || 0) + Number(tokens.output || 0);
  const window = WINDOWS[model] || null;
  return { used, window, percent: window ? Math.min(100, Math.round((used / window) * 100)) : null };
}

/** `$0.42` / `$0.00` / `—`. Four decimals under a cent, so a cheap run is not "free". */
function formatCost(value) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** `38%/200k` when the window is known, `21k` when it is not. */
function formatContext(use) {
  if (!use || !use.used) return '—';
  const short = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return use.window ? `${use.percent}%/${short(use.window)}` : short(use.used);
}

module.exports = { PRICES, WINDOWS, FREE_PROVIDERS, costOf, totalCost, contextUse, formatCost, formatContext };
