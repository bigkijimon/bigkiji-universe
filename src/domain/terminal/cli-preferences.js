'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeMode } = require('./cli-theme');

const DEFAULTS = Object.freeze({ theme: 'warm-brown', modeAccent: 'follow', contrast: 'standard', mode: 'plan', catCommentary: 'low' });
function clone(value) { return JSON.parse(JSON.stringify(value)); }
class CliPreferences {
  constructor({ root = path.join(os.homedir(), '.bigkiji'), file } = {}) {
    this.root = root; this.file = file || path.join(root, 'config.json'); this.state = this.load();
  }
  load() { try { return this.normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) { return clone(DEFAULTS); } }
  normalize(value = {}) {
    const next = { ...DEFAULTS, ...value };
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
