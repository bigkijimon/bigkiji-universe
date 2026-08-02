'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');
const { SandboxPolicyResolver } = require('./sandbox-policy');
const { GLM_MODELS, resolveModel } = require('./model-router');
const { ContextPruner } = require('./context-pruner');
const { LocalQwenGuardrails } = require('./local-qwen-guardrails');
const { SecurityPolicy } = require('../pi-core/security/security-policy');
const { createDisclosureManifest, verifyDisclosureManifest } = require('../pi-core/security/disclosure-manifest');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { ResearchBroker } = require('../pi-core/security/research-broker');

// Providers are spawned only after PiAgent approval and are never kept resident.
class TaskRunner extends EventEmitter {
  constructor({ cwd = process.cwd(), maxParallel = 5, vaultRoot = cwd, graphPath = '', spawnImpl = spawn, qwenGuardrails = new LocalQwenGuardrails(), security = new SecurityPolicy(), broker = new ResearchBroker() } = {}) {
    super();
    this.cwd = cwd;
    this.maxParallel = maxParallel;
    this.tasks = new Map();
    this.spawnImpl = spawnImpl;
    this.broker = broker;
    this.secretProvider = null;
    this.security = security; this.policy = new SandboxPolicyResolver({ vaultRoot, security });
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

  plan({ id, provider, prompt, cwd = this.cwd, planHash = null, metadata = {}, model = null }) {
    knowledge.assertExecutor(provider);
    if (this.tasks.has(id)) throw new Error(`Task already exists: ${id}`);
    const task = { id, provider, model: model == null ? resolveModel(provider, prompt, metadata.role) : String(model || ''),
      prompt: knowledge.cleanText(prompt, 20000), promptHash: knowledge.hash(prompt),
      planHash, cwd, status: 'awaiting_approval', output: '', error: '', tokens: { input: 0, output: 0 },
      metadata: { ...metadata }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.tasks.set(id, task);
    try { this.prepareContext(task); }
    catch (error) {
      task.status = 'blocked'; task.error = String(error.message || error); task.updatedAt = new Date().toISOString();
      knowledge.recordEvent(id, { type: 'security-block', status: task.status, provider, evidence: task.error });
      this.emit('security', { taskId: id, provider, decision: 'DENY', reason: task.error, at: task.updatedAt });
    }
    this.emit('task', this.public(task));
    knowledge.recordEvent(id, { type: 'planned', status: task.status, provider,
      evidence: task.status === 'awaiting_approval' ? 'awaiting owner approval' : task.error });
    return this.public(task);
  }

  approve(id, expected = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.status !== 'awaiting_approval' && task.status !== 'failed') throw new Error(`Task is not approvable: ${task.status}`);
    if (!expected.disclosureHash || expected.disclosureHash !== task.disclosure?.disclosureHash) throw new Error('STALE_DISCLOSURE_HASH');
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
    if (autoApprove && ['qwen', 'ollama'].includes(task.provider)) this.approve(task.id, { disclosureHash: task.disclosure?.disclosureHash });
    return this.waitFor(task.id, timeoutMs);
  }

  retry(id) {
    const task = this.tasks.get(id);
    if (!task || !['failed', 'blocked'].includes(task.status)) throw new Error('Only failed or blocked tasks can be retried');
    task.output = ''; task.error = ''; task.status = 'awaiting_approval'; task.updatedAt = new Date().toISOString();
    try { this.prepareContext(task); }
    catch (error) {
      task.status = 'blocked'; task.error = String(error.message || error); task.updatedAt = new Date().toISOString();
      this.emit('security', { taskId: id, provider: task.provider, decision: 'DENY', reason: task.error, at: task.updatedAt });
    }
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
      if (!policy.valid) throw new Error(policy.error || 'SECURITY_POLICY_INVALID');
      if (!['qwen', 'ollama'].includes(task.provider)) this.policy.assertProvider(policy, task.provider);
      if (policy.security?.policyHash !== task.disclosure?.policyHash) throw new Error('STALE_SECURITY_POLICY');
      if (!verifyDisclosureManifest(task.disclosure, policy, task.preparedPrompt)) throw new Error('STALE_DISCLOSURE_MANIFEST');
      // The owner approved a specific brain on specific files. Re-tiering between
      // approval and launch would run a model they never saw.
      if ((task.disclosure.model || '') !== (task.model || '')) throw new Error('STALE_MODEL_SELECTION');
      prepared = { prompt: task.preparedPrompt, metrics: task.context };
      task.runtime = this.security.createRuntime(task.id);
      fs.writeFileSync(task.runtime.policyFile, JSON.stringify(policy, null, 2), { mode: 0o600 });
      this.writeProviderPolicies(task.provider, task.runtime, policy);
      ({ command, args } = this.adapter(task.provider, prepared.prompt, task.cwd, policy, task.runtime, task.model));
    } catch (error) {
      this.cleanupRuntime(task);
      task.status = 'blocked'; task.error = String(error.message || error); task.updatedAt = new Date().toISOString();
      knowledge.recordEvent(task.id, { type: 'policy-block', status: task.status, provider: task.provider, evidence: task.error });
      this.emit('security', { taskId: task.id, provider: task.provider, decision: 'DENY', reason: task.error, at: task.updatedAt });
      this.emit('task', this.public(task)); return this.public(task);
    }
    task.status = 'running'; task.startedAt = new Date().toISOString(); task.updatedAt = task.startedAt;
    const local = ['qwen', 'ollama'].includes(task.provider); if (local) this.qwenGuardrails.enter();
    try {
      const secret = this.secretProvider?.(task.provider) || '';
      const env = this.security.minimalEnv(task.provider, { runtime: task.runtime, secret,
        extra: task.provider === 'gemini' ? { GEMINI_CLI_TRUSTED_FOLDERS_PATH: task.runtime.geminiTrustFile } : {} });
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
    const redacted = redactPayload(buf.toString()); const text = knowledge.cleanText(redacted.text, 4000);
    if (!text) return;
    if (redacted.blocked) {
      this.emit('security', { taskId: task.id, provider: task.provider, decision: 'DENY', reason: 'SECURITY_CRITICAL_SECRET_IN_MODEL_OUTPUT', at: new Date().toISOString() });
      task.error = 'SECURITY_CRITICAL_SECRET_IN_MODEL_OUTPUT'; task.child?.kill('SIGTERM'); return;
    }
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
    this.cleanupRuntime(task);
    this.drain();
  }

  cleanupRuntime(task) {
    if (!task.runtime?.root) return;
    try { fs.rmSync(task.runtime.root, { recursive: true, force: true }); } catch (_) {}
    delete task.runtime;
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

  prepareContext(task) {
    const policy = this.policy.resolve(task.cwd);
    const local = ['qwen', 'ollama'].includes(task.provider);
    if (!local) this.policy.assertProvider(policy, task.provider);
    if (!policy.valid) throw new Error(policy.error || 'SECURITY_POLICY_INVALID');
    const pruner = local ? this.localPruner : this.pruner;
    const prepared = task.metadata?.promptOnly
      ? pruner.preparePromptOnly({ prompt: task.prompt, policy, maxTokens: local ? this.qwenGuardrails.budget() : this.pruner.maxTokens })
      : pruner.prepare({ prompt: task.prompt, policy, maxTokens: local ? this.qwenGuardrails.budget() : this.pruner.maxTokens });
    task.context = { ...prepared.metrics, policySource: policy.source };
    task.preparedPrompt = prepared.prompt; task.securityPolicy = policy;
    // A blocked research query blocks the task rather than being dropped: the specialist
    // asked for that fact, and running it without the fact — and without saying so — is
    // how a plausible but uninformed answer gets produced.
    const externalTools = this.broker.prepareAll(task.metadata?.research || []);
    task.disclosure = createDisclosureManifest({ runId: task.metadata?.runId || task.id, provider: task.provider,
      model: task.model, purpose: task.metadata?.title || task.prompt.slice(0, 240), policy, slices: prepared.slices,
      redactions: prepared.redactions, estimatedTokens: prepared.metrics.prunedContextTokens, payload: prepared.prompt,
      externalTools });
    this.emit('security', { taskId: task.id, provider: task.provider, decision: 'MANIFEST', disclosure: task.disclosure, at: new Date().toISOString() });
    return task;
  }

  writeProviderPolicies(provider, runtime, policy) {
    const hook = path.resolve(__dirname, '..', 'pi-core', 'security', 'hook-entry.js').replace(/'/g, "'\\''");
    if (provider === 'claude' || provider === 'claude-code') {
      runtime.claudeSettings = path.join(runtime.root, 'claude-settings.json'); runtime.mcpConfig = path.join(runtime.root, 'mcp.json');
      const settings = { disableAllHooks: false, permissions: { deny: ['WebSearch', 'WebFetch', 'mcp__.*'] },
        hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `node '${hook}'`, timeout: 15 }] }] } };
      fs.writeFileSync(runtime.claudeSettings, JSON.stringify(settings, null, 2), { mode: 0o600 });
      fs.writeFileSync(runtime.mcpConfig, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    }
    if (provider === 'gemini') {
      runtime.geminiPolicy = path.join(runtime.root, 'gemini-admin-policy.toml');
      runtime.geminiTrustFile = path.join(runtime.root, 'trustedFolders.json');
      fs.writeFileSync(runtime.geminiTrustFile, JSON.stringify({ [policy.taskRoot]: 'TRUST_FOLDER' }, null, 2), { mode: 0o600 });
      fs.writeFileSync(runtime.geminiPolicy, [
        '[[rule]]', 'toolName = ["google_web_search", "web_fetch", "activate_skill", "invoke_agent"]', 'decision = "deny"', 'priority = 999',
        'denyMessage = "BigKiji security policy: external tools are broker-only."', '',
        '[[rule]]', 'toolName = "run_shell_command"', 'decision = "deny"', 'priority = 998',
        'denyMessage = "BigKiji security policy: shell execution is local PiAgent-only."', '',
        '[[safety_checker]]', 'toolName = ["write_file", "replace"]', 'priority = 999', '[safety_checker.checker]',
        'type = "in-process"', 'name = "allowed-path"', 'required_context = ["environment"]', '',
      ].join('\n'), { mode: 0o600 });
      const geminiDir = path.join(runtime.home, '.gemini'); fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true },
        disableYoloMode: true, disableAlwaysAllow: true, enablePermanentToolApproval: false,
        environmentVariableRedaction: { enabled: true }, toolSandboxing: true },
      tools: { sandbox: true, sandboxNetworkAccess: false, sandboxAllowedPaths: [] }, mcpServers: {} }, null, 2), { mode: 0o600 });
    }
  }

  adapter(provider, prompt, cwd, policy, runtime = {}, model = '') {
    if (provider === 'claude' || provider === 'claude-code') return {
      command: process.env.CLAUDE_BIN || 'claude',
      args: ['--print', prompt, ...(model ? ['--model', model] : []),
        '--output-format', 'stream-json', '--verbose', '--permission-mode', policy.allowWrite.length ? 'acceptEdits' : 'plan',
        '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config',
        ...(runtime.mcpConfig ? ['--mcp-config', runtime.mcpConfig] : []), ...(runtime.claudeSettings ? ['--settings', runtime.claudeSettings, '--setting-sources', 'user'] : []),
        '--allowed-tools', 'Read,Edit,Write,Bash,Grep,Glob', '--disallowed-tools', 'WebSearch,WebFetch,mcp__.*',
        ...policy.allowRead.flatMap((dir) => ['--add-dir', dir])],
    };
    if (provider === 'codex') return { command: process.env.CODEX_BIN || 'codex',
      args: ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--strict-config',
        '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"',
        '--sandbox', policy.allowWrite.length ? 'workspace-write' : 'read-only', '--cd', cwd, prompt] };
    if (provider === 'gemini') return { command: process.env.GEMINI_BIN || 'gemini',
      args: ['--prompt', prompt, '--output-format', 'stream-json', '--approval-mode', policy.allowWrite.length ? 'default' : 'plan', '--sandbox',
        ...(runtime.geminiPolicy ? ['--admin-policy', runtime.geminiPolicy] : [])] };
    if (provider === 'glm') return { command: process.env.PI_BIN || 'pi',
      args: ['--print', '--model', `zai/${GLM_MODELS.flagship}`, '--no-context-files', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', prompt] };
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

  public(task) { const { child, prompt, preparedPrompt, securityPolicy, runtime, ...safe } = task; return { ...safe, promptPreview: prompt.slice(0, 160) }; }
}

module.exports = { TaskRunner };
