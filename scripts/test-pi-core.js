'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../src/domain/pi-agent/core-execution-coordinator');
const { ModelCapabilityRegistry } = require('../src/domain/pi-agent/model-capability-registry');

function fakeSpawn(command) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 143, 'SIGTERM');
  setTimeout(() => {
    child.stdout.write(`${JSON.stringify({ event: 'result', command, input_tokens: 24, output_tokens: 8 })}\n`);
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
  }, 12);
  return child;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-pi-core-'));
  fs.mkdirSync(path.join(root, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pi', 'sandbox.json'), JSON.stringify({ filesystem: { allowRead: [root], allowWrite: [root] },
    models: { allowPaid: ['claude', 'claude-code', 'codex', 'gemini', 'glm'] } }));
  fs.writeFileSync(path.join(root, 'README.md'), '# E2E fixture\n');
  const runner = new TaskRunner({ cwd: root, vaultRoot: root, spawnImpl: fakeSpawn, maxParallel: 5 });
  const registry = new ModelCapabilityRegistry({ root: path.join(root, 'knowledge') });
  const coordinator = new CoreExecutionCoordinator({ taskRunner: runner, registry, settingsProvider: () => ({
    routing: { executionMode: 'auto', maxAgents: 3, activationMode: 'on-demand', sessionLeader: 'auto' },
    quality: { gate: 'strict', maxRepairCycles: 3 },
  }) });
  const events = []; coordinator.on('run', (event) => events.push(event));
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'e2e', 'bigkiji-3d-shooter.json'), 'utf8'));
  const run = coordinator.submit({ prompt: fixture.ownerPrompt, promptSpec: { goal: fixture.ownerPrompt, acceptance: fixture.acceptance }, mode: 'auto', cwd: root });
  assert.strictEqual(run.status, 'AWAITING_APPROVAL');
  assert.strictEqual(runner.snapshot().filter((task) => task.status === 'running').length, 0);
  coordinator.approve(run.id, { revision: run.revision, planHash: run.planHash, disclosureHash: run.disclosureHash,
    idempotencyKey: 'owner-test-approval' });
  const deadline = Date.now() + 3000;
  while (!['COMPLETED', 'FAILED'].includes(coordinator.get(run.id).status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = coordinator.get(run.id);
  assert.strictEqual(result.status, 'COMPLETED', JSON.stringify(result, null, 2));
  assert.strictEqual(result.assignments.length, 3);
  assert.deepStrictEqual(new Set(result.assignments.map((a) => a.provider)), new Set(['claude-code', 'codex', 'glm']));
  assert(events.some((event) => event.status === 'EXECUTING'));
  assert(events.some((event) => event.status === 'COMPLETED'));
  assert(runner.snapshot().every((task) => task.status === 'completed'));
  assert.strictEqual(registry.performance.models.codex.successRate, 1);
  console.log(`pi core E2E selftest: PASS · explicit owner approval · ${result.assignments.length} on-demand specialists · ${events.length} lifecycle events`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
