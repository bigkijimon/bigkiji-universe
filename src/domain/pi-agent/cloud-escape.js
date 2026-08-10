'use strict';

// The way out when this machine's own model has been switched off.
//
// `gpu-signal.sh` serialises GPU work by SIGSTOPping Ollama for the whole of a render —
// `mem-switch.sh freeze_ollama()` signals every process matching `llama-server` and
// `ollama serve`, by name, so the size of the model makes no difference at all. Measured
// 2026-08-10 while the owner watched it: all three processes in `T`, port 11434 not
// answering, and the smallest chat model on disk 6.0 GB. Downloading a 0.5B would have
// been stopped by exactly the same signal. There is no small-model escape; there is only
// an off-machine one.
//
// So for the duration of a render the owner's questions go to a paid provider, or they
// get a template. They chose Claude then Codex (2026-08-10).
//
// What leaves the machine is the prompt the caller composed, and nothing else.
//
// Stated that way rather than as "one line", because it is not one line. The front desk
// sends the owner's request; the conversation sends its whole composed prompt, which
// includes the recent turns of that session — it has to, or the reply would answer a
// question with no context. What it never includes is anything this module went and
// fetched: no tools, no context files, no session persistence, no MCP, no repository, and
// an empty working directory for the one provider that cannot be told to skip tools.
//
// The text is redacted first with the same `redactPayload` the disclosure manifest runs —
// a masked key still goes, a private key stops the call. The provider is named in the
// result so the surfaces can tell the owner which words went where, because that is a
// fact about their privacy rather than an implementation detail.
//
// Generalised out of `fast-api-router.runGlm`, which had the shape right and served one
// provider that has never had a key on this machine.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readiness } = require('./provider-readiness');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS } = require('./model-router');

// The owner's order, and the only order. Claude first because it is the one with a
// working login and a completion record; Codex second (152 samples, 128 successes);
// GLM last because it has never been reachable here — kept because the key is one
// `settings` entry away, and a chain that silently drops a provider is worse than one
// that tries it and reports the failure.
const ESCAPE_ORDER = Object.freeze(['claude', 'codex', 'glm']);

// Escape name → the id `provider-readiness` knows it by. The two vocabularies already
// differed (`claude` in the front desk's PRIORITY, `claude-code` in the readiness table)
// and translating in one place is what stops a provider from being silently unaskable.
const READINESS_ID = Object.freeze({ claude: 'claude-code', codex: 'codex', glm: 'glm' });

const ESCAPE_TIMEOUT_MS = 60000;
const MAX_OUTPUT = 4 * 1024 * 1024;

// Chat, not engineering. Opus answering 「はい」 during a render is the wrong instrument
// and the wrong bill; the escape's whole job is one conversational turn returning JSON.
// Overridable because this is the one value here chosen from reasoning rather than from
// measurement — the first live turn is what should settle it.
const ESCAPE_MODELS = Object.freeze({
  claude: process.env.BIGKIJI_CLAUDE_CHAT_MODEL || CLAUDE_MODELS.chat,
  codex: CODEX_MODELS.general,
  glm: GLM_MODELS.flash,
});

// Named so the denial is legible in a log rather than looking like a typo. An allowlist
// is used rather than only a denylist because a denylist has to be updated every time a
// tool is added, and the failure mode of forgetting is the wrong direction.
const NO_TOOLS = 'BigKijiEscapeAllowsNoTools';
const KNOWN_TOOLS = 'Read,Write,Edit,Bash,Grep,Glob,WebSearch,WebFetch,Task,NotebookEdit,SlashCommand,mcp__.*';

/** An empty directory to run in, so a provider that can read has nothing of the owner's to read. */
function scratchDir() {
  const dir = path.join(os.tmpdir(), 'bigkiji-escape');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { /* tmpdir is best effort */ }
  return dir;
}

/**
 * Can a *spawned child* reach this provider — not "is the owner allowed to use it".
 *
 * `secret` is deliberately empty, for the reason `glmCredentialled` was written with:
 * `readiness()` counts a key saved inside BigKiji as ready, and it would be for anything
 * reading the settings store, but these providers are child processes and a child sees
 * the environment and the login files. Asking the wrong question here is how the front
 * desk spent 60 seconds per turn spawning a provider with no key (fixed in 4678dee).
 *
 * `deps` reaches `readiness()` untouched so a caller — in practice a test — can state the
 * machine instead of probing it. Without it, every assertion about this chain would
 * depend on whether the machine running it happened to be signed in, which is precisely
 * the dependence `detect()`'s arguments exist to remove.
 */
