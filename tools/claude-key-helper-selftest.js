'use strict';

// The sandbox hid the keychain, not just a file.
//
// Every BigKiji task runs with a throwaway HOME. On macOS `security` finds the
// login keychain at $HOME/Library/Keychains, so the sandbox did not merely hide
// Claude Code's credential — it hid the store the credential is in. Measured
// 2026-08-03, same item, same command, nothing changed but HOME:
//
//     HOME=/Users/you    exit 0
//     HOME=<sandbox>     exit 44   (item not found)
//
// That is the whole of "Not logged in · Please run /login". The fix is the
// mechanism Anthropic documents for headless use: apiKeyHelper, a command named in
// settings whose stdout becomes the credential, run from an absolute path.
//
// Nothing here touches a real keychain. `run` and `env` are injected, because a
// test that reads the owner's credentials to prove it can read the owner's
// credentials is not a test worth having.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readToken, loginKeychain, SERVICE } = require('../src/domain/pi-core/security/claude-key-helper');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const ITEM = JSON.stringify({
  claudeAiOauth: { accessToken: 'oauth-access', refreshToken: 'oauth-refresh', expiresAt: 4102444800000, scopes: ['user:inference'] },
  mcpOAuth: { 'plugin:figma:figma|abc': { accessToken: 'figma-token', clientSecret: 'figma-secret' } },
});
const runOk = () => ITEM;

ok('an explicit key wins and the keychain is never opened', () => {
  let opened = false;
  const result = readToken({ env: { ANTHROPIC_API_KEY: 'sk-owner' }, run: () => { opened = true; return ITEM; } });
  assert.equal(result.token, 'sk-owner');
  assert.equal(result.source, 'ANTHROPIC_API_KEY');
  assert.equal(opened, false, 'reaching into a credential store when the owner already handed over the credential is wrong');
  // Whitespace-only is not a key: it would silently shadow the keychain path.
  assert.equal(readToken({ env: { ANTHROPIC_API_KEY: '   ' }, run: runOk, platform: 'darwin' }).source, 'keychain');
});

ok('the keychain is addressed by absolute path, never through $HOME', () => {
  // $HOME is the sandbox. os.userInfo() reads the passwd database, which the
  // sandbox does not change — that is the entire trick.
  assert.equal(loginKeychain('/Users/example'), path.join('/Users/example', 'Library', 'Keychains', 'login.keychain-db'));
  let args = null;
  readToken({ env: {}, run: (bin, argv) => { args = { bin, argv }; return ITEM; }, platform: 'darwin' });
  assert.equal(args.bin, '/usr/bin/security', 'the system binary by absolute path');
  assert.deepEqual(args.argv.slice(0, 4), ['find-generic-password', '-s', SERVICE, '-w']);
  assert.ok(path.isAbsolute(args.argv[4]) && args.argv[4].endsWith('login.keychain-db'),
    'the keychain must be named, or security looks under $HOME and finds nothing');
});

ok('only the one approved field leaves the keychain item', () => {
  const result = readToken({ env: {}, run: runOk, platform: 'darwin' });
  assert.equal(result.token, 'oauth-access');
  assert.equal(result.source, 'keychain');
  // The item also holds the refresh token and the Figma/Vercel MCP tokens. The
  // owner approved claudeAiOauth.accessToken and nothing else (2026-08-03).
  for (const other of ['oauth-refresh', 'figma-token', 'figma-secret']) {
    assert.notEqual(result.token, other);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-core', 'security', 'claude-key-helper.js'), 'utf8');
  for (const forbidden of ['refreshToken', 'mcpOAuth', 'clientSecret']) {
    const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.ok(!code.includes(forbidden), `${forbidden} must not be referenced by the code, only explained in the comments`);
  }
});

ok('an expired token fails loudly instead of printing something dead', () => {
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: 'stale', expiresAt: 1000 } });
  const result = readToken({ env: {}, run: () => expired, now: 2000000, platform: 'darwin' });
  assert.ok(!result.token, 'a dead credential must not be handed over');
  assert.match(result.error, /expired/);
  // A token expiring in thirty seconds is treated as expired: it is fetched just
  // before the request that uses it.
  const soon = JSON.stringify({ claudeAiOauth: { accessToken: 'nearly', expiresAt: 1000000 + 30000 } });
  assert.match(readToken({ env: {}, run: () => soon, now: 1000000, platform: 'darwin' }).error, /expired/);
  const fine = JSON.stringify({ claudeAiOauth: { accessToken: 'good', expiresAt: 1000000 + 600000 } });
  assert.equal(readToken({ env: {}, run: () => fine, now: 1000000, platform: 'darwin' }).token, 'good');
});

ok('every failure says which one it was', () => {
  const cases = [
    [() => { const e = new Error('boom'); e.status = 44; throw e; }, /item not found/],
    [() => 'not json at all', /not JSON/],
    [() => JSON.stringify({ claudeAiOauth: {} }), /no claudeAiOauth\.accessToken/],
  ];
  for (const [run, pattern] of cases) {
    const result = readToken({ env: {}, run, platform: 'darwin' });
    assert.ok(!result.token);
    assert.match(result.error, pattern);
  }
});

ok('off macOS it says so, instead of shelling out to a binary that is not there', () => {
  // The implementation returns this before touching `security`. Asserting it keeps
  // the platform branch honest on the runners where the keychain does not exist.
  const result = readToken({ env: {}, run: () => { throw new Error('must not be called'); }, platform: 'linux' });
  assert.ok(!result.token);
  assert.match(result.error, /macOS only/);
});

ok('the task settings actually name the helper', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'task-runner.js'), 'utf8');
  assert.match(runner, /apiKeyHelper: `node '\$\{keyHelper\}'`/, 'a helper nothing points at authenticates nothing');
  assert.match(runner, /claude-key-helper\.js/);
  assert.ok(/--settings', runtime\.claudeSettings/.test(runner) || runner.includes("'--settings', runtime.claudeSettings"),
    'and the settings file has to be passed to the CLI');
});

if (failures) { console.error(`claude key helper selftest: ${failures} FAILED`); process.exit(1); }
console.log('claude key helper selftest: PASS · explicit key wins · keychain by absolute path not $HOME · one field only · expiry refused · every failure named');
