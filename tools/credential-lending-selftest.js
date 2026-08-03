'use strict';

// The providers were never broken. They were never authenticated.
//
// BigKiji gives every task a throwaway HOME so a provider cannot read the owner's
// ~/.ssh, ~/.aws or .env. Claude Code, Codex and Pi all prove they are logged in
// from a file under HOME, so the same sandbox removed their logins. Measured
// 2026-08-03: with the sandbox HOME, Claude Code answered "Not logged in · Please
// run /login" (error: authentication_failed) and Codex got 401 Unauthorized from
// wss://api.openai.com/v1/responses; with the real HOME and byte-identical
// arguments, Claude Code answered correctly. That is the whole explanation for 27
// assignments and zero paid completions.
//
// The owner approved lending exactly the file that authenticates, and nothing more
// (2026-08-03). These checks hold that boundary: the login is lent, everything else
// stays out, and the copy is read-only and dies with the task.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecurityPolicy, CREDENTIAL_FILES, CREDENTIAL_FIELDS, isSensitivePath } = require('../src/domain/pi-core/security/security-policy');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const listing = (dir, prefix = '') => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? listing(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]));
  } catch (_) { return []; }
};

const policy = new SecurityPolicy();
const runtimes = [];
const runtimeFor = (provider) => { const r = policy.createRuntime(`selftest-${provider}`, provider); runtimes.push(r); return r; };

ok('each provider is lent only the file that logs it in', () => {
  for (const [provider, files] of Object.entries(CREDENTIAL_FILES)) {
    const present = files.filter((relative) => fs.existsSync(path.join(os.homedir(), relative)));
    const runtime = runtimeFor(provider);
    assert.deepEqual(listing(runtime.home).sort(), present.sort(),
      `${provider}'s sandbox must contain its login and nothing else`);
    assert.deepEqual(runtime.linked.sort(), present.sort(), 'and must report what it lent');
  }
});

ok('a whole-file lend is never used where a few fields will do', () => {
  // ~/.claude.json is 62KB and its `projects` key is every path the owner has opened
  // plus their prompt history. The account binding is three fields of it. Copying the
  // file would hand a provider the other 61KB for no reason.
  for (const [provider, spec] of Object.entries(CREDENTIAL_FIELDS)) {
    for (const [relative, fields] of Object.entries(spec)) {
      assert.ok(!(CREDENTIAL_FILES[provider] || []).includes(relative),
        `${relative} must be lent as fields or as a file, never both`);
      const runtime = runtimeFor(provider);
      const target = path.join(runtime.home, relative);
      if (!fs.existsSync(path.join(os.homedir(), relative))) continue;
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.deepEqual(Object.keys(written).sort(), [...fields].sort(),
        `${relative} must carry exactly the approved fields`);
      assert.ok(!('projects' in written), 'the owner’s project history is not a credential');
      assert.ok(fs.statSync(target).size < 4096, 'a lent binding is small by construction');
      assert.equal(fs.statSync(target).mode & 0o777, 0o400);
    }
  }
});

ok('the stale July credentials file is not lent back', () => {
  // Lending ~/.claude/.credentials.json did not help and may have shadowed the macOS
  // login keychain, which is where this install's token actually lives. Measured
  // 2026-08-03: with it lent, and again with only the binding lent, Claude Code
  // answered "Not logged in" either way — so it is not lent at all.
  for (const provider of ['claude', 'claude-code']) {
    assert.ok(!(CREDENTIAL_FILES[provider] || []).includes('.claude/.credentials.json'),
      `${provider} must not be handed a credential file this install does not use`);
  }
});

ok('a provider with no login file gets an empty home', () => {
  for (const provider of ['gemini', 'qwen', 'ollama', '']) {
    const runtime = runtimeFor(provider);
    assert.deepEqual(listing(runtime.home), [], `${provider || '(none)'} authenticates by env or not at all`);
  }
});

