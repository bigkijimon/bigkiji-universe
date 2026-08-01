const STATUS = new Set(['EXEC', 'SYNC', 'IDLE', 'GENERATE', 'ERROR']);

const labelFor = (raw = {}) => {
  if (raw.agentLabel) return String(raw.agentLabel);
  const source = String(raw.agent || raw.provider || raw.source || raw.model || 'BIGKIJI').toLowerCase();
  if (source.includes('claude')) return 'CLAUDE CODE';
  if (source.includes('glm') || source.includes('glim')) return 'GLM';
  if (source.includes('qwen') || source.includes('biglama')) return 'QWEN FACILITATOR';
  if (source.includes('comfy')) return 'COMFYUI';
  if (source.includes('pi')) return 'PIAGENT';
  return String(raw.agent || raw.source || 'BIGKIJI').replace(/[-_]/g, ' ').toUpperCase();
};

const statusFor = (raw = {}) => {
  const explicit = String(raw.status || '').toUpperCase();
  if (STATUS.has(explicit)) return explicit;
  const kind = String(raw.kind || raw.type || raw.state || '').toLowerCase();
  if (raw.isError || /error|fail|blocked|degrade/.test(kind)) return 'ERROR';
  if (/comfy|generat|sampling|executing/.test(`${raw.source || ''} ${kind}`)) return 'GENERATE';
  if (/tool|exec|run|start|delta|task/.test(kind)) return 'EXEC';
  if (/file|vault|sync|result|complete|done/.test(kind)) return 'SYNC';
  return 'IDLE';
};

const messageFor = (raw = {}) => String(
  raw.message || raw.text || raw.line || raw.detail || raw.reason || raw.node || raw.state || 'Standing by'
).replace(/\s+/g, ' ').trim().slice(0, 260);

export class TelemetryStore {
  constructor({ limit = 120 } = {}) {
    this.limit = limit;
    this.events = [];
    this.listeners = new Set();
    this.phase = { name: 'PREFLIGHT', progress: 0, state: 'idle', detail: 'Awaiting directive' };
    this.comfy = { state: 'offline', progress: 0, node: '', message: 'Local media engine is sleeping', jobId: null, assetUrl: null };
    this.tasks = new Map();
    this.runs = new Map();
    this.ids = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  snapshot() {
    return { events: this.events.slice(), phase: { ...this.phase }, comfy: { ...this.comfy }, tasks: [...this.tasks.values()], runs: [...this.runs.values()] };
  }

  ingest(raw = {}, channel = '') {
    const timestamp = Number(raw.ts || raw.timestamp) || Date.now();
    const id = String(raw.id || `${channel}:${timestamp}:${messageFor(raw)}`);
    if (this.ids.has(id)) return;
    this.ids.add(id);
    const event = {
      id, timestamp, channel, agent: labelFor(raw), status: statusFor(raw), message: messageFor(raw),
      tool: raw.toolName || raw.tool || '', file: raw.file || raw.path || '', progress: Number(raw.progress) || 0,
    };
    const previous = this.events[this.events.length - 1];
    if (previous && event.status === 'EXEC' && previous.agent === event.agent && timestamp - previous.timestamp < 350) {
      this.events[this.events.length - 1] = event;
    } else this.events.push(event);
    while (this.events.length > this.limit) {
      const removed = this.events.shift();
      this.ids.delete(removed.id);
    }
    this.notify();
  }

  setPhase(name, progress, detail = '', state = 'active') {
    this.phase = { name, progress: Math.max(0, Math.min(100, Number(progress) || 0)), detail, state };
    this.notify();
  }

  setComfy(update = {}) {
    this.comfy = { ...this.comfy, ...update };
    this.ingest({ source: 'comfyui', kind: update.state, status: update.state === 'error' ? 'ERROR' : update.state === 'offline' ? 'IDLE' : 'GENERATE',
      text: update.message || update.node || update.state, progress: update.progress, ts: update.ts }, 'comfy');
  }

  upsertTask(task = {}) {
    if (!task.id) return;
    this.tasks.set(String(task.id), { ...task });
    this.ingest({ ...task, source: task.provider || task.agent || 'task', text: `${task.name || task.id} · ${task.state || 'updated'}` }, 'task');
  }

  upsertRun(run = {}) {
    if (!run.id) return;
    this.runs.set(String(run.id), { ...(this.runs.get(String(run.id)) || {}), ...run });
    this.ingest({ id: `run:${run.id}:${run.updatedAt || run.status}`, source: 'piagent', kind: 'run',
      text: `${run.promptPreview || run.id} · ${run.status}`, ts: Date.parse(run.updatedAt || '') || Date.now() }, 'run');
  }
}
