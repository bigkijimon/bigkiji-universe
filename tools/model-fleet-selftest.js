'use strict';

// One model per task, several tasks at once, and only one on the GPU.
//
// The owner asked for three things: manage the fleet per model rather than per
// provider, pick the right model for each task automatically, and run several
// models on several jobs at the same time. Each was partly there and wrong in a
// different way.
//
//   Per model      the performance registry is keyed by (provider, model), but only
//                  Claude ever carried one — GLM always ran its flagship and the
//                  local tier was pinned to the 21GB model — so there was one row
//                  per provider and the tiers could not be told apart.
//   Per task       resolveModel returned '' for everything except Claude and Codex.
//   At once        maxParallel was a literal 3 nobody could reach, and nothing
//                  stopped two local models sharing the one GPU. `enter()` on the
//                  guardrails counted; it never refused.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { resolveModel, pickWeight, CLAUDE_MODELS, GLM_MODELS, CODEX_MODELS, LOCAL_MODELS } = require('../src/domain/pi-agent/model-router');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { SettingsStore } = require('../src/core/settings-store');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-fleet-'));

ok('every provider names a model for every task', () => {
  // '' meant "the adapter decides", and the adapter decided the same thing every
  // time. A fleet cannot be managed per model while three of its members are
  // anonymous.
  for (const provider of ['claude-code', 'codex', 'glm', 'qwen']) {
    const model = resolveModel(provider, 'implement the change', 'leader', { write: true });
    assert.ok(model, `${provider} must name the model it will run`);
  }
  assert.equal(resolveModel('gemini', 'anything', 'leader'), '', 'a provider with one model still names none, honestly');
});

ok('the model follows the task, not the provider', () => {
  // Read-only work on a short request is a check. A check does not need the
  // expensive tier, and the local one does not need 21GB of card.
  assert.equal(resolveModel('glm', 'run the tests', 'debug', { write: false }), GLM_MODELS.flash);
  assert.equal(resolveModel('glm', 'implement the validation', 'leader', { write: true }), GLM_MODELS.flagship);
  assert.equal(resolveModel('qwen', 'narrow down the relevant files', 'context', { write: false }), LOCAL_MODELS.light);
  assert.equal(resolveModel('qwen', 'implement it', 'leader', { write: true }), LOCAL_MODELS.heavy);
  // Claude's axis is kind, not effort, and it is unchanged.
  assert.equal(resolveModel('claude-code', 'anything', 'ui', { write: true }), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'fix the null check', 'leader', { write: true }), CLAUDE_MODELS.general);
  assert.equal(resolveModel('codex', 'anything', 'ui', { write: true }), CODEX_MODELS.general);
});

ok('cheap is the exception, expensive is the default', () => {
  // Being wrong in the cheap direction produces a bad answer; being wrong in the
  // expensive direction produces a slightly larger bill.
  assert.equal(pickWeight('anything', 'debug', { write: true }), 'heavy', 'anything that writes is heavy');
  assert.equal(pickWeight('全面的に作り直したい', 'debug', { write: false }), 'heavy', 'the owner called it a rebuild');
  assert.equal(pickWeight('x'.repeat(2000), 'debug', { write: false }), 'heavy', 'a long request is not a quick check');
  assert.equal(pickWeight('check it', 'leader', { write: false }), 'heavy', 'leader decides what the others do');
  assert.equal(pickWeight('check it', 'debug', { write: false }), 'light');
});

