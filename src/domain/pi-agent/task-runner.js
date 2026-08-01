'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const knowledge = require('./pi-knowledge-orchestrator');
const { SandboxPolicyResolver } = require('./sandbox-policy');
const { ContextPruner } = require('./context-pruner');
const { LocalQwenGuardrails } = require('./local-qwen-guardrails');

// Providers are spawned only after PiAgent approval and are never kept resident.
class TaskRunner extends EventEmitter {
  constructor({ cwd = process.cwd(), maxParallel = 5, vaultRoot = cwd, graphPath = '', spawnImpl = spawn, qwenGuardrails = new LocalQwenGuardrails() } = {}) {
    super();
    this.cwd = cwd;
    this.maxParallel = maxParallel;
    this.tasks = new Map();
    this.spawnImpl = spawnImpl;
    this.secretProvider = null;
    this.policy = new SandboxPolicyResolver({ vaultRoot });
    this.pruner = new ContextPruner({ graphPath }); this.localPruner = new ContextPruner({ graphPath, maxFiles: 7, maxChars: 32000, maxTokens: 8192 });
    this.qwenGuardrails = qwenGuardrails;
    this.completions = new Map();
  }

  snapshot() { return [...this.tasks.values()].map(({ child, ...task }) => ({ ...task })); }
  setSecretProvider(provider) { this.secretProvider = typeof provider === 'function' ? provider : null; }
  get(id) { return this.tasks.get(id) || null; }
  microTasks(prompt) { return this.qwenGuardrails.chunk(prompt); }

  prepare({ prompt, planHash = null, cwd = this.cwd }) {
    const base = `plan-${Date.now().toString(36)}-${knowledge.hash(prompt)}`;
    return ['claude-code', 'glm'].map((provider) => this.plan({
      id: `${base}-${provider}`, provider, prompt, cwd, planHash,
    }));
  }

