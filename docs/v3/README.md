# BigKiji Universe V3 — Architecture Design Specification

Written 2026-08-02 against commit `a571150`.

## If you were asked to improve the prompts

Read `run-ledger.md` in this folder, not the source. It is the English record of every
finished run: the prompt exactly as it was given, what actually shipped, the **gap**
between the two, and one line on what that implies for the prompt. `bigkiji ledger --gaps`
groups the repeats — a pattern seen once is an anecdote.

Proposals go in `prompt-improvements.md`. Do not edit `ROLE_BLUEPRINT` directly.

## The one rule this specification follows

**A number appears here only if it was measured.** Everything else is labelled `target`
or `not measured`. This is rule 25 of the app's own operating instructions
(`src/domain/pi-core/system-instructions.md`), applied to the document that describes
it. Where a figure comes from published research it carries its source; where it comes
from this machine it says so, and says it was a single run.

Several V3 requirements turned out to rest on things that do not exist in the codebase.
Those are named as absences with the grep that establishes them, rather than described
as if they were being extended.

## Decisions this specification is written under

| Question | Decision |
|---|---|
| Platform | **Hybrid.** Electron + Three.js stays the product; a SwiftUI helper owns Settings, notifications and permissions only. RealityKit and Metal are not adopted — see `06-rendering.md` and `07-native-shell.md` for why, and where the boundary would go. |
| Dependencies | **No new *runtime* dependencies.** Embeddings run over Ollama HTTP, vectors are `Float32Array` in a flat file. Amended 2026-08-03 by the owner for the console rebuild — see below. |
| Console renderer | **React + Vite, for that one window only.** The tray, the Synapse Canvas and the setup wizard stay plain scripts loaded by `<script src>`. |
| Embedding model | **bge-m3** — MIT, official Ollama, 100+ languages, 8K context. Pulled 2026-08-02. Before that no embedding model was installed at all and `/api/embed` refused every model. |
| MCP | **stdio and 127.0.0.1 only.** No external MCP servers, no OAuth 2.1, no Streamable HTTP. The `mcp__` denial for spawned providers stays. |
| A2A | **Not adopted.** |
| GraphRAG | **Not adopted** at this corpus size; BM25 + RRF + rerank instead. |

## Amendment — 2026-08-03, the console renderer

The original table said "No new npm dependencies" without qualification. The owner amended
it when the conversation window was rebuilt, having been shown both options and their
costs. Recorded here because this document's rule is that decisions carry their source.

**What changed.** `react`, `react-dom`, `vite` and `@vitejs/plugin-react` were added as
**devDependencies**. Vite bundles them into the built output, so they are not resolved from
`node_modules` at runtime and electron-builder does not package them.

**What did not change.** The shipped `dependencies` list is still the same eight packages
(`@xterm/*`, `three`, `node-pty`, `ws`, `dotenv`, `dotenv-expand`, `qrcode`). The app is
still `main: src/core/main.js` built by electron-builder, and the signing and notarisation
pipeline is untouched — Vite is used as a static output tool for one window, not as a build
system for the app. `electron-forge` and `electron-vite` were both declined for that reason.

**Scope.** `src/components/UI/console-app/` is the only React source in the repository.
`tray.html`, `main.html` and `setup.html` remain plain scripts, and shared code between them
(`markdown.js`, `settings-modal.js`, `xterm-theme.js`) is written so both worlds can load it:
a guarded dual export that works under `require()` and as a side-effect `import`.

## Contents

| Document | Covers |
|---|---|
| [00-overview.md](00-overview.md) | System architecture, component diagram, Local First priority chain, sequence and data flow |
| [01-agent-mesh.md](01-agent-mesh.md) | The current PiAgent against Blackboard / Actor / HTN / Planner-Executor-Critic, what to add and what to refuse |
| [02-knowledge-graph.md](02-knowledge-graph.md) | Living Knowledge Graph schema, File→Particle→Galaxy→Universe mapping, Watcher agents, search |
| [03-local-ai-boot.md](03-local-ai-boot.md) | Progressive boot, warm start, hidden warmup prompt, TTFT definition and measurement points |
| [04-gpu-scheduler.md](04-gpu-scheduler.md) | Adaptive GPU scheduler, and the honest mapping from "GPU %" to knobs that exist |
| [05-cache-layers.md](05-cache-layers.md) | Cache layers, the dependency-free vector store format, which layers are real and which are absent |
| [06-rendering.md](06-rendering.md) | Synapse physics, 2D ⇄ 3D transition, core energy, why RealityKit and Metal Compute are declined |
| [07-native-shell.md](07-native-shell.md) | The hybrid boundary, the SwiftUI helper's responsibilities, IPC, signing and distribution |
| [08-cli-gui.md](08-cli-gui.md) | Developer and Creator modes, tmux versus cmux, CLI structure |
| [09-security.md](09-security.md) | Security architecture, local-only MCP, disclosure manifests, repository separation |
| [10-performance.md](10-performance.md) | Performance targets, how each one is to be measured, and what is missing today |
| [11-plugins.md](11-plugins.md) | Plugin architecture |
| [12-stack-2026.md](12-stack-2026.md) | The 2026 landscape — MCP, A2A, Context Engineering, GraphRAG, semantic cache, embeddings — and what applies here |

## If the owner says BigKiji is answering nonsense

Read [gpu-freeze-and-zombie-runs-2026-08-09.md](gpu-freeze-and-zombie-runs-2026-08-09.md)
before reading any source. Three faults produced that complaint once, and only one of them
was in the conversation path: the local model was SIGSTOPped by `gpu-signal.sh` for a
render, a run from three days earlier was still checkpointing every ten minutes, and the
phase row and `/status` disagreed about that same run. It carries the commands to tell
which of the three is happening now.

## If the owner says nothing ever starts, or that they cannot see the work

Read [work-gate-2026-08-09.md](work-gate-2026-08-09.md). The complaint was
「まだ一度もまともに使えていない」 and the cause was two shut doors, not a bug: a request
phrased outside a fourteen-word lexicon was classified CHAT and started nothing — the same
sentence with 「ほしい」 in kana instead of 「欲しい」 did start work — and even when a run did
exist, a step showed `Edit foo.js +12 −3` and never the lines. It records the bargain that
opened the first door: the conversation model may now call a turn TASK, and a TASK it called
waits for one approval even under `auto-edit`. `tools/work-gate-selftest.js` fails if either
half of that is removed.

## Read these first if you are short on time

- `10-performance.md` — what is measured, what is estimated, and the gap between them.
- `01-agent-mesh.md` §"what we are not adopting" — the requirements that research argued against.
- `03-local-ai-boot.md` §1.1 — the conversation model is configured in two places that disagree, and the obvious fix was tested and makes things worse.
