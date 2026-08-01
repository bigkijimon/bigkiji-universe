'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const broken = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:require\(|from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (![target, `${target}.js`, `${target}.mjs`, path.join(target, 'index.js')].some(fs.existsSync)) broken.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }
}
walk(path.join(root, 'src')); walk(path.join(root, 'tools'));
assert.deepStrictEqual(broken, [], `Broken relative imports:\n${broken.join('\n')}`);
console.log('relative import selftest: PASS');
