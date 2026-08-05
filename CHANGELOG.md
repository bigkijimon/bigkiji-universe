# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull-request
  templates, and `.github/FUNDING.yml`, ahead of making the repository public.

### Changed

- The daemon now **refuses to start on a non-loopback address** unless
  `BIGKIJI_ALLOW_LAN=1` is set. `state/remote.json` is a plain file, and a `bind`
  of `0.0.0.0` in it used to be silent: the daemon came up looking identical to a
  loopback start while every device on the network could reach `/api/turn` behind
  one bearer token. A typo in a config file should fail loudly at startup, not
  widen the attack surface quietly.

### Removed

- Operating playbooks (`skills/`), a private video reference-analysis note, and
  an internal organisation handbook are no longer tracked. They were the
  maintainer's own operating documents rather than application code, and they
  named internal paths. `skill-registry.js` also reads `~/.claude/skills`, so the
  app degrades gracefully without the bundled copies.

## [2.5.0] — 2026-08-03

First version of this changelog. The project's git history begins 2026-07-31;
everything before this entry is recorded there rather than summarised here.

Highlights of the state at 2.5.0:

- macOS menu-bar Electron app, a detached loopback daemon on `127.0.0.1:8777`,
  a CLI/TUI (`bigkiji`, `kiji`), and a phone PWA served by the daemon.
- Orchestration of external AI coding CLIs (Claude Code, Codex, Gemini, GLM via
  `pi`) and a local Ollama model, through a local planning agent.
- Disclosure manifests: per-file SHA-256 with line ranges, provider and model id,
  redaction counts, payload and policy hashes, folded into one `disclosureHash`
  that the owner approves before anything is spawned. Stale policy, manifest or
  model selection rejects the run rather than re-approving it.
- Sandboxed spawns: minimal environment, private `0700` HOME and TMPDIR, a single
  provider key, an allowlisted shell subset, all web and `mcp__*` tools denied,
  and isolated git worktrees.
- A Three.js "Synapse Canvas" rendering the real files and relationships being
  worked on, and an integrated xterm/node-pty terminal.
- 61 selftests, run on macOS, Windows and Ubuntu in CI, plus an Electron smoke run.

[Unreleased]: https://github.com/bigkijimon/bigkiji-universe/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/bigkijimon/bigkiji-universe/releases/tag/v2.5.0
