'use strict';

// The folder the owner shares with their phone (iCloud Drive / BigkijiUniverse-Check).
//
// Three drawers, and they are not the same kind of thing:
//   input/        the owner drops things in from the phone. Nothing here is processed.
//                 It is a pile, on purpose — the owner asks to look at it when they
//                 want to, and paying an LLM to watch a folder is the opposite of that.
//   deliverables/ finished work, saved so the phone can actually run or play it.
//   reports/      what was checked, written so it can be verified from the phone.
//
// The one thing that genuinely needs code is the first drawer. With "Optimize Mac
// Storage" on — which it is on this machine — a file the phone uploads does not land
// on the Mac. What lands is a zero-byte stub named `.thing.jpg.icloud`, and the real
// bytes stay in iCloud until something asks for them. So a plain readdir of `input/`
// reports an empty folder while the phone insists it sent five screenshots. Everything
// here exists to make "have a look at what I sent" mean what it says.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KINDS = [
  { kind: 'image', ext: new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.gif', '.webp']) },
  { kind: 'video', ext: new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv']) },
  { kind: 'text', ext: new Set(['.txt', '.md', '.markdown', '.rtf']) },
  { kind: 'link', ext: new Set(['.webloc', '.url']) },
  { kind: 'document', ext: new Set(['.pdf', '.pages', '.numbers', '.key', '.csv', '.json']) },
  { kind: 'audio', ext: new Set(['.m4a', '.mp3', '.wav', '.aiff']) },
];

/** What kind of thing this is, by extension. Unknown is a kind too — never dropped. */
function kindOf(name) {
  const ext = path.extname(String(name)).toLowerCase();
  for (const entry of KINDS) if (entry.ext.has(ext)) return entry.kind;
  return 'other';
}

/**
 * The real name behind an iCloud placeholder.
 *
 * `.holiday.jpg.icloud` is not a file called `.holiday.jpg.icloud`. It is `holiday.jpg`
 * with the bytes elsewhere. Reporting the stub's own name would show the owner a
 * filename they have never seen, so the stub is translated back.
 *
 * @returns {{name: string, placeholder: boolean}}
 */
function realName(entryName) {
  const name = String(entryName);
  if (name.startsWith('.') && name.endsWith('.icloud')) {
    return { name: name.slice(1, -'.icloud'.length), placeholder: true };
  }
  return { name, placeholder: false };
}

/** Hidden bookkeeping the owner did not put there. `.DS_Store` is not an input. */
function ignored(name) {
  const { name: real, placeholder } = realName(name);
  if (!placeholder && name.startsWith('.')) return true;
  return real === '.DS_Store' || real === 'Icon\r';
}

/**
 * Everything in a directory, placeholders resolved to what they will become.
 * Sorted newest first, because the thing just sent is the thing being asked about.
 */
function inventory(dir, { fsImpl = fs } = {}) {
  let entries = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const items = [];
  for (const entry of entries) {
    if (entry.isDirectory() || ignored(entry.name)) continue;
    const { name, placeholder } = realName(entry.name);
    let size = 0; let modified = 0;
    try {
      const stat = fsImpl.statSync(path.join(dir, entry.name));
      size = stat.size; modified = stat.mtimeMs;
    } catch (_) { /* vanished between readdir and stat; report it as zero */ }
    items.push({ name, kind: kindOf(name), placeholder, size, modified,
      path: path.join(dir, placeholder ? entry.name : name) });
  }
  return items.sort((a, b) => b.modified - a.modified);
}

function run(file, args, timeout) {
  return new Promise((resolve) => execFile(file, args, { timeout }, (error) => resolve(!error)));
}

/**
 * Pull the bytes down for anything that is still a stub.
 *
 * `brctl download` is asynchronous underneath: it returns before the file is whole, so
 * the placeholder is polled away rather than assumed gone. A file that never arrives is
 * reported as still pending instead of being presented as empty — the owner is offline,
 * or iCloud is busy, and "your screenshot is blank" would be a lie.
 */
async function materialise(dir, { timeoutMs = 20000, brctl = 'brctl', pollMs = 400, fsImpl = fs } = {}) {
  const pending = inventory(dir, { fsImpl }).filter((item) => item.placeholder);
  if (!pending.length) return { requested: 0, arrived: [], stillPending: [] };
  for (const item of pending) await run(brctl, ['download', item.path], timeoutMs);

  const deadline = Date.now() + timeoutMs;
  let waiting = pending.map((item) => item.name);
  while (waiting.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const now = new Set(inventory(dir, { fsImpl }).filter((item) => item.placeholder).map((item) => item.name));
    waiting = waiting.filter((name) => now.has(name));
  }
  return {
    requested: pending.length,
    arrived: pending.map((item) => item.name).filter((name) => !waiting.includes(name)),
    stillPending: waiting,
  };
}

/** Where the drawers are, given the resolved check root. */
function layout(checkRoot) {
  return {
    root: checkRoot,
    input: path.join(checkRoot, 'input'),
    deliverables: path.join(checkRoot, 'deliverables'),
    reports: path.join(checkRoot, 'reports'),
  };
}

function ensure(checkRoot, { fsImpl = fs } = {}) {
  const dirs = layout(checkRoot);
  for (const dir of [dirs.root, dirs.input, dirs.deliverables, dirs.reports]) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

const KB = 1024;
function human(size) {
  if (size < KB) return `${size}B`;
  if (size < KB * KB) return `${Math.round(size / KB)}KB`;
  return `${(size / KB / KB).toFixed(1)}MB`;
}

/**
 * One screen's worth of "what is in there". Plain text on purpose: this is read in a
 * terminal and pasted into a conversation, not rendered.
 */
function summarise(items, { now = 0 } = {}) {
  if (!items.length) return 'input: 空';
  const byKind = new Map();
  for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) || 0) + 1);
  const counts = [...byKind].map(([kind, n]) => `${kind}×${n}`).join(' ');
  const lines = items.map((item) => {
    const age = now && item.modified ? `${Math.max(0, Math.round((now - item.modified) / 60000))}分前` : '';
    return `  ${item.placeholder ? '☁️ ' : '   '}${item.name}  ${item.kind}  ${human(item.size)}${age ? `  ${age}` : ''}`;
  });
  return [`input: ${items.length}件 (${counts})`, ...lines].join('\n');
}

module.exports = { kindOf, realName, ignored, inventory, materialise, layout, ensure, summarise, human, KINDS };
