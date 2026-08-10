'use strict';

// What leaves the machine while a render holds the GPU.
//
// gpu-signal.sh SIGSTOPs Ollama for the whole of a generation — mem-switch.sh signals
// every process matching `llama-server` and `ollama serve`, by name — so during a render
// the owner's questions either go off this machine or come back as a template. They chose
// off the machine (Claude, then Codex, 2026-08-10). These assertions are the terms.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const escape = require('../src/domain/pi-agent/cloud-escape');

let failures = 0;
const ok = (name, body) => {
  try { const out = body(); if (out?.then) return out.then(() => console.log(`  ok  ${name}`), (error) => { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
  return Promise.resolve();
};

(async () => {
  // --- the order is the owner's, and local is not in it -----------------------
  await ok('the chain is Claude, then Codex, then GLM', () => {
    assert.deepStrictEqual([...escape.ESCAPE_ORDER], ['claude', 'codex', 'glm']);
    // Gemini is absent by decision, not by oversight: its free quota on this machine is
    // limit:0 — a billing plan rather than a key — and it has completed zero assignments.
    assert.ok(!escape.ESCAPE_ORDER.includes('gemini'), 'gemini is not an escape here');
    // Nothing local. A frozen Ollama is exactly why this module is being called.
    assert.ok(!escape.ESCAPE_ORDER.includes('qwen') && !escape.ESCAPE_ORDER.includes('ollama'));
  });

  // --- a permission is not a credential ---------------------------------------
  // `deps` states the machine, so these assertions do not depend on whether the box
  // running them is signed in. Every assertion in this repository that skipped that step
  // has eventually gone red for a reason that had nothing to do with the code.
  const NO_LOGINS = { exists: () => false };
  const ALL_LOGINS = { exists: () => true };

  await ok('a provider with no key is not a candidate', () => {
    // The question is what a *child process* can see, which is why `secret` is empty
    // inside escapeReady: a key saved in BigKiji's own settings is invisible to a spawned
    // CLI. Getting this backwards is how the front desk spent 60 seconds per turn
    // spawning GLM, which has never had a key on this machine (fixed 2026-08-10).
    assert.deepStrictEqual(escape.escapeCandidates({}, escape.ESCAPE_ORDER, NO_LOGINS), [],
      'no keys and no logins means no escape at all');
    assert.deepStrictEqual(escape.escapeCandidates({ ZAI_API_KEY: 'x' }, escape.ESCAPE_ORDER, NO_LOGINS), ['glm'],
      'a key in the environment is enough on its own');
    // Claude and Codex sign in with a file; GLM has `login: []` in the readiness table —
    // there is no "sign in to GLM" on this machine, only ZAI_API_KEY. Worth pinning,
    // because "the escape is unavailable" and "you never set one key" are different
    // problems with different fixes, and the draft note now names which.
    assert.deepStrictEqual(escape.escapeCandidates({}, escape.ESCAPE_ORDER, ALL_LOGINS), ['claude', 'codex'],
      'a login file is enough for claude and codex, and cannot be enough for glm');
    // Order survives filtering — a chain that reshuffles bills the wrong provider first.
    assert.deepStrictEqual(escape.escapeCandidates({ ZAI_API_KEY: 'x' }, escape.ESCAPE_ORDER, ALL_LOGINS),
      ['claude', 'codex', 'glm']);
  });

  // --- what actually leaves ----------------------------------------------------
  await ok('no tools, no context, no session, no repository', () => {
    const claude = escape.commandFor('claude', 'THE PROMPT', 'm');
    assert.ok(claude.args.includes('--print'), 'one shot, not a session');
    assert.ok(claude.args.includes(escape.NO_TOOLS), 'an allowlist that matches nothing');
    assert.ok(claude.args.includes('--no-session-persistence'), 'nothing is retained by the CLI');
    assert.ok(claude.args.includes('--strict-mcp-config'), 'and no MCP server is attached');
    assert.ok(!claude.args.includes('--add-dir'), 'the repository is not handed over');
    assert.ok(!claude.args.some((a) => String(a).includes('BIGKIJI')), 'nor is any path into it');
    // `--bare` looks made for this and cannot be used: it documents that OAuth and the
    // keychain are never read, and this machine signs in with ~/.claude/.credentials.json.
    assert.ok(!claude.args.includes('--bare'), 'the flag that would break login is not used');

    const codex = escape.commandFor('codex', 'THE PROMPT', 'm');
    assert.ok(codex.args.includes('--sandbox') && codex.args.includes('read-only'),
      'codex has no no-tools switch, so its boundary is the sandbox');
    assert.ok(codex.args.includes('--ephemeral') && codex.args.includes('--ignore-user-config'));
    assert.ok(codex.args.some((a) => String(a).includes('web_search="disabled"')));
    const cd = codex.args[codex.args.indexOf('--cd') + 1];
    assert.ok(fs.existsSync(cd) && fs.readdirSync(cd).length === 0,
      'and it runs in an empty directory, so a provider that can read has nothing to read');

    const glm = escape.commandFor('glm', 'THE PROMPT', 'm');
    for (const flag of ['--no-tools', '--no-context-files', '--no-session', '--no-skills']) {
      assert.ok(glm.args.includes(flag), `${flag} is what keeps this to one prompt`);
    }
    // The prompt is an argument, never interpolated into a shell string.
    for (const built of [claude, codex, glm]) {
      assert.ok(built.args.includes('THE PROMPT'), 'the prompt is passed as its own argv entry');
    }
  });

  await ok('an unknown provider is refused rather than guessed at', () => {
    assert.throws(() => escape.commandFor('gemini', 'p', 'm'), /No cloud escape/);
    assert.throws(() => escape.commandFor('', 'p', 'm'), /No cloud escape/);
  });

  // --- redaction, the half that survives without a manifest -------------------
  await ok('a key is masked and a private key stops the call', async () => {
    let sent = null;
    await escape.runEscape('claude', `use sk-ant-api03-${'A'.repeat(80)} please`,
      { spawn: (bin, args, opts, done) => { sent = args[1]; done(null, 'ok', ''); } });
    assert.ok(!sent.includes('sk-ant-'), `the key must not reach the argv of a cloud process: ${sent}`);
    assert.match(sent, /<REDACTED:anthropic-key>/, 'its absence is marked rather than silently blanked');
    assert.match(sent, /use .* please/, 'the rest of the request survives — redaction is not truncation');

    await assert.rejects(
      async () => escape.runEscape('claude', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        { spawn: () => { throw new Error('must not spawn'); } }),
      /SECURITY_CRITICAL_SECRET/, 'a private key stops the call instead of being masked');
  });

  // --- the 60 seconds, and why there were 60 of them --------------------------
  await ok('stdin is closed on every provider', async () => {
    // Measured on the owner's machine 2026-08-10: `pi --print --model zai/... < /dev/null`
    // exits in 0.56 s; the same command through execFile, whose stdin is an open pipe, ran
    // 60010 ms and returned nothing, because it wants to offer /login and waits for an
    // answer that cannot arrive. Every question asked during a render cost one full
    // timeout. The fix existed in local-lookup.js and had not reached the second caller;
    // this module exists partly so there is no third.
    for (const provider of escape.ESCAPE_ORDER) {
      let closed = false;
      await escape.runEscape(provider, 'anything', {
        spawn: (bin, args, opts, done) => { done(null, 'ok', ''); return { stdin: { end() { closed = true; } } }; },
      });
      assert.equal(closed, true, `${provider}: stdin is closed, or the child waits out the whole timeout`);
    }
  });

  await ok('a timeout is always set', async () => {
    let opts = null;
    await escape.runEscape('claude', 'x', { spawn: (bin, args, o, done) => { opts = o; done(null, 'ok', ''); } });
    assert.equal(opts.timeout, escape.ESCAPE_TIMEOUT_MS, 'a hung provider cannot hold the conversation open');
  });

  // --- the chain walks, and stops honestly ------------------------------------
  await ok('the first provider that answers wins, and a failure moves on', async () => {
    const tried = [];
    const result = await escape.escape('prompt', {
      env: {}, deps: ALL_LOGINS,
      spawn: (bin, args, opts, done) => {
        tried.push(bin);
        if (tried.length === 1) return done(new Error('claude is out of quota'), '', 'quota');
        return done(null, '{"reply":"answered"}', '');
      },
    });
    assert.equal(tried.length, 2, 'the second provider was tried after the first failed');
    assert.equal(result.provider, 'codex', 'and the result names the one that actually answered');
    assert.match(result.text, /answered/);
  });

  await ok('nothing reachable returns null rather than a lie', async () => {
    assert.equal(await escape.escape('prompt', { env: {}, deps: NO_LOGINS }), null,
      'nobody signed in anywhere is null, not an invented answer');
    // Empty output is not an answer. A provider that exits 0 with nothing has not helped,
    // and reporting it as a reply would put an empty message on the owner's screen under
    // a provider's name.
    const blank = await escape.escape('prompt', {
      env: {}, order: ['claude'], deps: ALL_LOGINS,
      spawn: (bin, args, opts, done) => done(null, '   ', ''),
    });
    assert.equal(blank, null, 'an empty stdout is a failure, not a short answer');
    // Every provider failing is the same answer as none existing.
    const allDown = await escape.escape('prompt', {
      env: {}, deps: ALL_LOGINS,
      spawn: (bin, args, opts, done) => done(new Error('down'), '', 'down'),
    });
    assert.equal(allDown, null, 'a chain that fails end to end does not fabricate a reply');
  });

  // --- the model is a chat tier, deliberately ---------------------------------
  await ok('the escape does not answer 「はい」 on the engineering tier', () => {
    const { CLAUDE_MODELS } = require('../src/domain/pi-agent/model-router');
    assert.notEqual(escape.escapeModel('claude'), CLAUDE_MODELS.general,
      'a conversation turn taken because Ollama is frozen is not Opus work');
    assert.equal(escape.escapeModel('claude'), CLAUDE_MODELS.chat);
    assert.ok(escape.escapeModel('codex'), 'every provider in the chain resolves to a model id');
    assert.ok(escape.escapeModel('glm'));
  });

  // --- and it is off unless the owner turned it on ----------------------------
  await ok('the daemon only calls this while cloudFallback says gpu-busy', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
    assert.match(source, /cloudFallback === 'gpu-busy'[\s\S]{0,80}escape\(prompt\)/,
      'the switch is checked at call time, not captured at construction');
    assert.match(source, /conversation: \{ \.\.\.\(saved\.conversation \|\| \{\}\) \}/,
      'and the block carrying that switch reaches ownerSettings() at all');
  });

  if (failures) { console.error(`cloud escape selftest: ${failures} FAILED`); process.exit(1); }
  console.log('cloud escape selftest: PASS · Claude then Codex then GLM · a permission is not a credential · no tools, no context, no repository · a key is masked and a private key stops the call · stdin closed on every provider · the chain walks and stops honestly · a chat tier, not the engineering one · off unless the owner turned it on');
})().catch((error) => { console.error(error); process.exit(1); });
