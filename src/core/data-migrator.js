'use strict';
// Moves the entries chosen by migration-plan.js into the app-owned data root.
//
// Transactional model:
//   * per entry, atomic on the same volume (fs.rename)
//   * across volumes, resumable rather than atomic (copy -> verify -> delete source)
//   * the manifest is written BEFORE any mutation and updated after every state change
//   * the data-root pointer and settings.paths.* are written LAST, so a crash at any
//     point leaves the app still reading the legacy locations
// The source is deleted strictly last, which is what makes rollback always possible.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { writeJsonAtomic } = require('./data-root');

const HASH_LIMIT = 32 * 1024 * 1024; // full sha256 below this; sampled digest above
const SAMPLE = 1024 * 1024;

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function freeBytes(target) {
  let probe = path.resolve(target);
  for (let depth = 0; depth < 64; depth += 1) {
    try { const stat = fs.statfsSync(probe); return stat.bavail * stat.bsize; } catch (_) {}
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return Infinity; // statfs unavailable: do not block the owner on a check we cannot make
}

// Refuse conditions are hard failures, not warnings — each one silently corrupts
// something if allowed through.
function preflight({ plan, layout, vaultRoot = '' }) {
  const errors = [];
  if (vaultRoot && isInside(vaultRoot, layout.dataRoot)) {
    errors.push('The data root cannot live inside your Obsidian vault: the app scans the vault and would index its own state.');
  }
  for (const entry of plan.entries) {
    if (isInside(entry.src, entry.dst) || isInside(entry.dst, entry.src)) {
      errors.push(`${entry.id}: source and destination overlap (${entry.src} -> ${entry.dst}).`);
    }
  }
  // The copy path needs source and destination to coexist, so require headroom.
  const needed = Math.round(plan.totalBytes * 1.2);
  const available = freeBytes(path.dirname(layout.dataRoot));
  if (available < needed) {
    errors.push(`Not enough free space: ${Math.ceil(needed / 1e6)} MB required, ${Math.floor(available / 1e6)} MB available.`);
  }
  return { ok: errors.length === 0, errors, needed, available };
}

function digestFile(file, size) {
  const hash = crypto.createHash('sha256');
  if (size <= HASH_LIMIT) {
    hash.update(fs.readFileSync(file));
    return { algo: 'sha256', value: hash.digest('hex') };
  }
  // Full hashing of multi-gigabyte model blobs costs minutes and buys little over a
  // size check; sample the head, middle and tail instead and say so in the manifest.
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(SAMPLE);
    for (const offset of [0, Math.max(0, Math.floor(size / 2) - SAMPLE / 2), Math.max(0, size - SAMPLE)]) {
      const read = fs.readSync(handle, buffer, 0, SAMPLE, offset);
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(handle); }
  hash.update(String(size));
  return { algo: 'sampled', value: hash.digest('hex') };
}

function walk(root) {
  const out = new Map();
  let stat = null;
  try { stat = fs.lstatSync(root); } catch (_) { return out; }
  if (!stat.isDirectory()) { out.set(path.basename(root), stat.size); return out; }
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) { stack.push(childRel); continue; }
      try { out.set(childRel, fs.lstatSync(path.join(root, childRel)).size); } catch (_) {}
    }
  }
  return out;
}

// Merge semantics: newer mtime wins. The knowledge stores under <userData> and under
// ~/.pi have genuinely diverged copies of the same filenames, so a blind overwrite in
// either direction would discard real data.
// Returns the source files that were actually written to the destination. Files we
// skipped (because the destination copy is newer) are deliberately NOT reported, and
// the caller must not delete them: their contents were never carried across, so
// removing the source would silently discard the owner's older revision and would
// also make rollback inexact.
async function mergeCopy(src, dst, copied = []) {
  const stat = await fsp.lstat(src);
  if (!stat.isDirectory()) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    let existing = null;
    try { existing = await fsp.lstat(dst); } catch (_) {}
    if (existing && existing.mtimeMs >= stat.mtimeMs) return copied;
    await fsp.copyFile(src, dst);
    await fsp.utimes(dst, stat.atime, stat.mtime);
    copied.push(src);
    return copied;
  }
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    await mergeCopy(path.join(src, entry.name), path.join(dst, entry.name), copied);
  }
  return copied;
}

// Remove exactly the files we carried across, then any directories left empty.
// Anything the merge skipped stays where it is.
async function removeCopiedSources(root, copied) {
  for (const file of copied) { try { await fsp.rm(file, { force: true }); } catch (_) {} }
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    dirs.push(dir);
    for (const entry of entries) if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
  }
  for (const dir of dirs.reverse()) { try { await fsp.rmdir(dir); } catch (_) {} }
  return !fs.existsSync(root);
}

function verifyCopy(src, dst) {
  const from = walk(src); const to = walk(dst);
  const missing = [];
  for (const [rel, size] of from) {
    if (!to.has(rel)) { missing.push(rel); continue; }
    if (to.get(rel) !== size) {
      // A merge legitimately keeps a newer destination file of a different size.
      let srcNewer = false;
      try { srcNewer = fs.lstatSync(path.join(src, rel)).mtimeMs > fs.lstatSync(path.join(dst, rel)).mtimeMs; } catch (_) {}
      if (srcNewer) missing.push(`${rel} (size mismatch)`);
    }
  }
  return { ok: missing.length === 0, missing: missing.slice(0, 20), files: from.size };
}

