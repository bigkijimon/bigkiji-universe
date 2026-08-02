'use strict';

const { themeFor, stripAnsi } = require('../../domain/terminal/cli-theme');

const ESC = '\x1b';
const plain = (value) => stripAnsi(value);
const clip = (value, width) => { const text = plain(value); return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text; };
const pad = (value, width) => `${clip(value, width)}${' '.repeat(Math.max(0, width - plain(clip(value, width)).length))}`;
const bar = (value, width = 12) => { const n = Math.max(0, Math.min(width, Math.round((Number(value) || 0) / 100 * width))); return `${'━'.repeat(n)}${'─'.repeat(width - n)}`; };

// Sticky Bottom TUI:
//   Sticky Top    = キジトラマスコット + PHASE VECTOR + ACTIVE AI MODELS（固定ヘッダ）
//   中間          = LIVE AGENT RELAY（DECSTBM スクロール領域）
//   Sticky Bottom = 入力バー（π> ＋キーヒント・常に最下部）
// 依存追加なし・ANSIエスケープ（DECSTBM \x1b[top;bottom r）のみで実現する。
class TUIRenderer {
  constructor({ output = process.stdout } = {}) { this.output = output; }

  metrics() {
    const width = Math.max(72, Math.min(150, Number(this.output.columns || 110)));
    const rows = Math.max(16, Number(this.output.rows || 30));
    return { width, rows };
  }

  sections(state = {}, relay = []) {
    const { width, rows } = this.metrics();
    const mode = state.preferences?.mode || state.mode || 'plan'; const C = themeFor(mode);
    const fleet = state.models?.models || state.models || [];
    const runs = state.runs || []; const current = runs.at(-1); const connected = fleet.filter((model) => model.connected).length;
    const phase = state.phase || current?.status || 'IDLE';
    const line = '─'.repeat(width - 2);
    const border = (text) => `${C.border}${text}${C.reset}`;
    const box = (content = '') => `${border('│')}${content}${' '.repeat(Math.max(0, width - 2 - plain(content).length))}${border('│')}`;

    const header = [border(`╭${line}╮`),
      box(` ${C.bold}${C.ink}(=^･ω･^=)  BigKiji Universe${C.reset}   ${C.dim}Core 8777 · PID ${state.pid || '—'}${C.reset}`),
      box(` ${C.muted}Pi-Orchestrator · warm brown theme · ${String(mode).toUpperCase()} · models wake only when assigned${C.reset}`),
      border(`├${line}┤`),
      box(` ${C.bold}${C.ink}PHASE VECTOR${C.reset}  ${this.phase('PREFLIGHT', phase, 1, C)}  ${this.phase('EXECUTE', phase, 2, C)}  ${this.phase('VERIFY', phase, 3, C)}`),
      box(` ${C.accent}${bar(this.progress(phase), Math.max(20, width - 24))}${C.reset}  ${pad(`${this.progress(phase)}%`, 5)} ${C.muted}${pad(phase, 14)}${C.reset}`),
      border(`├${line}┤`),
      box(` ${C.bold}${C.ink}ACTIVE AI MODELS${C.reset}  ${C.accent}${connected} connected${C.reset}`)];
    const footer = [border(`├${line}┤`),
      box(` ${C.strong}π>${C.reset} ${C.muted}q quit · r reload · a accept · x reject · ↑↓ session · Shift+Tab mode · h HUD${C.reset}`),
      border(`╰${line}╯`)];

    const modelCapacity = Math.max(0, Math.min(6, rows - header.length - footer.length - 5));
    const visible = fleet.slice(0, modelCapacity);
    for (const model of visible) {
      const status = model.status || 'IDLE'; const color = status === 'ERROR' ? C.error : status === 'OFFLINE' ? C.muted : model.connected ? C.accent : C.brown;
      const metrics = model.metrics || {};
      header.push(box(`  ${color}●${C.reset} ${pad(model.displayName || model.id, 20)} ${color}${pad(status, 11)}${C.reset} ${C.muted}lat ${pad(`${metrics.latencyMs || 0}ms`, 9)} tok ${pad(metrics.tokensUsed || 0, 8)} saved ${pad(metrics.tokensSaved || 0, 8)}${C.reset}`));
    }
    while (header.length < 8 + Math.min(4, modelCapacity)) header.push(box());
    header.push(border(`├${line}┤`), box(` ${C.bold}${C.ink}LIVE AGENT RELAY${C.reset}`));

    const middleRows = Math.max(3, rows - header.length - footer.length);
    const logs = relay.slice(-middleRows);
    const middle = logs.map((entry) => box(` ${C.muted}${pad(entry.time || '--:--:--', 8)}${C.reset} ${C.accent}${pad(entry.source || entry.event || 'SYSTEM', 13)}${C.reset} ${pad(entry.text || entry.status || '', Math.max(10, width - 30))}`));
    if (!middle.length) middle.push(box(` ${C.muted}${pad('No transmissions — standing by', width - 4)}${C.reset}`));
    while (middle.length < middleRows) middle.push(box());
    return { header, middle, footer, rows, width };
  }

