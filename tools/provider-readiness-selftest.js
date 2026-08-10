'use strict';
// Whether a provider can start work, and why not when it cannot.
//
// The test this replaces was "is there an API key in the settings store?", which
// is the wrong question for two of the four providers and asks the wrong place
// for a third. Claude Code and Codex authenticate with their own CLI login and
// have no key to paste; Gemini's CLI reads GOOGLE_API_KEY as readily as
// GEMINI_API_KEY; and the owner's keys were in .env, which the settings store
// never sees.
//
// The failure mode is the quiet one. Nothing errored — the coordinator simply
// believed it had no paid provider and routed every plan to the local model,
// and the fleet showed `offline` for everything, which is a word that explains
// nothing. Both halves are asserted here: the verdict, and the reason.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readiness, survey, credentialFor, PROVIDERS } = require('../src/domain/pi-agent/provider-readiness');

// The code under test joins these with path.join, so the fixture has to as well —
// a literal '/home/o/.claude/.credentials.json' never matches
// '\\home\\o\\.claude\\.credentials.json' on Windows, and the check then reports
// "not signed in" for a reason that has nothing to do with being signed in.
const HOME = path.resolve(path.sep, 'home', 'o');
const at = (...parts) => path.join(HOME, ...parts);

let checks = 0;
// Awaited when the body returns a promise. A synchronous `ok()` handed an async body
// counts the check, prints it, and never learns whether it failed — the assertion becomes
// an unhandled rejection and the suite reports PASS.
const pending = [];
const ok = (label, fn) => {
  const result = fn(); checks += 1;
  if (result && typeof result.then === 'function') pending.push(result.then(() => {}, (error) => { throw error; }));
  if (process.env.VERBOSE) console.log(`  ok  ${label}`);
};

const nothing = { env: {}, home: '/nowhere', secret: () => '', exists: () => false };

ok('with no credential of any kind, nothing paid is ready', () => {
  for (const row of survey(nothing)) {
    assert.equal(row.ready, false, `${row.id} claimed to be ready with nothing configured`);
    assert.ok(row.detail.length > 8, `${row.id} must say what is missing, not just "offline": ${row.detail}`);
  }
});

ok('a CLI login is a credential — this is the case that was broken', () => {
  // Claude Code and Codex have no API key to paste. Requiring one kept them
  // permanently unavailable while both were signed in and working.
  const logged = { ...nothing, home: HOME, exists: (file) => [at('.claude', '.credentials.json'), at('.codex', 'auth.json')].includes(file) };
  const claude = readiness('claude-code', logged);
  assert.equal(claude.ready, true, 'a signed-in Claude Code is available');
  assert.equal(claude.via, 'login');
  assert.match(claude.detail, /\.claude/);
  assert.equal(readiness('codex', logged).ready, true);
  assert.equal(readiness('gemini', logged).ready, false, 'and a login file for one tool is not one for another');
});

ok('`claude` and `claude-code` are the same provider', () => {
  const logged = { ...nothing, home: HOME, exists: (file) => file === at('.claude', '.credentials.json') };
  assert.equal(readiness('claude', logged).id, 'claude-code');
  assert.equal(readiness('claude', logged).ready, true);
});

ok('gemini accepts the Google name, because its CLI does', () => {
  assert.equal(readiness('gemini', { ...nothing, env: { GOOGLE_API_KEY: 'x' } }).ready, true);
  assert.equal(readiness('gemini', { ...nothing, env: { GEMINI_API_KEY: 'x' } }).ready, true);
  // and the child still receives it under the canonical name
  assert.deepEqual(credentialFor('gemini', { env: { GOOGLE_API_KEY: 'value' }, secret: () => '' }),
    { name: 'GEMINI_API_KEY', value: 'value' });
});

ok('an empty variable is not a credential', () => {
  // Three of the four keys in the owner's .env are present and empty. A name
  // with nothing after the `=` must not read as configured.
  for (const value of ['', '   ', undefined]) {
    assert.equal(readiness('glm', { ...nothing, env: { ZAI_API_KEY: value } }).ready, false, `"${value}" is not a key`);
  }
  assert.equal(readiness('glm', { ...nothing, env: { ZAI_API_KEY: 'real' } }).ready, true);
});

ok('a key the owner entered in the app outranks the environment', () => {
  const both = { ...nothing, env: { ZAI_API_KEY: 'from-env' }, secret: (id) => (id === 'glm' ? 'from-settings' : '') };
  assert.equal(readiness('glm', both).via, 'secret');
  assert.equal(credentialFor('glm', both).value, 'from-settings');
});

ok('local providers need nothing', () => {
  for (const id of ['qwen', 'ollama', 'local-qwen']) {
    const row = readiness(id, nothing);
    assert.equal(row.ready, true, `${id} runs on this machine`);
    assert.equal(row.via, 'local');
  }
});

ok('no credential value is ever returned in a reason', () => {
  // `detail` is written to the screen. It names what to do, never what was found.
  const loaded = { ...nothing, env: { GEMINI_API_KEY: 'SECRET-VALUE-1234', ZAI_API_KEY: 'SECRET-VALUE-5678' },
    secret: () => 'SECRET-VALUE-9999' };
  for (const row of survey(loaded)) {
    assert.ok(!/SECRET-VALUE/.test(row.detail), `a credential leaked into a reason: ${row.detail}`);
    assert.ok(!/SECRET-VALUE/.test(JSON.stringify(row)), `a credential leaked into the survey: ${JSON.stringify(row)}`);
  }
});

ok('an unreadable home directory is a missing login, not a crash', () => {
  const hostile = { ...nothing, home: HOME, exists: () => { throw new Error('EACCES'); } };
  assert.equal(readiness('claude-code', hostile).ready, false);
});

