# Security Policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
**[Report a vulnerability](https://github.com/bigkijimon/bigkiji-universe/security/advisories/new)**

Please do not open a public issue for anything that could be exploited.

This is a one-person project. Expect a first reply within about a week. If a
report is confirmed, the fix and the advisory go out together.

## What this project is trying to protect

BigKiji Universe spawns external AI coding CLIs on your machine and shows you,
before each run, exactly what would leave it. The security model is therefore
about two boundaries:

1. **What gets sent out.** A run is planned locally, pruned to a sandbox-scoped
   slice, redacted, and sealed into a disclosure manifest — per-file SHA-256 with
   line ranges, the provider and the exact model id, redaction counts, verbatim
   text of any brokered external query, a payload hash and a policy hash, all
   folded into one `disclosureHash`. You approve that hash. If the policy, the
   manifest or the model selection changes between approval and spawn, the run is
   rejected as stale rather than silently re-approved.
2. **What a spawned CLI can reach.** Child processes get a minimal environment
   (a private `0700` HOME and TMPDIR, and only the one provider key they need).
   A `PreToolUse` hook denies all web tools and all `mcp__*` tools, and allows
   only an allowlisted subset of shell commands — no pipes, no redirection, no
   networking binaries. The research broker is the only sanctioned network path.
   Children cannot spawn further agents.

Findings that defeat either boundary are the ones worth reporting: a way to get
data into a payload that the manifest does not list, a way to reach the network
from a spawned tool, a way to make an approved hash cover a different payload.

## Network exposure — read this before you enable remote access

The daemon listens on **`127.0.0.1:8777` by default**, and that default is the
safe one.

`state/remote.json` in your data root can override the bind address. Setting it
to `0.0.0.0` puts `/api/turn` on every interface your machine is attached to,
behind a single bearer token. Non-loopback binds now **refuse to start** unless
you also set `BIGKIJI_ALLOW_LAN=1`, so this cannot happen by a typo — but if you
set that variable, understand what you are turning on.

Remote surfaces are additionally pinned to `executionMode: 'plan'`: a request
that did not come from loopback cannot buy an unattended write, whatever mode it
asks for. Requesting a mode is not the same as being allowed one.

To reach the app from a phone, prefer a private overlay network (the bundled
Tailscale integration proxies `http://127.0.0.1:8777`) over binding the daemon
to the LAN.

## Supported versions

The latest release on `main` is the only supported version.

## Scope

In scope: this repository's code, its default configuration, and its bundled
selftests.

Out of scope: vulnerabilities in the external CLIs this project launches
(Claude Code, Codex, Gemini, GLM, Ollama) — report those to their maintainers —
and anything that requires an attacker to already have your user account on your
machine.
