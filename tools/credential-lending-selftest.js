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

// Read-only lending is enforced with POSIX mode bits, which Windows does not have —
// fs.stat there reports a fixed 0o666/0o444 from the read-only flag alone, and NTFS
// ACLs are the real model. Asserting 0o400 on Windows tests nothing and fails.
// This is a security property, so it is skipped loudly rather than quietly: on
// Windows the lending is NOT verified read-only by this suite.
const POSIX_MODES = process.platform !== 'win32';
function assertLentReadOnly(file, message) {
  if (!POSIX_MODES) return false;
  assert.equal(fs.statSync(file).mode & 0o777, 0o400, message);
  return true;
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecurityPolicy, CREDENTIAL_FILES, CREDENTIAL_FIELDS, OWNER_HOME_PROVIDERS, isSensitivePath } = require('../src/domain/pi-core/security/security-policy');

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
      assertLentReadOnly(target, `${relative} must be lent read-only`);
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
    if (assertLentReadOnly(file, `${relative} must be lent read-only`)) {
      assert.throws(() => fs.writeFileSync(file, 'tampered'), /EACCES|EPERM/, 'and writing to it must fail');
    }
  }
});

ok('the copy dies with the task', () => {
  const runtime = policy.createRuntime('selftest-cleanup', 'codex');
  assert.ok(runtime.linked.length ? fs.existsSync(path.join(runtime.home, runtime.linked[0])) : true);
  fs.rmSync(runtime.root, { recursive: true, force: true }); // what cleanupRuntime does
  assert.ok(!fs.existsSync(runtime.home), 'nothing survives the run that produced it');
});

ok('HOME still points at the sandbox for everyone but the one approved exception', () => {
  // The owner approved exactly one provider seeing the real HOME (2026-08-14): Claude Code
  // resolves its macOS keychain login from HOME + USER and could not authenticate at all
  // without it. The approval was for one name, so the set is asserted by value — adding a
  // second provider has to fail here rather than pass quietly.
  assert.deepEqual([...OWNER_HOME_PROVIDERS].sort(), ['claude-code'],
    'widening the real-HOME exception is an owner decision, not an edit');

  for (const provider of ['codex', 'glm', 'gemini', 'qwen', 'pi']) {
    const runtime = runtimeFor(provider);
    const env = policy.minimalEnv(provider, { runtime });
    assert.equal(env.HOME, runtime.home, `${provider} keeps the throwaway HOME`);
    assert.notEqual(env.HOME, os.homedir());
    assert.equal(env.TMPDIR, runtime.tmp);
  }

  // And for the exception, the reduction is bounded to HOME. Everything else that could
  // lead somewhere — the temp dir and the three XDG roots — stays inside the sandbox.
  const runtime = runtimeFor('claude-code');
  const env = policy.minimalEnv('claude-code', { runtime });
  assert.equal(env.HOME, os.homedir(), 'the approved exception gets the real HOME');
  assert.equal(env.TMPDIR, runtime.tmp, 'and nothing else moves with it');
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    assert.ok(env[key].startsWith(runtime.home), `${key} must stay in the sandbox`);
  }
});

ok('the exception moves the environment, never the lending', () => {
  // The dangerous version of this change is making createRuntime() hand back the real home:
  // lendCredentials writes 0o400 copies into runtime.home, so that would drop a read-only
  // file onto the owner's own ~/.claude.json. runtime.home must stay a temp directory even
  // for the provider whose child is told otherwise.
  const runtime = runtimeFor('claude-code');
  assert.notEqual(runtime.home, os.homedir(), 'the lending target is never the owner’s home');
  assert.ok(runtime.home.startsWith(policy.runtimeRoot), 'and it lives under the runtime root');
  for (const relative of runtime.linked) {
    assert.ok(fs.existsSync(path.join(runtime.home, relative)), 'the copy is in the sandbox');
  }
});