  frame(state = {}, relay = []) { const { header, middle, footer } = this.sections(state, relay); return [...header, ...middle, ...footer].join('\n'); }

  phase(name, current, index, C = themeFor('plan')) {
    const normalized = String(current).toUpperCase(); const active = normalized.includes(name) || (name === 'PREFLIGHT' && normalized.includes('AWAITING'));
    return active ? `${C.strong}● ${index} ${name}${C.reset}` : `${C.muted}○ ${index} ${name}${C.reset}`;
  }
  progress(phase) { const text = String(phase).toUpperCase(); return text.includes('COMPLETED') ? 100 : text.includes('VERIFY') ? 88 : text.includes('EXEC') || text.includes('REPAIR') ? 58 : text.includes('AWAIT') ? 25 : text.includes('PREFLIGHT') || text.includes('PLANNING') ? 12 : 0; }

  draw(state, relay) {
    const { header, middle, footer, rows } = this.sections(state, relay);
    const top = header.length + 1; const bottom = rows - footer.length;
    let out = `${ESC}[r${ESC}[H`;
    header.forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    middle.forEach((text, index) => { out += `${ESC}[${top + index};1H${ESC}[2K${text}`; });
    footer.forEach((text, index) => { out += `${ESC}[${bottom + 1 + index};1H${ESC}[2K${text}`; });
    out += `${ESC}[${top};${bottom}r${ESC}[${bottom};1H`;
    this.output.write(out);
  }
}

// REPL 用 Sticky Bottom シェル:
//   最下行 = readline 入力（π> プロンプト・固定）、上部 = 固定ヘッダ（マスコット）、
//   中間 = DECSTBM スクロール領域（出力はここに流れる）。リサイズにも追従する。
class StickyScreen {
  constructor({ output = process.stdout } = {}) { this.output = output; this.header = []; this.active = false; this.onLayout = null; this._resize = null; }
  get rows() { return Math.max(8, Number(this.output.rows || 24)); }
  get top() { return Math.min(this.header.length + 1, this.rows - 2); }
  get bottom() { return this.rows - 1; }
  start({ header = [], onLayout } = {}) {
    if (!this.output.isTTY) return false;
    this.header = header; this.onLayout = onLayout || null; this.active = true;
    this.output.write(`${ESC}[2J`); this.layout();
    this._resize = () => { if (this.active) { this.output.write(`${ESC}[2J`); this.layout(); } };
    this.output.on('resize', this._resize);
    return true;
  }
  layout() {
    let out = `${ESC}[r${ESC}[H`;
    this.header.slice(0, this.top - 1).forEach((text, index) => { out += `${ESC}[${index + 1};1H${ESC}[2K${text}`; });
    out += `${ESC}[${this.top};${this.bottom}r${ESC}[${this.bottom};1H`;
    this.output.write(out);
    this.onLayout?.();
  }
  print(text) {
    if (!this.active) { this.output.write(`${String(text)}\n`); return; }
    const lines = String(text).split('\n');
    this.output.write(`${ESC}[${this.bottom};1H${lines.map((line) => `\n\r${line}`).join('')}`);
  }
  clear() { if (this.active) { this.output.write(`${ESC}[2J`); this.layout(); } }
  suspend() { if (!this.active) return; this.active = false; this.output.write(`${ESC}[r${ESC}[2J${ESC}[H`); }
  resume() { if (!this.output.isTTY) return; this.active = true; this.output.write(`${ESC}[2J`); this.layout(); }
  stop() {
    if (this._resize) { this.output.off('resize', this._resize); this._resize = null; }
    if (!this.active) return; this.active = false;
    this.output.write(`${ESC}[r${ESC}[${this.rows};1H\n`);
  }
}

module.exports = { TUIRenderer, StickyScreen, clip, pad, bar };
