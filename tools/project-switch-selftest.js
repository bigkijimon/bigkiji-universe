'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before requiring the daemon, for the reason daemon-selftest states at length:
// pi-knowledge-orchestrator resolves its root once at module load from this variable, and
// nothing about an injected stateRoot reaches it. Without this line the test appends to
// the owner's real task_state.json.
process.env.BIGKIJI_KNOWLEDGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-project-knowledge-'));

const store = require('../src/core/project-store');
const { DaemonEngine, resolveWorkspace } = require('../src/domain/server/daemon');

const TEMP = [];
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigkiji-project-${label}-`));
  TEMP.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of TEMP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  try { fs.rmSync(process.env.BIGKIJI_KNOWLEDGE_ROOT, { recursive: true, force: true }); } catch (_) {}
});

// A registry that records rather than writes. The real one lives in <userData> and this
// test must not touch the owner's list of folders — the same rule workspace-registry's own
// selftest states about its env override.
function fakeRegistry({ allows = true, registerThrows = null, roots = [] } = {}) {
  const calls = [];
  return {
    calls,
    list: () => roots,
    allows: () => allows,
    register: (target) => { calls.push(target); if (registerThrows) throw new Error(registerThrows); },
  };
}

// ── 1. The name a human types survives, and the characters a shell would misread do not ──
assert.equal(store.folderName('いがた屋レンタカー'), 'いがた屋レンタカー',
  'a Japanese name must not be slugged away — workspace-registry.slug() returns "root" for this');
assert.equal(store.folderName('  My  New / Site '), 'My-New-Site');
assert.equal(store.folderName('../../etc'), 'etc', 'path traversal must not survive a name');
assert.equal(store.folderName('...'), '');
assert.equal(store.folderName(`a${String.fromCharCode(0)}b`), 'ab', 'control characters are removed');

// ── 2. The boundaries, each one restating a rule the codebase already defends ──
const home = tempDir('home');
const dataRoot = path.join(home, 'BigKijiUniverse');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true });
fs.mkdirSync(path.join(home, '.config', 'thing'), { recursive: true });
// The department folder the owner names is created for them; its parent is not. A parent
// whose own parent is missing is a typo, and building the tree would bury the project.
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });

assert.match(store.refuseReason(home, { home, dataRoot }), /home directory/i);
assert.match(store.refuseReason(path.join(dataRoot, 'anything'), { home, dataRoot }), /data folder/i);
assert.match(store.refuseReason(dataRoot, { home, dataRoot }), /data folder/i);
assert.match(store.refuseReason(path.join(home, 'Library', 'Application Support'), { home, dataRoot }), /Application data/i);
assert.match(store.refuseReason(path.join(home, '.config', 'thing'), { home, dataRoot }), /hidden/i);
assert.equal(store.refuseReason(path.join(home, 'Documents', 'Rental', 'site'), { home, dataRoot }), '',
  'an ordinary folder under Documents is a project');

// ── 3. Creation makes a folder, a README, a .gitignore and a git repository ──
const gitCalls = [];
const created = store.createProject({
  parent: path.join(home, 'Documents', 'IgataCarRental'),
  name: 'igataya-rentacar',
  home,
  dataRoot,
  exec: (file, args) => { gitCalls.push(`${file} ${args.join(' ')}`); },
});
assert.equal(created.created, true);
assert.equal(path.basename(created.path), 'igataya-rentacar');
assert.ok(fs.readFileSync(path.join(created.path, '.gitignore'), 'utf8').includes('node_modules/'));
// The scaffold that follows is `create-next-app`, which refuses a directory holding
// anything outside its own allowed list. A README there made the first real project
// unscaffoldable; .gitignore is on the list and is fine. Nothing else may be added here
// without checking that same list.
assert.deepStrictEqual(fs.readdirSync(created.path).sort(), ['.gitignore'],
  'a new project must contain nothing that create-next-app treats as a conflict');
assert.deepStrictEqual(gitCalls, ['git init --quiet'], 'a project without a git repo has nothing for a run to isolate');
assert.equal(created.git, true);

const again = store.createProject({ parent: path.join(home, 'Documents', 'IgataCarRental'), name: 'igataya-rentacar', home, dataRoot, exec: () => {} });
assert.equal(again.created, false, 'creating the same project twice must not report it as new');

assert.throws(() => store.createProject({ parent: path.join(home, 'Documents'), name: '...', home, dataRoot, exec: () => {} }),
  /needs a name/i);
assert.throws(() => store.createProject({ parent: dataRoot, name: 'x', home, dataRoot, exec: () => {} }),
  /data folder/i, "the app's own storage is refused as a parent, not just as a target");

// ── 4. Listing looks one level down, and only at folders carrying a marker ──
const scanRoot = path.join(home, 'Documents', 'IgataCarRental');
fs.mkdirSync(path.join(scanRoot, 'notes'), { recursive: true });
fs.mkdirSync(path.join(scanRoot, '.hidden'), { recursive: true });
fs.writeFileSync(path.join(scanRoot, '.hidden', 'package.json'), '{}');
fs.mkdirSync(path.join(created.path, '.git'), { recursive: true });
const listed = store.listProjects([{ path: scanRoot, label: 'IgataCarRental' }]).map((entry) => entry.path);
assert.ok(listed.includes(created.path), 'a folder with .git is a project');
assert.ok(!listed.includes(path.join(scanRoot, 'notes')), 'a folder with no marker is not a project');
assert.ok(!listed.some((entry) => entry.includes('.hidden')), 'a dot-folder is never offered');

// ── 5. resolveWorkspace: the owner's chosen project outranks detection, and never repairs ──
const chosen = created.path;
assert.equal(resolveWorkspace('', {}, home, dataRoot, home, { activeProject: chosen }).workspace, chosen);
assert.equal(resolveWorkspace('', { BIGKIJI_WORKSPACE: scanRoot }, home, dataRoot, home, { activeProject: chosen }).workspace,
  path.resolve(scanRoot), 'being told still beats the saved project');
assert.notEqual(resolveWorkspace('', {}, home, dataRoot, home, { activeProject: path.join(home, 'gone') }).workspace,
  path.join(home, 'gone'), 'a deleted project falls through to detection instead of being recreated');
assert.notEqual(resolveWorkspace('', {}, home, dataRoot, home, { activeProject: dataRoot }).workspace, dataRoot,
  "a saved project inside BigKiji's own data folder is refused, not obeyed");
assert.equal(resolveWorkspace('', {}, home, dataRoot, home, {}).workspace,
  resolveWorkspace('', {}, home, dataRoot, home).workspace, 'no saved project means the old behaviour, unchanged');

// ── 6. The switch moves EVERY derived field, or it has corrupted the daemon ──
const stateRoot = tempDir('state');
const projectA = path.join(home, 'Documents', 'IgataCarRental', 'igataya-rentacar');
const projectB = path.join(home, 'Documents', 'IgataCarRental', 'second-site');
fs.mkdirSync(projectB, { recursive: true });
fs.writeFileSync(path.join(projectB, 'only-in-b.txt'), 'b');

const engine = new DaemonEngine({ stateRoot, workspace: projectA, savedPaths: {}, home, dataRoot, registry: fakeRegistry() });
assert.equal(engine.workspace, projectA);

const moved = engine.setWorkspace(projectB);
assert.equal(moved.changed, true);
assert.equal(moved.previous, projectA);

// Every field a run reads, listed by hand on purpose. When a future change derives a sixth
// thing from the workspace it must be added here — a switch that moves five of six leaves
// the daemon describing two different projects at once, which is how a run ends up with the
// new cwd and the old sandbox and dies at spawn with SECURITY_PATH_OUTSIDE_READ.
const derived = {
  'engine.workspace': engine.workspace,
  'runner.cwd': engine.runner.cwd,
  'runner.policy.vaultRoot': engine.runner.policy.vaultRoot,
  'ideas.workspace': engine.ideas.workspace,
  'inventory.root': engine.inventory.root,
};
for (const [label, value] of Object.entries(derived)) {
  assert.equal(fs.realpathSync(value), fs.realpathSync(projectB), `${label} did not follow the project switch`);
}
assert.ok(engine.runner.policy.vaultRoots.some((root) => fs.realpathSync(root) === fs.realpathSync(projectB)),
  'the sandbox boundary must contain the new project or every run in it is refused');
assert.equal(engine.workspaceRedirect, null, 'a redirect describes how the previous workspace was reached');

assert.equal(engine.setWorkspace(projectB).changed, false, 'switching to where we already are is not a change');
assert.throws(() => engine.setWorkspace(path.join(home, 'no-such-folder')), /Not a folder/);
assert.throws(() => engine.setWorkspace(dataRoot), /data folder/i);

// ── 7. Nothing moves while something is running ──
const idleSnapshot = engine.coordinator.snapshot.bind(engine.coordinator);
engine.coordinator.snapshot = () => [{ id: 'r1', status: 'EXECUTING' }];
assert.throws(() => engine.setWorkspace(projectA), /PROJECT_SWITCH_WHILE_BUSY/,
  'moving the boundary under an approved run invalidates a seal the owner already signed');
engine.coordinator.snapshot = idleSnapshot;
assert.equal(engine.setWorkspace(projectA).changed, true, 'and it moves again once the fleet is idle');

// ── 8. Registration happens only when the project is outside every registered root ──
const inside = new DaemonEngine({ stateRoot: tempDir('state-inside'), workspace: projectA, savedPaths: {}, home, dataRoot, registry: fakeRegistry({ allows: true }) });
inside.createProject({ parent: path.join(home, 'Documents', 'IgataCarRental'), name: 'covered' });
assert.deepStrictEqual(inside.workspaces.calls, [],
  'registering a folder nested in a registered root throws "Overlaps an existing workspace" — so it must not be attempted');

const outside = new DaemonEngine({ stateRoot: tempDir('state-outside'), workspace: projectA, savedPaths: {}, home, dataRoot, registry: fakeRegistry({ allows: false }) });
const fresh = outside.createProject({ parent: path.join(home, 'Documents', 'Elsewhere'), name: 'new-thing' });
assert.deepStrictEqual(outside.workspaces.calls, [path.join(home, 'Documents', 'Elsewhere')],
  'a project outside every root is unreachable until its parent is registered');
assert.equal(fresh.workspace, fresh.path, 'creating a project is also choosing it');

const raced = new DaemonEngine({
  stateRoot: tempDir('state-raced'), workspace: projectA, savedPaths: {}, home, dataRoot,
  registry: fakeRegistry({ allows: false, registerThrows: 'Overlaps an existing workspace: /somewhere' }),
});
assert.doesNotThrow(() => raced.createProject({ parent: path.join(home, 'Documents', 'Elsewhere'), name: 'overlapping' }),
  'an overlap means some root already covers it, which is the outcome we wanted');

console.log('project switch selftest: PASS · a typed name survives · home/dataRoot/Library/dot-folders refused'
  + ' · creation makes a git repo · the saved project outranks detection and is never repaired'
  + ' · every derived field follows the switch · nothing moves while a run is live'
  + ' · only a project outside every root is registered');
