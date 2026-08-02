# 10 — Performance

Status: V3 design. This document is governed by the app's own constitution,
`src/domain/pi-core/system-instructions.md:31` (rule 25):

> "State a number only if it was measured. Say 'not measured' otherwise, and never
> quote a reduction ratio that has no benchmark behind it."

Accordingly, every number below is labeled **measured** (with method and file:line),
**estimated** (heuristic, not a measurement), or **target** (an intention, `not
measured`). No target in §6 has been achieved, because none has been measured.

## 1. What is actually measured today

These instrumentation points exist in the code and produce real timings at runtime:

| Metric | Where | Notes |
|---|---|---|
| Pi turn statistics | `src/core/main.js:741-742` (`pi.turnStats()`) | per-turn stats pulled after each Pi reply |
| Tool round-trip start | `src/core/main.js:817` (`toolT0.set(evt.toolName, Date.now())`) | paired with tool-end events for per-tool latency |
| Fast-path latency | `src/domain/pi-agent/fast-api-router.js:56` (start), `:60` (cache hit), `:80` (clarification), `:89` (final `latencyMs`) | wall-clock per request |
| Conversation turn latency | `src/domain/pi-core/conversation-engine.js:153` (start), `:200` (`latencyMs` in output) | wall-clock per turn |
| Conversation TTFT | `conversation-engine.js:183-186` (`ttftMs` on first streamed chunk), emitted at `:200` | `null` means "not measured", never zero (comment at `:198-199`) |
| TTS synthesis time | `src/core/natural-tts-service.js:176-181` (`latencyMs`, `synthesisMs`) | per synthesis call |
| Time to first audio playback | `src/components/UI/audio-engine.js:142` (`firstAudioMs`) | request-to-audible, measured in the renderer |
| Voice SLA check | `src/core/main.js:1344-1349` | `firstAudioMs` compared against `audio.firstSpeechDeadlineMs` (default 30000ms fallback at `:1348`) |
| Per-model latency EWMA | `src/domain/pi-agent/model-capability-registry.js:95-114` | EWMA updated only when `durationMs > 0` (`:104-106`) |
| Local Qwen degradation | `src/domain/pi-agent/local-qwen-guardrails.js:14-24` | degraded when 2 consecutive timeouts, or last-3 average exceeds `max(15000ms, 1.8 × baseline)` (`:20`) |
| Model warm-up time | `src/domain/pi-agent/model-router.js:143-163` (`warmModel()` returns measured `ms`) | invoked from `daemon.js:330` |

What is *not* yet done with these: none of them are aggregated into persisted
distributions (p50/p95). They are per-event values, mostly consumed live or folded
into an EWMA. §7 addresses this.

## 2. Measured results from 2026-08-02 (this machine, single runs)

Method: `warmModel()` (`model-router.js:143`) issues an empty-prompt generate call so
Ollama loads the weights and the call returns the measured duration; residency was then
confirmed with `ollama ps`, isolating model-load time from generation time. Cold =
model not resident; warm = confirmed resident.

| Model | Not resident | Resident |
|---|---|---|
| `qwen2.5:0.5b` | 723 ms | 139 ms |
| `qwen3.5:latest` | 4160 ms | 260 ms |

**This pair does not describe the conversation path.** Neither side sent `num_ctx`, so
it measures the raw cost of loading weights and nothing more. Ollama keys a loaded
instance on its runtime options, which produced a second measurement worth more than
the first — on `qwen3.5:latest`, timing a load probe that always used `num_ctx: 4096`:

| Warmup performed | Next `num_ctx: 4096` request |
|---|---|
| without `options` | 3450 ms — full reload; the warmup accomplished nothing |
| with `options: { num_ctx: 4096 }` | 254 ms — genuinely resident |

The first version of the warmup shipped without passing `num_ctx` and therefore warmed
an instance the conversation never used, while still reporting success. It was
corrected the same day.

End to end on the model the app actually runs (`qwen2.5:0.5b`, `num_ctx: 4096`), cold
versus warmed with matching options:

| | TTFT | Total turn |
|---|---|---|
| Cold | 799 ms | 1016 ms |
| Warm | 189 ms | 503 ms |

All of the above are **single runs on one machine**. They are sufficient to show that
residency dominates local setup time, that a warmup must request the options the turn
will use, and that warming is worth doing. They are not sufficient to characterize a
distribution, and none of them should be quoted as a benchmark.

## 3. What is estimated, not measured

- **Token counts are heuristics, not tokenizer output.** `estimateTokens()` counts
  ASCII chars ÷ 4 plus wide chars ÷ 1.5 (`src/domain/pi-agent/context-pruner.js:98-102`).
  Both context-preparation paths honestly tag their metrics
  `measurement: 'estimated'` (`context-pruner.js:104`, `:119`).
- **Daemon conversation output tokens are `reply.length / 4`**
  (`src/domain/server/daemon.js:245`) — a display estimate, not a count.

## 4. The single promotion path to "actual" — and its unfilled denominator

Exactly one code path can upgrade an estimate to a measurement:
`captureUsage()` (`src/domain/pi-agent/task-runner.js:295-308`, called at `:181`)
parses provider stream-JSON for `input_tokens` / `output_tokens` and, when found, sets
`task.context.measurement = 'actual'` and recomputes `tokensSaved` against real input
tokens (`:303-306`).

