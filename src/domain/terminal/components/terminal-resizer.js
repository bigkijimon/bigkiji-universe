(() => {
  // v2.5: the terminal sits BESIDE the synapse canvas, so the divider is vertical
  // and the pane is sized by width. The legacy key is still read (and kept in
  // sync) so an existing install keeps the pane size it was already given.
  const STORAGE_KEY = 'bigkiji.terminal-width.v1';
  const LEGACY_STORAGE_KEY = 'bigkiji.terminal-height.v1';

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

    // The axis the divider travels along. innerWidth is authoritative; innerHeight
    // is only a fallback for hosts that do not report a horizontal viewport.
    viewport() {
      return window.innerWidth || window.innerHeight || 0;
    }

    bounds() {
      const span = this.viewport();
      const minimum = Math.max(180, Math.round(span * 0.18));
      // 220px は必ずシナプス映像側に残す予約幅（main.html の .main-content max-width と一致）
      const maximum = Math.max(minimum, span - 220);
      return { minimum, maximum };
    }

    clamp(value) {
      const { minimum, maximum } = this.bounds();
      return Math.max(minimum, Math.min(maximum, Math.round(value)));
    }

    apply(value, { persist = true } = {}) {
      const width = this.clamp(value);
      document.documentElement.style.setProperty('--terminal-width', `${width}px`);
      this.handle.setAttribute('aria-valuemin', String(this.bounds().minimum));
      this.handle.setAttribute('aria-valuemax', String(this.bounds().maximum));
      this.handle.setAttribute('aria-valuenow', String(width));
      this.handle.title = `Terminal width: ${width}px · drag or use ← →`;
      if (persist) {
        try {
          this.storage.setItem(STORAGE_KEY, String(width));
          this.storage.setItem(LEGACY_STORAGE_KEY, String(width));
        } catch (_) {}
      }
      this.requestFit();
      return width;
    }

    restore() {
      let stored = 0;
      let migrated = false;
      try {
        const own = this.storage.getItem(STORAGE_KEY);
        stored = Number(own ?? this.storage.getItem(LEGACY_STORAGE_KEY));
        migrated = own == null;
      } catch (_) {}
      if (!Number.isFinite(stored) || stored <= 0) return this.apply(this.viewport() * 0.4, { persist: false });
      // A value carried over from the vertical split was a height; keep it, but never
      // hand the owner a pane too narrow to read on first launch after the change.
      this.apply(migrated ? Math.max(stored, this.viewport() * 0.32) : stored, { persist: false });
    }

    reset() { this.apply(this.viewport() * 0.4); }

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
        this.drag = { x: event.clientX, width: this.container.getBoundingClientRect().width };
        this.handle.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-terminal');
        this.handle.classList.add('dragging');
      });
      this.handle.addEventListener('pointermove', (event) => {
        if (!this.drag || !this.handle.hasPointerCapture(event.pointerId)) return;
        // The pane grows leftward, so moving the divider left widens the terminal.
        this.apply(this.drag.width + this.drag.x - event.clientX, { persist: false });
      });
      const finish = (event) => {
        if (!this.drag) return;
        if (this.handle.hasPointerCapture(event.pointerId)) this.handle.releasePointerCapture(event.pointerId);
        this.drag = null;
        document.body.classList.remove('resizing-terminal');
        this.handle.classList.remove('dragging');
        this.apply(this.container.getBoundingClientRect().width);
      };
      this.handle.addEventListener('pointerup', finish);
      this.handle.addEventListener('pointercancel', finish);
      this.handle.addEventListener('dblclick', () => this.reset());
      this.handle.addEventListener('keydown', (event) => {
        const current = this.container.getBoundingClientRect().width;
        const step = event.shiftKey ? 48 : 16;
        if (event.key === 'ArrowLeft') this.apply(current + step);
        else if (event.key === 'ArrowRight') this.apply(current - step);
        else if (event.key === 'Home') this.reset();
        else if (event.key === 'End') this.apply(this.bounds().maximum);
        else return;
        event.preventDefault();
      });
      window.addEventListener('resize', () => this.apply(this.container.getBoundingClientRect().width, { persist: false }));
    }
  }

  window.TerminalResizer = TerminalResizer;
})();
