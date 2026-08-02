# V3 Architecture — 03. Local AI Boot: Progressive Boot, Warm Start, Hidden Warmup, TTFT

Status: design specification (2026-08-02).
Discipline: per `src/domain/pi-core/system-instructions.md:31` (Article 25), numbers are
stated only when measured; measured numbers carry their method, targets are labelled
`target`, unknowns are `not measured`. Claims about current code carry `file:line`.

---

## 1. Current boot path (as-is, verified)

Runtime: Ollama 0.30.8, called over HTTP (`/api/generate`) from four sites, plus one
CLI call site for heavy on-demand planning (`ollama run`, `src/domain/pi-agent/task-runner.js:290-291`).

Boot sequence today:

1. `app.whenReady()` (`src/core/main.js:1460`) → daemon ensured (`:1467`) →
   `configureConversation(settingsStore.get().conversation)` (`main.js:1470`).
2. `DaemonEngine.configureConversation()` (`src/domain/server/daemon.js:306-315`)
   applies the **saved** model — overwriting the engine default at `daemon.js:307` —
   then calls `warmConversation()` (`:313`).
3. `warmConversation()` (`daemon.js:326-340`) fires `warmModel(model, { keepAlive: -1 })`
   (`:330`) without awaiting it, and publishes `CONVERSATION_WARM` /
   `CONVERSATION_WARM_FAILED` with the measured `warmupMs` (`:334-335`).
4. `warmModel()` (`src/domain/pi-agent/model-router.js:143-162`) POSTs an **empty
   prompt** to `/api/generate` (`:153`) so Ollama loads the weights, discards the
   answer, and returns `{model, ok, ms, error}` — measurable, injectable
   (`fetchImpl`, `endpoint` parameters, `:143-144`), and never throws (`:158-161`).

Steps 2–4 were implemented on 2026-08-02. Before that, warmup was written and exported
but never called, so every first turn after launch paid the full cold load
(`model-router.js:135-138`, comment records this history).

### 1.1 The model configuration contradiction (design issue, must be resolved)

- The engine default is `qwen3.5:latest` (`src/domain/pi-core/conversation-engine.js:79`).
- The comment directly above it records that `qwen2.5:0.5b` is **insufficient for
  conversation quality** — goal-parroting and broken sentences, measured 2026-08-02
  (`conversation-engine.js:77-78`).
- Yet the running system uses the **saved setting `qwen2.5:0.5b`**, because
  `main.js:1470` pushes saved settings and `daemon.js:307` overwrites the engine
  default. The tier table also still declares `qwen2.5:0.5b` as the resident chat
  model (`model-router.js:51`).

So the code's own measurement says the model that actually serves conversation is not
good enough, and the better default is dead configuration.

**The obvious resolution — migrate the saved setting to `qwen3.5:latest` — was tested
on 2026-08-02 and does not work.** That model is a reasoning model: it streams
`thinking` content with an empty `response` field, and with `num_predict: 650`
(`conversation-engine.js:128`) it spends the whole budget deliberating and never emits
the answer. Every turn came back `degraded: true` with
`Local conversation model returned invalid JSON`. Switching the setting today would
not improve conversation quality; it would remove conversation.

**V3 resolution, restated:** the resident conversation model must be chosen by
measuring candidates against this path, not by trusting either default. Whatever is
chosen, the tier table (`model-router.js:50-54`) and the settings store must stop being
able to disagree silently — one source of truth, not two. Concretely the choice needs a
model that (a) answers without a reasoning preamble, or (b) is given a `num_predict`
budget that accounts for thinking tokens and a parser that ignores them. Until that
work is done, `qwen2.5:0.5b` remains resident *because it is the only configuration
verified to answer at all*, and its quality limitation stands as a known defect rather
than a settled choice.

## 2. Definitions

| Term | Definition in this spec |
|---|---|
| **Cold start** | First `/api/generate` for a model not resident in VRAM; includes weight load. |
| **Warm start** | Request against a model already resident (`ollama ps` shows it loaded). |
| **Hidden Warmup Prompt** | An empty-prompt generate call issued by the system, never shown to the owner, whose only purpose is weight loading (`model-router.js:152-154`). |
| **TTFT** (time to first token) | T2 − T0 below. **Only defined for streaming responses.** |
| **TTFA** (time to full answer) | T3 − T0. This is what the app can measure today. |

## 3. Warm Start — measured results

All figures below were measured on 2026-08-02 on the development Mac. They are single
runs, not averaged: treat them as evidence that an effect exists and roughly how large
it is, not as a benchmark.

### 3.1 A warmup must request the options the turn will use

Ollama keys a loaded instance on its runtime options. Warming a model without the
`num_ctx` the conversation will ask for loads one instance, and the first real request
unloads it and loads another. The warmup reports success either way, so this failure is
invisible from the outside.

Measured on `qwen3.5:latest`, timing a second load probe that always used
`num_ctx: 4096`:

| Warmup performed | Next `num_ctx: 4096` request |
|---|---|
| without `options` | 3450 ms — full reload, warmup wasted |
| with `options: { num_ctx: 4096 }` | 254 ms — genuinely resident |

