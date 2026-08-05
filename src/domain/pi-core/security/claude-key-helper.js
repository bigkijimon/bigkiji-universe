#!/usr/bin/env node
'use strict';

// Print Claude Code's own OAuth access token, so a sandboxed task can use the
// owner's existing subscription instead of a separate API key.
//
// Why this file exists at all
// ---------------------------
// Every BigKiji task runs with a throwaway HOME so a provider cannot read the
// owner's ~/.ssh, ~/.aws or .env. On macOS, Claude Code's token lives in the login
// keychain — and `security` finds the login keychain at $HOME/Library/Keychains.
// So the sandbox did not merely hide a file, it hid the keychain itself. Measured
// 2026-08-03, reading the same item twice with nothing changed but HOME:
//
//     HOME=/Users/you         exit 0
//     HOME=<sandbox>          exit 44   (item not found)
//
// which is exactly what Claude Code reported as "Not logged in · Please run
// /login" for 27 assignments and zero paid completions. It was never an ACL, a
// stale credential file or a broken login.
//
// Anthropic documents `apiKeyHelper` for precisely this case: a command named in
// settings.json whose stdout becomes the request credential, run from an absolute
// path and therefore independent of HOME. BigKiji already writes a settings file
// per task and passes it with --settings, so this hooks into a door that was
// already there.
//
// The owner approved reading this specific keychain item for this specific purpose
// (2026-08-03). Two deliberate limits keep that narrow:
//
//   - the keychain is addressed by absolute path derived from the passwd database
//     (os.userInfo), never from $HOME, so this works under the sandbox without the
//     sandbox being widened for anything else;
//   - only claudeAiOauth.accessToken is read. The refresh token, the MCP OAuth
//     tokens for Vercel and Figma that share this item, and everything else in it
//     are never touched and never printed.
//
// An expired token exits non-zero rather than printing something that will fail:
// a helper that succeeds with a dead credential turns an auth error into a
// mystery, and this project has had enough of those.
//
// What this does not solve, measured 2026-08-03
// ---------------------------------------------
// The subscription's OAuth access token is not an API key. Wiring it here moved
// Claude Code from "Not logged in · Please run /login" to "Invalid API key · Fix
// external API key" — which proves the helper reaches it, and proves the two
// credential types are not interchangeable. So ANTHROPIC_API_KEY is checked first:
// when the owner sets one, this is the whole answer and the keychain is never
// touched. The keychain path stays because it costs nothing and it is the correct
// credential the day it becomes usable this way.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVICE = 'Claude Code-credentials';

/** The login keychain, resolved without trusting $HOME. */
function loginKeychain(homedir = os.userInfo().homedir) {
  return path.join(homedir, 'Library', 'Keychains', 'login.keychain-db');
}

/**
 * The live access token, or null with a reason.
 * @returns {{token: string}|{error: string}}
 */
function readToken({ keychain = loginKeychain(), now = Date.now(), run = execFileSync,
  env = process.env, platform = process.platform } = {}) {
  // An explicit key wins. It is what Anthropic accepts here, and reaching for a
  // credential store when the owner has already provided the credential is wrong.
  const explicit = String(env.ANTHROPIC_API_KEY || '').trim();
  if (explicit) return { token: explicit, source: 'ANTHROPIC_API_KEY' };
  // `platform` is injectable so the parsing, the field selection and the expiry
  // window — none of which are macOS-specific — can be exercised on Linux and
  // Windows too. Without it those five checks simply failed off macOS, which is
  // how they sat red in CI while passing on the machine that wrote them.
  if (platform !== 'darwin') return { error: 'the login keychain is macOS only' };
  let raw;
  try {
    raw = run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w', keychain],
      { encoding: 'utf8', timeout: 10000 });
  } catch (error) {
    return { error: `keychain read failed (${error.status === 44 ? 'item not found' : error.status || error.message})` };
  }
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch (_) { return { error: 'keychain item is not JSON' }; }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) return { error: 'no claudeAiOauth.accessToken in the keychain item' };
  // expiresAt is epoch milliseconds. A minute of slack, because the token is fetched
  // just before the request that uses it.
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now + 60000) {
    return { error: 'the stored token has expired — run `claude` once to refresh it' };
  }
  return { token: String(oauth.accessToken), source: 'keychain' };
}

if (require.main === module) {
  const result = readToken();
  if (result.error) { process.stderr.write(`bigkiji claude key helper: ${result.error}\n`); process.exit(1); }
  process.stdout.write(result.token);
}

module.exports = { readToken, loginKeychain, SERVICE };
