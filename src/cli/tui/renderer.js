'use strict';

const { themeFor, stripAnsi } = require('../../domain/terminal/cli-theme');

const plain = (value) => stripAnsi(value);
const clip = (value, width) => { const text = plain(value); return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text; };
const pad = (value, width) => `${clip(value, width)}${' '.repeat(Math.max(0, width - plain(clip(value, width)).length))}`;
const bar = (value, width = 12) => { const n = Math.max(0, Math.min(width, Math.round((Number(value) || 0) / 100 * width))); return `${'━'.repeat(n)}${'─'.repeat(width - n)}`; };

class TUIRenderer {
  constructor({ output = process.stdout } = {}) { this.output = output; }
  frame(state = {}, relay = []) {
    const width = Math.max(72, Math.min(150, Number(this.output.columns || 110)));
    const mode = state.preferences?.mode || state.mode || 'plan'; const C = themeFor(mode);
    const fleet = state.models?.models || state.models || [];
    const runs = state.runs || []; const current = runs.at(-1); const connected = fleet.filter((model) => model.connected).length;
    const phase = state.phase || current?.status || 'IDLE';
    const line = '─'.repeat(width - 2);
    const border = (text) => `${C.border}${text}${C.reset}`;
    const rows = [border(`╭${line}╮`),
      border('│') + ` ${C.bold}${C.ink}(=^･ω･^=)  BigKiji Universe${C.reset}${' '.repeat(Math.max(1, width - 52))}${C.dim}Core 8777 · PID ${state.pid || '—'}${C.reset} ` + border('│'),
      border('│') + ` ${C.muted}Pi-Orchestrator · warm brown theme · ${String(mode).toUpperCase()} · models wake only when assigned${C.reset}${' '.repeat(Math.max(0, width - 77))}` + border('│'),
      border(`├${line}┤`),
      border('│') + ` ${C.bold}${C.ink}PHASE VECTOR${C.reset}  ${this.phase('PREFLIGHT', phase, 1, C)}  ${this.phase('EXECUTE', phase, 2, C)}  ${this.phase('VERIFY', phase, 3, C)}${' '.repeat(Math.max(0, width - 75))}` + border('│'),
      border('│') + ` ${C.accent}${bar(this.progress(phase), Math.max(20, width - 24))}${C.reset}  ${pad(`${this.progress(phase)}%`, 5)} ${C.muted}${pad(phase, 14)}${C.reset} ` + border('│'),
      border(`├${line}┤`),
      border('│') + ` ${C.bold}${C.ink}ACTIVE AI MODELS${C.reset}  ${C.accent}${connected} connected${C.reset}${' '.repeat(Math.max(0, width - 37))}` + border('│')];
    const visible = fleet.slice(0, 6);
    for (const model of visible) {
      const status = model.status || 'IDLE'; const color = status === 'ERROR' ? C.error : status === 'OFFLINE' ? C.muted : model.connected ? C.accent : C.brown;
      const metrics = model.metrics || {};
      rows.push(border('│') + `  ${color}●${C.reset} ${pad(model.displayName || model.id, 20)} ${color}${pad(status, 11)}${C.reset} ${C.muted}lat ${pad(`${metrics.latencyMs || 0}ms`, 9)} tok ${pad(metrics.tokensUsed || 0, 8)} saved ${pad(metrics.tokensSaved || 0, 8)}${C.reset}${' '.repeat(Math.max(0, width - 88))}` + border('│'));
    }
    while (visible.length < 4) { rows.push(border('│') + ' '.repeat(width - 2) + border('│')); visible.push({}); }
    rows.push(border(`├${line}┤`), border('│') + ` ${C.bold}${C.ink}LIVE AGENT RELAY${C.reset}${' '.repeat(Math.max(0, width - 22))}` + border('│'));
    const logWidth = width - 14;
    const logs = relay.slice(-Math.max(4, Math.min(9, Number(this.output.rows || 30) - rows.length - 4)));
    for (const entry of logs) rows.push(border('│') + ` ${C.muted}${pad(entry.time || '--:--:--', 8)}${C.reset} ${C.accent}${pad(entry.source || entry.event || 'SYSTEM', 13)}${C.reset} ${pad(entry.text || entry.status || '', logWidth - 24)} ` + border('│'));
    if (!logs.length) rows.push(border('│') + ` ${C.muted}${pad('No transmissions — standing by', width - 4)}${C.reset} ` + border('│'));
    rows.push(border(`├${line}┤`), border('│') + ` ${C.muted}q quit · r reload · a accept · x reject · ↑↓ session · Shift+Tab mode · h HUD${C.reset}${' '.repeat(Math.max(0, width - 80))}` + border('│'), border(`╰${line}╯`));
    return rows.join('\n');
  }
  phase(name, current, index, C = themeFor('plan')) {
    const normalized = String(current).toUpperCase(); const active = normalized.includes(name) || (name === 'PREFLIGHT' && normalized.includes('AWAITING'));
    return active ? `${C.strong}● ${index} ${name}${C.reset}` : `${C.muted}○ ${index} ${name}${C.reset}`;
  }
  progress(phase) { const text = String(phase).toUpperCase(); return text.includes('COMPLETED') ? 100 : text.includes('VERIFY') ? 88 : text.includes('EXEC') || text.includes('REPAIR') ? 58 : text.includes('AWAIT') ? 25 : text.includes('PREFLIGHT') || text.includes('PLANNING') ? 12 : 0; }
  draw(state, relay) { this.output.write(`\x1b[H\x1b[2J${this.frame(state, relay)}`); }
}

module.exports = { TUIRenderer, clip, pad, bar };
