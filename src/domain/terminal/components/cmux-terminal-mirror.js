'use strict';

(() => {
  class CmuxTerminalMirror {
    constructor({ terminal, fallbackInput, tabHost, controls }) {
      this.terminal = terminal; this.fallbackInput = fallbackInput; this.tabHost = tabHost; this.controls = controls;
      this.snapshot = { connected: false, surfaces: [] }; this.lastScreen = ''; this.pending = ''; this.pendingTimer = null;
      window.bigkiji.onCmuxSnapshot((snapshot) => this.update(snapshot));
      controls?.querySelector('[data-cmux-native]')?.addEventListener('click', () => window.bigkiji.cmuxOpenNative(this.snapshot.currentSurface));
      controls?.querySelector('[data-cmux-split]')?.addEventListener('click', () => window.bigkiji.cmuxAction('split', { direction: 'right', surface: this.snapshot.currentSurface }));
      controls?.querySelector('[data-cmux-refresh]')?.addEventListener('click', () => window.bigkiji.cmuxRefresh());
      window.bigkiji.cmuxSnapshot().then((snapshot) => this.update(snapshot));
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
        button.textContent = String(surface.title || surface.type || id).slice(0, 18); button.title = `${id} · double-click to open in cmux`;
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
  }
  window.CmuxTerminalMirror = CmuxTerminalMirror;
})();
