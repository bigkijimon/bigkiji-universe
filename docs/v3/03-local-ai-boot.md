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
good enough, and the better default is dead configuration. **V3 resolution:** saved
settings must be migrated (or the settings default changed) so the resident
conversation model is the one the quality measurement endorses; the tier table
(`model-router.js:50-54`) and the settings store must not be allowed to disagree
silently. Until that migration runs, this spec treats "which model is resident" as an
open item, not a settled fact.

## 2. Definitions

| Term | Definition in this spec |
|---|---|
| **Cold start** | First `/api/generate` for a model not resident in VRAM; includes weight load. |
| **Warm start** | Request against a model already resident (`ollama ps` shows it loaded). |
| **Hidden Warmup Prompt** | An empty-prompt generate call issued by the system, never shown to the owner, whose only purpose is weight loading (`model-router.js:152-154`). |
| **TTFT** (time to first token) | T2 − T0 below. **Only defined for streaming responses.** |
| **TTFA** (time to full answer) | T3 − T0. This is what the app can measure today. |

## 3. Warm Start — measured results

Measured 2026-08-02 via `warmModel()`; method: load time isolated from generation,
residency confirmed with `ollama ps` before the warm measurement.

| Model | Cold (not resident) | Warm (resident) | Saving |
|---|---|---|---|
| `qwen2.5:0.5b` | 723 ms | 139 ms | 584 ms |
| `qwen3.5:latest` | 4160 ms | 260 ms | 3900 ms |

Interpretation, tied to code:

- `ConversationEngine.turn()` aborts at `timeoutMs = 8000`
  (`conversation-engine.js:80,:122`) and falls back to the deterministic reply with
  `degraded:true` (`:132-134`). A 4160 ms cold load consumes half that budget before
  generation begins — so a cold heavy model risks not "slow" but **wrong-path**
  answers. This is why warmup is a correctness feature, not a comfort feature
  (also recorded at `daemon.js:317-325` and `model-router.js:135-138`).
- Warmup is fire-and-forget and deduplicated per model (`daemon.js:328`,
  `warmedModel`/`warming` guards), so repeated `configureConversation` calls do not
  stack requests.

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

**Current fact: all four HTTP Ollama call sites use `stream:false` with
`format:'json'`:**

- `conversation-engine.js:127` (conversation turns)
- `fast-api-router.js:37` (facilitator)
- `task-cache.js:67-68` (swarm lenses)
- `local-qwen-guardrails.js:40` (reset probe)

The process waits for the complete JSON object; **the event "first token" never
occurs in this app.** Consistently, grep for `ttft` / `firstToken` over `src/`
returns 0 hits (verified 2026-08-02). Any "TTFT" figure quoted for the current build
would be fiction — the only honest latency today is TTFA: `latencyMs = T3-ish − T0`
recorded per turn at `conversation-engine.js:139`.

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

**V3 adopts option 2 for the conversation path only**, strictly as instrumentation:
TTFT becomes measurable (T2 − T0), rendering behavior is unchanged, and the 8000 ms
abort can distinguish "model loading/thinking" (no bytes yet) from "model rambling"
(bytes flowing). Expected TTFT values: `not measured` — measurement is the point of
the change.

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
