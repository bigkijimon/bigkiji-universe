'use strict';

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const HANDLE = /^[a-z]+:[0-9]+$|^[0-9a-f-]{8,}$/i;
const KEYS = new Set(['enter', 'tab', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']);
const COMMAND = /^[a-z][a-z0-9-]*$/;
const DANGEROUS = /(^|\s)(?:close(?:-[a-z0-9-]+)?|remove|rm|logout|uninstall|disable|clear|interrupt|kill|delete|purge|hooks?\s+uninstall|vm\s+rm)(?=\s|$)/i;
const COMMAND_GROUPS = Object.freeze([
  { id: 'workspace', label: 'Workspaces', commands: ['list-workspaces', 'new-workspace', 'workspace-action', 'reorder-workspace', 'reorder-workspaces', 'move-workspace-to-window'] },
  { id: 'terminal', label: 'Terminals & panes', commands: ['new-split', 'list-panes', 'list-pane-surfaces', 'tab-action', 'send', 'send-key', 'read-screen'] },
  { id: 'appearance', label: 'Appearance', commands: ['themes', 'settings', 'config', 'reload-config'] },
  { id: 'navigation', label: 'Windows & focus', commands: ['list-windows', 'new-window', 'focus-window', 'focus-workspace', 'focus-panel', 'focus-surface', 'tree'] },
  { id: 'agents', label: 'Agents', commands: ['claude-teams', 'codex-teams', 'omo', 'omx', 'omc', 'hooks', 'feed', 'agent-hibernation'] },
  { id: 'remote', label: 'Remote & cloud', commands: ['ssh', 'ssh-tmux', 'ssh-session-list', 'ssh-session-attach', 'ssh-session-cleanup', 'vm', 'remotes'] },
  { id: 'tools', label: 'Tools', commands: ['open', 'diff', 'browser-status', 'enable-browser', 'disable-browser', 'events', 'auth', 'capabilities', 'version', 'ping'] },
]);

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
  constructor({ settingsStore, defaultBin = 'cmux' }) {
    super(); this.settingsStore = settingsStore; this.timer = null; this.currentSurface = null; this.lastScreen = '';
    this.defaultBin = defaultBin; this.pendingConfirmations = new Map();
    this.state = { connected: false, supported: process.platform === 'darwin', version: null, workspaces: [], surfaces: [],
      currentSurface: null, screen: '', themes: [], commandGroups: COMMAND_GROUPS, error: null };
  }
  cli() {
    const configured = this.settingsStore.get().cmux.cliPath;
    if (configured && configured !== 'cmux') return configured;
    return this.defaultBin || 'cmux';
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
    if (this.timer || process.platform !== 'darwin' || !this.settingsStore.get().cmux.enabled) return;
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
      const workspaces = [];
      const collectWorkspaces = (value) => {
        if (!value || typeof value !== 'object') return;
        const ref = value.workspace_ref || value.ref;
        if ((value.workspace_id || String(ref || '').startsWith('workspace:')) && !workspaces.some((row) => row.ref === ref)) {
          workspaces.push({ id: value.workspace_id || value.id || ref, ref, title: value.title || value.name || 'Workspace',
            color: value.color || value.badge_color || '', description: value.description || '', focused: !!(value.focused || value.selected) });
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') collectWorkspaces(child);
      };
      collectWorkspaces(tree);
      const focus = surfaces.find((item) => item.focused) || surfaces.find((item) => item.type === 'terminal') || surfaces[0];
      if (!this.currentSurface && focus) this.currentSurface = focus.ref || focus.id;
      let screen = this.lastScreen;
      if (this.currentSurface) {
        try {
          screen = await this.run(['read-screen', '--surface', this.currentSurface, '--scrollback', '--lines', String(this.settingsStore.get().cmux.mirrorLines)], { timeout: 1800 });
          this.lastScreen = screen;
        } catch (_) {}
      }
      this.state = { ...this.state, connected: true, version: '0.64.17+', tree, workspaces, surfaces,
        currentSurface: this.currentSurface, screen, error: null, ts: Date.now() };
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
    if (action === 'new-terminal') return this.run(['tab-action', '--action', 'new-terminal-right', '--surface', this._surface(payload.surface)]);
    if (action === 'rename-tab') return this.run(['tab-action', '--action', 'rename', '--surface', this._surface(payload.surface), '--title', String(payload.title || 'Terminal').slice(0, 80)]);
    if (action === 'duplicate-tab') return this.run(['tab-action', '--action', 'duplicate', '--surface', this._surface(payload.surface)]);
    if (action === 'workspace-color') return this.run(['workspace-action', '--workspace', String(payload.workspace || ''), '--action', 'set-color', '--color', this._color(payload.color)]);
    if (action === 'rename-workspace') return this.run(['workspace-action', '--workspace', String(payload.workspace || ''), '--action', 'rename', '--title', String(payload.title || 'Workspace').slice(0, 80)]);
    if (action === 'theme-list') return this.themeList();
    if (action === 'theme-set') return this.setTheme(payload.theme);
    if (action === 'focus') return this.run(['focus-panel', '--panel', this._surface(payload.surface)]);
    if (action === 'close-surface') return this.command({ argv: ['close-surface', '--surface', this._surface(payload.surface)], confirmationId: payload.confirmationId });
    throw new Error('Unsupported cmux action');
  }
  _color(value) {
    const color = String(value || 'Aqua');
    if (!/^#[0-9a-f]{6}$/i.test(color) && !/^(Red|Crimson|Orange|Amber|Olive|Green|Teal|Aqua|Blue|Navy|Indigo|Purple|Magenta|Rose|Brown|Charcoal)$/i.test(color)) throw new Error('Invalid workspace color');
    return color;
  }
  _argv(input) {
    if (!Array.isArray(input) || !input.length || input.length > 80) throw new Error('cmux argv must be a non-empty array');
    const argv = input.map((value) => String(value).slice(0, 4096));
    if (!COMMAND.test(argv[0]) || argv.some((value) => value.includes('\0')) || argv.includes('--password')) throw new Error('Invalid or protected cmux argument');
    return argv;
  }
  async command({ argv: input, confirmationId = '' } = {}) {
    const argv = this._argv(input); const preview = `cmux ${argv.join(' ')}`; const dangerous = DANGEROUS.test(preview);
    if (dangerous && this.settingsStore.get().cmux.confirmDangerous) {
      const expected = this.pendingConfirmations.get(confirmationId);
      if (!confirmationId || expected !== preview) {
        const id = crypto.randomUUID(); this.pendingConfirmations.set(id, preview);
        setTimeout(() => this.pendingConfirmations.delete(id), 60000).unref?.();
        return { requiresConfirmation: true, confirmationId: id, preview,
          impact: 'This command can close, remove, disconnect, or reconfigure cmux state.' };
      }
      this.pendingConfirmations.delete(confirmationId);
    }
    const output = await this.run(argv, { timeout: 30000 });
    await this.refresh();
    return { ok: true, preview, output: output.slice(0, 200000) };
  }
  async themeList() {
    const result = await this.run(['themes', 'list'], { json: true, timeout: 6000 });
    const themes = Array.isArray(result?.themes) ? result.themes : [];
    this.state.themes = themes.map((row) => ({ name: row.name, current: !!(row.current_dark || row.current_light) }));
    return { themes: this.state.themes, current: result?.current || null };
  }
  async setTheme(value) {
    const theme = String(value || '').trim(); if (!theme || theme.length > 120) throw new Error('Invalid cmux theme');
    const output = await this.run(['themes', 'set', theme], { timeout: 10000 });
    await this.refresh(); return { ok: true, theme, output };
  }
  async openNative(surface) {
    if (process.platform !== 'darwin') throw new Error('Native cmux is available on macOS only');
    await this.action('focus', { surface });
    await execute('/usr/bin/open', ['-a', 'cmux'], 2500);
    return { opened: true, surface: this._surface(surface) };
  }
}

module.exports = { CmuxBridge, HANDLE, KEYS, COMMAND, DANGEROUS, COMMAND_GROUPS };
