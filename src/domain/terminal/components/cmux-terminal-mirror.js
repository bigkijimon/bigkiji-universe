'use strict';

(() => {
  class CmuxTerminalMirror {
    constructor({ terminal, fallbackInput, tabHost, controls }) {
      this.terminal = terminal; this.fallbackInput = fallbackInput; this.tabHost = tabHost; this.controls = controls;
      this.snapshot = { connected: false, surfaces: [] }; this.lastScreen = ''; this.pending = ''; this.pendingTimer = null;
      window.bigkiji.onCmuxSnapshot((snapshot) => this.update(snapshot));
      controls?.querySelector('[data-cmux-native]')?.addEventListener('click', () => window.bigkiji.cmuxOpenNative(this.snapshot.currentSurface));
      controls?.querySelector('[data-cmux-split]')?.addEventListener('click', () => window.bigkiji.cmuxAction('split', { direction: 'right', surface: this.snapshot.currentSurface }));
      controls?.querySelector('[data-cmux-new]')?.addEventListener('click', () => window.bigkiji.cmuxAction('new-terminal', { surface: this.snapshot.currentSurface }));
      controls?.querySelector('[data-cmux-palette]')?.addEventListener('click', () => this.openPalette());
      controls?.querySelector('[data-cmux-refresh]')?.addEventListener('click', () => window.bigkiji.cmuxRefresh());
      window.bigkiji.cmuxSnapshot().then((snapshot) => this.update(snapshot));
      this.bindPalette();
    }
    get connected() { return !!this.snapshot.connected; }
    update(snapshot) {
      this.snapshot = snapshot || { connected: false, surfaces: [] };
      this.controls?.classList.toggle('connected', this.connected);
      const badge = this.controls?.querySelector('[data-cmux-state]');
      if (badge) badge.textContent = this.connected ? `CMUX · ${this.snapshot.surfaces?.length || 0}` : 'PTY FALLBACK';
      this.renderTabs(); this.renderScreen();
    }
    renderTabs() {
      if (!this.tabHost) return;
      this.tabHost.innerHTML = '';
      for (const surface of (this.snapshot.surfaces || []).slice(0, 8)) {
        const id = surface.ref || surface.id; const button = document.createElement('button');
        button.className = `cmux-surface-tab ${id === this.snapshot.currentSurface ? 'on' : ''}`;
        const workspace = (this.snapshot.workspaces || []).find((row) => row.ref === surface.workspace || row.id === surface.workspace);
        button.style.setProperty('--workspace', workspace?.color || '#00f3ff');
        button.textContent = String(surface.title || surface.type || id).slice(0, 18); button.title = `${workspace?.title || 'workspace'} · ${id} · double-click to open in cmux`;
        button.onclick = () => window.bigkiji.cmuxSelect(id); button.ondblclick = () => window.bigkiji.cmuxOpenNative(id);
        this.tabHost.appendChild(button);
      }
    }
    renderScreen() {
      if (!this.connected || !this.snapshot.screen || this.snapshot.screen === this.lastScreen) return;
      this.lastScreen = this.snapshot.screen;
      const safe = String(this.snapshot.screen).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
      this.terminal.write(`\x1b[2J\x1b[H${safe.replace(/\n/g, '\r\n')}`);
    }
    input(data) {
      if (!this.connected) { this.fallbackInput(data); return; }
      const special = { '\r': 'enter', '\x7f': 'backspace', '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\t': 'tab', '\x1b': 'escape' }[data];
      if (special) { this.flush(); window.bigkiji.cmuxKey(special, this.snapshot.currentSurface); return; }
      this.pending += data;
      clearTimeout(this.pendingTimer); this.pendingTimer = setTimeout(() => this.flush(), 24);
    }
    flush() {
      clearTimeout(this.pendingTimer); this.pendingTimer = null;
      if (!this.pending) return; const value = this.pending; this.pending = '';
      window.bigkiji.cmuxInput(value, this.snapshot.currentSurface);
    }
    bindPalette() {
      this.palette = document.getElementById('cmuxPalette');
      if (!this.palette) return;
      this.palette.querySelector('[data-palette-close]')?.addEventListener('click', () => this.closePalette());
      this.palette.addEventListener('click', (event) => { if (event.target === this.palette) this.closePalette(); });
      const input = this.palette.querySelector('input');
      input?.addEventListener('input', () => this.renderCommands(input.value));
      input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.executeInput(input.value); if (event.key === 'Escape') this.closePalette(); });
      this.palette.querySelector('[data-palette-run]')?.addEventListener('click', () => this.executeInput(input.value));
    }
    openPalette() {
      if (!this.palette) return;
      this.palette.classList.add('on'); this.palette.setAttribute('aria-hidden', 'false');
      const input = this.palette.querySelector('input'); input.value = ''; this.renderCommands(''); setTimeout(() => input.focus(), 20);
    }
    closePalette() { this.palette?.classList.remove('on'); this.palette?.setAttribute('aria-hidden', 'true'); }
    renderCommands(query = '') {
      const host = this.palette?.querySelector('[data-command-list]'); if (!host) return;
      const q = query.toLowerCase(); const groups = this.snapshot.commandGroups || [];
      host.innerHTML = groups.map((group) => {
        const commands = group.commands.filter((command) => !q || command.includes(q) || group.label.toLowerCase().includes(q));
        if (!commands.length) return '';
        return `<section><h4>${this.esc(group.label)}</h4>${commands.map((command) => `<button data-command="${command}"><b>${command}</b><span>cmux ${command}</span></button>`).join('')}</section>`;
      }).join('');
      host.querySelectorAll('[data-command]').forEach((button) => button.onclick = () => {
        const input = this.palette.querySelector('input'); input.value = button.dataset.command + ' '; input.focus();
      });
    }
    argv(text) {
      const values = []; let value = ''; let quote = '';
      for (const char of String(text || '').trim()) {
        if (quote) { if (char === quote) quote = ''; else value += char; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (/\s/.test(char)) { if (value) { values.push(value); value = ''; } } else value += char;
      }
      if (quote) throw new Error('Close the quoted argument before running the command');
      if (value) values.push(value); return values;
    }
    async executeInput(text) {
      const output = this.palette?.querySelector('[data-palette-output]');
      try {
        const argv = this.argv(text); if (!argv.length) return;
        let result = await window.bigkiji.cmuxCommand({ argv });
        if (result.requiresConfirmation) {
          const accepted = window.confirm(`${result.impact}\n\n${result.preview}\n\nRun this command?`);
          if (!accepted) { if (output) output.textContent = 'Command cancelled.'; return; }
          result = await window.bigkiji.cmuxCommand({ argv, confirmationId: result.confirmationId });
        }
        if (output) output.textContent = result.output || `${result.preview || 'cmux'} completed.`;
      } catch (error) { if (output) output.textContent = `Command blocked: ${error.message}`; }
    }
    esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  }
  window.CmuxTerminalMirror = CmuxTerminalMirror;
})();
