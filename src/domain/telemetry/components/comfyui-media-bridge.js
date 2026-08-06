'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { signalChild } = require('../../../core/child-signal');

const DEFAULT_ROOT = path.join(require('os').homedir(), 'ComfyUI');
const WORKFLOWS = Object.freeze({
  'bigkiji-hud': {
    file: 'user/default/workflows/_pro_templates/wf_realvisxl_2pass_api.json',
    promptNode: '2', negativeNode: '3', latentNode: '5', seedNodes: ['6', '8'], saveNode: '13', type: 'image',
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (value) => path.basename(String(value || 'asset.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
const mimeFor = (file) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm' }[path.extname(file).toLowerCase()] || 'application/octet-stream');

class ComfyUIMediaBridge extends EventEmitter {
  constructor({ root = process.env.COMFYUI_ROOT || DEFAULT_ROOT, baseUrl = process.env.COMFYUI_URL || '', outputDir, fetchImpl = global.fetch, spawnImpl = spawn } = {}) {
    super();
    this.root = root;
    this.fetch = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.outputDir = outputDir || path.join(root, 'output', 'BigKiji');
    this.urls = [...new Set([baseUrl, 'http://127.0.0.1:8188', 'http://127.0.0.1:8000'].filter(Boolean).map((url) => url.replace(/\/$/, '')))];
    this.baseUrl = null;
    this.child = null;
    this.clientId = `bigkiji-${crypto.randomUUID()}`;
    this.jobs = new Map();
    this.state = { state: 'offline', progress: 0, node: '', message: 'Local media engine is sleeping', jobId: null, assetUrl: null };
  }

  publish(update = {}) {
    this.state = { ...this.state, ...update, ts: Date.now() };
    this.emit('event', { ...this.state });
    return { ...this.state };
  }

  async request(url, options = {}, timeout = 1200) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try { return await this.fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async detect({ silent = false } = {}) {
    for (const url of this.urls) {
      try {
        const response = await this.request(`${url}/system_stats`, {}, 650);
        if (response.ok) {
          this.baseUrl = url;
          return this.publish({ state: 'ready', message: `Connected locally at ${url}`, progress: 0 });
        }
      } catch (_) {}
    }
    this.baseUrl = null;
    return silent ? { ...this.state, available: false } : this.publish({ state: 'offline', message: 'Local media engine is sleeping', progress: 0, node: '', jobId: null });
  }

  startLocal() {
    if (this.child && this.child.exitCode == null) return;
    const python = process.platform === 'win32'
      ? path.join(this.root, '.venv', 'Scripts', 'python.exe') : path.join(this.root, '.venv', 'bin', 'python');
    const main = path.join(this.root, 'ComfyUI-clean', 'main.py');
    if (!fs.existsSync(python) || !fs.existsSync(main)) throw new Error(`ComfyUI runtime not found under ${this.root}`);
    const port = Number(process.env.COMFYUI_PORT) || 8188;
    const args = [main, '--listen', '127.0.0.1', '--port', String(port),
      '--extra-model-paths-config', path.join(this.root, 'extra_model_paths_service.yaml'),
      '--output-directory', path.join(this.root, 'output'), '--input-directory', path.join(this.root, 'input'),
      '--user-directory', path.join(this.root, 'user')];
    this.publish({ state: 'starting', message: `Starting local ComfyUI on ${port}`, progress: 0, node: 'BOOTSTRAP' });
    this.child = this.spawnImpl(python, args, { cwd: path.dirname(main), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastRelay = 0;
    const relay = (chunk, error = false) => {
      const line = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').pop();
      const now = Date.now();
      if (line && now - lastRelay > 240) { lastRelay = now; this.publish({ state: 'starting', node: 'BOOTSTRAP', message: line.slice(0, 180) }); }
    };
    this.child.stdout?.on('data', (chunk) => relay(chunk));
    this.child.stderr?.on('data', (chunk) => relay(chunk, true));
    this.child.on('error', (error) => this.publish({ state: 'error', message: error.message, node: 'BOOTSTRAP' }));
    this.child.on('exit', (code) => {
      this.child = null; this.baseUrl = null;
      if (code && this.state.state !== 'offline') this.publish({ state: 'error', message: `ComfyUI exited with code ${code}`, node: 'BOOTSTRAP' });
    });
    this.urls.unshift(`http://127.0.0.1:${port}`);
  }

  async ensureReady() {
    await this.detect();
    if (this.baseUrl) return this.baseUrl;
    this.startLocal();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await delay(1000);
      await this.detect({ silent: true });
      if (this.baseUrl) return this.baseUrl;
    }
    throw new Error('ComfyUI did not become ready within 120 seconds');
  }

  loadWorkflow(id, inputs = {}, jobId) {
    const definition = WORKFLOWS[id];
    if (!definition) throw new Error(`UNSUPPORTED WORKFLOW: ${id}`);
    const file = path.join(this.root, definition.file);
    const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prompt = String(inputs.prompt || '').trim().slice(0, 1400);
    if (!prompt) throw new Error('Media prompt is required');
    workflow[definition.promptNode].inputs.text = `${prompt}, deep-space neural telemetry, elegant luminous fiber detail, no text, no logos`;
    const width = Math.round(Math.max(512, Math.min(1536, Number(inputs.width) || 1024)) / 64) * 64;
    const height = Math.round(Math.max(384, Math.min(1024, Number(inputs.height) || 576)) / 64) * 64;
    workflow[definition.latentNode].inputs.width = width;
    workflow[definition.latentNode].inputs.height = height;
    const seed = crypto.randomInt(1, 2147483646);
    for (const node of definition.seedNodes) workflow[node].inputs.seed = seed;
    workflow[definition.saveNode].inputs.filename_prefix = `BigKiji/${jobId}`;
    return { workflow, definition };
  }

  async generate(spec = {}) {
    const jobId = crypto.randomUUID();
    const workflowId = String(spec.workflowId || 'bigkiji-hud');
    let loaded;
    try { loaded = this.loadWorkflow(workflowId, spec.inputs || {}, jobId); }
    catch (error) { this.publish({ state: 'error', message: error.message, node: 'VALIDATE', jobId: null }); throw error; }
    const url = await this.ensureReady();
    this.publish({ state: 'queued', progress: 0, node: 'QUEUE', message: `Queued ${workflowId}`, jobId, target: spec.target || 'hud' });
    const response = await this.request(`${url}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: loaded.workflow, client_id: this.clientId }),
    }, 10000);
    const body = await response.json();
    if (!response.ok || body.error || !body.prompt_id) throw new Error(body.error?.message || body.error || `ComfyUI rejected workflow (${response.status})`);
    const job = { jobId, promptId: body.prompt_id, target: spec.target || 'hud', workflowId, cancelled: false };
    this.jobs.set(jobId, job);
    this.monitor(job).catch((error) => {
      if (!job.cancelled) this.publish({ state: 'error', message: error.message, node: 'EXECUTE', jobId: null });
      this.jobs.delete(jobId);
    });
    return { jobId, promptId: body.prompt_id, state: 'queued' };
  }

  async monitor(job) {
    const deadline = Date.now() + 30 * 60 * 1000;
    let progress = 1;
    while (!job.cancelled && Date.now() < deadline) {
      const response = await this.request(`${this.baseUrl}/history/${encodeURIComponent(job.promptId)}`, {}, 4000);
      const history = response.ok ? await response.json() : {};
      const record = history[job.promptId];
      if (record) {
        const status = record.status || {};
        if (status.status_str === 'error' || status.completed === false && status.messages?.some((entry) => entry[0] === 'execution_error')) {
          throw new Error('ComfyUI workflow execution failed');
        }
        const output = this.findOutput(record.outputs || {});
        if (output) {
          const asset = await this.downloadOutput(output, job.jobId);
          this.publish({ state: 'completed', progress: 100, node: 'OUTPUT', message: `Generated ${asset.name}`,
            jobId: null, assetUrl: asset.url, mime: asset.mime, target: job.target });
          this.jobs.delete(job.jobId);
          return;
        }
      }
      progress = Math.min(94, progress + (progress < 30 ? 3 : progress < 70 ? 1.5 : 0.5));
      this.publish({ state: 'running', progress, node: 'SAMPLING', message: `Executing ${job.workflowId}`, jobId: job.jobId, target: job.target });
      await delay(1200);
    }
    if (!job.cancelled) throw new Error('ComfyUI workflow timed out');
  }

  findOutput(outputs) {
    for (const output of Object.values(outputs)) {
      for (const key of ['images', 'gifs', 'videos']) {
        if (Array.isArray(output?.[key]) && output[key][0]?.filename) return output[key][0];
      }
    }
    return null;
  }

  async downloadOutput(output, jobId) {
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
    const response = await this.request(`${this.baseUrl}/view?${query}`, {}, 30000);
    if (!response.ok) throw new Error(`Unable to retrieve generated asset (${response.status})`);
    await fs.promises.mkdir(this.outputDir, { recursive: true });
    const name = `${jobId}-${safeName(output.filename)}`;
    const destination = path.join(this.outputDir, name);
    await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return { name, url: pathToFileURL(destination).href, mime: mimeFor(destination) };
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job) return { cancelled: false };
    job.cancelled = true;
    try { await this.request(`${this.baseUrl}/interrupt`, { method: 'POST' }, 2500); } catch (_) {}
    this.jobs.delete(job.jobId);
    this.publish({ state: 'ready', progress: 0, node: '', message: 'Generation cancelled', jobId: null });
    return { cancelled: true };
  }

  shutdown() {
    signalChild(this.child, 'SIGTERM');
    this.child = null;
  }
}

module.exports = { ComfyUIMediaBridge, WORKFLOWS };
