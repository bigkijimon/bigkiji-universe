'use strict';
// One bounded JSON list on disk, written atomically.
//
// Two memories keep one of these each — DeliberationMemory (which plan worked) and
// FailureMemory (which failure recurs and what fixed it) — and both had their own copy
// of these twelve lines. That is duplication of the kind worth removing: every line of
// it is load-bearing, and a copy is a place the fix does not reach.
//
//   0o700 on the directory, 0o600 on the file   these are the owner's private notes
//   tmp + rename                                a half-written memory reads as an empty
//                                               one, and an empty one is silently "we
//                                               have never seen this before"
//   pid in the tmp name                         the app, the daemon and the CLI can all
//                                               hold the same store open
//   slice(-limit) on write                      bounded without a separate sweep
//
// Never throws. A memory that cannot be read is a memory that knows nothing, which is
// the safe answer; a memory that cannot be written loses one lesson rather than the
// turn that produced it.

const fs = require('fs');
const path = require('path');

/**
 * @param {string} file
 * @param {string} key the array property this store keeps, e.g. 'plans'
 * @returns {object} always shaped `{ version, [key]: [] }`
 */
function readList(file, key) {
  const empty = { version: 1, [key]: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value?.[key]) ? value : empty;
  } catch (_) { return empty; }
}

/**
 * @param {string} file
 * @param {string} key
 * @param {object} memory
 * @param {number} limit newest `limit` entries are kept
 */
function writeList(file, key, memory, limit) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const entries = Array.isArray(memory?.[key]) ? memory[key] : [];
    fs.writeFileSync(tmp, JSON.stringify({ ...memory, [key]: entries.slice(-limit) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_) {}
}

module.exports = { readList, writeList };
