'use strict';

// Answer a look-at-it request by looking, on the local model, for nothing.
//
// The owner typed 「データ見せてください」 and got two questions with six invented options
// (2026-08-10). The questions are fixed elsewhere — see `isInspection` — but fixing them
// only moved the request one step along: it became a *plan*, submitted to the paid fleet
// and held for an approval. Listing what is on disk should not cost a codex dispatch and
// an approval prompt. The owner's words, twice: 「まだすぐにだしてくれません」.
//
// So a request that only reads is answered by reading. `pi` already runs against local
// Ollama with an explicit tool allowlist — the same mechanism `task-runner.js` uses for
// the local role, and the reason that role can check things at all rather than guessing
// from the prompt text.
//
// Three properties, all of them load-bearing:
//
//   free       — ollama/<local model>, no paid provider is started
//   read-only  — `--tools read,grep,find,ls`. Not a promise in a prompt: pi's own
//                allowlist, the same one the approval gate relies on when it tells the
//                owner a task will not write
//   one-shot   — no session, no context files, no skills. Nothing is retained and
//                nothing about this repository is attached that the answer did not read
//
// It does not decide *whether* a request is an inspection. That is `isInspection()` in
// conversation-engine.js, next to the lexicon it shares vocabulary with.

const { execFile } = require('child_process');
const { ollamaFrozen, readGpuLock } = require('../pi-agent/gpu-lock');

// The same string task-runner.js uses for a local read role. Duplicated deliberately
// rather than imported: pi-core must not depend on pi-agent's runner, and a four-word
// allowlist that drifts is visible in one grep.
const READ_TOOLS = 'read,grep,find,ls';

// The tool that hung this route, and the joke is not lost on anybody.
//
// pi ships an `ask_question` tool. In `--print` mode there is no one to answer it, so the
// model asks, pi waits on stdin, and the process sits there until the timeout kills it.
// Measured 2026-08-10: 100 s, empty stdout, empty stderr, exit by timeout — the same
// silent shape as the SIGSTOPped socket, and produced while building the fix for a
// complaint that reads 「質問が多いです」. With it excluded, the same lookup answered in
// 15.6 s. stdin is closed as well, so nothing else can wait on it either.
const EXCLUDED_TOOLS = 'ask_question';

// Long enough for a targeted lookup, short enough that a failure is not the slowest thing
// that has ever happened to the owner.
//
// Measured 2026-08-10, with one of the owner's renders competing for the card:
//
//   「package.json の version を教えて」        17.2 s   answered, correct
//   「tools/ に selftest は何本あるか数えて」   >120 s   timed out — 63 files is a lot of
//                                                       tool round-trips for a 6.6B model
//
// The wide one falls back to the planning route, which costs its own ~50 s on top. So the
// budget is set where a failure is survivable rather than where the widest question might
// eventually succeed: this is the fast path, and a fast path that takes two minutes to
// admit defeat is not one.
const LOOKUP_TIMEOUT_MS = 45000;

const MAX_ANSWER_CHARS = 4000;

/**
 * What the local model is asked. Deliberately not the facilitator prompt: this is not
 * writing a spec for somebody else to build, it is answering the owner now.
 */
function lookupPrompt(request, facts = '') {
  return 'You are BigKiji answering the owner directly. This request only looks at things — '
    + 'you have read, grep, find and ls, and no way to change anything.\n'
    + 'Look first, then answer. Open the files or list the directories you need; do not answer '
    + 'from memory and do not describe what you would do.\n'
    + 'If what was asked for does not exist, say exactly that and say where you looked. '
    + 'Never invent a filename, a count, or a category.\n'
    + 'Answer in the owner\'s language, in plain prose or a short list. No preamble.\n'
    + (facts ? `Known system state — real numbers, use them and invent no others:\n${facts}\n` : '')
    + `Owner: ${String(request || '').slice(0, 2000)}`;
}

/**
 * Read-only answer from the local model, or `null` when this route cannot serve it.
 *
 * `null` rather than a thrown error on every failure path, because the caller's fallback
 * is the ordinary planning route and a broken `pi` must not swallow the request. The one
 * thing worth knowing is *why*, so it comes back on the object.
 *
 * @returns {Promise<{ok: boolean, text: string, reason: string, ms: number}>}
 */
async function localLookup(request, { facts = '', cwd = process.cwd(), model = '',
  spawn = execFile, timeoutMs = LOOKUP_TIMEOUT_MS, frozen = null } = {}) {
  const started = Date.now();
  const done = (ok, text, reason = '') => ({ ok, text, reason, ms: Date.now() - started });
  // Do not spend the timeout asking a stopped process. gpu-signal.sh SIGSTOPs Ollama for
  // the duration of a render, and pi would sit on the socket exactly as the conversation
  // engine used to.
  //
  // Stopped, not "somebody holds the lock". Those are different facts and the first draft
  // of this used the second: measured 2026-08-10, a render held the lock through a CPU
  // phase with Ollama in state S and answering, and every look-at-it request fell back to
  // the paid planning route for no reason. The lock says who has the card; `T` says
  // whether we can be answered, and it is the same test ConversationEngine already uses.
  // When the render does need the card, gpu-signal.sh stops Ollama and this refuses.
  const stopped = frozen === null ? ollamaFrozen()?.frozen === true : !!frozen;
  if (stopped) {
    const lock = readGpuLock();
    return done(false, '', lock.held
      ? `the local model is stopped — the GPU is held by "${lock.holder || 'a generation job'}"`
      : 'the local model is stopped, and nothing holds the GPU lock');
  }
  const local = model || process.env.BIGKIJI_QWEN_MODEL || 'qwen3.5:latest';
  const args = ['--print', '--model', `ollama/${local}`, '--no-context-files', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--tools', READ_TOOLS,
    '--exclude-tools', EXCLUDED_TOOLS, lookupPrompt(request, facts)];
  return new Promise((resolve) => {
    const child = spawn(process.env.PI_BIN || 'pi', args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return resolve(done(false, '', String(stderr || error.message).trim().slice(0, 160)));
        const text = String(stdout || '').trim();
        if (!text) return resolve(done(false, '', 'the local model returned nothing'));
        return resolve(done(true, text.slice(0, MAX_ANSWER_CHARS)));
      });
    // Nothing is going to type at it. An open stdin is the other half of the hang above.
    try { child?.stdin?.end(); } catch (_) {}
  });
}

module.exports = { localLookup, lookupPrompt, READ_TOOLS, LOOKUP_TIMEOUT_MS, MAX_ANSWER_CHARS };
