'use strict';

// The sandbox is the boundary, and a boundary has to be one thing.
//
// pi-sandbox@0.6.1 merges a project config over the global one with two different rules
// (README, and src/config.ts:78 mergeConfigLayers):
//
//   arrays  allowRead / allowWrite / denyRead / denyWrite / allowedDomains
//           -> [...new Set([...global, ...project])].  A local file can only ADD.
//   scalars enabled, and anything else that is not an array
//           -> the LOCAL value wins.
//
// So `{"enabled": false}` in any project's .pi/sandbox.json turns the sandbox off for
// that whole tree, in one line, silently. There are eight of these files on this
// machine; without this test there are eight kill switches for one boundary.
//
// The second asymmetry is the one that decides where a secret must be declared:
//   denyRead  "is not a hard-block; it just marks regions as denied by default.
//              Granting a prompt adds to allowRead, which OVERRIDES denyRead."
//   denyWrite "DENY takes precedence and is never prompted."
// Read and write run in opposite directions. Anything that must not be touched belongs
// in denyWrite; denyRead alone lasts until the first "yes".
//
// The full reference is org canon, not app documentation, because it governs every
// department's Pi and not just this app:
//   ~/Documents/CEOBigKiji/Executive_Office/knowledge/pi-sandbox-リファレンス.md

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const GLOBAL = path.join(HOME, '.pi', 'agent', 'sandbox.json');
const VAULT = path.join(HOME, 'Documents', 'CEOBigKiji');
const REFERENCE = path.join(VAULT, 'Executive_Office', 'knowledge', 'pi-sandbox-リファレンス.md');
// The app's own .pi/sandbox.json is read by BigKiji's SandboxPolicyResolver, not by
// pi-sandbox — same filename, different reader. It is checked separately, by
// skill-registry-selftest.js, and must not be judged by pi-sandbox's rules.
const APP_POLICY = path.resolve(__dirname, '..', '.pi', 'sandbox.json');

let failures = 0;
const ok = (name, body) => {
  try { body(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// This machine's layout is what is being checked, so an absent vault is "nothing to
// check" rather than a failure — the same file has to pass on a fresh checkout.
if (!fs.existsSync(GLOBAL)) {
  console.log('sandbox boundary selftest: SKIP · no ~/.pi/agent/sandbox.json on this machine');
  process.exit(0);
}

/** Every sandbox.json pi-sandbox could read, excluding the app's same-named policy. */
function localConfigs(root = VAULT) {
  const found = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 5 || /(?:^|\/)(?:node_modules|\.git|dist|_archive)(?:\/|$)/.test(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push([full, depth + 1]); continue; }
      if (entry.name === 'sandbox.json' && path.basename(dir) === '.pi' && full !== APP_POLICY) found.push(full);
    }
  }
  return found.sort();
}

const locals = localConfigs();
console.log(`  ..  global + ${locals.length} project configs`);

ok('the boundary is enabled, in the one file allowed to decide that', () => {
  assert.strictEqual(readJson(GLOBAL).enabled, true, 'the global sandbox must be on');
});

ok('no project config can switch the sandbox off', () => {
  // `enabled` is a scalar, so the local value wins outright. This is the only field in
  // the whole schema that lets a local file REMOVE protection instead of adding to it.
  for (const file of locals) {
    const config = readJson(file);
    assert.ok(!('enabled' in config),
      `${file} sets "enabled" — a scalar, so it overrides the global boundary for this whole tree`);
  }
});

ok('project configs only ever add permissions', () => {
  // deny arrays merge as a union, so a deny written locally silently applies to every
  // other department's work too. Local files add allowRead/allowWrite and nothing else.
  const allowed = new Set(['filesystem', '$comment']);
  for (const file of locals) {
    const config = readJson(file);
    for (const key of Object.keys(config)) {
      assert.ok(allowed.has(key), `${file}: "${key}" is not an additive grant`);
    }
    for (const key of Object.keys(config.filesystem || {})) {
      assert.ok(/^allow(Read|Write)$/.test(key) || key === '$comment',
        `${file}: filesystem.${key} — deny lists merge as a union and would apply company-wide`);
    }
  }
});

ok('what must never be written is in denyWrite, not only denyRead', () => {
  // denyRead is promptable and allowRead overrides it; denyWrite is absolute and is
  // never prompted. A secret protected only by denyRead lasts until the first "yes".
  const filesystem = readJson(GLOBAL).filesystem || {};
  const denyWrite = filesystem.denyWrite || [];
  for (const pattern of ['.env', '*.pem', '*.key']) {
    assert.ok(denyWrite.includes(pattern),
      `${pattern} must be in denyWrite — denyRead alone is not a hard block`);
  }
  assert.ok((filesystem.denyRead || []).includes('/Users'),
    'the global policy is deny-wide then punch holes; losing the wide deny inverts it');
  assert.ok((filesystem.allowWrite || []).length > 0, 'and something has to be writable');
});

ok('the reference that explains all of this is where every department can read it', () => {
  // The five department configs grant read on Executive_Office/knowledge, so a reference
  // kept there is reachable from any Pi. One inside app/ would not be.
  assert.ok(fs.existsSync(REFERENCE), `${REFERENCE} is missing`);
  const text = fs.readFileSync(REFERENCE, 'utf8');
  for (const claim of ['denyWrite', 'denyRead', 'enabled', 'mergeConfigLayers', 'CVE-2026-54325']) {
    assert.ok(text.includes(claim), `the reference must state ${claim}`);
  }
  const readable = locals.filter((file) => {
    const allow = (readJson(file).filesystem || {}).allowRead || [];
    return allow.some((entry) => entry.replace('~', HOME).includes(path.join('Executive_Office', 'knowledge')));
  });
  assert.ok(readable.length >= 3,
    `a reference no agent can open is not a reference: only ${readable.length} configs grant it`);
});

ok('the app’s same-named policy is not mistaken for pi-sandbox’s', () => {
  const config = readJson(APP_POLICY);
  assert.ok(Array.isArray(config.$comment) && config.$comment.join(' ').includes('NOT by this app'),
    'this file must keep saying which reader it is for; the filename collision is the trap');
  assert.ok(!('enabled' in config), 'and it must not look like it can toggle the real boundary');
});

if (failures) { console.error(`sandbox boundary selftest: ${failures} FAILED`); process.exit(1); }
console.log('sandbox boundary selftest: PASS · one boundary · no local kill switch · locals only add · secrets in denyWrite · reference readable from every department');