ok('the daemon asks this rather than asking for an API key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(source, /available: \(provider\) => readiness\(/, 'the routing gate must use it');
  assert.ok(!/available: \(provider\) => \['qwen', 'ollama'\]\.includes/.test(source),
    'the old key-only test must be gone, not shadowed');
  // The reason has to reach the owner; `offline` on its own is what cost the evening.
  assert.match(source, /apiHealth: row\.ready \? .* : row\.detail/, 'a provider that cannot start says why');
});

ok('a real daemon shows the fleet what the router decided', () => {
  // Asserting the call exists in the source is not enough — the method's own
  // definition matches the same pattern, so deleting the constructor's call went
  // unnoticed. This builds one and reads what an owner would see.
  const os = require('os');
  const { DaemonEngine } = require('../src/domain/server/daemon');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-readiness-'));
  const engine = new DaemonEngine({ stateRoot: root, workspace: process.cwd() });
  const fleet = engine.models.snapshot().models || [];
  assert.ok(fleet.length, 'the fleet should not be empty');
  for (const row of engine.providerReadiness || []) {
    const shown = fleet.find((model) => model.id === row.id);
    if (!shown) continue;
    assert.equal(shown.available, row.ready, `${row.id}: the display disagrees with the router`);
    assert.ok(String(shown.metrics?.apiHealth || '').length > 3, `${row.id} must say something about why`);
    if (!row.ready) assert.equal(shown.metrics.apiHealth, row.detail, `${row.id} must show the actual reason`);
  }
  assert.ok((engine.providerReadiness || []).length >= 4, 'every paid provider is surveyed');
  engine.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

ok('every provider declares how to fix it', () => {
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    assert.ok(spec.hint && spec.hint.length > 10, `${id} needs an actionable hint`);
    assert.ok(spec.keys.length > 0, `${id} needs at least one environment name`);
  }
});

// The fleet display asked the wrong question.
//
// fast-api-router.detect() reports which providers the *front desk* may use, and it
// is local-only on purpose: no owner text reaches a paid provider before a
// disclosure manifest is approved. Wired to the status display, those deliberate
// falses put four working providers behind the word "Not available" — measured on
// screen 2026-08-03 while GLM and Codex were completing real work.
//
// 2026-08-09: `glm` left that list. It is now reachable in one stated situation — the GPU
// is held by a render, so Ollama is SIGSTOPped, and the owner has switched
// `conversation.cloudFallback` to 'gpu-busy'. Asserted by calling `detect()` rather than
// by reading the source for `glm: false`, because the claim being made is about behaviour
// and a source match would pass on a comment.
ok('the front desk router is not a status display', async () => {
  const fastRouter = require('../src/domain/pi-agent/fast-api-router');
  // `gpuHeld`, `localReady` and `cloudReady` are all stated rather than probed: otherwise
  // this reads the owner's GPU and login files and answers differently at midnight than
  // at noon. The claim is about behaviour, so it is made by calling detect() — a source
  // match for `claude: false` used to stand in for it, and stopped being true the day the
  // escape chain grew past GLM without the assertion noticing.
  const stated = { gpuHeld: true, localReady: false, cloudReady: () => true };
  const shut = await fastRouter.detect(stated);
  for (const provider of ['claude', 'codex', 'gemini', 'glm']) {
    assert.equal(shut[provider], false, `${provider} is shut with no setting turned on, and that is not a status`);
  }
  const free = await fastRouter.detect({ ...stated, cloudFallback: 'gpu-busy', gpuHeld: false, localReady: true });
  for (const provider of ['claude', 'codex', 'gemini', 'glm']) {
    assert.equal(free[provider], false, `a working local model closes ${provider} again — this is an escape, not a status`);
  }
  // Open, in exactly one situation: the owner asked, the GPU is held, and the local model
  // is therefore stopped. Gemini stays shut in all of them — limit:0 free quota here.
  const open = await fastRouter.detect({ ...stated, cloudFallback: 'gpu-busy' });
  assert.equal(open.claude, true, 'the owner asked and the card is busy — that is the whole window');
  assert.equal(open.codex, true);
  assert.equal(open.gemini, false, 'gemini is not in the escape chain at any setting');
  assert.equal(typeof fastRouter.ollamaReady, 'function', 'the display needs the local probe without the paid falses');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
  assert.ok(!/fastRouter\.detect\(\)\.then\(\(availability\) => fleetMetrics\.setAvailability/.test(main),
    'the fleet display must not be driven by the front desk router');
  assert.match(main, /providerSurvey\(\{ secret:/, 'it asks readiness, the same question the daemon and the coordinator ask');
});
ok('a ready provider is shown as usable, an unready one is not', () => {
  const { ModelStatusStore } = require('../src/domain/hud/model-status-store');
  const store = new ModelStatusStore({});
  store.setAvailability({ claude: true, codex: true, gemini: false, glm: true, ollama: true });
  const byId = Object.fromEntries(store.snapshot().models.map((model) => [model.id, model]));
  assert.strictEqual(byId['claude-code'].status, 'IDLE');
  assert.strictEqual(byId.glm.available, true);
  assert.strictEqual(byId.gemini.status, 'OFFLINE', 'a provider that really cannot start still says so');
});

Promise.all(pending).then(() => {
  console.log(`provider readiness selftest: PASS · ${checks} checks · a CLI login counts · GOOGLE_API_KEY works for gemini · an empty variable does not · settings outrank env · reasons carry no secrets · the daemon uses it for both routing and display · the front desk opens to Claude then Codex only while the GPU is held and the owner asked`);
}).catch((error) => { console.error(error); process.exit(1); });
