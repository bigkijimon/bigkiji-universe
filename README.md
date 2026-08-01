# BigKiji Universe

BigKiji Universe is a local-first Electron command center that turns your files, AI agents, plans, and terminal sessions into an explorable 3D universe.

The central **Core Accretion Field** receives live data through curved synapse streams. Department and file clusters form an interactive force-directed graph, roadmap phases appear as illuminated gates, and Pi-Agents reduce context before any approved frontier model is called. The desktop also includes a two-track natural voice engine and, on macOS, a complete cmux control plane.

> Local planning, memory, context pruning, and speech use Qwen/Ollama. The only authorized paid execution providers are Claude, Codex, Gemini, and GLM.

Natural conversation is local-first too. A lightweight resident Qwen model handles chat and idea capture without waking paid models. Ideas begin as private Markdown drafts under `~/.bigkiji/ideas/`; adopting a draft, improving it with Gemini, or turning it into code always remains an explicit Owner action.

## What you get

- **3D Force Graph Canvas** — real Vault files, agent relationships, organic synapse strands, pointer zoom, focus and auto-camera modes.
- **Dynamic Phase Gates** — roadmap phases and status particles rendered as layered 3D planes.
- **Core Accretion Field** — curved inflow streams and genesis bursts visualize actual activity.
- **Active AI Models Fleet** — only real connected providers are shown; unused models stay asleep until PiAgent assigns an approved task.
- **Mission Relay + Multi-Terminal** — owner-visible commentary is separate from task streams and interactive terminals.
- **cmux Operations Index** — macOS workspace, tab, split, theme, color, SSH, VM, remote, diff, browser, agent, and advanced CLI controls. Destructive commands require confirmation.
- **Dynamic Voice Engine** — independent Owner and Agent tracks, local Qwen3-TTS, English by default, Japanese auto-detection, and thinking-log suppression.
- **Standalone daemon + CLI/TUI** — `bigkiji` auto-starts the local core on port 8777 and works before Electron is opened.
- **Optional Obsidian, Graphify, ComfyUI, and Tailscale-secured phone PWA integrations.**

## Requirements

- Git
- Node.js **24 LTS** and npm
- macOS 13+, Windows 10/11 64-bit, or a modern 64-bit Linux distribution
- Python 3.11+ only when running local Qwen3-TTS
- A working C/C++ toolchain may be required to rebuild `node-pty`

Optional tools:

