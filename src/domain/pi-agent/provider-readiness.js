'use strict';

// Can this provider actually start work, and if not, what is missing.
//
// The gate this replaces asked one question — "is there an API key in the
// settings store?" — and answered no for every paid provider, forever. Claude
// Code and Codex do not use API keys; they authenticate with their own CLI
// login. Gemini's CLI reads GOOGLE_API_KEY as readily as GEMINI_API_KEY. And the
// owner's keys lived in .env, which the settings store never sees.
//
// So the owner had four working providers, a coordinator that believed it had
// none, and every plan routed to the local model. Nothing was broken enough to
// produce an error; it just quietly did less.
//
// Two things this is careful about.
//
// It never reads a credential. Presence is established from the name of an
// environment variable being non-empty, or an auth file existing on disk — the
// values are not opened, not logged, and not returned. `detail` is written for
// the owner to read on screen, so it names what to do, never what was found.
//
// It says why. "offline" told the owner nothing and cost an evening; a provider
// that cannot start now reports the specific missing thing.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Where each provider's readiness can come from. `keys` are environment
// variable names in priority order; `login` are auth files a CLI writes when it
// logs in, relative to the home directory.
const PROVIDERS = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    keys: ['ANTHROPIC_API_KEY'],
    login: ['.claude/.credentials.json'],
    hint: 'run `claude` once and sign in, or set ANTHROPIC_API_KEY',
  }),
  codex: Object.freeze({
    label: 'Codex',
    keys: ['OPENAI_API_KEY'],
    login: ['.codex/auth.json'],
    hint: 'run `codex` once and sign in, or set OPENAI_API_KEY',
  }),
  gemini: Object.freeze({
    label: 'Gemini',
    // The CLI honours both, and the owner's .env uses the Google name.
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    login: ['.gemini/oauth_creds.json'],
    hint: 'set GEMINI_API_KEY or GOOGLE_API_KEY, or run `gemini` once and sign in',
  }),
  glm: Object.freeze({
    label: 'GLM',
    keys: ['ZAI_API_KEY'],
    login: [],
    hint: 'set ZAI_API_KEY',
  }),
});

const LOCAL = new Set(['qwen', 'ollama', 'local-qwen']);

const canonical = (provider) => (provider === 'claude' ? 'claude-code' : String(provider || ''));

/**
 * @param {string} provider
 * @param {{env?: object, home?: string, secret?: (id: string) => string, exists?: (file: string) => boolean}} deps
 * @returns {{id: string, ready: boolean, via: string, detail: string}}
 */
function readiness(provider, { env = process.env, home = os.homedir(), secret = () => '',
  exists = (file) => fs.existsSync(file) } = {}) {
  const id = canonical(provider);
  if (LOCAL.has(id)) return { id, ready: true, via: 'local', detail: 'runs on this machine' };
  const spec = PROVIDERS[id];
  if (!spec) return { id, ready: false, via: '', detail: 'unknown provider' };

  // An owner-entered secret outranks the environment: it is the one they can
  // change from inside the app.
  const stored = String(secret(id) || secret(provider) || '').trim();
  if (stored) return { id, ready: true, via: 'secret', detail: 'key saved in settings' };

  const key = spec.keys.find((name) => String(env[name] || '').trim());
  if (key) return { id, ready: true, via: 'env', detail: `${key} is set` };

  const login = spec.login.find((file) => { try { return exists(path.join(home, file)); } catch (_) { return false; } });
  if (login) return { id, ready: true, via: 'login', detail: `signed in (~/${login})` };

  return { id, ready: false, via: '', detail: spec.hint };
}

/** Every paid provider, in a stable order. */
function survey(deps = {}) {
  return Object.keys(PROVIDERS).map((id) => readiness(id, deps));
}

/**
 * The environment name a child process should receive the credential under,
 * whatever name it was found beside. The Gemini CLI accepts GOOGLE_API_KEY, but
 * only GEMINI_API_KEY is guaranteed, so the value travels under the canonical
 * name and the alias is resolved here rather than in five call sites.
 */
function credentialFor(provider, { env = process.env, secret = () => '' } = {}) {
  const id = canonical(provider);
  const spec = PROVIDERS[id];
  if (!spec) return { name: '', value: '' };
  const stored = String(secret(id) || secret(provider) || '').trim();
  if (stored) return { name: spec.keys[0], value: stored };
  const key = spec.keys.find((name) => String(env[name] || '').trim());
  return key ? { name: spec.keys[0], value: String(env[key]).trim() } : { name: spec.keys[0], value: '' };
}

module.exports = { readiness, survey, credentialFor, PROVIDERS, LOCAL, canonical };
