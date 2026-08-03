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
const { SecurityPolicy, CREDENTIAL_FILES, isSensitivePath } = require('../src/domain/pi-core/security/security-policy');

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
  const runtime = runtimeFor('claude-code');
  for (const relative of runtime.linked) {
    const file = path.join(runtime.home, relative);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400, `${relative} must be lent read-only`);
    assert.throws(() => fs.writeFileSync(file, 'tampered'), /EACCES|EPERM/, 'and writing to it must fail');
  }
});

ok('the copy dies with the task', () => {
  const runtime = policy.createRuntime('selftest-cleanup', 'claude-code');
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

ok('the runner asks for the right provider’s login', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'task-runner.js'), 'utf8');
  assert.match(runner, /createRuntime\(task\.id, task\.provider\)/,
    'without the provider every task would get an empty home again');
});

for (const runtime of runtimes) fs.rmSync(runtime.root, { recursive: true, force: true });
if (failures) { console.error(`credential lending selftest: ${failures} FAILED`); process.exit(1); }
console.log('credential lending selftest: PASS · one login per provider, named not globbed · read-only · dies with the task · HOME still sandboxed · nothing else crosses');