ok('the command that runs carries the chosen model', () => {
  const runner = new TaskRunner({ cwd: root });
  const policy = { allowRead: [], allowWrite: [] };
  const modelOf = (provider, model) => {
    const args = runner.adapter(provider, 'p', root, policy, {}, model).args;
    const index = args.indexOf('--model');
    return index >= 0 ? args[index + 1] : args[1];
  };
  assert.equal(modelOf('glm', 'glm-4.7-flash'), 'zai/glm-4.7-flash', 'GLM ignored this and always ran its flagship');
  // Prefixed, like glm's zai/ above: local work now runs through Pi rather than
  // `ollama run`, so the model name carries Pi's provider namespace.
  assert.equal(modelOf('qwen', 'qwen3.5:latest'), 'ollama/qwen3.5:latest', 'and the local tier was pinned to the 21GB model');
  assert.equal(modelOf('codex', CODEX_MODELS.general), CODEX_MODELS.general);
  // A caller that resolved nothing still gets a working command.
  assert.equal(modelOf('glm', ''), `zai/${GLM_MODELS.flagship}`);
  assert.equal(modelOf('qwen', ''), `ollama/${LOCAL_MODELS.heavy}`);
  // Read tools unless the run was approved to write. A task that can write when the
  // disclosure manifest said it would not makes that manifest a lie.
  const readOnly = runner.adapter('qwen', 'p', root, { allowRead: [], allowWrite: [] }, {}, '').args;
  assert.equal(readOnly[readOnly.indexOf('--tools') + 1], 'read,grep,find,ls');
  const writable = runner.adapter('qwen', 'p', root, { allowRead: [], allowWrite: [root] }, {}, '').args;
  assert.match(writable[writable.indexOf('--tools') + 1], /edit,write$/);
  for (const args of [readOnly, writable]) {
    assert.ok(!args.includes('bash'), 'a shell is a write primitive whatever the role');
    assert.ok(args.includes('--no-extensions'), 'CVE-2026-54325: project-local extensions load without approval');
  }
});

ok('several models run at once, and only one of them on the GPU', () => {
  const live = new Set(); const together = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const index = args.indexOf('--model');
    const model = index >= 0 ? args[index + 1] : args[1];
    live.add(model);
    if (live.size > 1) together.push([...live]);
    setTimeout(() => { live.delete(model); child.emit('close', 0); }, 60);
    return child;
  };
  const runner = new TaskRunner({ cwd: root, maxParallel: 4, spawnImpl });
  for (const [id, provider, model] of [['t1', 'glm', 'glm-5.2'], ['t2', 'codex', 'gpt-5.6-sol'],
    ['t3', 'claude-code', 'claude-opus-5'], ['t4', 'qwen', 'qwen3.5:latest'], ['t5', 'qwen', 'qwen3.5:35b-a3b']]) {
    const task = runner.plan({ id, provider, model, prompt: 'p', cwd: root, metadata: {} });
    runner.approve(id, { disclosureHash: task.disclosure.disclosureHash });
  }
  const widest = together.reduce((best, set) => (set.length > best.length ? set : best), []);
  assert.ok(widest.length >= 3, `several models must genuinely overlap: ${JSON.stringify(together)}`);
  for (const set of together) {
    const localCount = set.filter((model) => /qwen/.test(model)).length;
    assert.ok(localCount <= 1, `two local models shared the one GPU: ${set.join(' + ')}`);
  }
  runner.shutdown();
});

ok('the GPU limit is a refusal, not a counter', () => {
  const runner = new TaskRunner({ cwd: root, maxParallel: 4 });
  const running = (id, provider) => runner.tasks.set(id, { id, provider, status: 'running' });
  running('a', 'glm'); running('b', 'codex');
  assert.equal(runner.canStart({ id: 'c', provider: 'claude-code' }), true, 'paid work is network, not card');
  assert.equal(runner.canStart({ id: 'd', provider: 'qwen' }), true, 'and the first local task is fine');
  running('e', 'qwen');
  assert.equal(runner.canStart({ id: 'f', provider: 'ollama' }), false,
    'the standing rule for this machine is one GPU job at a time — two is the Metal error it exists to prevent');
  // The queue must look past a blocked task, or one waiting local job idles every
  // paid provider behind it.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'task-runner.js'), 'utf8');
  assert.match(source, /for \(const next of \[\.\.\.this\.tasks\.values\(\)\]\.filter\(\(item\) => item\.status === 'queued'\)\)/);
});

