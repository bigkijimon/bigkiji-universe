# BigKiji Universe v2.5 Master Initialization & Self-Evolution Directive

Execute in dependency order: data root resolution, local indexing, Local Qwen guardrails,
canonical daemon and cmux synchronization, UI/audio/mobile integration, then
approval-based self-correction.

## Invariants

- PiAgent is the local orchestration, context-pruning and approval layer.
- Port 8777 is the only canonical runtime for CLI, TUI, Electron and Mobile PWA.
- Claude, Codex, Gemini and GLM are the only paid providers. Local Qwen handles local
  preflight work. A provider that cannot start is not selected for a role.
- Providers remain stopped until selected and exit after their assignment.
- Mobile and desktop consume the same runs, sessions, telemetry and approval state.
- No mutation begins without explicit Owner approval of the current plan revision and
  hash. The approved hash covers the provider, the model tier, the files disclosed and
  every external query that would leave the machine.
- The app stores nothing in a location belonging to the person who built it.
  `src/core/data-root.js` resolves the data root; nothing else decides where state lives.
- BigKiji reads and edits only inside folders the Owner explicitly registered.

## Ordered execution

1. Resolve the data root (`BIGKIJI_DATA_ROOT` → `<userData>/data-root.json` → the
   default under the home directory) before requiring any module that computes a
   storage path at load time. Report an interrupted migration rather than starting a
   second one on top of it.
2. Generate and load `<data root>/state/system_memory.json`; reuse only memory whose
   structure hash is current.
3. Prune Local Qwen context to the relevant files and current directive, enforce the
   local token budget, split long work and reset degraded cache safely.
4. Attach every surface to the standalone daemon; avoid duplicate cmux monitors and
   duplicate HTTP listeners.
5. Keep the horizontal engineer-facing desktop layout, the device-GPU mobile graph and
   the low-fatigue voice policy. Pair mobile devices through Tailscale using expiring
   one-time codes. Serve generated media over the authenticated media route so what the
   Owner asked for is reachable from the phone that asked for it.
6. Deliberate before spending: for substantial work, or any work that drives a local
   tool, take independent proposals and merge them in code. Recall a merged plan for
   work already deliberated instead of paying for the same discussion again.
7. Let PiAgent diagnose and prepare diffs automatically, then stop at
   `AWAITING_OWNER_DIRECTIVE`. Accept, edit, reject and custom directives must work
   identically from desktop and paired mobile devices.
8. After approval, apply only sandbox-scoped edits, run focused tests, the full suite
   and smoke verification. On regression, stop and return a recovery proposal for a new
   approval.
9. Record what went badly at the moment it went badly: a slow or failed delegation
   penalises that provider and model for that role immediately, and the penalty decays
   on sustained recovery.

Report only measured activity and verification evidence. State a number only if it was
measured; say "not measured" otherwise. Never persist secrets, pairing credentials or
internal reasoning.
