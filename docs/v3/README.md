# BigKiji Universe V3 — Architecture Design Specification

Written 2026-08-02 against commit `a571150`.

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
| Dependencies | **No new npm dependencies.** Embeddings run over Ollama HTTP, vectors are `Float32Array` in a flat file. |
| Embedding model | **bge-m3** — MIT, official Ollama, 100+ languages, 8K context. Pulled 2026-08-02. Before that no embedding model was installed at all and `/api/embed` refused every model. |
| MCP | **stdio and 127.0.0.1 only.** No external MCP servers, no OAuth 2.1, no Streamable HTTP. The `mcp__` denial for spawned providers stays. |
| A2A | **Not adopted.** |
| GraphRAG | **Not adopted** at this corpus size; BM25 + RRF + rerank instead. |

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

## Read these first if you are short on time

- `10-performance.md` — what is measured, what is estimated, and the gap between them.
- `01-agent-mesh.md` §"what we are not adopting" — the requirements that research argued against.
- `03-local-ai-boot.md` §1.1 — the conversation model is configured in two places that disagree, and the obvious fix was tested and makes things worse.
