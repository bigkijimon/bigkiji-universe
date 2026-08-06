# BigKiji Universe

Version 2.5.0 · Apache-2.0 · Electron desktop app

BigKiji Universe is a menu-bar-resident Electron app that orchestrates external AI coding
CLIs — Claude Code, Codex, Gemini, GLM and a local Ollama/Qwen model — through a local
supervising agent (PiAgent). Every external run is planned locally, pruned to a small
sandbox-scoped context, sealed into a disclosure manifest, and started only after the owner
approves that exact manifest.

Alongside the orchestrator the app ships a Three.js canvas that renders the real files and
relationships PiAgent is working on, an integrated terminal (`node-pty` + `@xterm/xterm`),
a loopback daemon, and a standalone `bigkiji` CLI/TUI that attaches to the same daemon.

On macOS the app hides its dock icon and lives in the menu bar (`app.dock.hide()` in
`src/core/main.js`). Windows and Linux build targets exist in `package.json`, and CI runs
the suite on all three — green on Windows and Linux. The tray-resident behaviour, the cmux
bridge and the zsh launcher are macOS-specific, and the app itself has not been run on
Windows ([docs/known-issues.md](docs/known-issues.md)).

---

## Requirements

| | |
|---|---|
| Node | `>=24 <27` (`package.json` `engines`; `.nvmrc` pins 24) |
| Electron | `^43.2.0` (devDependency; 43.2.0 resolved in this tree) |
| Runtime dependencies | `three ^0.172.0`, `@xterm/xterm ^5.5.0`, `@xterm/addon-fit ^0.10.0`, `node-pty ^1.0.0`, `ws ^8.21.0`, `qrcode ^1.5.4`, `dotenv ^16.6.1`, `dotenv-expand ^11.0.7` |
| Build tooling | `electron-builder ^26.15.3`, `@electron/rebuild ^4.2.0` |
| Native toolchain | needed only to rebuild `node-pty`; if the rebuild fails the app falls back to pipe-mode terminals and says so in the event log |

### External CLIs

BigKiji does not bundle any model or CLI. It shells out to whatever is already installed.
Every one of these is optional — a provider you never approve is never spawned. The exact
argv is in `adapter()` in `src/domain/pi-agent/task-runner.js`.

| Provider id | Executable | Override | Notes |
|---|---|---|---|
| `claude`, `claude-code` | `claude` | `CLAUDE_BIN` | run with `--strict-mcp-config`, an empty MCP config, a generated settings file and `--disallowed-tools WebSearch,WebFetch,mcp__.*` |
| `codex` | `codex` | `CODEX_BIN` | `exec --ephemeral --ignore-user-config --strict-config -c web_search="disabled" -c shell_environment_policy.inherit="none"` |
| `gemini` | `gemini` | `GEMINI_BIN` | `--sandbox` plus a generated admin-policy TOML that denies web search, web fetch and shell |
| `glm` | `pi` | `PI_BIN` | `pi --print --model zai/<flagship> --no-tools --no-extensions --no-skills --no-context-files` |
| `qwen`, `ollama` | `ollama` | `OLLAMA_BIN` | `ollama run <model> <prompt>`; model from `BIGKIJI_QWEN_MODEL`, default `qwen3.5:35b-a3b` |