function escapeReady(provider, env = process.env, deps = {}) {
  return readiness(READINESS_ID[provider] || provider, { env, secret: () => '', ...deps }).ready;
}

/** The escape chain, filtered to what can actually start right now, in order. */
function escapeCandidates(env = process.env, order = ESCAPE_ORDER, deps = {}) {
  return order.filter((provider) => escapeReady(provider, env, deps));
}

function escapeModel(provider) { return ESCAPE_MODELS[provider] || ''; }

/**
 * One prompt, no repository. The flags are the contract.
 *
 * Each command is the one `task-runner.js` already uses for that provider — proven on
 * this machine — with the parts a conversation turn has no business having removed:
 * no `--add-dir`, no tools, no session, no MCP, and an empty working directory.
 */
function commandFor(provider, prompt, model) {
  if (provider === 'claude') {
    return {
      command: process.env.CLAUDE_BIN || 'claude',
      // `--bare` looks made for this and is not usable here: it documents that OAuth and
      // the keychain are never read, and this machine signs in with
      // ~/.claude/.credentials.json (readiness: via 'login'). It would authenticate
      // nothing. Measured before choosing these flags rather than after.
      args: ['--print', prompt, ...(model ? ['--model', model] : []),
        '--permission-mode', 'plan',
        '--allowed-tools', NO_TOOLS, '--disallowed-tools', KNOWN_TOOLS,
        '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config'],
    };
  }
  if (provider === 'codex') {
    return {
      command: process.env.CODEX_BIN || 'codex',
      // Codex has no "no tools" switch, so the boundary is its sandbox: read-only, web
      // search off, no inherited environment, and pointed at an empty directory.
      args: ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--strict-config',
        ...(model ? ['--model', model] : []),
        '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"',
        '--sandbox', 'read-only', '--cd', scratchDir(), prompt],
    };
  }
  if (provider === 'glm') {
    return {
      command: process.env.PI_BIN || 'pi',
      args: ['--print', '--model', `zai/${model || GLM_MODELS.flash}`, '--no-context-files', '--no-session',
        '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', prompt],
    };
  }
  throw new Error(`No cloud escape for provider: ${provider}`);
}

/**
 * Run one escape turn. Resolves with the provider's stdout; rejects with a named reason.
 *
 * @param {string} provider  one of ESCAPE_ORDER
 * @param {string} prompt    already-composed prompt; it is redacted here, not by the caller
 * @returns {Promise<string>}
 */
async function runEscape(provider, prompt, { spawn = execFile, timeoutMs = ESCAPE_TIMEOUT_MS, model = '' } = {}) {
  const inspected = redactPayload(String(prompt || ''));
  if (inspected.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_ESCAPE_PROMPT');
  const { command, args } = commandFor(provider, inspected.text, model || escapeModel(provider));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${provider} ${String(stderr || error.message).trim().slice(0, 160)}`));
        return resolve(String(stdout || ''));
      });
    // Close stdin or the child waits out the whole timeout with nothing to say.
    //
    // Measured on the owner's machine 2026-08-10: `pi --print --model zai/... < /dev/null`
    // prints "No API key found for zai." and exits in 0.56 s, while the same command
    // through execFile — whose stdin is an open pipe — ran 60010 ms and returned empty
    // stdout and empty stderr, because it wants to offer `/login` and waits for an answer
    // that cannot arrive. Every question asked during a render cost exactly one timeout.
    // local-lookup.js had the fix and the reason; it had not reached the second caller.
    // This module exists partly so there is no third.
    try { child?.stdin?.end(); } catch (_) { /* a stub spawn need not have one */ }
  });
}

/**
 * Walk the chain until one answers. Returns null when none can, with the reasons kept.
 *
 * A broken shortcut must never be how a request disappears: every caller falls back to
 * whatever it did before when this returns null.
 *
 * @returns {Promise<{text: string, provider: string, model: string}|null>}
 */
async function escape(prompt, { env = process.env, order = ESCAPE_ORDER, deps = {}, onStart = null, ...options } = {}) {
  const errors = [];
  for (const provider of escapeCandidates(env, order, deps)) {
    onStart?.(provider);
    try {
      const text = await runEscape(provider, prompt, options);
      if (String(text || '').trim()) return { text, provider, model: escapeModel(provider), errors };
      errors.push(`${provider} returned nothing`);
    } catch (error) { errors.push(String(error.message || error)); }
  }
  return null;
}

module.exports = { ESCAPE_ORDER, READINESS_ID, ESCAPE_MODELS, ESCAPE_TIMEOUT_MS, NO_TOOLS, KNOWN_TOOLS,
  escapeReady, escapeCandidates, escapeModel, commandFor, runEscape, escape };
