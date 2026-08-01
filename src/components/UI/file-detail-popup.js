const fmtSize = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export class FileDetailPopup {
  constructor(el) { this.el = el; this.current = null; }
  async open(file, anchor = null) {
    if (!file || !window.bigkiji?.fileDetail) return;
    this.current = file;
    this.el.classList.add('loading', 'on');
    this.el.innerHTML = '<div class="fd-kicker">FILE SYNAPSE</div><div class="fd-title">Loading detail…</div>';
    if (anchor) this.position(anchor.x, anchor.y);
    try {
      const detail = await window.bigkiji.fileDetail(file.p || file.path);
      if (this.current !== file) return;
      const color = file.color || '#34d399';
      this.el.style.setProperty('--fd-color', color);
      this.el.innerHTML = `<button class="fd-close" aria-label="Close">×</button>
        <div class="fd-kicker">${detail.company || 'CORE'} · ${detail.agent || 'core'}</div>
        <div class="fd-title"></div><div class="fd-path"></div>
        <dl><div><dt>SIZE</dt><dd>${fmtSize(detail.size)}</dd></div>
        <div><dt>UPDATED</dt><dd>${new Date(detail.mtimeMs).toLocaleString()}</dd></div>
        <div><dt>TYPE</dt><dd>${(detail.name.split('.').pop() || 'file').toUpperCase()}</dd></div></dl>
        <div class="fd-prompt-label">PROMPT / CONTENT OVERVIEW</div><p class="fd-summary"></p>`;
      this.el.querySelector('.fd-title').textContent = detail.name;
      this.el.querySelector('.fd-path').textContent = detail.path;
      this.el.querySelector('.fd-summary').textContent = detail.promptSummary || 'No prompt context recorded';
      this.el.querySelector('.fd-close').addEventListener('click', () => this.close());
      this.el.classList.remove('loading');
    } catch (err) {
      this.el.innerHTML = `<div class="fd-kicker">FILE SYNAPSE</div><div class="fd-title">Detail unavailable</div><p class="fd-summary"></p>`;
      this.el.querySelector('.fd-summary').textContent = String(err.message || err);
      this.el.classList.remove('loading');
    }
  }
  position(x, y) { this.el.style.left = `${Math.max(12, Math.min(x + 16, innerWidth - 330))}px`; this.el.style.top = `${Math.max(12, Math.min(y + 16, innerHeight - 230))}px`; }
  close() { this.current = null; this.el.classList.remove('on'); }
}