Without Ollama, local conversation degrades to a deterministic classifier rather than
failing (`src/domain/pi-core/conversation-engine.js`). Other optional integrations —
ComfyUI, n8n, Obsidian, Graphify, ACE-Step, LTX-2, cmux, Tailscale, whisper — are detected,
never installed. See [Tool connections](#tool-connections).

---

## Install and run

```bash
git clone git@github.com:bigkijimon/bigkiji-universe.git
cd bigkiji-universe/app
npm install          # postinstall runs electron-rebuild -f -w node-pty
cp .env.example .env # optional; every key may be left blank
npm start            # electron .
```

```bash
npm run dev          # electron . --show-main — opens the main window immediately
```

Smoke test — boots the app headlessly, checks the tray, both renderers and the PTY mode,
prints one `SMOKE OK` / `SMOKE FAIL` line and exits after ~4 s:

```bash
SMOKE=1 npx electron .
```

## Test

```bash
npm test
```

`npm test` runs all **61** `test:*` scripts in sequence (`test:architecture`,
`test:security`, `test:routing`, `test:deliberation`, `test:assets`, `test:context`,
`test:pi-core`, `test:daemon`, `test:workspaces`, `test:tools`, `test:ui-3d`,
`test:cli-render`, … — see the `scripts` block of `package.json`). Every declared
`test:*` script is reachable from `npm test`; none are orphaned. Individual suites can be
run directly, e.g. `npm run test:security`.

Each one is a plain Node script under `tools/` with no test framework, and prints a single
line naming what it checked.

CI (`.github/workflows/ci.yml`) runs `npm ci && npm test` on macOS, Windows and Ubuntu, and
runs the Electron smoke test under `xvfb` on Ubuntu. Windows, Linux and the smoke run are
green; the macOS leg is intermittently torn down by the runner before it can finish, which
is measured and written up in [docs/known-issues.md](docs/known-issues.md).

---

## Data layout

`src/core/data-root.js` is the single source of truth for where the app keeps its own state.
It is pure Node — the Electron main process, the daemon and the CLI all load it.

Resolution order, highest priority first:

1. `BIGKIJI_DATA_ROOT` — explicit override, and also how Electron tells child processes
2. `<userData>/data-root.json` — pointer written by the first-run wizard
3. `~/BigKijiUniverse` — the default

The data root is a **visible directory in your home folder**, not a hidden application
directory. Under it:

```
<data root>/
  bigkiji-data.json          root marker
  state/                     system_memory.json, remote.json, daemon.pid,
                             mobile-devices.json, cli-config.json
  sessions/  ideas/  logs/  reports/  knowledge/
  recordings/  generated-media/  cache/tts/  models/  migrations/
```

Only settings and secrets stay in the Electron `userData` directory
(`~/Library/Application Support/bigkiji-universe` on macOS): `settings.json`,
`secrets.enc.json` (encrypted with Electron `safeStorage`), the `data-root.json` pointer,
`setup-state.json`, and `workspaces.json`.

### First run

`setupStatus()` treats `setup-state.json` — not the existence of the data root — as the
"already configured" marker, so a half-failed migration does not strand you outside the
wizard. `BIGKIJI_SKIP_SETUP=1`, `SMOKE` or `SNAP` suppress it.

The wizard (`src/components/UI/setup.html`) asks four things: where the data root goes,
how existing data should get there, which Obsidian vault to read, and then shows the plan
before doing anything. The move step is skipped entirely on a fresh install.

Two modes:

- **Move** — a real relocation. `src/core/data-migrator.js` renames within a volume and
  copies → verifies (sha256, sampled above 32 MB) → deletes across volumes. The source is
  deleted strictly last, which is what makes `rollbackMigration()` possible.
- **Reference** — nothing moves. The pointer records where each root already lives, via
  per-key `overrides` in `dataLayout()`.

Local model blobs are a separate opt-in checkbox, off by default; the wizard warns that
moving the TTS virtualenv breaks it because virtualenvs store absolute paths.
`src/core/migration-plan.js` is a whitelist, not "move `~/.bigkiji`", so unrelated shell
scripts in that directory are left alone.

---

## Workspaces

`src/core/workspace-registry.js` holds the flat list of folders BigKiji may read and edit.

- **Explicit registration only.** There is no parent-directory auto-scan. `candidates()`
  proposes directories for the setup UI, but a proposal is never a registration.
- **The registry lives in `userData`**, never inside the folders it points at, so it
  survives one of them being deleted or unmounted.
- **Overlapping roots are refused.** `register()` throws `Overlaps an existing workspace`
  if a new root nests inside an existing one or contains it. Re-registering the same path
  is an update, not an overlap.
- **A vanished root is reported, not repaired.** `statusOf()` returns `ok`, `unreadable`
  (EPERM/EACCES — re-grant access) or `missing` (ENOENT — re-pick). Nothing is silently
  re-pointed.
- **Per-root exclusions from the start.** Default: `node_modules`, `.git`, `.next`, `dist`,
  `build`, `graphify-out`, `_archive`, `recordings`, `venv`, `.venv`, `__pycache__`, `Pods`.
- `allows(path)` is the single question anything that scans or edits should ask.
- macOS security-scoped bookmarks are stored opaquely per root (`bookmark`), captured by
  the main process at pick time.

Developer override:

```bash
BIGKIJI_WORKSPACES=~/code/project-a,~/code/project-b npm start
```

When set it **replaces** the registry entirely, so a test run cannot mutate the real one.

---

## Security model

Source: `src/domain/pi-core/security/` and `src/domain/pi-agent/sandbox-policy.js`.

**Sandbox policy resolution.** `SandboxPolicyResolver.resolve(cwd)` walks up from the task
directory to the vault root looking for `.pi/sandbox.json` (or `sandbox.json`). A cwd
outside the vault, or invalid JSON, returns `valid: false` and the run is blocked. Read and
write roots are canonicalised through `realpath`, dropped if they escape the vault, and
dropped if they match the sensitive-path patterns (`.env*`, `.ssh`, `.aws`, `.gnupg`,
`secrets`, `credentials`, `*.pem`/`*.key`/`*.p12`, …) — that filter is not configurable
from the file. Declared paid providers are intersected with the built-in allowlist
(`claude`, `claude-code`, `codex`, `gemini`, `glm`).

```json
{
  "filesystem": {
    "allowRead":  ["./src", "./tools", "./docs"],
    "allowWrite": ["./src", "./tools"]
  },
  "models": { "allowPaid": ["claude-code", "codex", "gemini", "glm"] }
}
```

**Per-run disclosure manifest.** Before a provider can start, `createDisclosureManifest()`
builds a v2 manifest containing: `runId`, provider, **model id**, purpose, every included
file with its line ranges and **sha256**, redaction counts by type, every brokered external
tool query verbatim, estimated tokens, the payload hash, and the policy hash. The whole
document is hashed into `disclosureHash`.

`approve(id, { disclosureHash })` rejects a hash that does not match (`STALE_DISCLOSURE_HASH`).
At launch, `start()` re-checks all of it and refuses on `STALE_SECURITY_POLICY`,
`STALE_DISCLOSURE_MANIFEST` (a file changed on disk since approval) or `STALE_MODEL_SELECTION`
(re-tiering between approval and launch would run a model the owner never saw).

**Payload redaction.** `redactPayload()` replaces private keys, Anthropic/OpenAI/Google/
GitHub/Slack/AWS/Z.ai keys, JWTs, `Authorization` headers, named secrets, emails and phone
numbers with `<REDACTED:type>` markers. Vendor-specific patterns run before the generic
`sk-` pattern so a finding is labelled with the provider it belongs to. A private key is
`critical`: it throws `SECURITY_CRITICAL_SECRET_IN_CONTEXT` rather than being redacted and
sent. The same redactor runs over provider stdout/stderr — a critical hit kills the child.

**Tool interceptor.** `ToolInterceptor.decide()` is installed for Claude Code as a
`PreToolUse` hook (`hook-entry.js`) and mirrored by per-provider policy files. It denies
every web tool and every `mcp__*` tool, asserts read/write paths against the sandbox, and
allows shell only for commands matching the policy allowlist (`npm test|run …`,
`node --check`, `tsc --noEmit`, `git status|diff|log|show`, `rg`) — with pipes, redirects,
command substitution and any networking binary (`curl`, `wget`, `ssh`, `nc`, …) rejected
outright. An unrecognised tool name is denied, not allowed.

**Research broker.** `ResearchBroker` is the only sanctioned network path. A specialist that
needs a fact asks for it as a request; the broker sanitises the query (strips code fences,
replaces paths with `<PATH>`, redacts secrets, rejects anything code-shaped or containing a
path) and the surviving string is written into the manifest by name — so the owner approves
the exact string that would leave the machine. One blocked query blocks the whole task
rather than being silently dropped.

**Minimal-env child spawning.** `SecurityPolicy.createRuntime()` makes a private temp root
with its own `home` and `tmp` (mode `0700`). `minimalEnv()` builds the child environment
from scratch — `PATH`, locale, `TERM`, the isolated `HOME`/`TMPDIR`/XDG dirs, the policy
file path, and **only that provider's credential** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `ZAI_API_KEY`). The runtime directory is deleted when the task finishes.

**What this does not claim.** These are process- and policy-level controls. They constrain
what a cooperating CLI can reach; they are not a proof against an OS- or provider-level
vulnerability.

---

## Orchestration

`CoreExecutionCoordinator` (`src/domain/pi-agent/core-execution-coordinator.js`) selects
roles per run from a fixed blueprint and wakes only the ones a prompt actually needs:

| Role | Agent | Provider | Writes |
|---|---|---|---|
| facilitator | Facilitator-Pi | gemini | no |
| leader | Lead-Pi | claude-code | yes |
| ui | Design-Pi | codex | yes |
| debug | Debug-Pi | glm | no |
| context | Context-Pi | qwen | no |

`TaskRunner` runs at most 5 tasks in parallel and queues the rest. Providers are spawned
per run and never kept resident.

`ContextPruner` scores files inside the sandbox's read roots against terms from the prompt
(optionally seeded by a Graphify `graph.json`), then includes only ±24-line slices around
matching lines. Defaults: 10 files / 48 000 chars / 12 000 tokens for external providers,
7 / 32 000 / 8 192 for local Qwen.

`LocalQwenGuardrails` caps the local model at 6 144 context tokens normally, 4 096 when
degraded, 8 192 hard, with a 60 s per-task timeout.

**On token savings:** `prepare()` reports `fullContextTokens`, `prunedContextTokens` and
`tokensSaved` with `measurement: 'estimated'` — both sides are a character-class heuristic
(`estimateTokens()`), not a tokenizer. `prunedContextTokens` is upgraded to
`measurement: 'actual'` only when a provider's stream reports real input token counts
(`captureUsage()` in `task-runner.js`); `fullContextTokens` always stays an estimate.
**There is no benchmark in this repository, so no reduction ratio or speed-up factor is
claimed here.**

---

## Tool connections

`src/domain/pi-agent/tool-registry.js` detects and connects tools that are already on the
machine. Nothing is bundled, copied or installed — model weights and virtualenvs run to
gigabytes, so the app only remembers where you already put them.

Two separate questions, deliberately never collapsed:

- `detectAll()` — "is it here, and where?" Synchronous, `statSync` only, so opening
  Settings is instant.
- `probe()` — "is it answering right now?" Asynchronous, always resolves, always bounded
  (1 200 ms default).

Three states: `missing` (nothing at the resolved path), `found` (installed, health not
verified) and `connected` (a health check ran and answered). A status is never promoted
without evidence.

| Tool | Kind | Health check |
|---|---|---|
| ComfyUI | directory | `GET /system_stats` on 127.0.0.1:8000 or :8188 |
| ACE-Step | directory | any HTTP answer on 127.0.0.1:8001 |
| LTX-2 | directory | none — it is a batch job, not a resident server |
| Ollama | binary | `GET /api/tags` on 127.0.0.1:11434 |
| n8n | directory | `GET /healthz` on 127.0.0.1:5678 |
| Obsidian vault | directory | `.obsidian/` marker; read-only to BigKiji, never written, never moved |
| Graphify CLI | binary | `graphify --version` |
| Graphify `graph.json` | file | parsed asynchronously; refused above 128 MB |
| GPU arbitration script | binary | none — presence on disk is all that is claimed |

Resolution order per tool: environment override → saved setting → conventional install
paths → `PATH` (for binaries). An explicitly configured path that no longer exists reports
`missing` instead of silently falling back.

---

## Terminal, daemon and CLI

The renderer's terminal uses `@xterm/xterm` over `node-pty` in the main process. If the
native rebuild is unavailable the app degrades to pipe mode and logs
`node-pty unavailable — running in pipe mode`.

`package.json` registers one binary implementation under four aliases — `bigkiji`,
`Bigkiji`, `kiji`, `Kiji` — all resolving to `tools/bigkiji`, a zsh wrapper around
`src/domain/terminal/bigkiji-cli.js`.

```bash
bigkiji                 # interactive REPL; starts the daemon if it is not running
bigkiji status          # or `fleet` — print daemon/fleet state
bigkiji monitor         # or `tui` — live ANSI monitor
bigkiji hud             # launch the Electron GUI and attach to the same daemon
bigkiji resume          # pick a JSONL-backed session
bigkiji reload          # reload local PiAgent hooks
bigkiji "some prompt"   # one-shot turn
```

REPL commands: `/help`, `/status`, `/mode ask|auto-edit|plan`, `/setting`, `/resume`,
`/reload`, `/ideas`, `/idea plan|enhance|send|adopt|archive <id>`, `/run …`, `/hud`,
`/abort`, `/clear`, `/exit`.

The daemon binds `127.0.0.1:8777`. Bind address, port and the auth token live in
`<data root>/state/remote.json`, created with mode `0600` on first start. Sessions are
JSONL under `<data root>/sessions/`.

The same daemon serves the phone UI (`src/components/UI/remote/mobile.html`) and the
generated-media routes:

| Route | Behaviour |
| --- | --- |
| `GET /api/assets` | Index of `<data root>/generated-media`, newest first, media files only |
| `GET /assets/<name>` | Serves one file. Authenticated; content type comes from a fixed extension map (an unmapped extension is `415`, never a guess); the resolved path must be inside the media root, so `..` in either raw or percent-encoded form is `403` |
| Range | `206` with `Content-Range`, including open-ended (`bytes=4000-`) and suffix (`bytes=-64`) forms, `416` when unsatisfiable, and `HEAD` for size probes. Without this Safari will not play a video at all |

The service worker deliberately does not cache `/assets/` or any ranged request:
answering a range out of the Cache API returns `200` with the whole body and breaks
playback. `tools/assets-route-selftest.js` pins all of the above.

---

## Configuration

`.env` in the app directory is loaded through `dotenv` + `dotenv-expand` at startup.
API keys can instead be stored from Settings via Electron `safeStorage`.

### Read by the app

| Variable | Effect |
|---|---|
| `BIGKIJI_DATA_ROOT` | Overrides the data root; skips the pointer file entirely |
| `BIGKIJI_KNOWLEDGE_ROOT` | Knowledge root (`KNOWLEDGE_ROOT` accepted as an alias; the prefixed name wins) |
| `BIGKIJI_VAULT_ROOT` | Explicit Obsidian vault root |
| `BIGKIJI_WORKSPACES` | Comma-separated absolute paths; replaces the workspace registry |
| `BIGKIJI_SKIP_SETUP` | `1` suppresses the first-run wizard |
| `BIGKIJI_SHOW_MAIN` | `1` opens the main window at launch (same as `--show-main`) |
| `BIGKIJI_AUTOHEAL` | `0` disables automatic tool self-repair after repeated failures |
| `BIGKIJI_SWARM` | `0` disables swarm dispatch in the task cache |
| `BIGKIJI_QWEN_MODEL` | Local Ollama model for tasks and guardrails (default `qwen3.5:35b-a3b`) |
| `BIGKIJI_CONVERSATION_MODEL` | Local conversation model (default `qwen3.5:latest`) |
| `BIGKIJI_OLLAMA_ENDPOINT` | Conversation endpoint (default `http://127.0.0.1:11434`) |
| `BIGKIJI_CLAUDE_MODEL` | Claude model id for general work (default `claude-opus-5`) |
| `BIGKIJI_CLAUDE_DESIGN_MODEL` | Claude model id for design work (default `claude-fable-5`) |
| `BIGKIJI_GLM_MODEL` | GLM flagship model id (default `glm-5.2`) |
| `BIGKIJI_GLM_FLASH_MODEL` | GLM flash model id (default `glm-4.7-flash`) |
| `BIGKIJI_SLOW_TASK_MS` | Threshold above which a task counts as slow when learning routing (default 180000) |
| `BIGKIJI_GPU_SIGNAL` | Path to the GPU arbitration script |
| `BIGKIJI_TTS_IDLE_MS` | Idle timeout before the TTS process is released (minimum 15000, default 60000) |
| `BIGKIJI_CLI_ASCII` | `1` forces ASCII glyphs in the CLI transcript |
| `BIGKIJI_CLI_CAT` | Selects the CLI loading sprite frame set |
| `BIGKIJI_BUILD_ID` | Overrides the displayed build id (defaults to `v<version>`) |
| `BIGKIJI_APP_PATH` | Path to a packaged `BigKiji Universe.app` for `bigkiji hud` |
| `BIGKIJI_E2E_FIXTURE` | Loads a fixture for end-to-end runs |

Non-prefixed variables also read by the code: `CLAUDE_BIN`, `CODEX_BIN`, `GEMINI_BIN`,
`PI_BIN`, `OLLAMA_BIN`, `CMUX_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`, `COMFYUI_ROOT`,
`ACESTEP_ROOT` / `ACE_STEP_ROOT`, `LTX2_ROOT`, `N8N_ROOT`, `GRAPHIFY_BIN`,
`GRAPHIFY_GRAPH_PATH`, `KNOWLEDGE_ROOT`, `APP_ROOT`, `UI_ROOT`, and the four provider keys
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY`.

### Set by the app, not by you

`BIGKIJI_SECURITY_POLICY` (policy file path, read by the PreToolUse hook), `BIGKIJI_EXECUTOR`
(provider marker in the child env), `BIGKIJI_WORKSPACE` and `BIGKIJI_DAEMON_PARENT` (passed
to the spawned daemon), `BIGKIJI_TTS_FILE` / `BIGKIJI_TTS_TEXT` (Windows SAPI fallback),
`BIGKIJI_CANARY_SECRET` (used only by `tools/security-selftest.js`).

> `.env.example` still lists `BIGKIJI_DAEMON_PORT`. **No code reads it** — the daemon port
> comes from `<data root>/state/remote.json`.

---

## Build

```bash
npm run dist            # node tools/build-host.js — build for the current host
npm run dist:mac        # dmg + zip, arm64 + x64, notarised via the BigKijiNotary profile
npm run dist:win        # nsis + zip, x64 + arm64
npm run dist:linux      # AppImage + deb, x64 + arm64
npm run dist:local      # unsigned/self-signed .app directory for local testing
npm run verify:release  # node tools/verify-macos-release.js
```

macOS release builds set `hardenedRuntime`, `forceCodeSigning` and `notarize` in
`package.json`, so a missing Developer ID certificate is a build failure rather than a
skipped step. `asar` is disabled and `three/examples/jsm` is copied in as an extra resource
because the 3D canvas loads Three.js addons over `file://` as ES modules.

---

## Status

Honest list of what is not settled:

- **Context-saving figures are estimates.** `measurement: 'estimated'` is the default and
  `fullContextTokens` is never measured. No benchmark exists in this repository, so no
  percentage reduction or speed-up multiple is stated anywhere in this README.
- **No published performance numbers.** There is no `bench/` directory and no timing
  harness beyond the pass/fail selftests.
- **Platform coverage is uneven.** Menu-bar residency (`app.dock.hide`) and the cmux bridge
  are macOS-only. The `bigkiji` launcher is a zsh script, so the CLI aliases assume a
  POSIX shell with zsh available.
- **Windows runs the suite green, but is otherwise unexercised.** All 62 selftests pass on
  windows-latest as of 2026-08-06. Getting there fixed six defects that had been invisible
  while CI could only run on macOS — two of them real product bugs, including a sandbox check
  that compared 8.3 short names against expanded ones and so refused every read inside the
  sandbox. See [docs/known-issues.md](docs/known-issues.md). That is the test suite, not the
  application: the tray-resident behaviour, the cmux bridge and the zsh launcher are still
  macOS-only, and nobody has run the app itself on Windows for real.
- **Not published to a registry.** `package.json` sets `"private": true`; install from a
  clone.
- **The macOS CI leg is flaky, and it is not this code.** Windows, Linux and the Electron
  smoke run pass. The macOS job is sent SIGTERM from outside three to four seconds into
  `test:daemon`, at unremarkable memory, while another leg runs the identical code to
  completion — the selftest instruments itself under CI and says so. Written up in
  [docs/known-issues.md](docs/known-issues.md) rather than left for you to discover.
- **No release badges.** No external status, coverage or package service is configured
  for this repository, so none is linked here.

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for
setup and the check you are expected to run. Vulnerabilities go through
[SECURITY.md](SECURITY.md), not the public issue tracker. Participation is under
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Support

This is free, runs entirely on your own machine, and has no paid tier. Nothing in
it phones home and nothing is metered — the compute you spend is your own.

There is no support link here yet — the one that was here pointed at a GitHub
Sponsors page that is not enabled, which is worse than none. When there is a real
one it will go in `.github/FUNDING.yml` and appear as the repository's Sponsor
button rather than as a badge in this file.

Whatever that ends up being, it will be a donation and not a purchase: no feature
behind it, no priority queue, no tier. Nothing is withheld from anyone who does
not pay.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
