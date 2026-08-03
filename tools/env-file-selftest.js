'use strict';

// The packaged app could not see its own keys.
//
// `.env` lived only in the checkout. That works for a daemon started from source
// and cannot work for the .app, whose root resolves to Contents/Resources/app —
// where a secrets file correctly is not. Measured 2026-08-03: with a valid
// ZAI_API_KEY on disk, the GUI still drew GLM as OFFLINE, because the process
// drawing that label had never read the file.
//
// The data root is the right home: owned by the owner rather than by a checkout,
// outside the git repository, outside the bundle, and unaffected by a rebuild.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { envCandidates, loadEnvFiles } = require('../src/core/env-file');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-env-'));
const dataRoot = path.join(root, 'data'); const appRoot = path.join(root, 'app');
fs.mkdirSync(dataRoot); fs.mkdirSync(appRoot);

ok('the data root is tried before the checkout', () => {
  assert.deepEqual(envCandidates({ dataRoot, appRoot }), [path.join(dataRoot, '.env'), path.join(appRoot, '.env')]);
  // A packaged app has no useful appRoot for this; a fresh clone has no dataRoot yet.
  assert.deepEqual(envCandidates({ dataRoot }), [path.join(dataRoot, '.env')]);
  assert.deepEqual(envCandidates({ appRoot }), [path.join(appRoot, '.env')]);
  assert.deepEqual(envCandidates({}), []);
});

ok('a missing file is not an error, it is just a missing file', () => {
  const env = {};
  const read = loadEnvFiles({ dataRoot, appRoot, dotenv: { config: () => ({ error: new Error('ENOENT') }) } });
  assert.deepEqual(read, []);
  assert.deepEqual(env, {});
});

ok('both locations are read, and the first one wins', () => {
  // dotenv does not overwrite a variable that is already set, so reading the data
  // root first is what makes it authoritative.
  const seen = [];
  const dotenv = {
    config: ({ path: file }) => {
      seen.push(file);
      if (!fs.existsSync(file)) return { error: new Error('ENOENT') };
      return { parsed: { WHERE: path.basename(path.dirname(file)) } };
    },
  };
  fs.writeFileSync(path.join(appRoot, '.env'), 'WHERE=app\n');
  assert.deepEqual(loadEnvFiles({ dataRoot, appRoot, dotenv }), [path.join(appRoot, '.env')],
    'a checkout with no data root still works — that is the development case');
  fs.writeFileSync(path.join(dataRoot, '.env'), 'WHERE=data\n');
  assert.deepEqual(loadEnvFiles({ dataRoot, appRoot, dotenv }),
    [path.join(dataRoot, '.env'), path.join(appRoot, '.env')]);
  assert.equal(seen[seen.length - 2], path.join(dataRoot, '.env'), 'the data root is asked first');
});

ok('both surfaces use it, so they cannot disagree about which keys exist', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  for (const [name, source] of [['main.js', main], ['daemon.js', daemon]]) {
    assert.match(source, /loadEnvFiles\(\{/, `${name} must load through the shared resolver`);
    assert.ok(!/dotenv'?\)?\.config\(\{ path: (?:path|require\('path'\))\.join\((?:APP_ROOT|__dirname)/.test(source),
      `${name} must not go straight at the checkout copy`);
  }
});

ok('nothing writes a secret to disk', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'env-file.js'), 'utf8');
  for (const forbidden of ['writeFile', 'appendFile', 'createWriteStream']) {
    assert.ok(!source.includes(forbidden), 'putting a key on disk is the owner’s action, never this module’s');
  }
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`env file selftest: ${failures} FAILED`); process.exit(1); }
console.log('env file selftest: PASS · data root before checkout · a missing file is not an error · both surfaces share the resolver · read-only');
