# BigKiji Universe v2.0 Master Initialization & Self-Evolution Directive

Execute in dependency order: local indexing, Local Qwen guardrails, canonical daemon and cmux synchronization, UI/audio/mobile integration, then approval-based self-correction.

## Invariants

- PiAgent is the local orchestration, context-pruning and approval layer.
- Port 8777 is the only canonical runtime for CLI, TUI, Electron and Mobile PWA.
- Claude, Codex, Gemini and GLM are the only paid providers. Local Qwen handles local preflight work.
- Providers remain stopped until selected and exit after their assignment.
- Mobile and desktop consume the same runs, sessions, telemetry and approval state.
- No mutation begins without explicit Owner approval of the current plan revision and hash.

## Ordered execution

1. Generate and load `~/.bigkiji/system_memory.json`; reuse only memory whose structure hash is current.
2. Prune Local Qwen context to the relevant files and current directive, enforce the local token budget, split long work and reset degraded cache safely.
3. Attach every surface to the standalone daemon; avoid duplicate cmux monitors and duplicate HTTP listeners.
4. Keep the floating transparent desktop design, device-GPU mobile graph and low-fatigue voice policy. Pair mobile devices through Tailscale using expiring one-time codes.
5. Let PiAgent diagnose and prepare diffs automatically, then stop at `AWAITING_OWNER_DIRECTIVE`. Accept, edit, reject and custom directives must work identically from desktop and paired mobile devices.
6. After approval, apply only sandbox-scoped edits, run focused tests, the full suite and smoke verification. On regression, stop and return a recovery proposal for a new approval.

Report only measured activity and verification evidence. Never persist secrets, pairing credentials or internal reasoning.

