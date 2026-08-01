const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const compact = (value) => value >= 1000000 ? `${(value/1000000).toFixed(2)}m` : value >= 1000 ? `${(value/1000).toFixed(1)}k` : String(value || 0);
const metric = (value, suffix = '') => value === null || value === undefined ? '—' : `${typeof value === 'number' ? Math.round(value * 100) / 100 : value}${suffix}`;

export class ActiveAIModelsFleet {
  constructor({ root } = {}) { this.root = root; this.frame = 0; this.update({ models: [], totals: {}, connected: 0 }); }
  update(snapshot = {}) { this.snapshot = snapshot; if (this.frame) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(this.snapshot); }); }
  render(snapshot = {}) {
    if (!this.root) return; const models = snapshot.models || [], totals = snapshot.totals || {};
    this.root.innerHTML = `<header class="fleet-head"><span><i></i> ACTIVE AI MODELS FLEET</span><b>${snapshot.connected || 0} CONNECTED NOW</b></header>
      <section class="fleet-total"><span>TOTAL TOKENS USED & SAVED</span><strong>${compact(totals.tokensUsed)} / ${compact(totals.tokensSaved)}</strong><em>actual telemetry only</em></section>
      <div class="fleet-grid model-grid">${models.map((model) => { const displayStatus = model.status === 'ERROR' ? 'ERROR' : model.connected ? model.status : (model.available ? 'SLEEPING' : 'OFFLINE'); const progress = model.connected ? (model.status === 'THINKING' ? 42 : model.status === 'PRUNING' ? 28 : 58) : 0; return `<article class="fleet-agent model-card" data-state="${esc(displayStatus)}">
        <header><b>${esc(model.displayName)}</b><i>${esc(displayStatus)}</i></header><span>${esc(model.role)}</span>
        <div class="fleet-task">${esc(model.activeTask || (model.connected ? model.metrics.apiHealth : model.available ? 'Available · starts only on PiAgent assignment' : 'Not available'))}</div>
        <div class="model-progress"><i style="width:${progress}%"></i></div>
        <dl><div><dt>TOKENS</dt><dd>${compact(model.metrics.tokensUsed)}</dd></div><div><dt>LATENCY</dt><dd>${metric(model.metrics.latencyMs,'ms')}</dd></div><div><dt>SAVED</dt><dd>${compact(model.metrics.tokensSaved)}</dd></div>
          <div><dt>P / C</dt><dd>${compact(model.metrics.promptTokens)} / ${compact(model.metrics.completionTokens)}</dd></div><div><dt>HEALTH</dt><dd>${esc(model.metrics.apiHealth || '—')}</dd></div><div><dt>COST</dt><dd>${model.metrics.estimatedCostUsd == null ? '—' : `$${model.metrics.estimatedCostUsd.toFixed(4)}`}</dd></div></dl>
        ${model.id === 'pi-agent-core' ? `<small>Pruned ${metric(model.metrics.prunedContextRatio,'%')} · ${metric(model.metrics.filesHandled)} files · ${metric(model.metrics.executedCommands)} commands</small>` : ''}
        ${model.id === 'local-qwen' ? `<small>${metric(model.metrics.tokensPerSecond,' t/s')} · VRAM ${metric(model.metrics.vramUsage)}</small>` : ''}
      </article>`; }).join('')}</div>`;
  }
  dispose() { if (this.frame) cancelAnimationFrame(this.frame); }
}
