'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// Files produced by the build, not committed, and loaded behind a fallback.
// main.js wraps the build stamp in a try/catch that yields null on purpose — a run
// from a clone has no stamp and must still start. Without this list the check fails on
// every fresh checkout, which is exactly where it matters most: CI was red on
// `npm test` for this reason, so nobody could clone the project and verify anything.
// An entry here is a promise that the importer handles the file being absent.
//
// Note for whoever edits this comment: the scanner below reads *this* file too, so do
// not write a literal require of a relative path in a comment. It will be flagged.
const GENERATED = new Set([
  path.join(root, 'src', 'core', 'build-info.json'),
]);

const broken = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:require\(|from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (GENERATED.has(target)) continue;
        if (![target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')].some(fs.existsSync)) broken.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }
}
walk(path.join(root, 'src')); walk(path.join(root, 'tools'));
assert.deepStrictEqual(broken, [], `Broken relative imports:\n${broken.join('\n')}`);
console.log('relative import selftest: PASS');
