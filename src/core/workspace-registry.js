'use strict';
// Which folders on this machine BigKiji is allowed to read and work inside.
//
// Replaces the single `vaultRoot`, which assumed one directory and — until V2.5 —
// hardcoded one person's. The shape here follows what comparable local-first apps
// actually do, rather than something invented:
//
//   * Obsidian, VS Code, Zed and Docker Desktop all keep a FLAT list of explicitly
//     registered roots. None of them rescans a parent directory to decide what is
//     open, because that cannot represent an external volume or a folder outside the
//     conventional location. We propose candidates and let the owner confirm; we do
//     not treat a live scan as the registry.
//   * The registry itself lives in the app's own data directory, never inside the
//     folders it points at, so it survives one of them being deleted or unmounted.
//     Per-folder settings may live in the folder (Obsidian's .obsidian/), but the
//     master list does not.
//   * No app auto-repairs a vanished root. They mark it and ask for re-selection.
//     Matching that is deliberate: silently re-pointing at a different directory is
//     worse than saying "this one is gone".
//   * Exclusions are per-root and exist from the start. VS Code and Raycast both
//     learned this late, and retrofitting it once a huge folder has jammed indexing
//     is painful.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_FILE = 'workspaces.json';

// Applied to every root unless overridden. These are the directories that make an
// index explode without carrying meaning.
const DEFAULT_EXCLUDE = Object.freeze([
  'node_modules', '.git', '.next', 'dist', 'build', 'graphify-out',
  '_archive', 'recordings', 'venv', '.venv', '__pycache__', 'Pods',
]);

// Folders under the home directory that are never workspace candidates: either the
// app's own storage, someone else's application data, or a tool checkout.
const NOT_A_WORKSPACE = /^(?:\.|BigKijiUniverse$|Library$|Applications$|node_modules$)/;

function expandHome(value, home = os.homedir()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

function registryFile(userData) { return path.join(userData, REGISTRY_FILE); }

function slug(target) {
  return path.basename(target).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

function readRegistry(userData) {
  try {
    const value = JSON.parse(fs.readFileSync(registryFile(userData), 'utf8'));
    if (!Array.isArray(value.roots)) return { version: 1, roots: [] };
    return { version: 1, roots: value.roots.filter((root) => root && typeof root.path === 'string') };
  } catch (_) { return { version: 1, roots: [] }; }
}

function writeRegistry(userData, registry) {
  fs.mkdirSync(userData, { recursive: true });
  const file = registryFile(userData);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), roots: registry.roots }, null, 2));
  fs.renameSync(tmp, file);
  return registry;
}

// A developer override, in the Electron convention: an env var, not a magic folder.
// Comma-separated absolute paths; when present it replaces the registry entirely so a
// test run cannot mutate the real one.
function overrideRoots(env = process.env, home = os.homedir()) {
  const raw = String(env.BIGKIJI_WORKSPACES || '').trim();
  if (!raw) return null;
  return raw.split(',').map((entry) => expandHome(entry, home)).filter(Boolean)
    .map((target) => ({ id: slug(target), path: target, label: path.basename(target), exclude: [...DEFAULT_EXCLUDE], source: 'env' }));
}

// Proposed, not registered. The setup UI shows these so the owner is not staring at an
// empty folder picker, which is the one place the major apps are needlessly unhelpful.
function candidates({ home = os.homedir(), roots = [path.join(os.homedir(), 'Documents')] } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_A_WORKSPACE.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      let mtime = 0; let files = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
      try { files = fs.readdirSync(dir).length; } catch (_) {}
      found.push({
        path: dir,
        label: entry.name,
        isObsidianVault: fs.existsSync(path.join(dir, '.obsidian')),
        entries: files,
        mtime,
      });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function statusOf(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return 'missing';
    fs.accessSync(target, fs.constants.R_OK);
    return 'ok';
  } catch (error) {
    // ENOENT is gone; EPERM/EACCES is macOS withholding access, which is a different
    // problem with a different remedy (re-grant, not re-pick).
    return error.code === 'EPERM' || error.code === 'EACCES' ? 'unreadable' : 'missing';
  }
}

class WorkspaceRegistry {
  constructor({ userData, home = os.homedir(), env = process.env } = {}) {
    if (!userData) throw new Error('WorkspaceRegistry requires userData');
    this.userData = userData;
    this.home = home;
    this.env = env;
  }

  list() {
    const override = overrideRoots(this.env, this.home);
    const roots = override || readRegistry(this.userData).roots;
    return roots.map((root) => ({
      ...root,
      exclude: Array.isArray(root.exclude) ? root.exclude : [...DEFAULT_EXCLUDE],
      status: statusOf(root.path),
      overridden: Boolean(override),
    }));
  }

  register(target, { label = '', bookmark = '', exclude = null } = {}) {
    const resolved = expandHome(target, this.home);
    if (!resolved) throw new Error('A workspace path is required');
    if (statusOf(resolved) !== 'ok') throw new Error(`Not a readable directory: ${resolved}`);
    const registry = readRegistry(this.userData);
    // Nesting one root inside another double-indexes everything below the inner one
    // and makes exclusions ambiguous. Refuse rather than silently double-count.
    for (const existing of registry.roots) {
      // Re-registering the same path is an update (a rename, a refreshed bookmark),
      // not an overlap.
      if (path.resolve(existing.path) === resolved) continue;
      const relative = path.relative(existing.path, resolved);
      const nested = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      const contains = !path.relative(resolved, existing.path).startsWith('..');
      if (nested || contains) throw new Error(`Overlaps an existing workspace: ${existing.path}`);
    }
    const root = {
      id: slug(resolved),
      path: resolved,
      label: label || path.basename(resolved),
      // Opaque to this module. macOS drops folder access on relaunch for sandboxed
      // apps, and a security-scoped bookmark is Apple's only sanctioned way to keep
      // it; the main process captures it at pick time and hands us the string.
      bookmark: String(bookmark || ''),
      exclude: Array.isArray(exclude) ? exclude : [...DEFAULT_EXCLUDE],
      addedAt: new Date().toISOString(),
    };
    registry.roots = [...registry.roots.filter((item) => item.path !== resolved), root];
    writeRegistry(this.userData, registry);
    return root;
  }

  remove(id) {
    const registry = readRegistry(this.userData);
    const before = registry.roots.length;
    registry.roots = registry.roots.filter((root) => root.id !== id);
    writeRegistry(this.userData, registry);
    return before !== registry.roots.length;
  }

  update(id, patch = {}) {
    const registry = readRegistry(this.userData);
    const root = registry.roots.find((item) => item.id === id);
    if (!root) return null;
    if (typeof patch.label === 'string') root.label = patch.label;
    if (Array.isArray(patch.exclude)) root.exclude = patch.exclude;
    if (typeof patch.bookmark === 'string') root.bookmark = patch.bookmark;
    writeRegistry(this.userData, registry);
    return root;
  }

  // True when a path is inside a registered, readable workspace and not excluded.
  // Everything that scans or edits should ask this rather than reasoning about paths.
  allows(target) {
    const resolved = expandHome(target, this.home);
    for (const root of this.list()) {
      if (root.status !== 'ok') continue;
      const relative = path.relative(root.path, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const segments = relative.split(path.sep);
      if (segments.some((segment) => root.exclude.includes(segment))) return false;
      return true;
    }
    return false;
  }
}

module.exports = {
  WorkspaceRegistry, DEFAULT_EXCLUDE, REGISTRY_FILE,
  candidates, overrideRoots, statusOf, expandHome, registryFile, slug,
};
