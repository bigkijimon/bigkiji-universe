'use strict';

// Stop asking a provider that has just told us to stop asking.
//
// BigKiji's fallback table is static: when claude-code fails, try glm, then
// codex, then the local model. That is the right shape for a provider that
// broke, and the wrong shape for one that is rate limited, because the table
// does not remember. Three assignments in the same run each walk the chain from
// the top, each hits the same exhausted quota, and each spends a network round
// trip and a repair cycle discovering what the first one already knew.
//
// This is the memory. A provider that answers "not now" enough times inside a
// window is skipped until its cooldown expires, then gets exactly one trial
// before the decision is renewed.
//
//   closed     — the normal state. Attempts go through.
//   open       — recently throttled. Attempts are skipped by the caller.
//   half-open  — the cooldown has expired. The next attempt goes through, and
//                its result decides whether we close or re-open for longer.
//
// Two things this deliberately does NOT do.
//
// It does not retry anything. Nothing here calls a provider or sets a timer; it
// answers "would you ask this one right now?" and remembers what happened. The
// clock is injected, so a test can move time without waiting for it.
//
// It does not touch approval. When the coordinator skips an open provider it
// still proposes the replacement to the owner and still stops at
// AWAITING_APPROVAL. The breaker changes who is offered, never whether the owner
// is asked — that gate is the whole safety design and a throttled API is not a
// reason to open it.

const DEFAULTS = Object.freeze({
  threshold: 3,          // failures inside the window before the circuit opens
  windowMs: 120000,      // 2 minutes: long enough to catch a burst, short enough to forget one
  cooldownMs: 60000,     // first wait
  maxCooldownMs: 900000, // 15 minutes: an exhausted daily quota should not be retried every minute
});

// A quota is spent for longer than a rate limit is hot. Starting its cooldown
// higher stops us walking back into the same wall a minute later, without
// hard-coding a guess about when the allowance resets.
const FIRST_COOLDOWN = Object.freeze({ 'rate-limit': 1, quota: 5 });

const THROTTLED = new Set(['rate-limit', 'quota']);

class CircuitBreaker {
  constructor(options = {}) {
    const { threshold, windowMs, cooldownMs, maxCooldownMs } = { ...DEFAULTS, ...options };
    this.threshold = Math.max(1, Math.trunc(threshold));
    this.windowMs = Math.max(1000, Math.trunc(windowMs));
    this.cooldownMs = Math.max(1000, Math.trunc(cooldownMs));
    this.maxCooldownMs = Math.max(this.cooldownMs, Math.trunc(maxCooldownMs));
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.circuits = new Map();
  }

  _circuit(provider) {
    const key = String(provider || '');
    if (!this.circuits.has(key)) this.circuits.set(key, { hits: [], openUntil: 0, cooldownMs: 0, opens: 0, reason: '', trialTaken: false });
    return this.circuits.get(key);
  }

  /**
   * What happened when we asked this provider.
   * @param {string} provider
   * @param {{ok?: boolean, reason?: string, retryAfterMs?: number}} outcome
   * @returns {{provider: string, state: string, opened: boolean, openUntil: number, reason: string}|null}
   */
  record(provider, { ok = false, reason = '', retryAfterMs = 0 } = {}) {
    if (!provider) return null;
    const circuit = this._circuit(provider);
    const at = this.now();

    // Only a provider that actually answered closes its circuit. An ordinary
    // failure leaves it exactly where it was.
    //
    // Treating every non-throttle outcome as "reachable" looked reasonable and
    // was wrong: while a quota cooldown was running, one unrelated crash from
    // any other task on the same provider wiped it, and the next repair walked
    // straight back into the exhausted quota. Silence is not evidence of health.
    if (ok) {
      if (!circuit.hits.length && !circuit.openUntil) return null;
      this.circuits.set(String(provider), { hits: [], openUntil: 0, cooldownMs: 0, opens: 0, reason: '', trialTaken: false });
      return { provider, state: 'closed', opened: false, openUntil: 0, reason: '' };
    }
    if (!THROTTLED.has(reason)) return null; // a crash says nothing about reachability

    circuit.reason = reason;
    circuit.hits = circuit.hits.filter((time) => at - time < this.windowMs);
    circuit.hits.push(at);

    // Already open, and throttled again on the trial request: the cooldown was
    // too short. Double it rather than asking again at the same cadence.
    const reopening = circuit.openUntil > 0;
    if (!reopening && circuit.hits.length < this.threshold) {
      return { provider, state: 'closed', opened: false, openUntil: 0, reason };
    }

    const base = circuit.cooldownMs
      ? Math.min(this.maxCooldownMs, circuit.cooldownMs * 2)
      : Math.min(this.maxCooldownMs, this.cooldownMs * (FIRST_COOLDOWN[reason] || 1));
    // The provider's own number beats ours when it gave one, but never shortens
    // a cooldown we have already had to extend.
    const wait = Math.max(base, Math.min(this.maxCooldownMs, Math.trunc(retryAfterMs) || 0));
    circuit.cooldownMs = wait;
    circuit.openUntil = at + wait;
    circuit.opens += 1;
    circuit.hits = [];
    circuit.trialTaken = false; // a fresh cooldown earns a fresh trial
    return { provider, state: 'open', opened: true, openUntil: circuit.openUntil, reason, cooldownMs: wait };
  }

  /** 'closed' | 'open' | 'half-open'. A pure query — it consumes nothing. */
  state(provider) {
    const circuit = this.circuits.get(String(provider || ''));
    if (!circuit || !circuit.openUntil) return 'closed';
    return this.now() >= circuit.openUntil ? 'half-open' : 'open';
  }

  /** True only while the cooldown is running. Does not consume the half-open trial. */
  isOpen(provider) { return this.state(provider) === 'open'; }

  /**
   * May I ask this provider now? Consumes the half-open trial, so exactly one
   * caller gets through per cooldown.
   *
   * This is the difference between the docstring above and what the code did.
   * The repair loop hands every failed assignment to _fallback in a single pass;
   * with a pure clock comparison all three of them saw half-open and all three
   * were offered the same still-throttled provider — the exact case this module
   * exists to prevent.
   */
  allow(provider) {
    const state = this.state(provider);
    if (state === 'open') return false;
    if (state === 'half-open') {
      const circuit = this._circuit(provider);
      if (circuit.trialTaken) return false;
      circuit.trialTaken = true;
    }
    return true;
  }

  /** Milliseconds until this provider is worth asking again; 0 when it is now. */
  retryInMs(provider) {
    const circuit = this.circuits.get(String(provider || ''));
    if (!circuit || !circuit.openUntil) return 0;
    return Math.max(0, circuit.openUntil - this.now());
  }

  snapshot() {
    return [...this.circuits.entries()]
      .filter(([, circuit]) => circuit.openUntil || circuit.hits.length)
      .map(([provider, circuit]) => ({ provider, state: this.state(provider), reason: circuit.reason,
        retryInMs: this.retryInMs(provider), opens: circuit.opens }));
  }
}

module.exports = { CircuitBreaker, DEFAULTS, THROTTLED, FIRST_COOLDOWN };
