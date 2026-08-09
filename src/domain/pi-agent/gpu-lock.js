'use strict';

// Whether the local model can answer at all right now.
//
// This machine serialises GPU work with gpu-signal.sh (Executive_Office/経営企画室).
// When a generation job takes the card it writes /tmp/bigkiji_gpu.lock and SIGSTOPs
// Ollama; ~/.bigkiji/ollama-watchdog.sh then refuses to thaw for as long as that lock
// exists. So Ollama is not down, not busy and not slow — it is stopped, and it will
// stay stopped until someone else's job finishes.
//
// Nothing in this app knew that. Measured in the owner's session on 2026-08-09:
//
//     10:05:45  /tmp/bigkiji_gpu.lock  ← "u09-final" (LTX video job, pid 92986)
//     10:05     ollama pid 1190 → STAT T, llama-server pid 75226 → STAT T
//     10:24     owner starts the CLI and asks a question
//     10:24:55  provider "deterministic-local", latencyMs 8012
//     10:25:26  provider "deterministic-local", latencyMs 8007
//     10:25:18  owner: 「指示が通ってないかも。」
//
// 8012ms and 8007ms are ConversationEngine's 8s stall deadline, to the millisecond:
// the connection was accepted by a stopped process and no byte ever came back. The
// owner got a template that reads like a considered reply, twice, and concluded the
// thing was broken. It was frozen, on purpose, by another part of the same company.
//
// This module exists so the app can say that sentence instead of guessing.
//
// It reads. It never writes, never signals, never thaws — the freeze belongs to
// gpu-signal.sh and the watchdog, and an app that un-freezes the GPU underneath a
// running render is a worse bug than the one this fixes.

const fs = require('fs');
const { execFileSync } = require('child_process');

// Written by gpu-signal.sh as `<name> <HH:MM:SS>`; see its LOCK= at line 22.
const LOCK_PATH = '/tmp/bigkiji_gpu.lock';

// The two processes gpu-mem-switch stops. `ollama` here is the server binary under
// Ollama.app/Contents/Resources, not the CLI wrapper the owner types.
const FROZEN_PROCS = Object.freeze(['ollama', 'llama-server']);

/**
 * Who holds the GPU, if anyone.
 *
 * `holder` and `since` come from the lock file's own single line, so they are whatever
 * gpu-signal.sh wrote — a job name and a wall-clock time, not a pid. That is enough to
 * tell the owner which of their own jobs is in the way, which is the only thing the
 * sentence needs.
 *
 * @param {{path?: string, readFile?: (file: string, enc: string) => string, statFile?: (file: string) => {mtimeMs: number}}} deps
 * @returns {{held: boolean, holder: string, since: string, ageMs: number|null}}
 */
function readGpuLock({ path: lockPath = LOCK_PATH, readFile = fs.readFileSync, statFile = fs.statSync } = {}) {
  const absent = { held: false, holder: '', since: '', ageMs: null };
  let line = '';
  try { line = String(readFile(lockPath, 'utf8') || '').trim(); } catch (_) { return absent; }
  // An empty lock file is a lock: gpu-signal.sh creates it before it writes the line,
  // and a job that got the card half a millisecond ago still has it.
  const [holder = '', since = ''] = line.split(/\s+/);
  let ageMs = null;
  // mtime, not the HH:MM:SS in the file — that string has no date on it, so a lock left
  // over from yesterday would read as minutes old.
  try { ageMs = Math.max(0, Date.now() - statFile(lockPath).mtimeMs); } catch (_) {}
  return { held: true, holder, since, ageMs };
}

/**
 * Are the local model processes stopped.
 *
 * Returns `null` for "could not tell" and never `false` on a failed lookup: reporting a
 * frozen model as running is the mistake this whole module exists to stop making.
 *
 * @param {{run?: () => string, names?: string[]}} deps
 * @returns {{frozen: boolean, stopped: string[]}|null}
 */
function ollamaFrozen({ run = () => execFileSync('ps', ['-Ao', 'stat,comm'], { encoding: 'utf8', timeout: 2000 }),
  names = FROZEN_PROCS } = {}) {
  let table = '';
  try { table = String(run() || ''); } catch (_) { return null; }
  if (!table.trim()) return null;
  const stopped = [];
  for (const row of table.split('\n').slice(1)) {
    const match = row.trim().match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, stat, command] = match;
    // T is stopped by a signal, so is its threaded variant. Anything else — S, R, U,
    // and the +/</N/s suffixes macOS appends — is a process that can still answer.
    if (!/^T/.test(stat)) continue;
    const name = command.trim().split('/').pop();
    if (names.includes(name)) stopped.push(name);
  }
  return { frozen: stopped.length > 0, stopped };
}

/**
 * One sentence for the owner, or '' when the local model's silence has no explanation
 * this module can vouch for.
 *
 * Deliberately says nothing when the lock is absent even if a process reads as stopped:
 * a stopped Ollama with no lock is a different fault (a job that died holding the freeze,
 * measured once — llama-server pid 75226 sat in T for a day), and guessing at its cause
 * in the owner's chat window is how the last round of wrong-but-plausible answers
 * happened. `frozenWithoutLock` is reported separately for the status surface.
 *
 * @param {{lock?: object, procs?: object|null, japanese?: boolean}} deps
 * @returns {string}
 */
function freezeExplanation({ lock = readGpuLock(), procs = ollamaFrozen(), japanese = true } = {}) {
  if (!lock.held) return '';
  const who = lock.holder || 'a generation job';
  const when = lock.since ? (japanese ? `${lock.since}から` : `since ${lock.since}`) : '';
  // procs === null means ps did not answer. The lock alone is enough to explain the
  // silence, so the sentence is still said — just without claiming to have seen T.
  const confirmed = procs?.frozen ?? null;
  if (japanese) {
    return `（GPUを「${who}」が${when}使用中のため、ローカルモデルは停止しています`
      + `${confirmed === false ? '（プロセスは動いているので、原因は別かもしれません）' : ''}。`
      + `生成が終わるまで会話は定型文になります）\n`;
  }
  return `(the GPU is held by “${who}” ${when} and the local model is stopped`
    + `${confirmed === false ? ' — though its process is running, so this may be something else' : ''}`
    + `; replies are templates until that job finishes)\n`;
}

/** True when the model is stopped and nothing holds the lock — a freeze nobody will lift. */
function frozenWithoutLock(deps = {}) {
  const lock = deps.lock || readGpuLock();
  const procs = deps.procs === undefined ? ollamaFrozen() : deps.procs;
  return !lock.held && procs?.frozen === true;
}

module.exports = { readGpuLock, ollamaFrozen, freezeExplanation, frozenWithoutLock, LOCK_PATH, FROZEN_PROCS };
