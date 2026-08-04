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

## Answered since (2026-08-05)

| Question | Answer | Who |
|---|---|---|
| Should a transient `model-unavailable` mark the model unusable in the capability registry? | **No, not on the first sighting.** It is recorded without a penalty and the same model is retried once; only a second failure of the same provider+model in one run is scored. `transient` is an explicit argument rather than adding the reason to `THROTTLED`, because a model that really is gone still has to be learned | claude |

