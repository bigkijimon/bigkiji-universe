#!/usr/bin/env node
'use strict';

// Stamp the build so "I fixed it" can be checked against what is running.
//
// The owner spent a morning reporting bugs that had been fixed hours earlier:
// the .app on screen was built at 14:27 the previous day and forty-five commits
// behind, while the CLI and the daemon ran straight from source. Nothing on
// screen said so. main.js already read BIGKIJI_BUILD_ID, but only from the
// runtime environment — an environment the packaged app never has — so every
// build displayed the same string and the staleness stayed invisible.
//
// This writes the identity at pack time, which is the only moment that knows it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'core', 'build-info.json');

/** The short commit, or an honest marker that there wasn't one. */
function commit() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch (_) { return 'nogit'; }
}
/** Whether the tree had uncommitted changes — a build from a dirty tree is not its commit. */
function dirty() {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0; }
  catch (_) { return false; }
}

function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const when = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const sha = commit();
  return {
    version: require(path.join(ROOT, 'package.json')).version,
    commit: sha,
    dirty: dirty(),
    buildId: `${sha}${dirty() ? '+' : '-'}${when}`,
    builtAt: now.toISOString(),
  };
}

if (require.main === module) {
  const info = stamp();
  fs.writeFileSync(OUT, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`build stamped: ${info.buildId} (v${info.version}${info.dirty ? ', dirty tree' : ''})`);
}

module.exports = { stamp, OUT };
