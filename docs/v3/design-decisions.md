# Design decisions — accumulated

The owner asked (2026-08-04, while away) that minor decisions be settled by discussing
them with the local Pi rather than waiting, and that every one be **recorded here** so the
data accumulates and real runs get more accurate instead of re-deciding the same thing.

Rules for this file:
- One row per decision. **Who decided** is part of the record: `owner` outranks `pi`,
  and `pi` decisions are provisional — the owner can overturn any of them cheaply.
- Anything with a security, money, or data-loss consequence is **not** minor and does not
  belong here; it waits for the owner.
- A decision with no reason is not a decision. The reason column is required.

| # | Date | Decision | Who | Reason |
|---|---|---|---|---|
| 1 | 2026-08-04 | Canvas becomes the conversation window; Console is retired **last**, only after Canvas proves it carries approvals, work steps, artifacts and the terminal | owner | One window. Two surfaces that both talk is what made the app confusing |
| 2 | 2026-08-04 | The menu-bar window stays resident — no hide-on-blur — and remembers where it was dragged | owner | A window that vanishes when you click elsewhere cannot be moved anywhere useful |
| 3 | 2026-08-04 | Telemetry (`ev/min`, fleet, relay, logs) goes behind a ⚡詳細 drawer, default off | owner | "数字や表示が多くてわかりにくい" |
| 4 | 2026-08-04 | Default theme is `paper` (#faf9f5), modern and simple; `studio` (the cosmic look) is **kept** as a choice, not deleted | owner | Owner asked to drop the space feel from the conversation surface, not to destroy the existing design |
| 5 | 2026-08-04 | Themes are **two**, not three. `slate` was drafted and dropped | claude | It was `paper` + `colorScheme: dark` under a second name. settings-store.js's own comment already says design language and light/dark are two different questions |
| 6 | 2026-08-04 | The light/dark escape hatch attribute is renamed `data-color-scheme`; `data-theme` now carries the design language | claude | Both were called `data-theme`. Latent collision — one would have silently shadowed the other |
| 7 | 2026-08-04 | With an empty conversation, the particle field stays **fully visible at low opacity** rather than hiding until first message | pi | An empty thread over a still field reads as sterile; a faint field is depth, not distraction. Provisional — overturn freely |
| 8 | 2026-08-04 | Particle "gravity" must be **additive on top of** the deterministic hash-seeded position, bounded (lerp ≤ 0.3) | docs/v3/06-rendering.md §3.3 | Deterministic placement is what gives the owner spatial memory of their own vault. Replacing it makes the universe unrecognisable between runs |
| 9 | 2026-08-04 | Particle motion moves into the **vertex shader**; the per-frame JS loop goes | claude | `synapse.js:424-429` integrates every file on the CPU every frame. Stardust already does it on the GPU for 30k points, so the pattern exists in-repo |
| 10 | 2026-08-04 | The particle design knowledge goes into `product-design/references/particle-fields.md`, not a new skill | claude | The owner's own rule, recorded in `skill-registry.js` CATEGORIES: one skill per category, and UI work folds into the big existing one |
| 11 | 2026-08-04 | Per-agent progress has **no denominator**: running agents get an indeterminate gauge plus a count of finished steps, only terminal ones get a filled bar, `—` ≠ 0. The one real fraction (assignments finished / planned) sits in the card header | claude | A provider never announces how many tools it will use. Same rule as `progressOf()` and `pricing.js` |
| 12 | 2026-08-04 | The particle motion becomes a bounded rotation about each file's **real parent-folder hub**, GPU-integrated | claude | `synapse.js:424-429` integrated every file on the CPU every frame. Superseded in part by #13 — on a disc the rotation is in-plane about the disc axis |
| 13 | 2026-08-05 | Each cloud becomes a **flat spiral disc**: arm = folder (categorical, assigned from sorted keys), radius = depth then recency (continuous). **Every particle moved once** | owner | 「全粒子の表示動かしても構いません。しっかり繋がりがわかるようにシナプスの固まりを表してください」. Overrides the "do not move placement" half of #8; the deterministic half stands — the new positions are still seeded from the path and never drift |
| 14 | 2026-08-05 | The console window is **retired**. Every owner-facing door — tray button, tray menu, ⌥⇧Space, the app menu's Settings — goes through one `openWorkspace()` and lands on the Canvas. The renderer is kept and reachable with `BIGKIJI_CONSOLE=1` | claude, on owner decision #1 | The condition #1 set was met and measured: the Canvas carries the approval gate, the per-agent work steps, the changed-file list and the terminal. Keeping the code costs nothing and makes the retirement an env var to undo rather than a revert |
| 15 | 2026-08-05 | On `paper`, four HUD layers — `#views`, `#popups`, `#crawl`, `#workState` — hide, and ⚡詳細 brings them all back. Studio keeps them | claude | Decision #3, applied to the layers a screenshot found still narrating over the conversation. `#workState` also **contradicted** the header: it means "a bus event arrived within 5 s", the header means "a run is executing", and they were six inches apart reading as one fact |
| 16 | 2026-08-05 | When a limit takes a provider out, the work is handed on in **one** order: **Claude → Codex → GLM → Gemini → Qwen**. Written as a list, and the five chains derived from it | owner | 「リミットがかかった場合のaiの優先順位はClaude,codex,glm,gemini,qwenの順番に選ばれるようにしてください」. The hand-written chains disagreed with each other — `claude-code` tried GLM before Codex while `codex` tried Claude before GLM — and **none of them reached Gemini**, so an exhausted Claude and Codex went past a working Gemini straight to the local model. Decision #16 does not overturn the 2026-08-03 rule that a local failure is the floor: Qwen is last, and `qwen: []` stands |

## Open, waiting on the owner

| Question | Why it is not minor |
|---|---|
| Does the synapse show at all on the paper theme, or only on studio? | Needs a screenshot judgement. If the inverted field reads as dirt rather than a faint line drawing, the answer changes the whole look of the default theme |
| ~~Should each cloud become a flat spiral disc?~~ | **Answered 2026-08-05 by the owner: yes.** 「全粒子の表示動かしても構いません」. Decision #13 below |
| ~~Should a transient `model-unavailable` mark the model unusable?~~ | **Answered 2026-08-05 — see "Answered since" at the foot of this file.** |

## Measured facts worth not rediscovering

- `pi` accepts both `qwen3.5:35b-a3b` and `ollama/qwen3.5:35b-a3b`. The `Model not found`
  seen at 13:28 was **transient**, not a name bug — an early diagnosis that said otherwise
  was wrong and was reverted.
- BKU's skill registry indexes **119** skills. Selection runs on SKILL.md frontmatter, not
  on `references/*`, so knowledge added as a reference file needs its trigger words added
  to the description or it is never selected.
- Short Japanese UI queries select **nothing**: 「ボタンのホバーを磨きたい」 → no skill,
  while the same request with more words selects `product-design`. `pruneCommonTerms()`
  leaves that skill only 16 distinguishing grams. Not yet fixed.
- The file galaxy runs at **120 fps, perfStage 0**, with **2176 particles for 2176 files**
  (measured through `window.bkGalaxyProbe()`, added 2026-08-04). Particle count has
  equalled file count all along; the defect was the motion, not the binding.
- The flow edges were **not** fabricated. An earlier note in
  `product-design/references/particle-fields.md` said the `Math.random()` in the edge
  builder meant the lines were fictional; the random draw only picks *which* real edge
  carries a light, and both endpoints are a file and its own parent. Corrected in the
  skill. The real defect was that the sample differed on every launch — seeded now.
- **An inline `style` attribute silently discards the stylesheet rule that fights it.**
  `<div id="views" style="…display:flex…">` meant `:root[data-theme="paper"] #views
  { display: none }` had never once taken effect, so the LOD chips sat on the
  conversation for the whole life of the paper theme while the file read as if they
  did not. `tools/contrast-selftest.js` fails on that shape now — same class as the
  undefined `var()` guard, and as the per-frame writer that was overwriting a label's
  opacity: the code says one thing, the cascade says another, and only a screenshot
  disagrees.
- `onBeforeCompile` on a Three.js material **requires `customProgramCacheKey`** here:
  four PointsMaterials in synapse.js share identical parameters, and without a distinct
  key the hub material can be given the leaf material's program and lose its attributes.

## The 2026-08-05 real-behaviour pass — what driving it actually found

Run in a real pty (`node-pty`, the CLI under `/bin/sh tools/bigkiji`) and a real Electron
window, because none of this is visible to `npm test`.

| # | Checked | Result |
|---|---|---|
| 1 | `/runs` lists what waits | `runs(0 waiting)` · `nothing is waiting for approval` |
| 2 | default mode is `ask` | footer reads `mode: ask` on a cold start |
| 3 | modes do not loosen from the LAN | `effectiveMode` (daemon-selftest) — loopback only |
| 4 | five state questions in a row are never answered by a model | **4 of 5.** 「承認待ちはありますか？」 fell through — fixed |
| 5 | the footer survives 63 columns | compact chips, meter, both rules and the mode row all intact |
| 6 | Ctrl-C | clean exit — `\e[?2004l\e[r` restores the scroll region |
| 7 | the GUI approval carries role, question and reads | screenshot: hashes + rev, ⚠未回答, ⚠下調べ 0/2, per-provider reads |
| 8 | `task:step` reaches the work card | 4 rows; the running agent's cat animates, the waiting one's is `paused` |
| 9 | a run's changed files are listed | `変更したファイル 2 · main.html +61 −4 · App.jsx +24 −6` |

Two defects came out of it, both invisible to the suite and both now guarded:

- **The footer said `failed` before the owner had asked for anything.** `phase` was the
  newest run's status whether or not it had finished, so an earlier session's failure
  greeted every new REPL — while `/runs` on the same screen said `0 waiting`. A finished
  run is history, not a phase; with nothing live the word is `IDLE`.
- **「承認待ちはありますか？」 was handed to the model.** The daemon already knows the
  answer exactly. Asking a model to report state is the bet that produced 「順調に進んで
  います」 over two untouched runs.

## Building a game from the CLI — what actually happened (2026-08-05)

The owner asked for a three.js mini game built **from the BigKiji terminal**, finished.
Driven in a real pty, `run-msenli4v`, ~5 minutes, 3 specialists:

| Specialist | Provider | Wrote |
|---|---|---|
| leader · lead-pi | codex gpt-5.6-sol · 125 s · 245k tok | `game.js` |
| ui · design-pi | codex gpt-5.6-sol · 123 s · 140k tok | `index.html`, `app.css` |
| debug · debug-pi | glm-4.7-flash · 20 s | read-only diagnosis |

**It works.** *BigKiji · Garden Patrol* — a cat in a garden, WASD/arrows to move,
pointer to aim, Space or click to fire, purple shadows closing in. Measured in a real
browser: **120 fps**, zero console errors, score climbs, health falls, game over shows
`Patrol again`, restart returns to 0/100 and the next round scores again.

Three things worth keeping:

- **Write-isolated runs are never auto-merged, by design.** Each specialist worked in
  its own `git worktree` and the coordinator keeps the worktree rather than applying it
  (`forgetRun`, "that work is the only copy of it and the owner has not looked at it
  yet"). The two halves had to be assembled by hand — and they fitted exactly, because
  every `getElementById` in the leader's `game.js` had a matching `id` in the ui's
  `index.html`. That is the DOM contract the debug lens verified.
- **The game shipped unwinnable, and arithmetic proved it before any play-test could.**
  Bullets spawn at `muzzleOffset.y = 1.1` and their velocity is `aim.clone().setY(0)`,
  so `y` never changes; enemies sit at `y = 0.5`; the hit test is a 3D
  `distanceTo(...) < 0.55`. A vertical gap of **0.6 against a radius of 0.55** means no
  shot can ever connect, however well aimed. Measured first: 14 seconds firing in every
  direction, score 0, health 0. Told this, BKU's own planner came back with the right
  one-line constraint — `muzzleOffset y を 0.5 に変更` — which is what was applied.
  Verified after: score 0 → 20 → 30, peak 30, restart scores again.
- **A "did it finish?" test must read a status field, not search the transcript.** Two
  driver versions stopped live runs early: one matched the words `run report` inside a
  specialist's grep of `run-report-selftest.js`, the other watched a footer field that
  disappears when the run ends. Searching output for a status is the same mistake as
  asking a model for one — the answer is somewhere in the text whether or not it is true.

### The approval loop — solved, and it was not the approval gate

`run-mseo84pl` was approved twice and came back to `AWAITING_APPROVAL` both times. The
unanswered question in the plan was a red herring. The cause, read out of the run's own
stderr:

```
{"type":"error","message":"You've hit your usage limit. Upgrade to Pro …"}   ← codex
"Claude usage limit reached. Your limit will reset at …"                      ← claude-code
```

`classifyFailure` returned **`''`** for both — measured, not assumed. Neither phrasing
contains the word `quota` or a `429`, and `QUOTA_PATTERN` had no pattern for the sentence
the two subscription CLIs actually send. Unclassified means:

1. the circuit breaker never opens on a spent allowance;
2. the router keeps assigning work to a provider that cannot run it;
3. every failure costs a **repair cycle** — and a repair cycle falls back to a different
   provider, which is a different disclosure, which by contract asks the owner to
   approve again.

So the owner saw an approval loop. What it was, was one unmatched sentence. The repair
cycle re-asking is **correct** and stays: a new provider must not inherit consent given
for a different one.

Fixed in `model-router.js` with the same tightness as everything else in that pattern —
the limit has to be a *usage* limit, and `tools/circuit-breaker-selftest.js` now pins
both the real messages and five ordinary sentences containing "limit" that must still be
penalised.

### The hand-off order, measured

Driven through the real coordinator with the real limit messages, each classified the
way `task-runner.js` classifies them before the breaker sees them:

```
claude-code  limit → quota        hands to codex
codex        limit → quota        hands to glm
glm          limit → rate-limit   hands to gemini
gemini       limit → quota        hands to qwen
```

Adding Gemini to every chain exposed a second gap, fixed in the same change:
`_fallback` filtered candidates on the **breaker only**, while `_pick` filtered on the
breaker, `isAvailable` and the owner's paid allowlist. A chain could therefore hand the
role to a provider with no key — which fails, costs a repair cycle, and asks the owner to
approve again. Harmless while the chains were short and never mentioned Gemini; Gemini is
the provider most likely to have no key on a given machine, so the owner's order would
have hit it on the first outage.

### Who may approve, and how the demo runs unattended

Nothing new was built for this: `effectiveMode` already answers it. Loopback — the CLI
and the Electron window, running as the owner on the owner's machine — gets the mode it
asks for; anything arriving over the LAN is forced to `plan` and waits for a human,
because the daemon listens on `0.0.0.0` and a token must not be able to buy unattended
writes. **Requesting a mode is not the same as being allowed one.**

For the demo the CLI is set to `auto-edit` (`~/BigKijiUniverse/state/cli-config.json`),
which is the only mode that releases a writing run without stopping. **shift+tab** cycles
`ask → auto-edit → plan`, so it is one keystroke back to asking.

## Answered since (2026-08-05)

| Question | Answer | Who |
|---|---|---|
| Should a transient `model-unavailable` mark the model unusable in the capability registry? | **No, not on the first sighting.** It is recorded without a penalty and the same model is retried once; only a second failure of the same provider+model in one run is scored. `transient` is an explicit argument rather than adding the reason to `THROTTLED`, because a model that really is gone still has to be learned | claude |

---

## Two records exist, and they are not the same thing (2026-08-07, owner)

`~/BigKijiUniverse/reports/report-*.md` is the Electron app's report: Japanese, written
for the owner, one per GUI run, and it covers tokens, savings and a screenshot. It is
called from `src/core/main.js` only — daemon runs never produced one, which is why that
folder held two files five days old.

`docs/v3/run-ledger.md` is the ledger: English, written for an external coding agent,
one per **daemon** run, and it covers the prompt as given, what shipped, and the gap
between them. Its job is to make the generated prompts improvable from evidence.

Keep both. Different reader, different language, different question.
