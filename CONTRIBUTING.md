# Contributing

Thanks for looking. This is a one-person project, so the most useful thing you
can send is a small change with a way to check it.

## Before you start

Open an issue first for anything larger than a bug fix. The architecture has
opinions — see [`docs/architecture.md`](docs/architecture.md) and
[`docs/v3/`](docs/v3/) — and it is cheaper to disagree in an issue than in a
1,000-line pull request.

## Setup

```sh
git clone git@github.com:bigkijimon/bigkiji-universe.git
cd bigkiji-universe
npm ci
npm start          # launches the menu-bar app
```

Node **>=24 <27** is required (`engines` in `package.json`). Electron 43 and
`node-pty` are prebuilt for your platform by `npm ci`; if the terminal falls back
to pipe mode, `node-pty` failed to load and the app says so rather than crashing.

The external AI CLIs (Claude Code, Codex, Gemini, GLM via `pi`, Ollama) are
**not** dependencies. The app detects what you have and degrades to what is
present. You can work on most of the codebase with none of them installed.

## Checks

```sh
npm test               # all 61 selftests
npm run test:security  # the boundary you most want to keep intact
npm run doctor         # environment diagnosis
SMOKE=1 npx electron . # ~4s headless launch, prints a SMOKE result
```

Every selftest is a plain Node script under `tools/` with no test framework. Add
one next to the thing you changed and wire it into the `test:*` chain in
`package.json`. A test that needs network access, a real provider key, or the
owner's home directory is not acceptable — use `os.tmpdir()` fixtures.

CI runs `npm ci && npm test` on macOS, Windows and Ubuntu, plus an xvfb Electron
smoke run. It must be green.

## Style

- **Commits**: `type(scope): what changed, in a sentence a human would say.`
  Look at `git log` — messages describe the behaviour, not the diff.
- **Comments explain why, not what.** The ones worth writing record a decision
  and the evidence for it, especially where the obvious approach was wrong. If
  you fixed a bug, say what it actually did.
- **Measure, don't assert.** Performance and behaviour claims in comments and
  docs should come with the number you observed and how you got it.
- No new runtime dependencies without discussing it in an issue first. The
  dependency list is deliberately short.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under Apache-2.0,
the same as the rest of the project.