- [Ollama](https://ollama.com/) for local Qwen planning
- [Graphify](https://github.com/Graphify-Labs/graphify) for code/knowledge graph synchronization
- [Obsidian](https://obsidian.md/) for Vault editing
- [cmux](https://cmux.com/) on macOS
- ComfyUI and whisper.cpp for local media and transcription

## Install

```bash
git clone https://github.com/bigkijimon/bigkiji-universe.git
cd bigkiji-universe
npm install
cp .env.example .env
npm start
```

`npm install` rebuilds `node-pty` for Electron. If the native rebuild is unavailable, BigKiji starts in pipe-terminal mode and explains the limitation in the event log.

For a development window that opens immediately:

```bash
npm run dev
```

## Configure your universe

BigKiji resolves paths in this order:

1. `.env`
2. values saved in **Settings → Models & API → Portable Data Paths**
3. OS-safe defaults

The default Vault is `~/Documents/BigKiji`. Existing installations with `~/Documents/CEOBigKiji` are detected automatically. Knowledge and generated runtime data live in Electron's per-user application-data directory.

Common `.env` settings:

```dotenv
BIGKIJI_VAULT_ROOT=/absolute/path/to/your/ObsidianVault
KNOWLEDGE_ROOT=/absolute/path/to/local/runtime/knowledge
GRAPHIFY_GRAPH_PATH=/absolute/path/to/your/ObsidianVault/graphify-out/graph.json
BIGKIJI_DAEMON_PORT=8777
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
ZAI_API_KEY=
```

Advanced portable deployments may also override `APP_ROOT` and `UI_ROOT`. `BIGKIJI_KNOWLEDGE_ROOT` and `KNOWLEDGE_ROOT` are equivalent; the prefixed name takes priority.

API keys can also be stored from the Settings UI using Electron's OS-encrypted credential storage. `OPENAI_API_KEY` is used for Codex execution only; BigKiji does not use paid OpenAI TTS or ElevenLabs.

### Settings UI

Open Settings with the HUD control or `Cmd/Ctrl + ,`.

- **Audio & Voices** — Owner/Agent volumes, attention cue, speech speed, Qwen voice profiles, previews.
- **Models & API** — approved provider credentials, Qwen timeout, Vault/Knowledge/Graphify paths.
- **Security** — live egress posture, disclosure seals, blocked actions, and policy hash.
- **cmux** — connection, themes, workspace colors, new terminals, splits, and the complete Operations Index.
- **Mobile** — Tailscale diagnostics, five-minute pairing QR codes, paired Owner devices, revocation, and PWA installation guidance.

Path changes apply after restart. Audio and most cmux changes apply immediately.

## Pi-Agent context routing

Before an external executor starts, BigKiji:

1. loads the closest `.pi/sandbox.json`;
2. rejects paths outside the configured Vault and blocked providers;
3. queries local Graphify data, or falls back to local text search;
4. includes only matching file slices;
5. redacts credentials and personal identifiers, then seals the selected paths and line ranges in a disclosure manifest;
6. waits for Owner approval of the exact revision, plan hash, disclosure hash, and policy hash;
7. emits `fullContextTokens`, `prunedContextTokens`, and `tokensSaved` to the Active AI Models Fleet HUD.

The daemon also maintains `~/.bigkiji/system_memory.json`, a secret-free structural index keyed by a source hash. Local Qwen receives at most 8,192 tokens (6,144 normally and 4,096 when degraded), and its work is split into short PiAgent-managed steps. Run `npm run index:memory` to inspect or refresh the index explicitly.

Example sandbox:

```json
{
  "filesystem": {
    "allowRead": ["~/Documents/BigKiji"],
    "allowWrite": ["~/Documents/BigKiji/projects/my-project"]
  },
  "models": {
    "allowPaid": ["claude", "codex", "gemini", "glm"]
  }
}
```

Invalid sandbox JSON, path traversal, symlink escape, sensitive file, stale disclosure, unknown tool, or a provider outside the allowlist fails closed before the provider process starts.

### Natural conversation and idea drafts

- Ordinary text uses `POST /api/turn`; `CHAT` replies naturally without creating an execution run.
- `IDEA` creates a private local Markdown draft. The repository stays unchanged until the Owner selects **Adopt**.
- `TASK` creates a local draft and a sealed execution plan. External models stay stopped until the exact plan and disclosure are approved.
- **Gemini polish** is a two-step action: review the payload hash and estimated tokens, then approve that exact draft. Gemini receives no repository files or web tools for this operation.
- CLI users can run `/ideas`, `/idea enhance`, `/idea send`, `/idea plan`, `/idea adopt`, and `/idea archive`. Use `/run …` for an explicit execution plan.

## Obsidian and Graphify

BigKiji never rewrites your `.obsidian` directory. Point `BIGKIJI_VAULT_ROOT` at an existing Vault or create a new folder.

Install the official Graphify package (`graphifyy` has two `y` characters; the command is `graphify`):

```bash
uv tool install graphifyy
cd /path/to/your/vault
graphify update .
```

Then set:

```dotenv
GRAPHIFY_GRAPH_PATH=/path/to/your/vault/graphify-out/graph.json
```

Graphify output is generated locally and is ignored by this repository. If `graph.json` is missing, BigKiji remains usable and shows a clear “Graphify graph not found” state.

## Terminal and cmux

The terminal area has separate views:

- **Neural** — Pi fleet and telemetry overview
- **Mission Relay** — live owner-visible agent commentary
- **Terminals** — interactive node-pty or cmux surfaces
- **Task streams** — independent Claude/GLM/Codex/Gemini process output

On macOS, install and start cmux, then set `CMUX_BIN` if it is not on `PATH`. The **Operations Index** exposes every cmux command as argv without invoking a shell. Commands that close, remove, log out, uninstall hooks, or delete VMs display the exact command and impact before execution.

Windows and Linux automatically use node-pty terminals; the rest of BigKiji remains available.

## Standalone `bigkiji` CLI, daemon, and sessions

`npm install` registers one canonical executable implementation. The command aliases `bigkiji`, `Bigkiji`, `kiji`, and `Kiji` all resolve to the same binary and state store.

```bash
bigkiji status       # starts the daemon automatically when needed
bigkiji              # interactive owner console
bigkiji monitor      # live TUI for cmux or any ANSI terminal
bigkiji hud          # open Electron and attach to the same daemon
bigkiji resume       # select a JSONL-backed session
bigkiji reload       # reload local PiAgent hooks/extensions
```

The daemon binds to `127.0.0.1:8777` by default. It stores private runtime credentials in `~/.bigkiji/remote.json` and session events in `~/.bigkiji/sessions/*.jsonl`. A submitted plan remains in `AWAITING_OWNER_DIRECTIVE`; external Claude, Codex, Gemini, or GLM processes are not started until the owner approves the exact current revision. Opening Electron later attaches to the existing daemon instead of spawning a second orchestration core.

## Small Window and phone access

Click the BigKiji menu-bar icon to open the transparent Small Window. Its four cards represent only the real execution surfaces: Claude, Codex, PiAgent, and Local Qwen. `OFFLINE` and `SLEEPING` are intentional zero-token states.

To connect an iPhone or Android device:

1. Install and sign in to Tailscale on the Mac and phone using the same tailnet.
2. Open **Settings → Mobile** and choose **Create 5-minute QR**.
3. BigKiji enables Tailscale Serve for the loopback daemon and creates a one-use pairing ticket. The daemon master token is never placed in the QR.
4. Scan the QR, pair the phone, then add **BigKiji Universe Mobile** to the Home Screen.
5. The paired PWA can send prompts, resume sessions, review the current plan and disclosure seals, hold to accept, edit, reject, or stop a run. Stale revisions, changed disclosures, and duplicate approvals are rejected by the daemon.

If Tailscale is logged out, Serve requires one-time tailnet approval, or the pairing ticket expires, Settings shows the exact recovery step and does not display a misleading live state. Paired phones can be revoked individually or all at once.
The mobile 3D deck is not a remote-desktop stream: Three.js renders locally through the phone's WebGL GPU while the Mac sends only compact JSON/SSE state. When the mobile page is hidden, both its render loop and live event connection pause.

## Local voice

BigKiji defaults to local Qwen3-TTS and starts speaking the first completed sentence while the answer continues. If the neural model is unavailable, it falls back to macOS system voices, `espeak-ng` on Linux, or Windows SAPI.

Internal `<thinking>`, `<thought>`, analysis, and draft content is never sent to either audio track.

See `tools/qwen3-tts-server.py --help` for the local server options. The default endpoint is `http://127.0.0.1:17890`.

## Test

```bash
npm test
npm run check:imports
SMOKE=1 npx electron .
```

The test suite covers architecture, sandbox boundaries, symlink escape, secret/PII canaries, minimal child environments, stale disclosures, context pruning, paid-provider policy, voice filtering, cmux command confirmation, 3D interaction, terminal resizing, telemetry, and Electron runtime contracts. It also exercises daemon auto-start, WebSocket/SSE delivery, JSONL sessions, one-time mobile pairing, CSRF protection, explicit Owner approval, on-demand model activation, and desktop-only hot reload.

## Build

Build for the current host:

```bash
npm run dist
```

Or select a platform:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

macOS production builds require a valid **Developer ID Application** certificate and the `BigKijiNotary` notarytool keychain profile. Signing and notarization are mandatory; a missing certificate is a release failure, not a skipped step.

```bash
npm run dist:mac
npm run verify:release
```

## Troubleshooting

### The app opens but the file universe is empty

Set `BIGKIJI_VAULT_ROOT` to an existing directory and restart BigKiji.

### Graphify is offline

Run `graphify update .` from the configured Vault and confirm `GRAPHIFY_GRAPH_PATH` points to the resulting `graph.json`.

### cmux shows PTY fallback

cmux integration is macOS-only. Start cmux, verify `cmux ping`, and set `CMUX_BIN` or the CLI path in Settings.

### Local speech is unavailable

Start `tools/qwen3-tts-server.py`, verify `/health`, or install the platform fallback voice engine. BigKiji continues without audio if neither is available.

### `node-pty` fails to build

Install the platform compiler tools, then run:

```bash
npx electron-rebuild -f -w node-pty
```

## Architecture

```text
src/core/                 Electron lifecycle, IPC, paths, voice, metrics, cmux bridge
src/domain/3d-canvas/     graph canvas, camera, roadmap, particles and shaders
src/domain/pi-agent/      sandbox policy, context pruning, cache, routers and task runner
src/domain/pi-core/       system memory, fail-closed tool hooks, redaction and disclosure seals
src/domain/server/        standalone daemon, GUI/CLI transport and JSONL sessions
src/domain/terminal/      Mission Relay, terminal tabs, cmux mirror and resize behavior
src/cli/tui/              ANSI/cmux live monitor
src/domain/telemetry/     live HUD, event store and optional ComfyUI bridge
src/components/UI/        shared renderer UI, settings, voice and mobile PWA
tools/                    self-tests, local Qwen TTS, release verification and CLI tools
```

## Security and privacy

- `.env`, recordings, Graphify output, model caches, and credentials are not committed.
- Renderer processes access privileged features only through the preload IPC bridge.
- External model context is sandbox-scoped, secret-filtered, and sealed in an Owner-approved disclosure manifest.
- Provider processes receive an isolated HOME and a minimal environment containing only that provider's credential.
- Model-native WebSearch, WebFetch, browser, MCP, extensions, and arbitrary network shell commands are blocked. Research must pass through the PiAgent sanitizing broker.
- Claude uses a PreToolUse deny hook; Gemini uses an admin policy and sandbox; Codex uses ephemeral strict configuration; GLM runs without tools. Missing enforcement stops the launch instead of relaxing policy.
- Self-repair may generate and test a proposal, but applying, reloading, committing, publishing, spending, or changing credentials always requires explicit Owner approval.
- cmux uses `execFile(argv)` without a shell and requires confirmation for destructive commands.
- Local Graphify code extraction requires no LLM. Semantic media/document extraction may use whichever backend you explicitly configure in Graphify itself.

Direct sandboxing materially reduces accidental disclosure but cannot prove safety against an operating-system or provider vulnerability. BigKiji reports such unsupported enforcement as `DEGRADED` and keeps the affected external model closed.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