`warmConversation()` therefore passes `this.conversation.maxContextTokens` and keys its
dedupe on `model::num_ctx`, not on the model alone (`daemon.js`).

### 3.2 End-to-end effect on the configured model

`qwen2.5:0.5b` with `num_ctx: 4096` — the model the app actually runs, since settings
override the engine default at startup (see §6). Cold means evicted with `keep_alive: 0`;
warm means `warmModel()` with matching options immediately beforehand.

| | TTFT | Total turn |
|---|---|---|
| Cold | 799 ms | 1016 ms |
| Warm | 189 ms | 503 ms |

### 3.3 Load time in isolation

Measured separately, with residency confirmed by `ollama ps` between runs and **no
`num_ctx` on either side** — an internally consistent pair that does not describe the
conversation path, and is recorded only to show the raw cost of loading weights:

| Model | Not resident | Resident |
|---|---|---|
| `qwen2.5:0.5b` | 723 ms | 139 ms |
| `qwen3.5:latest` | 4160 ms | 260 ms |

Interpretation, tied to code:

- `ConversationEngine.turn()` treats `timeoutMs = 8000` as a **stall** deadline — the
  longest silence tolerated between chunks — with `maxTurnMs` as a hard ceiling. Before
  streaming it was the budget for the whole turn, so a model that was generating
  correctly but slowly lost everything it had produced and the owner received the
  deterministic fallback with `degraded:true` for a turn that had not failed.
- Warmup is fire-and-forget and deduplicated per `model::num_ctx`
  (`warmedModel`/`warming` guards), so repeated `configureConversation` calls do not
  stack requests. A failed warmup is published, not retried: the next turn loads the
  model anyway.

## 4. Hidden Warmup Prompt — contract

1. **Payload:** empty `prompt`, target `keep_alive` (`model-router.js:153`). An empty
   prompt is sufficient for Ollama to load weights; no tokens of owner content are
   sent, so no redaction pass is needed.
2. **Invisibility:** the response body is discarded; the owner-visible artifact is only
   the `knowledge` event with `warmupMs` (`daemon.js:334-335`). The UI may show the
   *measured* number; it must not show an invented progress percentage (Article 25).
3. **Failure:** returns `{ok:false, error}` — reported once, not retried
   (`daemon.js:324-325` comment: the next real turn loads the model anyway).
4. **Timeout:** default 180000 ms (`model-router.js:143`), abort surfaces as
   `warmup timeout after <ms>ms` (`:160`).

## 5. TTFT — definition, and why it does not exist today

Measurement points for one conversation turn:

```
T0  owner submit (renderer)
T1  /api/generate request written            (conversation-engine.js:125)
T2  first response token received            ← ONLY exists with stream:true
T3  full JSON body parsed                    (conversation-engine.js:129-130)
T4  reply rendered (onDelta → UI)            (conversation-engine.js:138)
```

**Before 2026-08-02, all four HTTP Ollama call sites used `stream:false` with
`format:'json'`:**

- `conversation-engine.js` (conversation turns) — **now streaming, see §5.1**
- `fast-api-router.js:37` (facilitator) — still `stream:false`
- `task-cache.js:67-68` (swarm lenses) — still `stream:false`
- `local-qwen-guardrails.js:40` (reset probe) — still `stream:false`

Each of those three consumes a complete JSON object and has no owner-visible latency,
so streaming would buy instrumentation nobody reads. They stay as they are, and this is
a decision rather than an oversight.

Until the conversation path was changed, the process waited for the complete JSON
object and **the event "first token" never occurred in this app** — grep for `ttft` /
`firstToken` over `src/` returned 0 hits. Any TTFT figure quoted for a build before
that date would be fiction.

### 5.1 V3 position on streaming

`format:'json'` exists because the conversation contract is a parsed JSON object
(`kind`/`reply`/knowledge fields, `conversation-engine.js:110-111`) — partial JSON is
not renderable as-is. Options considered:

1. **Keep `stream:false`** and report TTFA honestly. Zero risk; no perceived-latency
   win.
2. **`stream:true` retained per token, buffered until parseable** — enables a real T2
   for *instrumentation* (TTFT metric, spinner→thinking transition) even though the
   reply still renders at T3.
3. Split the response into a streamed `reply` and a second structured call — rejected:
   doubles model calls on a machine where the GPU is a contended resource.

**V3 adopted option 2 for the conversation path only, and it is implemented**
(2026-08-02). Rendering behavior is unchanged — `onDelta` still fires once with the
finished reply, so no consumer of the daemon's `pi` delta channel had to change. What
changed is what the app can see and what a deadline is allowed to mean:

- `ttftMs` is recorded per turn and is **`null`, never `0`, when nothing was streamed**
  (a fallback answer, or a body delivered in one piece). Zero would assert an instant
  first token that never happened.
- `timeoutMs` is now the **stall** deadline — the longest silence tolerated between
  chunks — with `maxTurnMs` as a hard ceiling. Previously it bounded the whole turn, so
  a model generating correctly but slowly lost every token it had produced.
