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
  update(patch = {}) {
    this.state = this.normalize({ ...this.state, ...patch });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
    return this.get();
  }
}
module.exports = { CliPreferences, DEFAULTS };