ok('a provider can still find its own login', () => {
  // The other way to hand a provider nothing: build an environment so bare that its CLI
  // cannot locate the login it already has. Measured 2026-08-14 against the real `claude`,
  // one variable at a time — LOGNAME no, SHELL no, USER yes, and USER only works together
  // with the real HOME above. "The environment is minimal" and "the environment is
  // unusable" are one edit apart and only one of them is the goal.
  for (const provider of ['claude-code', 'codex', 'glm', 'gemini', 'qwen']) {
    const env = policy.minimalEnv(provider, { runtime: runtimeFor(provider) });
    assert.equal(env.USER, os.userInfo().username, `${provider} must be told which account it runs as`);
  }
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

ok('Pi is lent the policy that restricts it, not only the config that enables it', () => {
  // CVE-2026-54325 is one half of this; the other half is that the owner's own
  // sandbox.json — denying ~/.ssh, .env, *.pem, *.key and allow-listing the domains
  // Pi may reach — lives under HOME, so a sandboxed HOME hid it from Pi along with
  // everything else. The Pi that BigKiji started was the one instance on this
  // machine running with no policy at all. Lending it is strictly narrowing.
  for (const provider of ['pi', 'glm']) {
    assert.ok(CREDENTIAL_FILES[provider].includes('.pi/agent/sandbox.json'),
      `${provider} must be handed the restriction, not just the capability`);
  }
  const runtime = runtimeFor('pi');
  const file = path.join(runtime.home, '.pi/agent/sandbox.json');
  if (!fs.existsSync(path.join(os.homedir(), '.pi/agent/sandbox.json'))) return; // not configured on this machine
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(policy.enabled, true, 'a policy that is off is not a policy');
  for (const denied of ['~/.ssh', '.env']) {
    assert.ok((policy.filesystem?.denyRead || []).includes(denied), `${denied} must still be denied inside the sandbox`);
  }
  // And it is lent read-only, like everything else here — a model must not be able
  // to widen the policy that constrains it.
  assertLentReadOnly(file, 'the sandbox policy must be lent read-only too');
});

ok('the runner asks for the right provider’s login', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'task-runner.js'), 'utf8');
  assert.match(runner, /createRuntime\(task\.id, task\.provider\)/,
    'without the provider every task would get an empty home again');
});

ok('one credential route per provider, never two', () => {
  // apiKeyHelper and the real HOME are alternatives, not belt-and-braces.
  //
  // The helper was written on 2026-08-03 because a sandboxed HOME hides the login
  // keychain from `security` itself. The owner chose the real HOME instead on
  // 2026-08-14 — and leaving the helper on top of it does not add a fallback, because
  // Claude Code treats ANY api-key source as taking precedence over the claude.ai
  // login. Measured A/B, byte-identical arguments, only the settings file differing:
  //
  //   apiKeyHelper present → exit 143, "⚠ claude.ai connectors are disabled ..."
  //   apiKeyHelper absent  → exit 0
  //
  // So the task authenticated, ran, and died — which reads as a Claude problem rather
  // than a configuration one. Whichever route a provider is set up for, write only it.
  const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
  const runner = new TaskRunner();
  const policy = { allowRead: [], allowWrite: [], taskRoot: os.tmpdir() };
  for (const provider of ['claude-code', 'claude']) {
    const runtime = runtimeFor(provider);
    runner.writeProviderPolicies(provider, runtime, policy);
    const written = JSON.parse(fs.readFileSync(runtime.claudeSettings, 'utf8'));
    const wantsHelper = !OWNER_HOME_PROVIDERS.has(provider);
    assert.equal('apiKeyHelper' in written, wantsHelper,
      `${provider}: ${wantsHelper ? 'the sandbox HOME needs the helper' : 'the real HOME must NOT also carry an api-key source'}`);
  }
});

ok('every installed executor is reachable from the PATH a Finder-launched app would build', () => {
  // A Finder/Dock launch hands Electron only the GUI PATH. minimalEnv appends
  // PROVIDER_BIN_DIRS to reach anything under $HOME. Until 2026-08-15 that list was
  // missing ~/.local/bin, so `claude` — the only executor installed there — died with
  // `spawn claude ENOENT` on every Dock launch, while a shell launch worked. The bug
  // was invisible to any check run from a terminal.
  //
  // This does not assert a fixed list of directories: it asks where each executor
  // actually is on THIS machine, and requires minimalEnv to be able to find it.
  // Executors that are not installed are skipped, not failed.
  const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const realPath = process.env.PATH;
  let guiEnv;
  try {
    process.env.PATH = GUI_PATH;
    guiEnv = policy.minimalEnv('claude-code', { runtime: runtimeFor('path-probe') });
  } finally { process.env.PATH = realPath; }
  const reachable = guiEnv.PATH.split(':');

  const missing = [];
  for (const bin of ['claude', 'codex', 'gemini', 'pi', 'node']) {
    const homes = (realPath || '').split(':')
      .filter((dir) => dir && fs.existsSync(path.join(dir, bin)));
    if (!homes.length) continue;                       // not installed here — nothing to assert
    if (!homes.some((dir) => reachable.includes(dir))) missing.push(`${bin} (only in ${homes.join(', ')})`);
  }
  assert.deepEqual(missing, [],
    `these executors exist on disk but a Finder-launched BKU could not spawn them: ${missing.join(' · ')}`
    + '\n       → add the directory to PROVIDER_BIN_DIRS in security-policy.js');
});

for (const runtime of runtimes) fs.rmSync(runtime.root, { recursive: true, force: true });
if (failures) { console.error(`credential lending selftest: ${failures} FAILED`); process.exit(1); }
console.log(`credential lending selftest: PASS · one login per provider, named not globbed · ${POSIX_MODES ? 'read-only' : 'read-only NOT CHECKED (no POSIX modes on this platform)'} · dies with the task · HOME still sandboxed · every installed executor spawnable from a Finder launch · nothing else crosses`);