- **Any chunk counts as a sign of life, including reasoning tokens.** A model streaming
  `thinking` with an empty `response` is working, not silent; counting only answer
  tokens would abort exactly the models that take the longest to start answering.

Measured on `qwen2.5:0.5b` at `num_ctx: 4096` (see §3.2): TTFT 799 ms cold, 189 ms
warm. Single runs on one machine, not a benchmark.

## 6. Progressive Boot — synchronize, do not invent

### 6.1 Existing boot theater (do not duplicate)

The 3D canvas already has a seven-phase core awakening
(`src/domain/3d-canvas/components/synapse.js:667-680`):
`dormant → foreshock → infall → detonation → capture → steady → ringmorph → finale`,
with fixed durations `SEQ = {foreshock:900, infall:2600, detonation:430, capture:1400, finale:800}` ms
(`synapse.js:671`), entered via `triggerCoreAwakening()` (`:714`), with a
reduced-motion path that skips straight to `capture` (`:724-726`).

**V3 rule: Progressive Boot reuses this sequence and synchronizes it to real backend
events. No second boot animation is built.**

### 6.2 Event mapping

```mermaid
sequenceDiagram
    participant M as main.js (app.whenReady, :1460)
    participant D as daemon.js
    participant O as Ollama
    participant C as 3D canvas (synapse.js)
    M->>D: ensure() + configureConversation (main.js:1470)
    Note over C: dormant → foreshock (boot began)
    D->>O: warmModel — Hidden Warmup Prompt (daemon.js:330, model-router.js:153)
    Note over C: infall (weights loading; real work in flight)
    O-->>D: warmup response with measured ms
    D-->>C: knowledge event CONVERSATION_WARM, warmupMs (daemon.js:334-335)
    Note over C: detonation → capture (warm confirmed; show measured warmupMs)
    Note over C: steady (idle universe; conversation ready)
```

| Boot stage | Backing real event | Canvas phase |
|---|---|---|
| Process up, daemon ensured | `daemonClient.ensure()` resolves (`main.js:1467`) | `dormant → foreshock` |
| Warmup in flight | `warmConversation()` fired (`daemon.js:330`) | `infall` |
| Model resident | `CONVERSATION_WARM` with measured `warmupMs` (`daemon.js:334-335`) | `detonation → capture` |
| Warmup failed | `CONVERSATION_WARM_FAILED` (`daemon.js:334`) | skip to `steady`, surface the error text — no celebratory detonation for a failure |
| Ready | conversation turn serveable | `steady` |

### 6.3 The timing mismatch (design consideration, stated honestly)

The animation's fixed pre-steady time is 900+2600+430+1400 = 5330 ms (`SEQ`,
`synapse.js:671`), while measured warmups are 139–723 ms for `qwen2.5:0.5b` and
260–4160 ms for `qwen3.5:latest` (§3). So the animation is usually *slower* than the
warm truth and can be *faster* than a cold heavy load. V3 resolution:

- Phases up to `infall` may start on schedule, but **`detonation` waits for the real
  `CONVERSATION_WARM` event** — the animation may stretch `infall`, never fake the
  finish.
- If warmup finishes before `infall` would, the phase may shorten toward a minimum
  (target minimum: `foreshock` intact for legibility; exact floor `not measured` /
  to be tuned visually).
- Displayed numbers come from `warmupMs` only. No synthetic percentages.

## 7. Boot latency budget

| Segment | Value | Status |
|---|---|---|
| Warm start, `qwen2.5:0.5b` | 139 ms | measured 2026-08-02 (§3) |
| Warm start, `qwen3.5:latest` | 260 ms | measured 2026-08-02 (§3) |
| Cold start, `qwen2.5:0.5b` | 723 ms | measured 2026-08-02 (§3) |
| Cold start, `qwen3.5:latest` | 4160 ms | measured 2026-08-02 (§3) |
| Electron ready → daemon ensured | — | not measured |
| First conversation TTFA after warm boot | — | not measured (recorded per turn at `conversation-engine.js:139`; needs aggregation) |
| TTFT (post §5.1 streaming change) | — | not measured (not yet implementable: no streaming path exists) |
| End-to-end "launch → first honest reply" | target: under the 8000 ms turn timeout with margin | target, not measured |

## 8. Open items

1. Resolve the resident-model contradiction (§1.1) before tuning anything else — every
   number in §3 and §7 depends on which model is actually resident.
2. Implement §5.1 option 2 to make TTFT a real, measured quantity.
3. Aggregate per-turn `latencyMs` into a boot report so §7's `not measured` rows can be
   filled from production data rather than one-off benchmarks.
4. Decide warmup policy for the on-demand heavy model (`qwen3.5:35b-a3b`,
   `model-router.js:53`, `keep_alive:0`): pre-warming it conflicts with the
   one-GPU-workload discipline, so any warmup must be gated on GPU idleness — policy
   `not designed yet`, explicitly out of scope here.