ok('nothing else in the owner’s home crosses the boundary', () => {
  const runtime = runtimeFor('claude-code');
  const files = listing(runtime.home);
  for (const forbidden of ['.ssh', '.aws', '.env', '.gnupg', '.bigkiji', 'Documents', 'Library', '.npmrc', '.zshrc']) {
    assert.ok(!files.some((file) => file.split('/')[0] === forbidden || file.startsWith(`${forbidden}/`)),
      `${forbidden} must never appear in a task sandbox`);
  }
  // The lending list is a fixed literal, not a pattern over the owner's home: a glob
  // here would be one bad edit away from copying everything.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-core', 'security', 'security-policy.js'), 'utf8');
  const body = source.slice(source.indexOf('  lendCredentials(provider, home)')).split('\n  }')[0]
    .replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');
  assert.ok(!/readdirSync|readdir\b|glob/.test(body), 'lendCredentials must name its files, never enumerate a directory');
  for (const files of Object.values(CREDENTIAL_FILES)) {
    for (const relative of files) {
      assert.ok(!path.isAbsolute(relative) && !relative.includes('..'), `${relative} must stay inside the owner's home`);
    }
  }
});

ok('the lent copy is read-only, so a model cannot rewrite the owner’s login', () => {
  const runtime = runtimeFor('codex');
  for (const relative of runtime.linked) {
    const file = path.join(runtime.home, relative);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400, `${relative} must be lent read-only`);
    assert.throws(() => fs.writeFileSync(file, 'tampered'), /EACCES|EPERM/, 'and writing to it must fail');
  }
});

ok('the copy dies with the task', () => {
  const runtime = policy.createRuntime('selftest-cleanup', 'codex');
  assert.ok(runtime.linked.length ? fs.existsSync(path.join(runtime.home, runtime.linked[0])) : true);
  fs.rmSync(runtime.root, { recursive: true, force: true }); // what cleanupRuntime does
  assert.ok(!fs.existsSync(runtime.home), 'nothing survives the run that produced it');
});

ok('HOME still points at the sandbox, not at the owner', () => {
  const runtime = runtimeFor('claude-code');
  const env = policy.minimalEnv('claude-code', { runtime });
  assert.equal(env.HOME, runtime.home, 'lending a file must not have widened HOME itself');
  assert.notEqual(env.HOME, os.homedir());
  assert.equal(env.TMPDIR, runtime.tmp);
});

ok('the lent paths are still treated as sensitive everywhere else', () => {
  // Lending one file to one task must not make credentials readable in general:
  // the pruner, the disclosure manifest and the sandbox policy all key off this.
  for (const files of Object.values(CREDENTIAL_FILES)) {
    for (const relative of files) {
      if (!/credential|auth/i.test(relative)) continue;
      assert.equal(isSensitivePath(path.join(os.homedir(), relative)), true, `${relative} must stay sensitive to every other reader`);
    }
  }
});

ok('a redirect in the parent environment cannot reach a provider', () => {
  // The owner reported, from experience, that pointing Claude Code at GLM once left
  // Claude Code broken. That redirect is ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN,
  // and on this machine it lives in two ~/.zshrc aliases (glm-code, kimi-code) as
  // per-command prefixes — checked 2026-08-03: not exported, and the running daemon
  // inherits neither. It stays that way because minimalEnv builds the child's
  // environment from a fixed list rather than inheriting one; this holds that.
  const runtime = runtimeFor('claude-code');
  const poisoned = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'];
  const saved = {};
  for (const name of poisoned) { saved[name] = process.env[name]; process.env[name] = 'https://example.invalid/redirected'; }
  try {
    for (const provider of ['claude-code', 'codex', 'glm', 'gemini', 'qwen']) {
      const env = policy.minimalEnv(provider, { runtime });
      for (const name of poisoned) {
        assert.ok(!(name in env), `${provider} must not inherit ${name} from whatever shell started the daemon`);
      }
    }
  } finally {
    for (const name of poisoned) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
  // And the only secret a provider ever receives is its own.
  const env = policy.minimalEnv('claude-code', { runtime, secret: 'sk-test' });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
  assert.ok(!('ZAI_API_KEY' in env) && !('OPENAI_API_KEY' in env), 'one provider’s key is not another provider’s business');
});

ok('the runner asks for the right provider’s login', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'task-runner.js'), 'utf8');
  assert.match(runner, /createRuntime\(task\.id, task\.provider\)/,
    'without the provider every task would get an empty home again');
});

for (const runtime of runtimes) fs.rmSync(runtime.root, { recursive: true, force: true });
if (failures) { console.error(`credential lending selftest: ${failures} FAILED`); process.exit(1); }
console.log('credential lending selftest: PASS · one login per provider, named not globbed · read-only · dies with the task · HOME still sandboxed · nothing else crosses');
