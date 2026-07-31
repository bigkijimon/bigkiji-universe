# BigKiji Universe

Menu-bar Electron app that visualizes and commands the BigKiji AI agent
orchestration network — a brain-synapse canvas (all agents rendered as black
holes with photoreal accretion disks, myofibril fiber-bundle synapses, live
neurotransmitter pulses), a NEURAL metrics dashboard, a local-first voice
interface, and a remote sync engine for iPhone/CLI control.

Stack: Electron 34 · Three.js 0.172 (ESM importmap) · @xterm/xterm · node-pty ·
`pi` RPC core (Gemini free-tier fallback chain → local Ollama) · whisper.cpp ·
macOS `say`. Zero HTTP dependencies — the remote server is hand-rolled `node:http`.

## Run

```bash
npm install
npm start                 # menu-bar resident (❖)
SMOKE=1 npx electron .    # 4s boot check
npm run dist              # package .app → ../dist (unsigned; right-click → Open)
```

## Remote control (Tailscale)

The app serves a mobile PWA + JSON/SSE API on port 8777 (config + token:
`~/.bigkiji/remote.json`, auto-generated).

- iPhone (same tailnet): `http://<tailscale-ip>:8777/?t=<token>` — add to Home
  Screen. With `tailscale serve --bg 8777` enabled you get HTTPS
  (`https://<host>.<tailnet>.ts.net/?t=<token>`), which also unlocks mic/PWA
  install on iOS.
- CLI: `bigkiji` (REPL with live commentary), `bigkiji "prompt"` (one-shot),
  `bigkiji status`. Over SSH use `tools/bigkiji-tmux` (disconnect-safe).
- Sync engine: SSE down / POST up. Desktop canvas, PWA and CLI share one bus.

## Voice (full-duplex)

One tap on 🎙 starts a hands-free live session: energy VAD (16 kHz worklet),
two-pass whisper language detection (en/ja/th), sentence-level streaming TTS
(`say -o` → WebAudio playback so echo cancellation works), and barge-in — speak
while it talks and the TTS is cut instantly. Replies mirror the owner's
language (LANG_RULE in `pi-bridge.js`); all system text stays English.

## Swarm consensus + knowledge cache

`task-cache.js` classifies each prompt: small talk goes straight through;
known patterns inject a cached playbook (zero discussion tokens); unknown
tasks run a two-lens swarm discussion (architect/researcher, Gemini REST,
measured tokens) whose merged plan is injected and — on verified success —
saved to `../Knowledge/task_knowledge_base.json`. The more you use it, the
cheaper and faster it gets.

## Layout

```
main.js            main process: windows, bus, Pi bridge glue, voice TTS/STT, Auto-Heal
pi-bridge.js       pi --mode rpc child, model fallback chain, LANG_RULE injection
remote-server.js   node:http server — PWA, /api/state|events(SSE)|prompt|voice|abort
task-cache.js      direct/cache/swarm classification + task_knowledge_base.json
commentary.js      English live-commentary templates (single source of truth)
orchestrator.js    event bus (pty ingest, pulse, ring buffer)
renderer/          synapse canvas, NEURAL dashboard, tray, voice-live VAD/worklet
remote/            mobile PWA (single-file), manifest, service worker, icons
tools/             bigkiji CLI + tmux wrapper + pi selftest
```