**Honest status: no stored run has been observed with `measurement: 'actual'`.** The
plumbing exists; the promotion has not happened in practice yet. Consequently the
**token-reduction ratio has no benchmark denominator** — any "X% tokens saved" claim
today would violate rule 25. The V3 target in §6 stays `not measured` until actual
usage records exist.

## 5. TTFT status by path

- **Measured (one path)**: the conversation engine streams (`stream: true`,
  `conversation-engine.js:175-176`) and records `ttftMs` at the first streamed chunk
  (`:183-186`). `ttftMs: null` explicitly means the turn produced no stream (fallback
  or single-piece response) — null is "not measured", never zero (`:198-199`).
- **Not measurable (other paths)**: the fast-path router
  (`fast-api-router.js:37`) and the task cache (`src/domain/pi-agent/task-cache.js:67`)
  call Ollama with `stream: false`, so a first token does not exist as an observable
  event there. Any TTFT figure quoted for these paths would be fiction.

No TTFT distribution has been collected yet on any path.

## 6. Prerequisite: the learning-loop bug (fixed 2026-08-02)

Performance design on top of the model router was meaningless until this was fixed,
and the fix is part of this document's story.

**Observed corruption**: the capability registry held 207 samples across 6 providers
with **0 successes, 207 failures, and every latency = 0**. Three compounding causes:

1. `blocked` outcomes — sandbox denial, missing credential, owner interruption — were
   recorded as *provider failures*, though the provider never got a chance to fail
   (acknowledged in the code: `model-capability-registry.js:37`).
2. None of those four blocked paths ever set a start timestamp, so every recorded
   `durationMs` was 0.
3. The scorer read an EWMA of 0 as "fastest possible" and awarded a full latency
   bonus — the corrupted rows outscored honest ones.

**Fixes now in code**: blocked outcomes are excluded from provider stats; EWMA only
updates when `durationMs > 0` (`model-capability-registry.js:104-106`); a repair pass
resets rows that show samples with zero successes and zero EWMA — the exact corruption
signature (`:50`).

**Measured effect of the fix**: the leader score for `claude-code` moved from 0.28 to
1.000 and `codex` from 0.279 to 0.780 (recomputed on the repaired data, 2026-08-02).

**Implication**: routing-level performance targets (which provider is fast, when to
fall back) are only as good as this data. History before 2026-08-02 is unusable;
distributions start accumulating from the fix onward.

## 7. V3 targets — every one is a target, none is measured

| # | Target | How it will be measured | Current status |
|---|---|---|---|
| T1 | TTFT ≤ 500 ms (warm, local conversation) | `ttftMs` from `conversation-engine.js:200`, aggregated to p50/p95 over ≥100 turns; "warm" defined as model resident per `ollama ps` immediately before the turn; warm/cold labeled per sample | **not measured** (mechanism exists on one path; no distribution collected) |
| T2 | Watcher event → state update ≤ 20 ms | wrap the vault watcher handler: `Date.now()` at fs event receipt vs. state-store commit; log deltas to the perf journal; report p95 | **not measured** (no instrumentation exists yet) |
| T3 | Graph/universe update ≤ 16 ms (one 60 fps frame) | renderer-side: `requestAnimationFrame` delta around scene mutation + `PerformanceObserver` long-task entries during graph updates; report worst frame and p95 | **not measured** |
| T4 | Local search ≤ 50 ms | instrument the search entry point with wall-clock timing over a fixed representative query set (≥50 queries), run cold and warm; report p95 | **not measured** |
| T5 | Token reduction ≥ 80% | requires §4's `measurement: 'actual'` samples: ratio = `tokensSaved / fullContextTokens` with `prunedContextTokens` replaced by provider-reported input tokens; report per-provider medians | **not measured** — currently blocked: no 'actual' sample exists, so the ratio has no denominator |
| T6 | Cache hit rate ≥ 90% | hit/miss counters at every cache decision point, persisted, reported over a rolling window of ≥200 lookups | **not measured** — partially blocked: `task-cache.js` counts per-entry `hits` (`:141`, initialized `:187`) but records no misses, so a rate cannot be computed until miss counting is added |

Rules for this table going forward:

- A target moves to "met" only with a stated dataset (N, date, machine, warm/cold) —
  never from a single anecdote.
- If an instrument doesn't exist (T2, T3, T4, T6-misses), building it precedes any
  claim. An unmeasurable target is treated as failing, not as passing.

## 8. Measurement infrastructure to build (design)

1. **Perf journal**: append-only JSONL (`{ts, metric, value, unit, warm, provider,
   model, runId}`) written from the existing instrumentation points in §1 — they
   already compute the numbers; today the numbers are dropped after display.
2. **Percentile reporting**: a small aggregator over the journal producing p50/p95/max
   per metric per day. No new dependencies required.
3. **Warm/cold labeling**: every local-model timing carries residency state (via
   `ollama ps` or the `keep_alive` bookkeeping) — in §2's two samples the regimes
   differ by roughly 5× and 16×, so unlabeled aggregates would be meaningless.
4. **Actual-token capture watch**: alert when a provider run parses zero usage tokens
   (`captureUsage` found nothing), so the T5 denominator gap is visible instead of
   silent.

## 9. Caveats

- All measurements are from one machine (the owner's Mac). No cross-device claims are
  made or implied.
- §2 numbers are single runs; they justify the warm-up mechanism, not a latency SLA.
- The estimator (§3) remains useful for budgeting context *before* a call; it must
  never be quoted as a savings result. The tags `estimated` / `actual` in the metrics
  objects exist precisely so downstream displays can keep the distinction.
