'use strict';

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');

const HANDLE = /^[a-z]+:[0-9]+$|^[0-9a-f-]{8,}$/i;
const KEYS = new Set(['enter', 'tab', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']);

function execute(file, args, timeout = 2500) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { error.detail = String(stderr || stdout || error.message).slice(0, 500); reject(error); }
    else resolve(String(stdout || ''));
  }));
}
function walk(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.surface_id || value.surfaceId || value.ref?.startsWith?.('surface:')) out.push(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, out);
  return out;
}

class CmuxBridge extends EventEmitter {
  constructor({ settingsStore }) {
    super(); this.settingsStore = settingsStore; this.timer = null; this.currentSurface = null; this.lastScreen = '';
    this.state = { connected: false, version: null, workspaces: [], surfaces: [], currentSurface: null, screen: '', error: null };
  }
  cli() {
    const file = this.settingsStore.get().cmux.cliPath;
    return fs.existsSync(file) ? file : 'cmux';
  }
  async run(args, { json = false, timeout = 2500 } = {}) {
    const secret = this.settingsStore.getSecret('cmux');
    const full = secret ? ['--password', secret, ...args] : args;
    if (json) full.push('--json');
    const output = await execute(this.cli(), full, timeout);
    if (!json) return output;
    try { return JSON.parse(output); } catch (_) { return { raw: output }; }
  }
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  start() {
    if (this.timer || !this.settingsStore.get().cmux.enabled) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.settingsStore.get().cmux.pollMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async refresh() {
    try {
      await this.run(['ping'], { timeout: 1000 });
      const tree = await this.run(['tree', '--all'], { json: true, timeout: 2200 });
      const surfaces = walk(tree).map((item) => ({
        id: item.surface_id || item.surfaceId || item.id || item.ref,
        ref: item.ref || item.surface_ref || item.surfaceRef,
        title: item.title || item.name || item.command || 'Terminal',
        type: item.type || item.surface_type || 'terminal',
        workspace: item.workspace_ref || item.workspace || null,
        focused: !!(item.focused || item.selected || item.is_focused),
      })).filter((item) => item.id || item.ref);
      const focus = surfaces.find((item) => item.focused) || surfaces.find((item) => item.type === 'terminal') || surfaces[0];
      if (!this.currentSurface && focus) this.currentSurface = focus.ref || focus.id;
      let screen = this.lastScreen;
      if (this.currentSurface) {
        try {
          screen = await this.run(['read-screen', '--surface', this.currentSurface, '--scrollback', '--lines', String(this.settingsStore.get().cmux.mirrorLines)], { timeout: 1800 });
          this.lastScreen = screen;
        } catch (_) {}
      }
      this.state = { connected: true, version: '0.64.17+', tree, surfaces, currentSurface: this.currentSurface, screen, error: null, ts: Date.now() };
    } catch (error) {
      this.state = { ...this.state, connected: false, error: error.detail || error.message, ts: Date.now() };
    }
    this.emit('snapshot', this.snapshot());
    return this.snapshot();
  }
  _surface(value) {
    const surface = String(value || this.currentSurface || '');
    if (!HANDLE.test(surface)) throw new Error('Invalid cmux surface handle');
    return surface;
  }
  async select(surface) { this.currentSurface = this._surface(surface); return this.refresh(); }
  async send(text, surface) {
    const value = String(text || '').slice(0, 16000);
    if (!value) return;
    await this.run(['send', '--surface', this._surface(surface), value], { timeout: 3000 });
  }
  async sendKey(key, surface) {
    key = String(key || '').toLowerCase(); if (!KEYS.has(key)) throw new Error('Unsupported cmux key');
    await this.run(['send-key', '--surface', this._surface(surface), key]);
  }
  async action(action, payload = {}) {
    if (action === 'split') {
      const dir = ['left', 'right', 'up', 'down'].includes(payload.direction) ? payload.direction : 'right';
      return this.run(['new-split', dir, '--surface', this._surface(payload.surface)]);
    }
    if (action === 'new-workspace') return this.run(['new-workspace', '--name', String(payload.name || 'BigKiji Task').slice(0, 80), '--cwd', String(payload.cwd || process.cwd())]);
    if (action === 'focus') return this.run(['focus-panel', '--panel', this._surface(payload.surface)]);
    if (action === 'close-surface') return this.run(['close-surface', '--surface', this._surface(payload.surface)]);
    throw new Error('Unsupported cmux action');
  }
  async openNative(surface) {
    await this.action('focus', { surface });
    await execute('/usr/bin/open', ['-a', 'cmux'], 2500);
    return { opened: true, surface: this._surface(surface) };
  }
}

module.exports = { CmuxBridge, HANDLE, KEYS };
