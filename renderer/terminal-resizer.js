(() => {
  const STORAGE_KEY = 'bigkiji.terminal-height.v1';

  class TerminalResizer {
    constructor({ handle, container, onResize, storage = window.localStorage }) {
      this.handle = handle;
      this.container = container;
      this.onResize = onResize;
      this.storage = storage;
      this.drag = null;
      this.fitFrame = 0;
      this.bind();
      this.restore();
    }

    bounds() {
      const minimum = Math.max(180, Math.round(window.innerHeight * 0.18));
      const maximum = Math.max(minimum, window.innerHeight - 220);
      return { minimum, maximum };
    }

    clamp(value) {
      const { minimum, maximum } = this.bounds();
      return Math.max(minimum, Math.min(maximum, Math.round(value)));
    }

    apply(value, { persist = true } = {}) {
      const height = this.clamp(value);
      document.documentElement.style.setProperty('--terminal-height', `${height}px`);
      this.handle.setAttribute('aria-valuemin', String(this.bounds().minimum));
      this.handle.setAttribute('aria-valuemax', String(this.bounds().maximum));
      this.handle.setAttribute('aria-valuenow', String(height));
      this.handle.title = `Terminal height: ${height}px · drag or use ↑ ↓`;
      if (persist) {
        try { this.storage.setItem(STORAGE_KEY, String(height)); } catch (_) {}
      }
      this.requestFit();
      return height;
    }

    restore() {
      let stored = 0;
      try { stored = Number(this.storage.getItem(STORAGE_KEY)); } catch (_) {}
      this.apply(Number.isFinite(stored) && stored > 0 ? stored : window.innerHeight * 0.4, { persist: false });
    }

    reset() { this.apply(window.innerHeight * 0.4); }

    requestFit() {
      if (this.fitFrame) return;
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = 0;
        this.onResize?.();
      });
    }

    bind() {
      this.handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.drag = { y: event.clientY, height: this.container.getBoundingClientRect().height };
        this.handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-terminal');
        this.handle.classList.add('dragging');
      });
      this.handle.addEventListener('pointermove', (event) => {
        if (!this.drag || !this.handle.hasPointerCapture(event.pointerId)) return;
        // The terminal grows upward, so moving the divider up increases height.
        this.apply(this.drag.height + this.drag.y - event.clientY, { persist: false });
      });
      const finish = (event) => {
        if (!this.drag) return;
        if (this.handle.hasPointerCapture(event.pointerId)) this.handle.releasePointerCapture(event.pointerId);
        this.drag = null;
        document.body.classList.remove('resizing-terminal');
        this.handle.classList.remove('dragging');
        this.apply(this.container.getBoundingClientRect().height);
      };
      this.handle.addEventListener('pointerup', finish);
      this.handle.addEventListener('pointercancel', finish);
      this.handle.addEventListener('dblclick', () => this.reset());
      this.handle.addEventListener('keydown', (event) => {
        const current = this.container.getBoundingClientRect().height;
        const step = event.shiftKey ? 48 : 16;
        if (event.key === 'ArrowUp') this.apply(current + step);
        else if (event.key === 'ArrowDown') this.apply(current - step);
        else if (event.key === 'Home') this.reset();
        else if (event.key === 'End') this.apply(this.bounds().maximum);
        else return;
        event.preventDefault();
      });
      window.addEventListener('resize', () => this.apply(this.container.getBoundingClientRect().height, { persist: false }));
    }
  }

  window.TerminalResizer = TerminalResizer;
})();