ok('how many run at once is the owner’s setting', () => {
  const store = new SettingsStore({ userData: fs.mkdtempSync(path.join(root, 's-')) });
  assert.equal(store.get().routing.maxParallel, 3, 'the old literal is the default, so nothing changes unasked');
  store.update({ routing: { maxParallel: 6 } });
  assert.equal(store.get().routing.maxParallel, 6);
  store.update({ routing: { maxParallel: 99 } });
  assert.equal(store.get().routing.maxParallel, 8, 'clamped, because the machine is not infinite');
  store.update({ routing: { maxParallel: 0 } });
  assert.equal(store.get().routing.maxParallel, 1, 'and never zero, which would stop the fleet entirely');
  // maxAgents is how many roles one run may use. Different question, and it had the
  // same answer before this.
  assert.notEqual(store.get().routing.maxAgents, undefined);
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(daemon, /maxParallel: Math\.max\(1, Math\.min\(8, Number\(this\.ownerSettings\(\)\?\.routing\?\.maxParallel\)/);
});

ok('the registry can now tell the tiers apart', () => {
  // It has always been keyed by (provider, model) — that key just never had a model
  // in it for three of the four providers, so "glm was slow" could not distinguish
  // the flagship from flash.
  const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'r-')) });
  registry.record({ provider: 'glm', model: GLM_MODELS.flash, role: 'debug', ok: true, durationMs: 400, tokens: {} });
  registry.record({ provider: 'glm', model: GLM_MODELS.flagship, role: 'leader', ok: false, durationMs: 9000, tokens: {} });
  const models = registry.snapshot().performance.models;
  assert.ok(models[`glm::${GLM_MODELS.flash}`], 'flash is its own row');
  assert.ok(models[`glm::${GLM_MODELS.flagship}`], 'and so is the flagship');
  assert.notEqual(models[`glm::${GLM_MODELS.flash}`].successRate, models[`glm::${GLM_MODELS.flagship}`].successRate,
    'which is the whole point — one worked and one did not');
});

// ---------------------------------------------------------------------------
// One blip must not cost the local model its reputation.
//
// 'model-unavailable' is the one failure class where the message is genuinely
// ambiguous: a model that has been deleted and a model whose server hiccuped for one
// call say exactly the same sentence. Measured 2026-08-04 — `pi` accepted the exact
// model name that had just reported "not found", so the failure the owner watched was
// transient. It was still being scored as a fact about the model, and the model in
// question is the free, private, no-quota one the owner keeps as the last resort.
//
// An earlier diagnosis of this same screen blamed an `ollama/` prefix in task-runner
// and was wrong; both name forms were tested against the real CLI and both returned
// OK. These assertions exist so the corrected diagnosis is the one that survives.
// ---------------------------------------------------------------------------

ok('a first model-unavailable leaves no mark, a second one does', () => {
  const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 't-')) });
  const local = LOCAL_MODELS?.planner || 'qwen3.5:35b-a3b';
  const key = `ollama::${local}`;

  registry.record({ provider: 'ollama', model: local, role: 'leader', ok: false,
    reason: 'model-unavailable', transient: true });
  const afterBlip = registry.snapshot().performance.models[key];
  assert.ok(!afterBlip || !afterBlip.failures,
    `a transient sighting must not be scored: ${JSON.stringify(afterBlip)}`);

  registry.record({ provider: 'ollama', model: local, role: 'leader', ok: false,
    reason: 'model-unavailable', transient: false });
  const afterReal = registry.snapshot().performance.models[key];
  assert.ok(afterReal && afterReal.failures >= 1,
    'the second one is evidence and must be recorded as a failure');
});

ok('rate-limit and quota are still never scored, transient or not', () => {
  const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');
  const registry = new ModelCapabilityRegistry({ root: fs.mkdtempSync(path.join(root, 'th-')) });
  for (const reason of ['rate-limit', 'quota']) {
    registry.record({ provider: 'glm', model: GLM_MODELS.flash, role: 'debug', ok: false, reason });
    registry.record({ provider: 'glm', model: GLM_MODELS.flash, role: 'debug', ok: false, reason });
  }
  const row = registry.snapshot().performance.models[`glm::${GLM_MODELS.flash}`];
  assert.ok(!row || !row.failures,
    'being throttled is a fact about the calendar, not about the provider');
});

ok('the retry keeps the same model instead of jumping to a paid provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent',
    'core-execution-coordinator.js'), 'utf8');
  // The retry must run BEFORE the fallback chain, or the free model is abandoned first
  // and the retry never happens.
  assert.match(source, /this\._retryTransient\(run, item\) \|\| this\._fallback\(run, item\)/,
    'the same-model retry is tried first');
  const body = source.slice(source.indexOf('_retryTransient(run, assignment)'));
  assert.match(body.slice(0, 1400), /provider: assignment\.provider, model: assignment\.model/,
    'and it reuses the provider and model rather than resolving new ones');
  assert.match(body.slice(0, 1400), /if \(assignment\.transientRetried\) return false;/,
    'exactly once, so a model that really is gone still falls back');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`model fleet selftest: ${failures} FAILED`); process.exit(1); }
console.log('model fleet selftest: PASS · every provider names its model · cheap is the exception · several at once · one GPU job at a time · owner sets the width · one blip does not cost the local model its reputation');
