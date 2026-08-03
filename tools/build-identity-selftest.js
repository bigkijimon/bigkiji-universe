'use strict';

// Know which build is on screen.
//
// The owner reported five screenfuls of bugs that had all been fixed hours
// earlier. The .app running was packaged the previous afternoon and forty-five
// commits behind; the CLI and the daemon ran straight from source. Whichever
// process reached port 8777 first won, and nothing compared the two, so a 1.0.0
// GUI drove a 2.5.0 engine all morning without a word.
//
// Two things had to be true and were not: a build has to carry its own identity,
// and a surface has to notice when the engine is not the same build.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { stamp } = require('./stamp-build');
const { DaemonClient } = require('../src/domain/server/daemon-client');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

(async () => {
  // --- the stamp identifies one build and not another ----------------------
  const a = stamp(new Date('2026-08-03T12:34:00'));
  assert.match(a.buildId, /^[0-9a-f]{7,}[-+]0803-1234$/, `a build id has to name its commit and its minute: ${a.buildId}`);
  assert.equal(a.version, require('../package.json').version);
  const b = stamp(new Date('2026-08-03T12:35:00'));
  assert.notEqual(a.buildId, b.buildId, 'two builds a minute apart must not be indistinguishable');
  // A dirty tree is not its commit, and saying it is would restart the exact
  // confusion this file exists to end.
  assert.ok(a.buildId.includes(a.dirty ? '+' : '-'), 'a build from a modified tree has to say so');

  // main.js has to read the stamped file. Reading only the environment is what
  // made every packaged build display the same string.
  const main = read('src/core/main.js');
  assert.match(main, /require\('\.\/build-info\.json'\)/, 'the app must read the stamp that pack time wrote');
  assert.match(main, /BUILD_INFO\?\.buildId/, 'and prefer it over the version literal');
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['dist:local', 'dist:mac']) {
    assert.match(pkg.scripts[script], /^node tools\/stamp-build\.js &&/, `${script} must stamp before it packs`);
  }

  // --- a mismatched engine cannot stay invisible ---------------------------
  const client = new DaemonClient({ appRoot: path.join(__dirname, '..') });
  const seen = [];
  client.on('version-mismatch', (gap) => seen.push(gap));
  assert.equal(client.versionGap({ appVersion: pkg.version }), null, 'the same version is not a mismatch');
  assert.equal(seen.length, 0);
  const gap = client.versionGap({ appVersion: '1.0.0' });
  assert.deepEqual(gap, { ours: pkg.version, theirs: '1.0.0' }, 'and a different one is reported both ways round');
  assert.deepEqual(seen, [gap], 'as an event, so a surface can show it');
  assert.equal(client.versionGap({}), null, 'a daemon too old to report its version is not evidence of anything');
  assert.equal(client.versionGap(null), null);

  // ensure() has to carry the verdict, not compute it and drop it.
  const source = read('src/domain/server/daemon-client.js');
  assert.equal((source.match(/versionGap: this\.versionGap\(/g) || []).length, 2,
    'both the attach path and the spawn path must report it');
  const cli = read('src/domain/terminal/bigkiji-cli.js');
  assert.match(cli, /client\.on\('version-mismatch'/, 'the CLI has to say it out loud');
  assert.match(cli, /client\.versionGap\(health\)/, 'including on the path where the daemon was already running — the one that actually happened');

  console.log('build identity selftest: PASS · stamp names commit+minute and marks a dirty tree · dist scripts stamp first · a mismatched engine is announced, not hidden');
})().catch((error) => { console.error(error); process.exit(1); });
