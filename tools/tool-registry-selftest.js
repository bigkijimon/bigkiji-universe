'use strict';
// The tool registry decides what the Environment tab tells the owner about their own
// machine, so every assertion here runs against a FABRICATED filesystem in a temp
// directory. Nothing may depend on what happens to be installed on the machine running
// the suite, otherwise this passes for one person and fails on a fresh checkout.
//
// The three things that must never regress:
//   - detection is synchronous and cheap (opening Settings must not stall),
//   - `found` (installed, unverified) never collapses into `connected`,
//   - probe() resolves instead of rejecting, and returns within its timeout even when
//     the port is closed — a dead service must not freeze the settings screen.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const registry = require('../src/domain/pi-agent/tool-registry');
const { SettingsStore } = require('../src/core/settings-store');

const {
  TOOLS, TOOL_IDS, TOOL_PATH_IDS, TOOL_SETTING_ALIASES, KINDS, STATUS,
  detectAll, probe, findTool, expandPath,
} = registry;

// ---- the table is a frozen contract -----------------------------------------
assert.ok(Object.isFrozen(TOOLS), 'the tool table must be frozen');
assert.ok(TOOLS.length >= 9, 'every known local tool must be represented');
assert.strictEqual(new Set(TOOL_IDS).size, TOOL_IDS.length, 'tool ids must be unique');
for (const tool of TOOLS) {
  assert.ok(KINDS.includes(tool.kind), `${tool.id} declares an unknown kind`);
  assert.ok(tool.label && tool.purpose, `${tool.id} must say what BigKiji uses it for`);
  assert.ok(typeof tool.settingKey === 'string' && tool.settingKey, `${tool.id} needs a settings key`);
}
// The renderer must never be able to reach electron through this module: the daemon and
// the CLI load it as plain Node.
const source = fs.readFileSync(path.join(__dirname, '..', 'src/domain/pi-agent/tool-registry.js'), 'utf8');
assert.doesNotMatch(source, /require\(\s*['"]electron['"]\s*\)/, 'the registry must stay pure Node');
// Keys that other modules already own stay authoritative — a second key for the same
// value is a second source of truth that can disagree with the first.
assert.strictEqual(TOOL_SETTING_ALIASES.comfyui, 'comfyRoot', 'path-config.js and the ComfyUI bridge read paths.comfyRoot');
assert.strictEqual(TOOL_SETTING_ALIASES.obsidian, 'vaultRoot');
assert.strictEqual(TOOL_SETTING_ALIASES.graphifyGraph, 'graphifyGraphPath');
assert.ok(!TOOL_PATH_IDS.includes('comfyui'), 'comfyui must not also live under paths.tools');

// ---- a fabricated machine ---------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-tools-'));
const docs = path.join(home, 'Documents');
const bin = path.join(home, '.local', 'bin');
const vault = path.join(docs, 'SomeoneElsesVault');
const notAVault = path.join(docs, 'PlainFolder');
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
mk(path.join(docs, 'ComfyUI'));
mk(path.join(docs, 'ACE-Step'));
mk(path.join(vault, '.obsidian'));
mk(path.join(vault, 'graphify-out'));
mk(notAVault);
mk(bin);
fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\necho graphify 0.0.0\n', { mode: 0o755 });
fs.writeFileSync(path.join(vault, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] }));
// The arbitration script lives inside the vault at a depth and folder name that differ
// per person, which is exactly why it is searched for rather than hardcoded.
mk(path.join(vault, 'Office', 'Planning'));
fs.writeFileSync(path.join(vault, 'Office', 'Planning', 'gpu-signal.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

const env = { PATH: bin };
const started = Date.now();
const detectFake = (saved = {}) => detectAll({ env, home, saved, systemBinDirs: [] });
const rows = detectFake();
const elapsed = Date.now() - started;
assert.ok(Array.isArray(rows), 'detectAll must be synchronous — a Promise would stall the settings screen');
assert.ok(elapsed < 1000, `detection must be cheap, took ${elapsed}ms`);
const by = (id) => rows.find((row) => row.id === id);

// Present on disk but nothing verified: "found", never "connected".
assert.strictEqual(by('comfyui').status, STATUS.FOUND);
assert.strictEqual(by('comfyui').path, path.join(docs, 'ComfyUI'));
assert.strictEqual(by('comfyui').checked, false, 'an unprobed tool must report that it was not checked');
assert.strictEqual(by('acestep').status, STATUS.FOUND);
// Absent: "missing". LTX-2 and n8n were never created in this fake home.
assert.strictEqual(by('ltx2').status, STATUS.MISSING);
assert.strictEqual(by('n8n').status, STATUS.MISSING);
assert.strictEqual(by('ltx2').path, '', 'a missing tool resolves to no path at all');
// A binary is found through PATH, not through a hardcoded install location.
assert.strictEqual(by('graphify').status, STATUS.FOUND);
assert.strictEqual(by('graphify').path, path.join(bin, 'graphify'));
assert.strictEqual(by('ollama').status, STATUS.MISSING, 'nothing on the fake PATH means missing, not assumed');
// The vault marker is a statSync, so it is verified during detection.
assert.strictEqual(by('obsidian').status, STATUS.CONNECTED);
assert.strictEqual(by('obsidian').path, vault);
assert.match(by('obsidian').detail, /\.obsidian/);
// A multi-megabyte graph is never parsed synchronously: presence only.
assert.strictEqual(by('graphifyGraph').status, STATUS.FOUND);
assert.strictEqual(by('graphifyGraph').path, path.join(vault, 'graphify-out', 'graph.json'));
// The optional script is found by a bounded search, and its absence is not an error.
assert.strictEqual(by('gpuSignal').status, STATUS.FOUND);
assert.strictEqual(by('gpuSignal').path, path.join(vault, 'Office', 'Planning', 'gpu-signal.sh'));
assert.strictEqual(by('gpuSignal').optional, true);

// A directory without the `.obsidian` marker exists but is not a vault: "found".
const plain = detectFake({ vaultRoot: notAVault }).find((row) => row.id === 'obsidian');
assert.strictEqual(plain.status, STATUS.FOUND, 'a directory without .obsidian is present but unverified');
assert.strictEqual(plain.path, notAVault);

// An explicit saved path wins over detection, and a saved path that no longer exists is
// reported as missing rather than silently falling back and hiding the mistake.
const overridden = detectFake({ comfyRoot: path.join(home, 'elsewhere', 'ComfyUI') })
  .find((row) => row.id === 'comfyui');
assert.strictEqual(overridden.status, STATUS.MISSING);
assert.match(overridden.detail, /does not exist/);
assert.strictEqual(detectFake({ comfyRoot: '' }).find((row) => row.id === 'comfyui').path,
  path.join(docs, 'ComfyUI'), 'an emptied setting falls back to detection');
const savedTool = detectFake({ tools: { ltx2: path.join(docs, 'ComfyUI') } }).find((row) => row.id === 'ltx2');
assert.strictEqual(savedTool.status, STATUS.FOUND, 'paths.tools.<id> is honoured for tools without a dedicated key');
assert.strictEqual(expandPath('~/x', home), path.join(home, 'x'), 'tilde expansion uses the supplied home');

// ---- probes resolve, never reject, and always time out -----------------------
(async () => {
  // A closed port is the normal case for an installed-but-sleeping tool. It must come
  // back as a value, inside the budget.
  const closed = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
  const deadSpec = { id: 'dead', kind: 'directory', probe: { type: 'http', urls: [`http://127.0.0.1:${closed}/health`], accept: () => 'never' } };
  const t0 = Date.now();
  const dead = await probe(deadSpec, { timeoutMs: 1200 });
  const took = Date.now() - t0;
  assert.strictEqual(dead.ok, false);
  assert.strictEqual(dead.checked, true, 'the check ran and failed — that is not the same as unchecked');
  assert.notStrictEqual(dead.status, STATUS.CONNECTED, 'a closed port must never read as connected');
  assert.ok(took < 3000, `a closed port must not hang the settings screen, took ${took}ms`);

  // A port that never answers at all (blackhole address) must be cut off by the timeout.
  const blackhole = { id: 'slow', kind: 'directory', probe: { type: 'http', urls: ['http://10.255.255.1:9/health'], accept: () => 'never' } };
  const t1 = Date.now();
  const timedOut = await probe(blackhole, { timeoutMs: 400 });
  const tookSlow = Date.now() - t1;
  assert.strictEqual(timedOut.ok, false);
  assert.ok(tookSlow < 2500, `the timeout must bound the probe, took ${tookSlow}ms`);

  // Nonsense input is a status, never a thrown exception the UI has to catch.
  for (const input of ['no-such-tool', null, {}, { id: 'x', probe: { type: 'unsupported' } }]) {
    const result = await probe(input, { timeoutMs: 200 });
    assert.strictEqual(result.ok, false);
    assert.ok(typeof result.detail === 'string' && result.detail, 'every probe result explains itself');
  }

  // The graph probe does the parse detection deliberately skipped.
  const graph = await probe(by('graphifyGraph'), { timeoutMs: 1200 });
  assert.strictEqual(graph.ok, true);
  assert.strictEqual(graph.status, STATUS.CONNECTED);
  assert.match(graph.detail, /2 nodes/);
  const brokenPath = path.join(vault, 'graphify-out', 'broken.json');
  fs.writeFileSync(brokenPath, '{ this is not json');
  const broken = await probe(findTool('graphifyGraph'), { timeoutMs: 1200, path: brokenPath });
  assert.strictEqual(broken.ok, false);
  assert.strictEqual(broken.status, STATUS.FOUND, 'a file that exists but does not parse is found, not connected');
  fs.writeFileSync(path.join(vault, 'graphify-out', 'empty.json'), JSON.stringify({ nodes: [] }));
  const empty = await probe(findTool('graphifyGraph'), { timeoutMs: 1200, path: path.join(vault, 'graphify-out', 'empty.json') });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.detail, /no nodes/);

  // An executable that answers is connected; one that cannot run is not.
  const cli = await probe(by('graphify'), { timeoutMs: 2000 });
  assert.strictEqual(cli.ok, true);
  assert.strictEqual(cli.status, STATUS.CONNECTED);
  assert.match(cli.detail, /graphify 0\.0\.0/);

  // ---- settings normalisation ----------------------------------------------
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-tools-settings-'));
  const store = new SettingsStore({ userData, safeStorage: null });
  const saved = store.update({
    paths: {
      tools: {
        acestep: '~/Documents/ACE-Step', // tilde expands
        ltx2: 42,                        // a non-string is ignored
        n8n: '   ',                      // an emptied value falls back to detection
        totallyUnknown: '/tmp/whatever',  // an unknown id is dropped
        comfyui: '/tmp/ComfyUI',         // folds into the key path-config.js already reads
      },
    },
  });
  assert.deepStrictEqual(Object.keys(saved.paths.tools), ['acestep'],
    'unknown ids, non-strings and emptied values must not survive normalisation');
  assert.strictEqual(saved.paths.tools.acestep, path.join(os.homedir(), 'Documents', 'ACE-Step'));
  assert.strictEqual(saved.paths.comfyRoot, '/tmp/ComfyUI', 'paths.comfyRoot stays the single source of truth');
  assert.strictEqual(saved.paths.tools.comfyui, undefined, 'the alias must not leave a second copy behind');
  assert.strictEqual(saved.paths.vaultRoot, '', 'existing paths.* keys keep working');
  const cleared = store.update({ paths: { tools: { acestep: '' } } });
  assert.strictEqual(cleared.paths.tools.acestep, undefined, 'clearing a value falls back to detection, not to a pinned empty string');
  const hostile = store.update({ paths: { tools: 'not-an-object' } });
  assert.deepStrictEqual(hostile.paths.tools, {}, 'a hand-edited settings file cannot feed junk into detection');

  // The two tools the owner drives that nothing here knew about.
  //
  // Blender generates the thin/lattice assets and cleans GLBs for Unreal; Unreal is
  // the editor those assets go into. Both were installed and in daily use while the
  // fleet display counted neither.
  {
    const registry = require('../src/domain/pi-agent/tool-registry');
    const byId = Object.fromEntries(registry.detectAll({ env: {}, home: '/nonexistent-home', saved: {}, systemBinDirs: [] })
      .map((tool) => [tool.id, tool]));
    for (const id of ['blender', 'unreal']) {
      assert.ok(byId[id], `${id} has to be in the registry at all`);
      assert.match(byId[id].settingKey, /^tools\./, `${id} needs its own settings key so it can be pointed elsewhere`);
    }
    assert.equal(byId.blender.probe, false, 'Blender runs per job with --background — there is no server to health-check');
    assert.equal(byId.unreal.probe, true, 'the editor does hold a port open, and it is worth checking');

    // Port 8000 is ComfyUI on this machine, and it is also the plugin's default.
    // Pointed at the default, a client reached ComfyUI, was answered in HTML, and
    // reported a connection to an editor that was not running.
    const unreal = registry.TOOLS.find((tool) => tool.id === 'unreal');
    assert.ok(unreal.probe.urls.every((url) => !url.includes(':8000')),
      'the editor must never be probed on the port ComfyUI already holds');
    assert.match(unreal.probe.urls[0], /:55557\//);
    const html = '<!DOCTYPE html><html><head><title>ComfyUI</title></head></html>';
    assert.equal(unreal.probe.accept(html, { status: 200 }, 'http://127.0.0.1:55557/'), '',
      'a web page is not an editor, whatever port it came from');
    assert.equal(unreal.probe.accept('', { status: 503 }, 'http://127.0.0.1:55557/'), '',
      'a server that is failing is not a server that is ready');
    assert.match(unreal.probe.accept('Not Found', { status: 404 }, 'http://127.0.0.1:55557/'), /55557/,
      'the MCP server answers 404 on the root and that still proves the port is open');
  }

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log('tool registry selftest: PASS · sync detection · found ≠ connected · probes resolve within timeout · settings normalised · Blender and Unreal are managed, and the editor is never probed on ComfyUI\'s port');
})().catch((error) => { console.error(error); process.exit(1); });
