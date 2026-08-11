'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeMode } = require('./cli-theme');

const DEFAULTS = Object.freeze({ theme: 'warm-brown', modeAccent: 'follow', contrast: 'standard', mode: 'ask', catCommentary: 'low', modeMigration: 1 });

// Changing a default does not reach a machine that has already run.
//
// `normalize()` is `{...DEFAULTS, ...saved}`, so a key present in the saved file always
// wins — and every machine that has ever started this CLI has `"mode": "plan"` written
// into cli-config.json. This project has been bitten by exactly this shape once already:
// a settings.json pinning qwen2.5:0.5b outlived the default that replaced it and the
// owner ran a whole session against a 0.5B model (settings-store.js RETIRED_CHAT_MODELS,
// 2026-08-04). Same remedy: migrate once, record that it happened, and never touch the
// value again — so an owner who deliberately goes back to `plan` keeps it.
const MODE_MIGRATION = 1;
// What the up arrow can reach after the terminal has been closed and reopened.
//
// readline keeps a history in memory and throws it away on exit, so every restart began
// with an empty up arrow — and this CLI is restarted often, because until today it could
// not tell the owner its code was stale. 200 lines is what Claude Code keeps.
const HISTORY_LIMIT = 200;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
class CliPreferences {
  // An explicit root or file always wins, so callers (and tests) stay isolated from
  // the real data root. Only when neither is given do we resolve the app data root.
  constructor({ root = '', file = '' } = {}) {
    this.file = file || (root ? path.join(root, 'config.json') : CliPreferences.defaultFile());
    this.root = root || path.dirname(this.file); this.state = this.load();
  }
  static defaultFile() {
    const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
    const data = resolveDataRoot({ userData: defaultUserData() });
    return dataLayout(data.dataRoot, data.overrides).cliConfigFile;
  }
  load() { try { return this.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) { return clone(DEFAULTS); } }
  normalize(value = {}) {
    const next = { ...DEFAULTS, ...value };
    // The one-shot move off `plan`. It runs for a file written before this migration
    // existed, and for no file after: `modeMigration` is stamped below either way, so
    // choosing `plan` again survives every later start.
    if (Number(value?.modeMigration || 0) < MODE_MIGRATION && normalizeMode(next.mode) === 'plan') next.mode = 'ask';
    next.modeMigration = MODE_MIGRATION;
    next.mode = normalizeMode(next.mode); next.theme = 'warm-brown';
    next.modeAccent = next.modeAccent === 'fixed-orange' ? 'fixed-orange' : 'follow';
    next.contrast = next.contrast === 'high' ? 'high' : 'standard';
    next.catCommentary = next.catCommentary === 'periodic' ? 'periodic' : 'low';
    return next;
  }
  get() { return clone(this.state); }
  /**
   * The input history, newest first — the order readline's own `history` array uses,
   * so it can be handed straight to createInterface and taken straight back off `rl`.
   *
   * A separate file from the preferences on purpose: this one is written on every exit
   * and read by nothing else, and mixing it into config.json would put 200 lines of the
   * owner's typing in front of every settings read.
   */
  historyFile() { return path.join(this.root, 'cli-history.json'); }
  history() {
    try {
      const rows = JSON.parse(fs.readFileSync(this.historyFile(), 'utf8'));
      return Array.isArray(rows) ? rows.filter((row) => typeof row === 'string' && row.trim()).slice(0, HISTORY_LIMIT) : [];
    } catch (_) { return []; }
  }
  /**
   * @param {string[]} lines newest first
   * @param {(value: string) => boolean} [keep] a line this returns false for is never written
   */
  saveHistory(lines, keep = () => true) {
    const rows = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      const value = String(line ?? '');
      if (!value.trim() || rows.includes(value)) continue;
      // A key pasted into the prompt would otherwise live in a file forever. The caller
      // supplies the test — the redactor that already guards every outbound payload.
      if (!keep(value)) continue;
      rows.push(value);
      if (rows.length >= HISTORY_LIMIT) break;
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.historyFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    fs.renameSync(tmp, this.historyFile());
    return rows.length;
  }
  update(patch = {}) {
    this.state = this.normalize({ ...this.state, ...patch });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
    return this.get();
  }
}
module.exports = { CliPreferences, DEFAULTS, HISTORY_LIMIT };
