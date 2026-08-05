'use strict';
// Malformed input has to degrade. It must not take the process down.
//
// Four separate crashes shipped at once, and they shared a shape: some value
// arrives from outside the module — a hand-edited config file, a small model's
// JSON, a run created before any session existed, a file being replaced while it
// is read — and the code reads a property that only exists on the happy path.
//
// The reason these went unnoticed for so long is that the daemon is spawned with
// `stdio: 'ignore'` (daemon-client.js:49), so none of them left a single line
// anywhere. Two of them killed the whole engine; the symptom the owner saw was
// "did not become ready on port 8777".
//
// Each case below is the real trigger, not a synthetic one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; if (process.env.VERBOSE) console.log(`  ok  ${label}`); };

const { SandboxPolicyResolver } = require('../src/domain/pi-agent/sandbox-policy');
const { canonical } = require('../src/domain/pi-core/security/security-policy');
const { specText } = require('../src/domain/pi-agent/fast-api-router');

// ── sandbox.json: hand-edited, so every field is whatever the owner typed ──────
// `declared.map is not a function` threw out of the DaemonEngine constructor
// (daemon.js:142), which is not inside a try. The daemon never started.
{
  // The fixture must be canonicalised by the same function the resolver uses, or the
  // comparison is between two spellings of one place. macOS resolves /var to
  // /private/var; Windows expands 8.3 short names only in the native implementation,
  // which is why fs.realpathSync here disagreed with the resolver on that runner.
  const vault = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-malformed-')));
  const taskRoot = path.join(vault, 'project');
  const shared = path.join(vault, 'shared');
  fs.mkdirSync(path.join(taskRoot, '.pi'), { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  const resolve = (body) => {
    fs.writeFileSync(path.join(taskRoot, '.pi', 'sandbox.json'), body);
    return new SandboxPolicyResolver({ vaultRoot: vault }).resolve(taskRoot);
  };

  ok('a scalar where a list belongs does not throw', () => {
    for (const body of ['{"models":{"allowPaid":"claude"}}', '{"providers":{"allow":"glm"}}',
      'null', '"a string"', '42', '{"filesystem":"everything"}', '{"filesystem":{"allowRead":123}}']) {
      assert.doesNotThrow(() => resolve(body), `sandbox.json = ${body}`);
    }
  });

  ok('narrowing the allowlist to one provider is honoured, not discarded', () => {
    // The dangerous direction. Reading `"claude"` as "not an array, therefore
    // absent" falls through to the default and grants all four — the owner tried
    // to restrict and got the opposite.
    assert.deepEqual(resolve('{"models":{"allowPaid":"claude"}}').providers, ['claude']);
    assert.deepEqual(resolve('{"providers":{"allow":"codex"}}').providers, ['codex']);
    assert.deepEqual(resolve('{"models":{"allowPaid":["glm"]}}').providers, ['glm']);
  });

  ok('an absent declaration still gets the default', () => {
    const all = resolve('{}').providers;
    assert.ok(all.length >= 4, `an empty sandbox must not lock the owner out: ${JSON.stringify(all)}`);
    assert.deepEqual(resolve('null').providers, all, 'and neither should an unreadable one');
  });

  ok('a single read path as a string is one path, not a heap of characters', () => {
    // `[...'/tmp/x']` spreads into individual characters. They all fail the
    // isInside filter, so the symptom was a silently ignored setting.
    const policy = resolve(JSON.stringify({ filesystem: { allowRead: shared } }));
    assert.ok(policy.allowRead.includes(shared), `${JSON.stringify(policy.allowRead)} should contain ${shared}`);
    assert.ok(policy.allowRead.every((root) => root.length > 2), 'no single-character roots');
  });

  ok('a garbage write path never widens the sandbox', () => {
    for (const body of ['{"filesystem":{"allowWrite":"/etc"}}', '{"filesystem":{"allowWrite":["/etc","/"]}}']) {
      const policy = resolve(body);
      for (const root of policy.allowWrite) {
        assert.ok(root.startsWith(vault), `write escaped the vault: ${root} (from ${body})`);
      }
    }
  });

  fs.rmSync(vault, { recursive: true, force: true });
}

// ── a small model answering the promptSpec schema ─────────────────────────────
// `"constraints": "none"` is a reasonable thing for a 9B model to emit.
// `.join is not a function` was swallowed into a bare "Fast route unavailable",
// so the actual cause never reached anyone.
ok('a scalar in promptSpec renders instead of throwing', () => {
  for (const value of ['none', 42, undefined, null, { q: 'x' }]) {
    const spec = { promptSpec: { goal: 'g', constraints: value, steps: value, acceptance: value } };
    let text = null;
    assert.doesNotThrow(() => { text = specText(spec); }, `constraints = ${JSON.stringify(value)}`);
    assert.ok(/^Goal: g/.test(text), text);
    assert.equal(text.split('\n').length, 4, 'all four lines survive');
  }
  assert.match(specText({ promptSpec: { constraints: ['a', 'b'] } }), /Constraints: a; b/, 'and arrays still work');
});

// ── piping a file that can disappear underneath you ───────────────────────────
// `pipe()` does not forward source errors and this process exits on an uncaught
// exception, so one unreadable file took the whole daemon down. `sendFile`
// (daemon.js:64) exists precisely for this; one static route still bypassed it.
ok('every file read in the daemon goes through sendFile', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  const streams = source.split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((row) => row.line.includes('createReadStream'));
  assert.equal(streams.length, 1, `createReadStream must appear once, inside sendFile: ${JSON.stringify(streams)}`);
  assert.ok(!/createReadStream\([^)]*\)\s*\.pipe\(/.test(source),
    'a bare createReadStream().pipe() has no error listener and kills the process');
  // and sendFile still has to be the thing that handles it
  assert.match(source, /function sendFile[\s\S]{0,400}stream\.on\('error'/,
    'sendFile must keep its error listener');
});

// ── a run with no session attached ────────────────────────────────────────────
// directive() logged to the session *before* evaluating the approval, so a run
// whose id was never paired with a session threw "Invalid session id" and could
// not be approved or aborted from any surface. planIdea() only records the pair
// when a session is already open, which is not the case right after start-up.
(async () => {
  ok('a run without a session can still be approved and aborted', () => {
    const { DaemonEngine } = require('../src/domain/server/daemon');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-orphan-run-'));
    const engine = new DaemonEngine({ stateRoot: root, workspace: process.cwd() });
    try {
      const planned = engine.prompt('Review the daemon. Do not execute yet.', { mode: 'plan' });
      engine.runSessions.delete(planned.run.id);   // what start-up leaves behind
      let result = null;
      assert.doesNotThrow(() => {
        result = engine.directive({ action: 'reject', runId: planned.run.id, revision: planned.run.revision,
          planHash: planned.run.planHash, disclosureHash: planned.run.disclosureHash, idempotencyKey: 'orphan-1' });
      }, 'an orphaned run must still be actionable');
      assert.equal(result.status, 'FAILED', 'and the abort has to actually take effect');
      assert.equal(engine.runner.snapshot().filter((task) => task.status === 'running').length, 0);
    } finally {
      engine.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`malformed input selftest: PASS · ${checks} checks · a scalar config narrows instead of throwing · an absent one still defaults · a string path is one path · a model's scalar renders · every read goes through sendFile · an orphaned run stays actionable`);
})().catch((error) => { console.error(error); process.exit(1); });
