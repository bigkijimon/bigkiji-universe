'use strict';
// The registry decides which folders BigKiji may read and edit. Its shape follows what
// comparable local-first apps actually do (Obsidian, VS Code, Zed, Docker Desktop all
// keep a flat, explicitly-registered list in the app's own data directory), so these
// assertions pin the properties that made those designs work.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  WorkspaceRegistry, DEFAULT_EXCLUDE, candidates, overrideRoots, statusOf, registryFile,
} = require('../src/core/workspace-registry');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-ws-'));
const userData = path.join(home, 'ud');
const docs = path.join(home, 'Documents');
const mk = (...parts) => { const dir = path.join(...parts); fs.mkdirSync(dir, { recursive: true }); return dir; };

const school = mk(docs, 'Alpha');
const media = mk(docs, 'CreativeMedia');
const vault = mk(docs, 'Notes'); mk(vault, '.obsidian');
mk(docs, 'ComfyUI');
mk(home, 'BigKijiUniverse');      // the app's own data root
mk(home, 'Library');              // OS data
mk(docs, '.hidden');

// ---- candidates are PROPOSED, never auto-registered --------------------------
const proposed = candidates({ home, roots: [docs] });
const names = proposed.map((entry) => entry.label).sort();
assert.deepStrictEqual(names, ['Alpha', 'ComfyUI', 'CreativeMedia', 'Notes']);
assert.ok(!names.includes('.hidden'), 'dotfiles are not workspaces');
assert.strictEqual(proposed.find((entry) => entry.label === 'Notes').isObsidianVault, true,
  'an Obsidian vault is worth flagging, but it is still just a candidate');

const registry = new WorkspaceRegistry({ userData, home, env: {} });
assert.deepStrictEqual(registry.list(), [], 'proposing a candidate must not register it');

// ---- registration ------------------------------------------------------------
const registered = registry.register(school, { label: 'H&S Academy' });
assert.strictEqual(registered.path, school);
assert.deepStrictEqual(registered.exclude, [...DEFAULT_EXCLUDE],
  'exclusions exist from the first registration, not bolted on later');
registry.register(media);
assert.strictEqual(registry.list().length, 2);
assert.ok(fs.existsSync(registryFile(userData)),
  'the master list lives in the app data directory, not inside the folders it points at');
assert.ok(!fs.existsSync(path.join(school, 'workspaces.json')));

// Re-registering the same path replaces rather than duplicates.
registry.register(school, { label: 'Renamed' });
assert.strictEqual(registry.list().filter((root) => root.path === school).length, 1);
assert.strictEqual(registry.list().find((root) => root.path === school).label, 'Renamed');

// ---- overlap is refused ------------------------------------------------------
// Nested roots double-index everything beneath the inner one and make exclusions
// ambiguous, so this is an error rather than a silent double-count.
assert.throws(() => registry.register(path.join(school, 'sub')), /readable directory|Overlaps/);
mk(school, 'sub');
assert.throws(() => registry.register(path.join(school, 'sub')), /Overlaps/);
assert.throws(() => registry.register(docs), /Overlaps/, 'a parent of a registered root also overlaps');

// ---- a vanished root is reported, never silently re-pointed ------------------
fs.rmSync(media, { recursive: true, force: true });
const afterLoss = registry.list().find((root) => root.path === media);
assert.strictEqual(afterLoss.status, 'missing');
assert.strictEqual(registry.list().length, 2, 'a missing root stays in the list so it can be re-selected');
assert.strictEqual(statusOf(path.join(home, 'nope')), 'missing');

// ---- allows() is the single gate --------------------------------------------
assert.strictEqual(registry.allows(path.join(school, 'notes.md')), true);
assert.strictEqual(registry.allows(path.join(school, 'node_modules', 'x.js')), false, 'excluded by default');
assert.strictEqual(registry.allows(path.join(school, 'a', '.git', 'config')), false);
assert.strictEqual(registry.allows(path.join(docs, 'ComfyUI', 'main.py')), false, 'unregistered folders are denied');
assert.strictEqual(registry.allows(media), false, 'a missing root grants nothing');

registry.update(registered.id, { exclude: ['secrets'] });
assert.strictEqual(registry.allows(path.join(school, 'secrets', 'k.txt')), false);
assert.strictEqual(registry.allows(path.join(school, 'node_modules', 'x.js')), true,
  'per-root exclusions replace the defaults once set explicitly');

// ---- developer override ------------------------------------------------------
// An env var, matching the Electron convention, and it replaces the registry entirely
// so a development run cannot mutate the real one.
const scratch = mk(home, 'scratch');
assert.strictEqual(overrideRoots({}, home), null);
const overridden = new WorkspaceRegistry({ userData, home, env: { BIGKIJI_WORKSPACES: `${scratch},~/Documents/Alpha` } });
assert.deepStrictEqual(overridden.list().map((root) => root.path), [scratch, school]);
assert.ok(overridden.list().every((root) => root.overridden), 'an overridden list says so');
assert.strictEqual(registry.list().length, 2, 'the override must not have written to the real registry');

// ---- removal -----------------------------------------------------------------
assert.strictEqual(registry.remove(registered.id), true);
assert.strictEqual(registry.remove('does-not-exist'), false);
assert.ok(fs.existsSync(school), 'removing a workspace must never delete the folder');

fs.rmSync(home, { recursive: true, force: true });
console.log('workspace registry selftest: PASS · flat explicit registration · overlap refused · missing root reported · env override isolated');
