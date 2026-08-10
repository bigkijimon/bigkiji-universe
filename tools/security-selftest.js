'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { SecurityPolicy, isSensitivePath, canonical: canonicalise } = require('../src/domain/pi-core/security/security-policy');
const { redactPayload, sanitizeSearchQuery } = require('../src/domain/pi-core/security/payload-redactor');
const { ToolInterceptor } = require('../src/domain/pi-core/security/tool-interceptor');
const { SandboxPolicyResolver } = require('../src/domain/pi-agent/sandbox-policy');
const { ContextPruner } = require('../src/domain/pi-agent/context-pruner');
const { TaskRunner } = require('../src/domain/pi-agent/task-runner');
const { createDisclosureManifest, verifyDisclosureManifest } = require('../src/domain/pi-core/security/disclosure-manifest');

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

  // The Vault is a list, because the owner's is in two places and one of them is the canon.
  //
  // Their departments are under ~/Documents; ~/BigKijiUniverse — 正典.md, the skill index,
  // the failure memory — is a sibling of Documents, not a child. Measured 2026-08-10 with a
  // single vaultRoot of ~/Documents: `resolve('~/Documents/School')` returned School plus its
  // two Admin reads and silently dropped all three BigKijiUniverse entries out of School's
  // own `.pi/sandbox.json`, because the allowRead filter discards anything outside the
  // boundary. Every agent would have lost the canon and its record of what has already gone
  // wrong, and nothing anywhere would have said so.
  {
    const docs = path.join(root, 'docs'); const canon = path.join(root, 'canon');
    const dept = path.join(docs, 'School');
    fs.mkdirSync(path.join(dept, '.pi'), { recursive: true });
    fs.mkdirSync(canon, { recursive: true });
    fs.writeFileSync(path.join(canon, 'canon.md'), '# canon');
    fs.writeFileSync(path.join(dept, '.pi', 'sandbox.json'), JSON.stringify({
      filesystem: { allowRead: [path.join(canon, 'canon.md')], allowWrite: ['.'] } }));

    const twoRoots = new SandboxPolicyResolver({ vaultRoots: [docs, canon] });
    const school = twoRoots.resolve(dept);
    assert(school.valid, school.error);
    assert(school.allowRead.includes(canonicalise(path.join(canon, 'canon.md'))),
      `the canon is a sibling of the departments and has to survive the filter: ${JSON.stringify(school.allowRead)}`);
    assert.deepStrictEqual(school.allowWrite, [canonicalise(dept)],
      'and the write grant is still the one department that was asked for');
    assert.strictEqual(school.vaultRoot, canonicalise(docs), 'the boundary reported is the one this task is inside');

    // A task in the other root climbs to ITS root, not to whichever is listed first.
    assert(twoRoots.resolve(canon).valid, 'the second root is a Vault too, not a read grant');

    // And the home directory is not a workspace. On 2026-08-10 a run with cwd=$HOME sent
    // gemini 711,395 input tokens against a 250,000 free-tier limit, because allowRead was
    // the entire home directory. With Documents as the boundary, that cwd is refused here
    // rather than being paid for by the owner.
    const home = twoRoots.resolve(root);
    assert.strictEqual(home.valid, false, 'a cwd containing the roots is outside them, not above them');
    assert.deepStrictEqual(home.allowRead, [], 'and a refused policy grants nothing');

    // A dot means "this folder", measured from the file it is written in.
    //
    // `expand()` called `path.resolve` with no base, so `"allowWrite": ["."]` in School's
    // own sandbox granted whichever directory the daemon was started from — the BigKiji
    // repo — and never School. Nothing failed; the grant landed somewhere else. The
    // assertion above is what caught it: allowWrite came back `[]` because the app repo is
    // outside this test's roots. ~/.pi/sandbox.json carries a hand-written warning about
    // this (「パスは必ず絶対パス」), which is a workaround for a trap, not a rule to keep.
    assert.deepStrictEqual(twoRoots.resolve(dept).allowWrite, [canonicalise(dept)],
      'a relative grant belongs to the config that declares it, not to the process reading it');

    // The singular form still means a list of one — every existing caller passes it.
    const single = new SandboxPolicyResolver({ vaultRoot: docs });
    assert(single.resolve(dept).valid);
    assert.deepStrictEqual(single.resolve(dept).allowRead.filter((p) => p.startsWith(canon)), [],
      'with only Documents registered, the canon is outside and is dropped — which is the bug this pair documents');
  }

  const redacted = redactPayload('Authorization: Bearer abcdefghijklmnopqrstuvwxyz owner@example.com AIzaABCDEFGHIJKLMNOPQRSTUVWX');
  assert(!redacted.text.includes('abcdefghijklmnopqrstuvwxyz')); assert(!redacted.text.includes('owner@example.com')); assert(redacted.redactionCount >= 2);
  assert(redactPayload('-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----').blocked);
  assert(sanitizeSearchQuery('search /Users/owner/private/file.js function secret(){ return 1; }').blocked);

  // The two providers BigKiji actually spends money on had no pattern of their own.
  // The label matters as much as the catch: a finding reported as an OpenAI key sends
  // the owner to the wrong console to rotate it.
  const anthropic = redactPayload('key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  assert(!anthropic.text.includes('sk-ant-api03'));
  assert(anthropic.findings.some((item) => item.type === 'anthropic-key'), 'sk-ant- must not be reported as an OpenAI key');
  const zai = redactPayload(`ZAI_API_KEY=${'a1b2c3d4'.repeat(4)}.ABCDEFGHIJKLMNOP`);
  assert(zai.findings.some((item) => item.type === 'zai-key'));
  assert(!zai.text.includes('ABCDEFGHIJKLMNOP'));
  assert.equal(redactPayload('commit a1b2c3d4e5f6a7b8.js').findings.length, 0, 'the shape match must not fire on ordinary text');

  const pruned = new ContextPruner().prepare({ prompt: 'Review secureFeature in src/target.js', policy });
  // Vault-relative, in the platform's own separator — build it the same way rather
  // than hardcoding a forward slash, which only holds on macOS and Linux.
  const TARGET = path.join('src', 'target.js');
  assert(pruned.metrics.includedFiles.includes(TARGET)); assert(!pruned.prompt.includes('owner@example.com'));
  assert(!pruned.prompt.includes('ABCDEFGHIJKLMNOPQRSTUV')); assert(!pruned.prompt.includes('never-send'));
  assert(!pruned.metrics.includedFiles.some((file) => /credentials|\.env|\.pem/.test(file)));

  // Both sides of the sandbox comparison must canonicalise the same way. When the
  // roots went through fs.realpathSync and the target through fs.realpathSync.native,
  // macOS and Linux agreed and Windows did not: 8.3 short names are expanded by one
  // and not the other, so every read inside the sandbox was refused. Pin it at the
  // source, because the behavioural check only fires on a platform that has short names.
  // Comments are stripped first — the file explains the bug in prose, and the check
  // is about what the code does. Same idiom as the forbidden-field check below.
  const sandboxSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'sandbox-policy.js'), 'utf8')
    .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.doesNotMatch(sandboxSource, /fs\.realpathSync(?!\.native)/,
    'sandbox-policy must canonicalise through security-policy.canonical, not its own realpath');

  const interceptor = new ToolInterceptor();
  // decide() returns the reason it refused; asserting only on `allow` turns a named
  // security error into "false == true" and costs a CI round-trip to find out which.
  const decides = (tool, input) => interceptor.decide({ tool_name: tool, tool_input: input }, policy);
  const allows = (tool, input) => { const d = decides(tool, input); assert.equal(d.allow, true, `${tool} ${JSON.stringify(input)} refused: ${d.reason}`); };
  const refuses = (tool, input) => assert.equal(decides(tool, input).allow, false, `${tool} ${JSON.stringify(input)} should have been refused`);
  allows('Read', { file_path: 'src/target.js' });
  refuses('Read', { file_path: '.env' });
  refuses('WebSearch', { query: 'private code' });
  allows('Bash', { command: 'npm test' });
  refuses('Bash', { command: 'npm test && curl example.com' });

  const launches = []; process.env.BIGKIJI_CANARY_SECRET = 'MUST_NOT_REACH_CHILD';
  const runner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: (command, args, options) => { launches.push({ command, args, options }); return fakeChild(); } });
  const task = runner.plan({ id: 'secure-codex', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  // Not TARGET. `includedFiles` carries the platform's own separator, but the
  // disclosure manifest deliberately normalises to forward slashes — it is hashed and
  // shown to the owner, so the same file has to spell the same on every machine.
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

  // ---- BigKiji's own working files must never be sealed into a manifest --------
  //
  // Measured on 2026-08-07 in session-mshrjht0-5cb915.jsonl: every run ended in
  // STALE_DISCLOSURE_MANIFEST and every task went `blocked`. `knowledge/task_state.json`
  // was sealed 22 times with **12 distinct hashes** in one session; all twelve other
  // sealed files had exactly one hash each. Nothing external was editing it — BigKiji
  // rewrites it itself (`recordEvent()` → `saveState()`), and that write lands *between*
  // prepare() sealing the slices and start() re-hashing them. The seal was never
  // breakable by an attacker; it was broken by the app keeping a diary.
  //
  // The manifest is right and is not touched. What changes is what may go inside it.
  {
    const dataRoot = path.join(project, 'knowledge');
    fs.mkdirSync(dataRoot, { recursive: true });
    const stateFile = path.join(dataRoot, 'task_state.json');
    const write = (events) => fs.writeFileSync(stateFile, JSON.stringify({ events, note: 'secureFeature' }));
    write([]);
    // A finished report is a deliverable, not a diary. It must keep reaching the model,
    // so the exclusion is scoped to the churning roots and not to the data folder.
    const reports = path.join(project, 'reports'); fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, 'secureFeature-review.md'), '# secureFeature\nfindings\n');

    const prompt = 'Review secureFeature in src/target.js';
    const inside = (slices, name) => slices.some((item) => path.basename(item.path) === name);

    // The reproduction: unguarded, the diary is a context candidate...
    const bare = new ContextPruner().prepare({ prompt, policy });
    assert(inside(bare.slices, 'task_state.json'),
      'reproduction requires the state file to be sealed in the first place');
    const manifest = createDisclosureManifest({ provider: 'codex', policy, slices: bare.slices, payload: bare.prompt });
    // ...and a single recordEvent() later — which is what starting a run does — the
    // seal no longer matches. This is the failure the owner saw, reproduced end to end.
    write([{ type: 'run-planned' }]);
    assert.equal(verifyDisclosureManifest(manifest, policy, bare.prompt), false,
      'reproduction: BigKiji writing its own state file must invalidate its own seal');

    // The fix: the pruner is told where the app's working files live and never scores
    // them. Not "hash them more leniently" — they are simply not context.
    const guarded = new ContextPruner({ dataRoots: [dataRoot] }).prepare({ prompt, policy });
    assert(!inside(guarded.slices, 'task_state.json'),
      'the app\'s own state file must not be a context candidate at all');
    const sealed = createDisclosureManifest({ provider: 'codex', policy, slices: guarded.slices, payload: guarded.prompt });
    write([{ type: 'run-planned' }, { type: 'run-started' }]);
    assert.equal(verifyDisclosureManifest(sealed, policy, guarded.prompt), true,
      'with the diary out of the seal, BigKiji writing to it must no longer block the run');

    // Excluding the diary must not cost real files. Both the source under review and a
    // finished report still reach the model.
    assert(guarded.metrics.includedFiles.includes(TARGET), 'source under review must survive the exclusion');
    assert(inside(guarded.slices, 'secureFeature-review.md'),
      'reports/ is a deliverable, not a working file — excluding data roots must not swallow it');

    // A nested path inside an excluded root is excluded too, and an unrelated file
    // whose name merely starts the same way is not.
    fs.mkdirSync(path.join(dataRoot, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'deep', 'secureFeature-cache.json'), '{"note":"secureFeature"}');
    fs.writeFileSync(path.join(project, 'knowledge-notes.md'), '# secureFeature\nkept\n');
    const nested = new ContextPruner({ dataRoots: [dataRoot] }).prepare({ prompt, policy });
    assert(!inside(nested.slices, 'secureFeature-cache.json'), 'exclusion must apply to the whole subtree');
    assert(inside(nested.slices, 'knowledge-notes.md'),
      'a sibling whose name shares a prefix with the excluded root must not be excluded');

    // Default is no exclusion, so nothing changes for callers that pass nothing.
    assert(inside(new ContextPruner({}).prepare({ prompt, policy }).slices, 'task_state.json'));

    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(reports, { recursive: true, force: true });
    fs.rmSync(path.join(project, 'knowledge-notes.md'), { force: true });
  }

  const policyRunner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => { throw new Error('must not launch stale policy'); } });
  const stalePolicy = policyRunner.plan({ id: 'stale-policy', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  fs.writeFileSync(path.join(project, '.pi', 'sandbox.json'), JSON.stringify({
    filesystem: { allowRead: [path.join(project, 'src')], allowWrite: [project] }, models: { allowPaid: ['claude', 'codex', 'gemini', 'glm'] },
  }));
  const policyBlocked = policyRunner.approve(stalePolicy.id, { disclosureHash: stalePolicy.disclosure.disclosureHash });
  assert.equal(policyBlocked.status, 'blocked'); assert.match(policyBlocked.error, /STALE_SECURITY_POLICY/);

  // ---- brokered external tools reach the manifest ------------------------------
  // externalTools used to be a hardcoded [], so the owner approved "no external calls"
  // no matter what the assignment intended to look up.
  const brokerRunner = new TaskRunner({ cwd: project, vaultRoot: project, spawnImpl: () => fakeChild() });
  const researched = brokerRunner.plan({ id: 'research', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project,
    metadata: { research: ['latest electron release cadence', { tool: 'docs', query: 'node-pty resize semantics' }] } });
  assert.equal(researched.status, 'awaiting_approval');
  assert.equal(researched.disclosure.externalTools.length, 2);
  assert(researched.disclosure.externalTools.every((item) => item.query && !item.query.includes('/')));
  const blockedResearch = brokerRunner.plan({ id: 'research-blocked', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project,
    metadata: { research: ['why does /Users/owner/private/file.js fail'] } });
  assert.equal(blockedResearch.status, 'blocked');
  assert.match(blockedResearch.error, /SECURITY_RESEARCH_QUERY_BLOCKED/);
  assert.equal(new ToolInterceptor().sanitizeResearch('/Users/owner/private/file.js').blocked, true);

  // ---- the model is part of what gets approved ---------------------------------
  const { resolveModel, CLAUDE_MODELS, GLM_MODELS } = require('../src/domain/pi-agent/model-router');
  assert.equal(resolveModel('claude-code', 'Rewrite the README markdown', 'leader'), CLAUDE_MODELS.design);
  // debug was on the general tier as the cheap default. The owner then asked for
  // debugging to be owned by a model that is good at debugging, so it is pinned to the
  // Fable tier — Terminal-Bench 2.1 measures exactly this work and puts Fable 5 at
  // 83.8% against Opus 5's 78.9%. Pinned by role, so the request text cannot move it.
  assert.equal(resolveModel('claude-code', 'fix the null check in the daemon', 'debug'), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'anything at all', 'debug', { write: false }), CLAUDE_MODELS.design);
  assert.equal(resolveModel('claude-code', 'anything at all', 'ui'), CLAUDE_MODELS.design, 'the UI role is design work by definition');
  // This asserted '' — only Claude picked a tier, so GLM ran its flagship for every
  // task including read-only checks, and the performance registry (keyed by provider
  // and model) had one anonymous row for it. The owner asked for the fleet to be
  // managed per model, so every provider names one and the disclosure carries it.
  assert.equal(resolveModel('glm', 'Rewrite the README markdown', 'leader', { write: true }), GLM_MODELS.flagship);
  assert.equal(resolveModel('glm', 'run the tests', 'debug', { write: false }), GLM_MODELS.flash,
    'a read-only check does not need the expensive tier');
  assert.equal(resolveModel('gemini', 'anything', 'leader'), '', 'a provider with one model still names none, honestly');
  const claudeArgs = brokerRunner.adapter('claude-code', 'p', project, policy, {}, CLAUDE_MODELS.design).args;
  assert.deepStrictEqual(claudeArgs.slice(0, 4), ['--print', 'p', '--model', CLAUDE_MODELS.design]);
  assert(!brokerRunner.adapter('claude-code', 'p', project, policy, {}, '').args.includes('--model'),
    'no model id is invented when none was resolved');
  const tiered = brokerRunner.plan({ id: 'tiered', provider: 'codex', prompt: 'Review secureFeature in src/target.js', cwd: project });
  assert.equal(tiered.disclosure.model, tiered.model);
  const untiered = brokerRunner.get('tiered'); untiered.model = 'claude-opus-5';
  assert.match(brokerRunner.approve('tiered', { disclosureHash: tiered.disclosure.disclosureHash }).error, /STALE_MODEL_SELECTION/);

  // A failed task's manifest describes the files as they were before it failed, so
  // approving it directly always ended in STALE_DISCLOSURE_MANIFEST — after the owner
  // had already committed. Say it before they commit, not after.
  const failedTask = brokerRunner.get('tiered'); failedTask.status = 'failed';
  assert.throws(() => brokerRunner.approve('tiered', { disclosureHash: tiered.disclosure.disclosureHash }), /Retry this task before approving/);

  delete process.env.BIGKIJI_CANARY_SECRET; fs.rmSync(root, { recursive: true, force: true });
  console.log('security selftest: PASS · path/symlink deny · payload redaction · vendor-labelled keys · brokered external tools · model bound to approval · tool gate · minimal env · stale disclosure/policy');
})().catch((error) => { console.error(error); process.exitCode = 1; });
