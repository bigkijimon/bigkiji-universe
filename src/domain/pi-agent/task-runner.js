'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const knowledge = require('./pi-knowledge-orchestrator');

// Two approved execution lanes: Claude Code CLI and GLM through local Pi.
// Qwen is intentionally reserved for planning/memory and is not started here.
class TaskRunner extends EventEmitter {
  constructor({ cwd = process.cwd(), maxParallel = 2 } = {}) {
    super();
    this.cwd = cwd;
    this.maxParallel = maxParallel;
    this.tasks = new Map();
  }

  snapshot() { return [...this.tasks.values()].map(({ child, ...task }) => ({ ...task })); }
  get(id) { return this.tasks.get(id) || null; }

  prepare({ prompt, planHash = null, cwd = this.cwd }) {
    const base = `plan-${Date.now().toString(36)}-${knowledge.hash(prompt)}`;
    return ['claude-code', 'glm'].map((provider) => this.plan({
      id: `${base}-${provider}`, provider, prompt, cwd, planHash,
    }));
  }

  plan({ id, provider, prompt, cwd = this.cwd, planHash = null }) {
    knowledge.assertExecutor(provider);
    if (this.tasks.has(id)) throw new Error(`Task already exists: ${id}`);
    const task = { id, provider, prompt: knowledge.cleanText(prompt, 12000), promptHash: knowledge.hash(prompt),
      planHash, cwd, status: 'awaiting_approval', output: '', error: '', tokens: { input: 0, output: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.tasks.set(id, task);
    this.emit('task', this.public(task));
    knowledge.recordEvent(id, { type: 'planned', status: task.status, provider, evidence: 'awaiting owner approval' });
    return this.public(task);
  }

  approve(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.status !== 'awaiting_approval' && task.status !== 'failed') throw new Error(`Task is not approvable: ${task.status}`);
    if ([...this.tasks.values()].filter((t) => t.status === 'running').length >= this.maxParallel) {
      task.status = 'queued'; this.emit('task', this.public(task)); return this.public(task);
    }
    return this.start(task);
  }

  retry(id) {
    const task = this.tasks.get(id);
    if (!task || !['failed', 'blocked'].includes(task.status)) throw new Error('Only failed or blocked tasks can be retried');
    task.output = ''; task.error = ''; task.status = 'awaiting_approval'; task.updatedAt = new Date().toISOString();
    this.emit('task', this.public(task));
    return this.public(task);
  }

  abort(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.child) task.child.kill('SIGTERM');
    task.status = 'blocked'; task.error = 'aborted by owner'; task.updatedAt = new Date().toISOString();
    knowledge.recordEvent(id, { type: 'abort', status: task.status, provider: task.provider, evidence: task.error });
    this.emit('task', this.public(task));
    return this.public(task);
  }

  start(task) {
    knowledge.canSpend(task.provider, true);
    const command = task.provider === 'claude-code' ? (process.env.CLAUDE_BIN || 'claude') : (process.env.PI_BIN || 'pi');
    const args = task.provider === 'claude-code'
      ? ['-p', task.prompt, '--output-format', 'stream-json']
      : ['-p', '--model', 'zai/glm-4.7-flash', task.prompt];
    task.status = 'running'; task.startedAt = new Date().toISOString(); task.updatedAt = task.startedAt;
    try {
      task.child = spawn(command, args, { cwd: task.cwd, env: { ...process.env, BIGKIJI_EXECUTOR: task.provider }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return this.finish(task, 1, '', String(err.message)); }
    this.emit('task', this.public(task));
    knowledge.recordEvent(task.id, { type: 'start', status: task.status, provider: task.provider, evidence: command });
    task.child.stdout.on('data', (buf) => this.append(task, buf, false));
    task.child.stderr.on('data', (buf) => this.append(task, buf, true));
    task.child.on('error', (err) => this.finish(task, 1, '', String(err.message)));
    task.child.on('close', (code, signal) => this.finish(task, code || 0, '', signal ? `signal:${signal}` : 'process exited'));
    return this.public(task);
  }

  append(task, buf, isError) {
    const text = knowledge.cleanText(buf.toString(), 4000);
    if (!text) return;
    if (isError) task.error = `${task.error}\n${text}`.trim().slice(-8000);
    else task.output = `${task.output}\n${text}`.trim().slice(-16000);
    task.updatedAt = new Date().toISOString();
    this.emit('log', { taskId: task.id, provider: task.provider, stream: isError ? 'stderr' : 'stdout', text });
  }

  finish(task, code, extra = '', error = '') {
    if (task.status !== 'running') return;
    if (extra) task.error = `${task.error}\n${extra}`.trim();
    task.status = code === 0 ? 'completed' : 'failed'; task.exitCode = code;
    task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; delete task.child;
    knowledge.recordEvent(task.id, { type: 'finish', status: task.status, provider: task.provider,
      evidence: code === 0 ? 'process exited 0' : (error || task.error || `exit ${code}`) });
    this.emit('task', this.public(task));
    this.drain();
  }

  drain() {
    const active = [...this.tasks.values()].filter((t) => t.status === 'running').length;
    if (active >= this.maxParallel) return;
    const next = [...this.tasks.values()].find((t) => t.status === 'queued');
    if (next) this.start(next);
  }

  public(task) { const { child, prompt, ...safe } = task; return { ...safe, promptPreview: prompt.slice(0, 160) }; }
}

module.exports = { TaskRunner };
