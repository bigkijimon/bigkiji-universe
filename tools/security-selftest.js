'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { SecurityPolicy, isSensitivePath } = require('../src/domain/pi-core/security/security-policy');
const { redactPayload, sanitizeSearchQuery } = require('../src/domain/pi-core/security/payload-redactor');
const { ToolInterceptor } = require('../src/domain/pi-core/security/tool-interceptor');
const { SandboxPolicyResolver } = require('../src/domain/pi-agent/sandbox-policy');
const { ContextPruner } = require('../src/domain/pi-agent/context-pruner');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');

function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 1; queueMicrotask(() => child.emit('close', 1, 'SIGTERM')); };
  queueMicrotask(() => { child.stdout.end('{"input_tokens":12,"output_tokens":4}\n'); child.exitCode = 0; child.emit('close', 0, null); });
  return child;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-security-')); const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true }); fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({ filesystem: { allowRead: [project], allowWrite: [project] },
    models: { allowPaid: ['claude', 'codex', 'gemini', 'glm'] } }));
  fs.writeFileSync(path.join(project, 'src', 'target.js'), 'export const contact = "owner@example.com";\nexport const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV";\nexport function secureFeature(){ return true; }\n');
  fs.writeFileSync(path.join(project, '.env'), 'API_KEY=sk-proj-NEVERLEAKTHISVALUE123456\n');
  fs.writeFileSync(path.join(project, 'credentials.json'), '{"password":"never-send"}');
  fs.writeFileSync(path.join(project, 'private.pem'), '-----BEGIN PRIVATE KEY-----\nNEVER\n-----END PRIVATE KEY-----');
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'outside secret');
  try { fs.symlinkSync(outside, path.join(project, 'src', 'escape.txt')); } catch (_) {}

  assert(isSensitivePath(path.join(project, '.env'))); assert(isSensitivePath(path.join(project, 'credentials.json')));
  const resolver = new SandboxPolicyResolver({ vaultRoot: project }); const policy = resolver.resolve(project); assert(policy.valid);
  const security = new SecurityPolicy(); assert.throws(() => security.assertPath(policy, path.join(project, '.env')), /SENSITIVE/);
  assert.throws(() => security.assertPath(policy, outside), /OUTSIDE/);
  if (fs.existsSync(path.join(project, 'src', 'escape.txt'))) assert.throws(() => security.assertPath(policy, path.join(project, 'src', 'escape.txt')), /OUTSIDE/);

  const redacted = redactPayload('Authorization: Bearer abcdefghijklmnopqrstuvwxyz owner@example.com AIzaABCDEFGHIJKLMNOPQRSTUVWX');
  assert(!redacted.text.includes('abcdefghijklmnopqrstuvwxyz')); assert(!redacted.text.includes('owner@example.com')); assert(redacted.redactionCount >= 2);
  assert(redactPayload('-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----').blocked);
  assert(sanitizeSearchQuery('search /Users/owner/private/file.js function secret(){ return 1; }').blocked);

  const pruned = new ContextPruner().prepare({ prompt: 'Review secureFeature in src/target.js', policy });
  assert(pruned.metrics.includedFiles.includes('src/target.js')); assert(!pruned.prompt.includes('owner@example.com'));
  assert(!pruned.prompt.includes('ABCDEFGHIJKLMNOPQRSTUV')); assert(!pruned.prompt.includes('never-send'));
  assert(!pruned.metrics.includedFiles.some((file) => /credentials|\.env|\.pem/.test(file)));

  const interceptor = new ToolInterceptor();
  assert.equal(interceptor.decide({ tool_name: 'Read', tool_input: { file_path: 'src/target.js' } }, policy).allow, true);
  assert.equal(interceptor.decide({ tool_name: 'Read', tool_input: { file_path: '.env' } }, policy).allow, false);
  assert.equal(interceptor.decide({ tool_name: 'WebSearch', tool_input: { query: 'private code' } }, policy).allow, false);
  assert.equal(interceptor.decide({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, policy).allow, true);
  assert.equal(interceptor.decide({ tool_name: 'Bash', tool_input: { command: 'npm test && curl example.com' } }, policy).allow, false);

  const launches = []; process.env.BIGKIJI_CANARY_SECRET = 'MUST_NOT_REACH_CHILD';
  const runner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: (command, args, options) => { launches.push({ command, args, options }); return fakeChild(); } });
  const task = runner.plan({ id: 'secure-codex', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  assert(task.disclosure?.disclosureHash); assert(task.disclosure.files.some((file) => file.path === 'src/target.js'));
  runner.approve(task.id, { disclosureHash: task.disclosure.disclosureHash }); await runner.waitFor(task.id, 2000);
  assert.equal(launches.length, 1); assert.equal(launches[0].options.env.BIGKIJI_CANARY_SECRET, undefined);
  assert.equal(launches[0].options.env.OPENAI_API_KEY, undefined); assert(launches[0].args.includes('--ignore-user-config'));
  assert(launches[0].args.includes('--ephemeral')); assert(!launches[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));

  const staleRunner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => { throw new Error('must not launch stale manifest'); } });
  const stale = staleRunner.plan({ id: 'stale', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  fs.appendFileSync(path.join(project, 'src', 'target.js'), '\n// changed after approval preview\n');
  const blocked = staleRunner.approve(stale.id, { disclosureHash: stale.disclosure.disclosureHash });
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.error, /STALE_DISCLOSURE_MANIFEST/);

  const policyRunner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => { throw new Error('must not launch stale policy'); } });
  const stalePolicy = policyRunner.plan({ id: 'stale-policy', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({
    filesystem: { allowRead: [path.join(project, 'src')], allowWrite: [project] }, models: { allowPaid: ['claude', 'codex', 'gemini', 'glm'] },
  }));
  const policyBlocked = policyRunner.approve(stalePolicy.id, { disclosureHash: stalePolicy.disclosure.disclosureHash });
  assert.equal(policyBlocked.status, 'blocked'); assert.match(policyBlocked.error, /STALE_SECURITY_POLICY/);

  delete process.env.BIGKIJI_CANARY_SECRET; fs.rmSync(root, { recursive: true, force: true });
  console.log('security selftest: PASS · path/symlink deny · payload redaction · tool gate · minimal env · stale disclosure/policy');
})().catch((error) => { console.error(error); process.exitCode = 1; });