function manifestFile(layout, startedAt) {
  return path.join(layout.migrationsRoot, `manifest-${startedAt.replace(/[:.]/g, '-')}.json`);
}

async function executeMigration({ plan, layout, userData, startedAt, settingsBefore = {}, onProgress = () => {} }) {
  fs.mkdirSync(layout.migrationsRoot, { recursive: true });
  const manifest = {
    version: 1,
    startedAt,
    status: 'pending',
    dataRoot: layout.dataRoot,
    userData,
    settingsBefore,
    entries: plan.entries.map((entry) => ({
      id: entry.id, src: entry.src, dst: entry.dst, kind: entry.kind, group: entry.group,
      bytes: entry.bytes, files: entry.files, copyOnly: !!entry.copyOnly, mode: entry.mode || null,
      strategy: 'pending', state: 'pending', digest: null, error: '',
    })),
  };
  const file = manifestFile(layout, startedAt);
  const save = () => writeJsonAtomic(file, manifest, 0o600);
  save();

  for (const record of manifest.entries) {
    onProgress({ id: record.id, state: 'start', bytes: record.bytes });
    try {
      await fsp.mkdir(path.dirname(record.dst), { recursive: true });
      const canRename = !record.copyOnly && !fs.existsSync(record.dst);
      if (canRename) {
        try {
          await fsp.rename(record.src, record.dst);
          record.strategy = 'rename'; record.state = 'moved';
        } catch (err) {
          if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') throw err;
          record.strategy = 'copy';
        }
      } else {
        record.strategy = 'copy';
      }

      if (record.strategy === 'copy' && record.state !== 'moved') {
        const copied = await mergeCopy(record.src, record.dst);
        record.copiedFiles = copied.length;
        record.keptAtSource = Math.max(0, record.files - copied.length);
        record.state = 'copied'; save();
        const check = verifyCopy(record.src, record.dst);
        if (!check.ok) throw new Error(`verification failed, missing: ${check.missing.join(', ')}`);
        if (record.kind === 'file') record.digest = digestFile(record.dst, record.bytes);
        record.state = 'verified'; save();
        if (!record.copyOnly) {
          // Delete only what we actually carried across. Where the destination already
          // held a newer copy the merge skipped the source, so its contents were never
          // transferred — removing it would discard the owner's older revision outright
          // and would make rollback inexact.
          const gone = await removeCopiedSources(record.src, copied);
          record.state = gone ? 'moved' : 'moved-partial';
        } else {
          record.state = 'merged';
        }
      }

      // Copying does not always preserve restrictive modes; 0600 files must stay 0600.
      if (record.mode && fs.existsSync(record.dst)) {
        try { await fsp.chmod(record.dst, record.mode); } catch (_) {}
      }
      save();
      onProgress({ id: record.id, state: record.state, bytes: record.bytes });
    } catch (err) {
      record.state = 'failed'; record.error = String(err && err.message).slice(0, 300);
      manifest.status = 'failed'; save();
      onProgress({ id: record.id, state: 'failed', error: record.error });
      return { manifest, manifestPath: file, ok: false };
    }
  }

  manifest.status = 'complete';
  manifest.finishedAt = new Date().toISOString();
  save();
  return { manifest, manifestPath: file, ok: true };
}

async function rollbackMigration({ manifest, manifestPath }) {
  const reverted = [];
  for (const record of [...manifest.entries].reverse()) {
    try {
      if (record.state === 'moved' && record.strategy === 'rename') {
        await fsp.mkdir(path.dirname(record.src), { recursive: true });
        await fsp.rename(record.dst, record.src);
        reverted.push(record.id);
      } else if (record.state === 'moved' || record.state === 'moved-partial') {
        await mergeCopy(record.dst, record.src);
        await fsp.rm(record.dst, { recursive: true, force: true });
        reverted.push(record.id);
      } else if (record.state === 'copied' || record.state === 'verified' || record.state === 'merged') {
        // Source is still present; discarding the destination is enough.
        await fsp.rm(record.dst, { recursive: true, force: true });
        reverted.push(record.id);
      }
      record.state = 'reverted';
    } catch (err) {
      record.error = `rollback failed: ${String(err && err.message).slice(0, 200)}`;
    }
  }
  manifest.status = 'rolled-back';
  manifest.rolledBackAt = new Date().toISOString();
  if (manifestPath) writeJsonAtomic(manifestPath, manifest, 0o600);
  return { reverted, manifest };
}

// A pending manifest at launch means the previous run died mid-flight.
function findPendingManifest(layout) {
  let files = [];
  try { files = fs.readdirSync(layout.migrationsRoot).filter((name) => name.startsWith('manifest-')); } catch (_) { return null; }
  for (const name of files.sort().reverse()) {
    const manifestPath = path.join(layout.migrationsRoot, name);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.status === 'pending' || manifest.status === 'failed') return { manifest, manifestPath };
    } catch (_) {}
  }
  return null;
}

module.exports = { preflight, executeMigration, rollbackMigration, findPendingManifest, verifyCopy, digestFile, isInside, freeBytes };
