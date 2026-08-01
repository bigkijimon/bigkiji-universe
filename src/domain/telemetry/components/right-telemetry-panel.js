const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const clock = (timestamp) => new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
const PHASES = ['PREFLIGHT', 'EXECUTE', 'VERIFY'];

export class RightTelemetryPanel {
  constructor({ store, root, mirror, onComfyRetry, onComfyCancel, onApplyAsset } = {}) {
    this.store = store;
    this.root = root;
    this.mirror = mirror;
    this.handlers = { onComfyRetry, onComfyCancel, onApplyAsset };
    this.autoFollow = true;
    this.frame = 0;
    this.renderShell();
    this.unsubscribe = store.subscribe((state) => this.schedule(state));
  }

  renderShell() {
    if (this.root) {
      this.root.innerHTML = `
        <div class="thud-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <section class="thud-relay" aria-label="Live agent commentary">
          <header><span><i class="thud-live-dot"></i> LIVE AGENT RELAY</span><b id="thudCount">0 SIGNALS</b></header>
          <div id="thudSession" class="thud-session"></div>
          <div id="thudFeed" class="thud-feed" role="log" aria-live="polite"></div>
        </section>
        <section class="thud-lower">
          <div class="thud-roadmap"><header>PHASE VECTOR <b id="thudPhaseLabel">PREFLIGHT</b></header><div id="thudPhases"></div></div>
          <div class="thud-comfy"><header>MEDIA ENGINE <b id="thudComfyState">OFFLINE</b></header><div class="thud-comfy-body">
            <div class="thud-comfy-orbit"><i></i><img id="thudComfyPreview" alt="Generated media preview"><span id="thudComfyPct">0%</span></div>
            <div class="thud-comfy-copy"><strong id="thudComfyNode">LOCAL ENGINE SLEEPING</strong><span id="thudComfyMessage">Generation starts only when requested.</span><div class="thud-nodegraph" aria-label="ComfyUI node graph"><i data-node="QUEUE"></i><u></u><i data-node="SAMPLING"></i><u></u><i data-node="OUTPUT"></i></div><div class="thud-comfy-actions"><button id="thudComfyRetry">RECONNECT</button><button id="thudComfyCancel">CANCEL</button><button id="thudApplyAsset">APPLY ASSET</button></div></div>
          </div></div>
        </section>`;
      this.root.querySelector('#thudFeed')?.addEventListener('scroll', (event) => {
        const el = event.currentTarget;
        this.autoFollow = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      });
      this.root.querySelector('#thudComfyRetry')?.addEventListener('click', () => this.handlers.onComfyRetry?.());
      this.root.querySelector('#thudComfyCancel')?.addEventListener('click', () => this.handlers.onComfyCancel?.());
      this.root.querySelector('#thudApplyAsset')?.addEventListener('click', () => this.handlers.onApplyAsset?.());
    }
    if (this.mirror) this.mirror.innerHTML = '<span class="tm-dot"></span><b>TELEMETRY LINK</b><span id="tmState">IDLE · awaiting signal</span><i id="tmProgress"></i>';
  }

