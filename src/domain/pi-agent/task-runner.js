'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');
const { SandboxPolicyResolver } = require('./sandbox-policy');
const { GLM_MODELS, resolveModel, classifyFailure, retryAfterMs } = require('./model-router');

// Every one of these runs on the single GPU this machine has.
const LOCAL_PROVIDERS = new Set(['qwen', 'ollama']);
const { ContextPruner } = require('./context-pruner');
const { createStepReader, providerEmitsSteps } = require('./stream-steps');
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
    // Per-task JSONL line buffers for the work-step parser. Freed in finish().
    this.stepReaders = new Map();
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
    // A failed task's manifest describes files as they were before the failure, so
    // approving it directly always ends in STALE_DISCLOSURE_MANIFEST after the owner
    // has already committed. retry() re-seals it first; say so now instead.
    if (task.status !== 'awaiting_approval') throw new Error(task.status === 'failed'
      ? 'Retry this task before approving it: its disclosure is stale'
      : `Task is not approvable: ${task.status}`);
    if (!expected.disclosureHash || expected.disclosureHash !== task.disclosure?.disclosureHash) throw new Error('STALE_DISCLOSURE_HASH');
    if (!this.canStart(task)) {
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
      task.runtime = this.security.createRuntime(task.id, task.provider);
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
    const redacted = redactPayload(buf.toString());
    // Steps are read from the redacted-but-unflattened text, before cleanText() collapses
    // newlines and truncates. Everything below this block is unchanged: task:log still
    // carries the same cleaned string it always has, and captureUsage still runs on it.
    // This only adds a second, structured reading of the same bytes.
    if (!isError && !redacted.blocked && this.stepReaders) this.emitSteps(task, redacted.text);
    const text = knowledge.cleanText(redacted.text, 4000);
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

  /**
   * Forget finished work, oldest first, once there is enough of it.
   *
   * `this.tasks` had no delete anywhere: it held every task for the life of the
   * process, and the daemon runs for days. Nothing that is still queued, running or
   * waiting for the owner is ever dropped — the cap applies only to work that has
   * already ended, and the most recent 200 of those are kept because /status and the
   * report read them.
   */
  forgetOldTasks(keep = 200) {
    const terminal = [...this.tasks.values()]
      .filter((task) => ['completed', 'failed', 'blocked'].includes(task.status))
      .sort((a, b) => String(a.finishedAt || a.updatedAt || '').localeCompare(String(b.finishedAt || b.updatedAt || '')));
    for (const task of terminal.slice(0, Math.max(0, terminal.length - keep))) {
      this.tasks.delete(task.id);
      this.stepReaders?.delete?.(task.id);
      this.completions?.delete?.(task.id);
      this.emit('forgotten', { taskId: task.id });
    }
  }

  finish(task, code, extra = '', error = '') {
    if (task.status !== 'running') return;
    if (extra || error) task.error = `${task.error}\n${extra || error}`.trim();
    clearTimeout(task.timeoutTimer); delete task.timeoutTimer;
    task.status = code === 0 ? 'completed' : 'failed'; task.exitCode = code;
    // Why it failed, if the reason is one the provider is not to blame for. The
    // exit code alone cannot tell a rate limit from a bad patch — every CLI here
    // exits non-zero for both — so the classification reads what the provider
    // actually said on stderr. '' means an ordinary failure, which the router
    // should and does learn from.
    task.failureReason = code === 0 ? '' : classifyFailure(task.error);
    if (task.failureReason) task.retryAfterMs = retryAfterMs(task.error);
    task.finishedAt = new Date().toISOString(); task.updatedAt = task.finishedAt; delete task.child;
    this.stepReaders.delete(task.id);
    if (['qwen', 'ollama'].includes(task.provider)) this.qwenGuardrails.leave({
      durationMs: Math.max(0, new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()), timedOut: !!task.timedOut });
    this.forgetOldTasks();
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

  /**
   * Whether this task may start right now.
   *
   * Two limits, for two different reasons. `maxParallel` is about the machine as a
   * whole. The second is about the card: every local model runs on the one GPU the
   * owner also uses for ComfyUI, LTX-2 and ACE-Step, and the standing rule for this
   * machine is that GPU work goes one at a time — two at once is the Metal error and
   * the OOM that rule exists to prevent. Paid providers are network calls and are
   * not affected, so a local check and three cloud tasks genuinely run together.
   *
   * `enter()` on the guardrails only counted; nothing ever refused a second one.
   * @returns {boolean}
   */
  canStart(task) {
    const running = [...this.tasks.values()].filter((item) => item.status === 'running');
    if (running.length >= this.maxParallel) return false;
    if (!LOCAL_PROVIDERS.has(task.provider)) return true;
    return !running.some((item) => LOCAL_PROVIDERS.has(item.provider));
  }

  drain() {
    // Look past a blocked task rather than stopping at it: with one local task
    // running, the first queued item may be another local one, and stopping there
    // would idle every paid provider behind it.
    for (const next of [...this.tasks.values()].filter((item) => item.status === 'queued')) {
      if (!this.canStart(next)) continue;
      this.start(next);
      return;
    }
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
      // apiKeyHelper is how Anthropic documents authenticating without depending on
      // HOME: a command named in settings whose stdout becomes the credential, run
      // from an absolute path. The sandbox HOME hid the login keychain itself —
      // `security` looks for it under $HOME/Library/Keychains, measured exit 44 —
      // so every claude-code task reported "Not logged in". claude-key-helper.js
      // addresses the keychain by absolute path instead, and reads one field of it.
      const keyHelper = path.resolve(__dirname, '..', 'pi-core', 'security', 'claude-key-helper.js').replace(/'/g, "'\\''");
      const settings = { disableAllHooks: false, permissions: { deny: ['WebSearch', 'WebFetch', 'mcp__.*'] },
        apiKeyHelper: `node '${keyHelper}'`,
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
        ...(model ? ['--model', model] : []),
        '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"',
        '--sandbox', policy.allowWrite.length ? 'workspace-write' : 'read-only', '--cd', cwd, prompt] };
    if (provider === 'gemini') return { command: process.env.GEMINI_BIN || 'gemini',
      args: ['--prompt', prompt, '--output-format', 'stream-json', '--approval-mode', policy.allowWrite.length ? 'default' : 'plan', '--sandbox',
        ...(runtime.geminiPolicy ? ['--admin-policy', runtime.geminiPolicy] : [])] };
    // Both of these used to ignore the model the router chose: GLM ran its flagship
    // for every task including read-only checks, and the local tier was pinned to
    // the 21GB model whatever was asked. The resolved model is used when there is
    // one, and the old pin is the fallback so a caller that resolves nothing still
    // gets a working command.
    if (provider === 'glm') return { command: process.env.PI_BIN || 'pi',
      args: ['--print', '--model', `zai/${model || GLM_MODELS.flagship}`, '--no-context-files', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', prompt] };
    if (provider === 'qwen' || provider === 'ollama') return { command: process.env.OLLAMA_BIN || 'ollama',
      args: ['run', model || process.env.BIGKIJI_QWEN_MODEL || 'qwen3.5:35b-a3b', prompt] };
    throw new Error(`No task adapter for provider: ${provider}`);
  }

  // Structured work steps, emitted alongside the raw log rather than instead of it.
  //
  // The raw log stays the source of truth the owner can fall back on: if a provider
  // changes its stream format this parser goes quiet, and a quiet timeline next to a live
  // log is a degradation, whereas a timeline that were the only surface would be a
  // blackout right before an approval decision.
  emitSteps(task, rawText) {
    if (!providerEmitsSteps(task.provider)) return;
    let reader = this.stepReaders.get(task.id);
    if (!reader) { reader = createStepReader(); this.stepReaders.set(task.id, reader); }
    for (const step of reader(rawText)) {
      this.emit('step', Object.assign({
        taskId: task.id, runId: task.runId || '', provider: task.provider,
        seq: (this.stepSeq = (this.stepSeq || 0) + 1), at: new Date().toISOString(),
      }, step));
    }
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
