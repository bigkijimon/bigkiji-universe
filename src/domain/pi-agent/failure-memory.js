'use strict';
// What went wrong, why, and what fixed it — kept, so it is not rediscovered.
//
// The repair loop already existed: a failed assignment is retried on the same model,
// then on a different provider, up to maxRepairCycles. What it never did was ask *why*
// — the retry prompt carried the error string and nothing else — and nothing anywhere
// remembered the answer. So the same wall was hit three times per run, and again on the
// next run, and again next week.
//
// The pieces that already learn something learn something else:
//   ModelCapabilityRegistry  which model failed          (not: what the failure was)
//   CircuitBreaker           who is rate-limited now     (deliberately forgets)
//   DeliberationMemory       which plan worked           (not: which failure recurs)
//   knowledge.recordEvent    the last 300 events         (a log: no cause, no fix)
//
// This is the missing layer, and it is deliberately the same shape as
// DeliberationMemory — read/write/lookup/record, atomic tmp→rename, a bounded file —
// because a second storage idiom in the same directory is a second thing to get wrong.
//
// Two rules carried over from that class, both learned the expensive way:
//   * A remedy that has failed more than it has worked is not recalled. A memory that
//     cannot be disappointed is a cache.
//   * Untried is stored as untried. `—` is not 0, and "no evidence yet" must never be
//     read as "proven".

const path = require('path');
const { keywords, jaccard } = require('./task-cache');
const { readList, writeList } = require('./json-list-store');

const flat = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/**
 * The key a failure is remembered by.
 *
 * Deliberately coarse. `reason` comes from model-router.classifyFailure and `check` is
 * the quality check that did not pass, so "gemini ran out of quota while the tests were
 * failing" and "codex ran out of quota while the tests were failing" collapse to one
 * lesson — which is right, because the lesson is about the quota, not the provider.
 * The prompt text is kept separately in `terms` for the fuzzy half of the match.
 */
function signatureOf({ reason = '', check = '' } = {}) {
  const parts = [flat(reason, 60).toLowerCase(), flat(check, 60).toLowerCase()].filter(Boolean);
  return parts.join('/').replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unclassified';
}

class FailureMemory {
  constructor({ root, file = '', threshold = 0.4, limit = 200 } = {}) {
    this.file = file || path.join(root || '.', 'failure_memory.json');
    // Lower than DeliberationMemory's 0.5 on purpose: two requests that fail the same
    // way often share less wording than two requests that want the same plan.
    this.threshold = threshold;
    this.limit = limit;
  }

  read() { return readList(this.file, 'failures'); }

  write(memory) { writeList(this.file, 'failures', memory, this.limit); }

  /**
   * What is known about this failure, if anything.
   *
   * An exact signature match wins outright — that is the same failure by definition.
   * Otherwise the prompt is matched by wording, which is how a request that has not
   * failed *yet* can still be warned about the wall it is walking towards.
   *
   * @returns {object|null} null when nothing is known, or nothing worth repeating
   */
  lookup({ signature = '', prompt = '' } = {}) {
    const failures = this.read().failures;
    const key = signature ? signatureOf({ reason: signature }) : '';
    const usable = failures.filter((item) => {
      const { worked = 0, failed = 0 } = item.outcomes || {};
      // Never tried: the only information there is, so it is offered — labelled as
      // untried by `resolved: false`, never dressed up as proven.
      if (!worked && !failed) return true;
      // Tried, and it made things worse more often than better. That is not a remedy,
      // and repeating it is how three repair cycles get spent on one wall. The escape
      // hatch here used to read `|| worked === 0`, which meant a remedy with no
      // successes was recalled forever however often it failed — a memory that cannot
      // be disappointed, which is the exact thing this class exists to stop being.
      return failed <= worked;
    });
    const exact = key ? usable.find((item) => item.signature === signature || item.signature === key) : null;
    if (exact) return { ...exact, source: 'signature', similarity: 1 };
    const terms = keywords(prompt);
    if (!terms.length) return null;
    let best = null; let score = 0;
    for (const item of usable) {
      const value = jaccard(terms, item.terms || []);
      if (value > score) { score = value; best = item; }
    }
    if (!best || score < this.threshold) return null;
    return { ...best, source: 'wording', similarity: Number(score.toFixed(2)) };
  }

  /**
   * Record that this failure happened, and what the diagnosis made of it.
   *
   * Called once per failed assignment. A repeat increments `occurrences` rather than
   * appending, so the file answers "how many times have we hit this" — which is the
   * number that decides whether a plan should avoid the wall rather than walk into it.
   */
  record({ signature = '', prompt = '', cause = '', fix = '', runId = '', provider = '' } = {}) {
    const key = signature || signatureOf({});
    const memory = this.read();
    const existing = memory.failures.find((item) => item.signature === key);
    const now = new Date().toISOString();
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeen = now;
      existing.lastRunId = flat(runId, 60);
      // A later diagnosis that actually says something replaces silence, but never
      // overwrites an explanation that has already been proven by a resolution.
      if (cause && (!existing.cause || !existing.resolved)) existing.cause = flat(cause, 400);
      if (fix && (!existing.fix || !existing.resolved)) existing.fix = flat(fix, 400);
      this.write(memory);
      return existing;
    }
    const entry = {
      signature: key,
      terms: keywords(prompt),
      summary: flat(prompt, 120),
      cause: flat(cause, 400),
      fix: flat(fix, 400),
      provider: flat(provider, 40),
      occurrences: 1,
      // Nothing has been learned from this remedy yet, and that is a fact worth
      // storing rather than a zero to infer later.
      resolved: false,
      outcomes: { worked: 0, failed: 0 },
      firstSeen: now, lastSeen: now, lastRunId: flat(runId, 60),
    };
    memory.failures.push(entry);
    this.write(memory);
    return entry;
  }

  /**
   * What happened to the run that carried this remedy.
   *
   * Separate from record() because they answer different questions: record() says the
   * failure occurred, this says whether the fix for it was any good. Without this the
   * file would grow confident advice that has never once been checked.
   */
  resolve({ signature = '', ok = false } = {}) {
    const memory = this.read();
    const entry = memory.failures.find((item) => item.signature === signature);
    if (!entry) return null;
    entry.outcomes = entry.outcomes || { worked: 0, failed: 0 };
    entry.outcomes[ok ? 'worked' : 'failed'] += 1;
    if (ok) entry.resolved = true;
    this.write(memory);
    return entry;
  }

  /** The walls hit most often, for the doctor. */
  top(count = 5) {
    return this.read().failures
      .slice()
      .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0))
      .slice(0, Math.max(0, count));
  }
}

module.exports = { FailureMemory, signatureOf };