  schedule(state) {
    this.state = state;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(this.state); });
  }

  render(state) {
    if (!this.root || !state) return;
    const feed = this.root.querySelector('#thudFeed');
    const events = state.events.slice(-36);
    const run = (state.runs || []).at(-1);
    const runProgress = run ? (({ PLANNING:8, AWAITING_APPROVAL:18, DISPATCHING:28, EXECUTING:58, REPAIRING:72, VERIFYING:88, COMPLETED:100, FAILED:100 })[run.status] || 0) : 0;
    this.root.querySelector('#thudSession').innerHTML = run ? `<div class="thud-session-top"><span>MAIN SESSION</span><b>${esc(run.status)}</b></div><strong>${esc(run.promptPreview || run.id)}</strong><div class="thud-session-track"><i style="width:${runProgress}%"></i></div><div class="thud-session-models">${(run.assignments || []).map((item) => `<span data-state="${esc(item.status)}"><i></i>${esc(item.provider)}</span>`).join('')}</div>` : '<div class="thud-session-idle"><b>MAIN SESSION</b><span>Awaiting an owner directive</span></div>';
    feed.innerHTML = events.length ? events.map((event) => `
      <article class="thud-event" data-status="${esc(event.status)}">
        <time>[${clock(event.timestamp)}]</time><b>${esc(event.agent)}</b><em>${esc(event.status)}</em><span>${esc(event.message)}</span>
      </article>`).join('') : '<div class="thud-empty"><b>NO ACTIVE TRANSMISSION</b><span>Send a brief or run a task. Real agent activity will appear here.</span></div>';
    if (this.autoFollow) feed.scrollTop = feed.scrollHeight;
    this.root.querySelector('#thudCount').textContent = `${events.length} SIGNAL${events.length === 1 ? '' : 'S'}`;

    this.root.querySelector('#thudPhaseLabel').textContent = state.phase.name;
    const phaseIndex = Math.max(0, PHASES.indexOf(state.phase.name));
    this.root.querySelector('#thudPhases').innerHTML = PHASES.map((phase, index) => {
      const done = index < phaseIndex || state.phase.progress >= 100;
      const active = index === phaseIndex && !done;
      const progress = done ? 100 : active ? state.phase.progress : 0;
      return `<div class="thud-phase ${done ? 'done' : active ? 'active' : ''}" title="${esc(active ? state.phase.detail : phase)}"><span><i>${index + 1}</i>${phase}</span><b>${Math.round(progress)}%</b><u><i style="width:${progress}%"></i></u></div>`;
    }).join('');

    const comfy = state.comfy;
    const comfyState = String(comfy.state || 'offline').toUpperCase();
    this.root.dataset.comfy = comfyState;
    this.root.querySelector('#thudComfyState').textContent = comfyState;
    this.root.querySelector('#thudComfyPct').textContent = `${Math.round(comfy.progress || 0)}%`;
    this.root.querySelector('#thudComfyNode').textContent = comfy.node || (comfyState === 'OFFLINE' ? 'LOCAL ENGINE SLEEPING' : 'COMFYUI');
    this.root.querySelector('#thudComfyMessage').textContent = comfy.message || 'Waiting for media work.';
    this.root.querySelector('.thud-comfy-orbit').style.setProperty('--progress', `${Math.max(0, Math.min(100, comfy.progress || 0)) * 3.6}deg`);
    this.root.querySelector('#thudComfyCancel').disabled = !comfy.jobId;
    this.root.querySelector('#thudApplyAsset').disabled = !comfy.assetUrl;
    const preview = this.root.querySelector('#thudComfyPreview');
    if (comfy.assetUrl && /^image\//.test(comfy.mime || '')) { preview.src = comfy.assetUrl; preview.classList.add('on'); }
    else { preview.removeAttribute('src'); preview.classList.remove('on'); }
    const graphStep = comfyState === 'COMPLETED' ? 3 : ['RUNNING', 'QUEUED'].includes(comfyState)
      ? (String(comfy.node).toUpperCase().includes('OUTPUT') ? 3 : String(comfy.node).toUpperCase().includes('SAMP') ? 2 : 1) : 0;
    [...this.root.querySelectorAll('.thud-nodegraph i')].forEach((node, index) => node.classList.toggle('on', index < graphStep));

    if (this.mirror) {
      const latest = events[events.length - 1];
      this.mirror.dataset.status = latest?.status || 'IDLE';
      this.mirror.querySelector('#tmState').textContent = latest ? `${latest.agent} · ${latest.message}` : `${state.phase.name} · ${state.phase.detail}`;
      this.mirror.querySelector('#tmProgress').style.width = `${state.phase.progress}%`;
    }
  }

  dispose() { this.unsubscribe?.(); if (this.frame) cancelAnimationFrame(this.frame); }
}
