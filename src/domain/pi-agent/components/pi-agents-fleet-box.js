const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const fmtTokens = (value) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}m`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value || 0);
const fmtDuration = (value) => value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value || 0}ms`;

export class PiAgentsFleetBox {
  constructor({ root } = {}) {
    this.root = root;
    this.frame = 0;
    this.render({ agents: [], totals: {} });
  }

  update(snapshot = {}) {
    this.snapshot = snapshot;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(this.snapshot); });
  }

  render(snapshot = {}) {
    if (!this.root) return;
    const agents = snapshot.agents || [];
    const totals = snapshot.totals || {};
    this.root.innerHTML = `
      <div class="fleet-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <header class="fleet-head"><span><i></i> PI-AGENTS FLEET</span><b>${agents.filter((agent) => agent.status !== 'IDLE').length} ACTIVE</b></header>
      <section class="fleet-total">
        <span>TOTAL TOKENS SAVED</span><strong>${fmtTokens(totals.tokensSaved)}</strong><em>${fmtTokens((totals.promptTokens || 0) + (totals.completionTokens || 0))} measured</em>
      </section>
      <div class="fleet-compact">${agents.map((agent) => `<span title="${esc(agent.status)} · saved ${agent.tokensSaved} · ${agent.durationMs}ms · prompt ${agent.promptTokens} / completion ${agent.completionTokens}"><b>${esc(agent.label)}</b><i>${esc(agent.status === 'IDLE' ? 'IDLE' : agent.status)}</i><em>${fmtTokens(agent.tokensSaved)}</em></span>`).join('')}</div>
      <div class="fleet-grid ${agents.length > 8 ? 'many' : ''}">${agents.map((agent) => `
        <article class="fleet-agent" data-state="${esc(agent.status)}">
          <header><b>${esc(agent.label)}</b><i>${esc(agent.status)}</i></header>
          <span>${esc(agent.role)}</span>
          <div class="fleet-task">${esc(agent.activeTask || 'Standing by')}</div>
          <dl><div><dt>SAVED</dt><dd>${fmtTokens(agent.tokensSaved)}</dd></div><div><dt>TIME</dt><dd>${fmtDuration(agent.durationMs)}</dd></div><div><dt>P / C</dt><dd>${fmtTokens(agent.promptTokens)} / ${fmtTokens(agent.completionTokens)}</dd></div></dl>
        </article>`).join('')}</div>`;
  }

  dispose() { if (this.frame) cancelAnimationFrame(this.frame); }
}
