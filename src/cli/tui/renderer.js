'use strict';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', mint: '\x1b[38;2;84;211;164m',
  cyan: '\x1b[38;2;94;200;220m', amber: '\x1b[38;2;230;190;96m', violet: '\x1b[38;2;176;146;220m',
  coral: '\x1b[38;2;225;128;106m', ink: '\x1b[38;2;216;221;225m', muted: '\x1b[38;2;124;137;145m' };

const plain = (value) => String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
const clip = (value, width) => { const text = plain(value); return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text; };
const pad = (value, width) => `${clip(value, width)}${' '.repeat(Math.max(0, width - plain(clip(value, width)).length))}`;
const bar = (value, width = 12) => { const n = Math.max(0, Math.min(width, Math.round((Number(value) || 0) / 100 * width))); return `${'━'.repeat(n)}${'─'.repeat(width - n)}`; };

class TUIRenderer {
  constructor({ output = process.stdout } = {}) { this.output = output; }
  frame(state = {}, relay = []) {
    const width = Math.max(72, Math.min(150, Number(this.output.columns || 110)));
    const fleet = state.models?.models || state.models || [];
    const runs = state.runs || []; const current = runs.at(-1); const connected = fleet.filter((model) => model.connected).length;
    const phase = state.phase || current?.status || 'IDLE';
    const line = '─'.repeat(width - 2);
    const rows = [`${C.mint}╭${line}╮${C.reset}`,
      `${C.mint}│${C.reset} ${C.bold}${C.ink}(ฅ•ω•ฅ)  BigKiji Universe${C.reset}${' '.repeat(Math.max(1, width - 52))}${C.dim}Core 8777 · PID ${state.pid || '—'}${C.reset} ${C.mint}│${C.reset}`,
      `${C.mint}│${C.reset} ${C.muted}Pi-Orchestrator · context compaction active · models wake only when assigned${C.reset}${' '.repeat(Math.max(0, width - 77))}${C.mint}│${C.reset}`,
      `${C.mint}├${line}┤${C.reset}`,
      `${C.mint}│${C.reset} ${C.bold}PHASE VECTOR${C.reset}  ${this.phase('PREFLIGHT', phase, 1)}  ${this.phase('EXECUTE', phase, 2)}  ${this.phase('VERIFY', phase, 3)}${' '.repeat(Math.max(0, width - 75))}${C.mint}│${C.reset}`,
      `${C.mint}│${C.reset} ${C.amber}${bar(this.progress(phase), Math.max(20, width - 24))}${C.reset}  ${pad(`${this.progress(phase)}%`, 5)} ${C.muted}${pad(phase, 14)}${C.reset} ${C.mint}│${C.reset}`,
      `${C.mint}├${line}┤${C.reset}`,
      `${C.mint}│${C.reset} ${C.bold}ACTIVE AI MODELS${C.reset}  ${C.mint}${connected} connected${C.reset}${' '.repeat(Math.max(0, width - 37))}${C.mint}│${C.reset}`];
    const visible = fleet.slice(0, 6);
    for (const model of visible) {
      const status = model.status || 'IDLE'; const color = status === 'ERROR' || status === 'OFFLINE' ? C.coral : model.connected ? C.mint : C.muted;
      const metrics = model.metrics || {};
      rows.push(`${C.mint}│${C.reset}  ${color}●${C.reset} ${pad(model.displayName || model.id, 20)} ${color}${pad(status, 11)}${C.reset} ${C.muted}lat ${pad(`${metrics.latencyMs || 0}ms`, 9)} tok ${pad(metrics.tokensUsed || 0, 8)} saved ${pad(metrics.tokensSaved || 0, 8)}${C.reset}${' '.repeat(Math.max(0, width - 88))}${C.mint}│${C.reset}`);
    }
    while (visible.length < 4) { rows.push(`${C.mint}│${C.reset}${' '.repeat(width - 2)}${C.mint}│${C.reset}`); visible.push({}); }
    rows.push(`${C.mint}├${line}┤${C.reset}`, `${C.mint}│${C.reset} ${C.bold}LIVE AGENT RELAY${C.reset}${' '.repeat(Math.max(0, width - 22))}${C.mint}│${C.reset}`);
    const logWidth = width - 14;
    const logs = relay.slice(-Math.max(4, Math.min(9, Number(this.output.rows || 30) - rows.length - 4)));
    for (const entry of logs) rows.push(`${C.mint}│${C.reset} ${C.muted}${pad(entry.time || '--:--:--', 8)}${C.reset} ${C.cyan}${pad(entry.source || entry.event || 'SYSTEM', 13)}${C.reset} ${pad(entry.text || entry.status || '', logWidth - 24)} ${C.mint}│${C.reset}`);
    if (!logs.length) rows.push(`${C.mint}│${C.reset} ${C.muted}${pad('No transmissions — standing by', width - 4)}${C.reset} ${C.mint}│${C.reset}`);
    rows.push(`${C.mint}├${line}┤${C.reset}`,
      `${C.mint}│${C.reset} ${C.muted}q quit · r reload · a accept · x reject · ↑↓ session · h HUD${C.reset}${' '.repeat(Math.max(0, width - 66))}${C.mint}│${C.reset}`,
      `${C.mint}╰${line}╯${C.reset}`);
    return rows.join('\n');
  }
  phase(name, current, index) {
    const normalized = String(current).toUpperCase(); const active = normalized.includes(name) || (name === 'PREFLIGHT' && normalized.includes('AWAITING'));
    return active ? `${C.amber}● ${index} ${name}${C.reset}` : `${C.muted}○ ${index} ${name}${C.reset}`;
  }
  progress(phase) { const text = String(phase).toUpperCase(); return text.includes('COMPLETED') ? 100 : text.includes('VERIFY') ? 88 : text.includes('EXEC') || text.includes('REPAIR') ? 58 : text.includes('AWAIT') ? 25 : text.includes('PREFLIGHT') || text.includes('PLANNING') ? 12 : 0; }
  draw(state, relay) { this.output.write(`\x1b[H\x1b[2J${this.frame(state, relay)}`); }
}

module.exports = { TUIRenderer, C, clip, pad, bar };