  plan({ id, provider, prompt, cwd = this.cwd, planHash = null, metadata = {} }) {
    knowledge.assertExecutor(provider);
    if (this.tasks.has(id)) throw new Error(`Task already exists: ${id}`);
    const task = { id, provider, prompt: knowledge.cleanText(prompt, 20000), promptHash: knowledge.hash(prompt),
      planHash, cwd, status: 'awaiting_approval', output: '', error: '', tokens: { input: 0, output: 0 },
      metadata: { ...metadata }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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

  waitFor(id, timeoutMs = 900000) {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(`Unknown task: ${id}`));
    if (['completed', 'failed', 'blocked'].includes(task.status)) return Promise.resolve(this.public(task));
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.completions.delete(id); resolve({ ...this.public(task), status: 'failed', error: 'task completion timeout' }); }, timeoutMs);
      timer.unref?.(); this.completions.set(id, (value) => { clearTimeout(timer); resolve(value); });
    });
  }

  async executeTask(spec, { autoApprove = false, timeoutMs } = {}) {
    const task = this.plan(spec);
    if (autoApprove) this.approve(task.id);
    return this.waitFor(task.id, timeoutMs);
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
    if (task.child) {
      const child = task.child;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 2000);
      timer.unref?.();
      delete task.child;
    }
    task.status = 'blocked'; task.error = 'aborted by owner'; task.updatedAt = new Date().toISOString();
    knowledge.recordEvent(id, { type: 'abort', status: task.status, provider: task.provider, evidence: task.error });
    this.emit('task', this.public(task));
    return this.public(task);
  }

  start(task) {
    let policy; let prepared; let command; let args;
    try {
      knowledge.canSpend(task.provider, true);
      policy = this.policy.resolve(task.cwd);
      if (!['qwen', 'ollama'].includes(task.provider)) this.policy.assertProvider(policy, task.provider);
      const local = ['qwen', 'ollama'].includes(task.provider);
      prepared = (local ? this.localPruner : this.pruner).prepare({ prompt: task.prompt, policy,
        maxTokens: local ? this.qwenGuardrails.budget() : this.pruner.maxTokens });
      task.context = { ...prepared.metrics, policySource: policy.source };
      ({ command, args } = this.adapter(task.provider, prepared.prompt, task.cwd, policy));
    } catch (error) {
      task.status = 'blocked'; task.error = String(error.message || error); task.updatedAt = new Date().toISOString();
      knowledge.recordEvent(task.id, { type: 'policy-block', status: task.status, provider: task.provider, evidence: task.error });
      this.emit('task', this.public(task)); return this.public(task);
    }
    task.status = 'running'; task.startedAt = new Date().toISOString(); task.updatedAt = task.startedAt;
    const local = ['qwen', 'ollama'].includes(task.provider); if (local) this.qwenGuardrails.enter();
    try {
      const secret = this.secretProvider?.(task.provider) || '';
      const secretName = ({ claude: 'ANTHROPIC_API_KEY', 'claude-code': 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', glm: 'ZAI_API_KEY' })[task.provider];
      const env = { ...process.env, BIGKIJI_EXECUTOR: task.provider };
      if (secret && secretName) env[secretName] = secret;
      task.child = this.spawnImpl(command, args, { cwd: task.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return this.finish(task, 1, '', String(err.message)); }
    this.emit('task', this.public(task));
    knowledge.recordEvent(task.id, { type: 'start', status: task.status, provider: task.provider, evidence: command });
    task.child.stdout.on('data', (buf) => this.append(task, buf, false));
    task.child.stderr.on('data', (buf) => this.append(task, buf, true));
    task.child.on('error', (err) => this.finish(task, 1, '', String(err.message)));
    task.child.on('close', (code, signal) => this.finish(task, signal ? 1 : (code || 0), '', signal ? `signal:${signal}` : 'process exited'));
    if (local) {
      task.timeoutTimer = setTimeout(() => { if (task.child && task.status === 'running') { task.timedOut = true; task.child.kill('SIGTERM'); } }, this.qwenGuardrails.taskTimeoutMs);
      task.timeoutTimer.unref?.();
    }
    return this.public(task);
  }

  append(task, buf, isError) {
    const text = knowledge.cleanText(buf.toString(), 4000);
    if (!text) return;
    if (isError) task.error = `${task.error}\n${text}`.trim().slice(-8000);
    else task.output = `${task.output}\n${text}`.trim().slice(-16000);
    task.updatedAt = new Date().toISOString();
    this.captureUsage(task, text);
    this.emit('log', { taskId: task.id, provider: task.provider, stream: isError ? 'stderr' : 'stdout', text });
  }

  finish(task, code, extra = '', error = '') {
    if (task.status !== 'running') return;
    if (extra || error) task.error = `${task.error}\n${extra || error}`.trim();
    clearTimeout(task.timeoutTimer); delete task.timeoutTimer;
    task.status = code === 0 ? 'completed' : 'failed'; task.exitCode = code;
    task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; delete task.child;
    if (['qwen', 'ollama'].includes(task.provider)) this.qwenGuardrails.leave({
      durationMs: Math.max(0, new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()), timedOut: !!task.timedOut });
    knowledge.recordEvent(task.id, { type: 'finish', status: task.status, provider: task.provider,
      evidence: code === 0 ? 'process exited 0' : (error || task.error || `exit ${code}`) });
    this.emit('task', this.public(task));
    const complete = this.completions.get(task.id);
    if (complete) { this.completions.delete(task.id); complete(this.public(task)); }
    this.drain();
  }

  drain() {
    const active = [...this.tasks.values()].filter((t) => t.status === 'running').length;
    if (active >= this.maxParallel) return;
    const next = [...this.tasks.values()].find((t) => t.status === 'queued');
    if (next) this.start(next);
  }

  shutdown() {
    for (const task of this.tasks.values()) if (task.status === 'running') this.abort(task.id);
  }

  adapter(provider, prompt, cwd, policy) {
    if (provider === 'claude' || provider === 'claude-code') return {
      command: process.env.CLAUDE_BIN || 'claude',
      args: ['--print', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', policy.allowWrite.length ? 'acceptEdits' : 'plan',
        ...policy.allowRead.flatMap((dir) => ['--add-dir', dir])],
    };
    if (provider === 'codex') return { command: process.env.CODEX_BIN || 'codex',
      args: ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', policy.allowWrite.length ? 'workspace-write' : 'read-only', '--cd', cwd, prompt] };
    if (provider === 'gemini') return { command: process.env.GEMINI_BIN || 'gemini',
      args: ['--prompt', prompt, '--output-format', 'stream-json', '--approval-mode', policy.allowWrite.length ? 'auto_edit' : 'plan', '--sandbox', '--skip-trust'] };
    if (provider === 'glm') return { command: process.env.PI_BIN || 'pi',
      args: ['--print', '--model', 'zai/glm-4.7-flash', '--no-context-files', '--no-session', prompt] };
    if (provider === 'qwen' || provider === 'ollama') return { command: process.env.OLLAMA_BIN || 'ollama',
      args: ['run', process.env.BIGKIJI_QWEN_MODEL || 'qwen3.5:35b-a3b', prompt] };
    throw new Error(`No task adapter for provider: ${provider}`);
  }

  captureUsage(task, text) {
    for (const line of String(text || '').split('\n')) {
      let value; try { value = JSON.parse(line); } catch (_) { continue; }
      const flat = JSON.stringify(value);
      const input = +(flat.match(/"(?:input_tokens|inputTokens|promptTokens)":(\d+)/)?.[1] || 0);
      const output = +(flat.match(/"(?:output_tokens|outputTokens|completionTokens)":(\d+)/)?.[1] || 0);
      if (!input && !output) continue;
      task.tokens = { input: Math.max(task.tokens.input || 0, input), output: Math.max(task.tokens.output || 0, output) };
      if (input && task.context) {
        task.context.prunedContextTokens = input; task.context.measurement = 'actual';
        task.context.tokensSaved = Math.max(0, task.context.fullContextTokens - input);
      }
    }
  }

  public(task) { const { child, prompt, ...safe } = task; return { ...safe, promptPreview: prompt.slice(0, 160) }; }
}

module.exports = { TaskRunner };
