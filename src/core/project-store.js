'use strict';

// Starting a new piece of work, without editing a settings file by hand.
//
// Until this existed BigKiji could be told which folders it may READ (workspace-registry)
// but never which one it should WORK IN. Runs take their cwd from one daemon-wide value
// resolved once at startup (`resolveWorkspace` in domain/server/daemon.js), so beginning a
// new project meant: quit the app, kill the daemon — which outlives it — set an env var or
// hand-edit `paths.vaultRoot`, relaunch, and remember to put it back afterwards. Measured
// on the owner's machine 2026-08-15: every run was executing in `~/BigKijiUniverse`, the
// app's own data directory, because that is what `detectVault` finds first. New work landed
// in the filing cabinet.
//
// Two concepts, deliberately separate:
//
//   registered root   what BigKiji may read      workspace-registry.js
//   active project    where runs actually run    this file + paths.activeProject
//
// They were one value and that is precisely what went wrong: `vaultRoot` also means "the
// Obsidian vault" and `graphPath` is derived from it, so pointing it at a rental-car site
// would have moved the knowledge graph too.
//
// Pure Node on purpose — the daemon, the Electron main process and the selftest all load
// it, so it must not `require('electron')`. Same rule as data-root.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Characters a filesystem, a shell or a URL would misread. Everything else survives,
// including Japanese: the owner's existing department folders are named in it.
const UNSAFE = /[/\\:*?"<>|]/g;

/**
 * Control characters removed by code point rather than by a regular expression.
 *
 * A character class holding this range has to contain the bytes it matches, and a source
 * file with a literal NUL in it is one every tool downstream has an opinion about. The
 * comparison says the same thing and can be read.
 */
function stripControl(value) {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) out += character;
  }
  return out;
}

/**
 * A folder name from something a human typed.
 *
 * Not `slug()` from workspace-registry: that lowercases and strips every non-ASCII
 * character, which turns 「いがた屋レンタカー」 into an empty string and then into
 * `root`. A name the owner cannot recognise in Finder is not a name.
 * @returns {string} '' when nothing usable survives
 */
function folderName(raw) {
  return stripControl(String(raw || '').normalize('NFC'))
    .replace(UNSAFE, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 64);
}

function isInside(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);
  if (from === to) return true;
  const relative = path.relative(from, to);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why this path may not be a project, or '' when it may.
 *
 * These are not new rules. Each one is a boundary the codebase already defends somewhere
 * else, restated in one place so the answer cannot differ between the API and the UI:
 *
 *   home            `resolveWorkspace` — "Home is never a project". A run there offered
 *                   the whole home directory as candidate context; measured 2026-08-07 at
 *                   5,661,108 tokens for a one-line request.
 *   dataRoot        `resolveWorkspace` again, and docs/known-issues.md: with the workspace
 *                   inside `~/BigKijiUniverse`, `.` is in allowRead and a run can read
 *                   `state/remote.json` — the daemon token that drives the whole API.
 *   ~/Library       application data belonging to other programs. Nothing there is source.
 *   dot-directories the same reason the inventory walker skips them.
 *
 * @returns {string} a sentence for the owner, or ''
 */
function refuseReason(target, { home = os.homedir(), dataRoot = '' } = {}) {
  const value = String(target || '').trim();
  if (!value) return 'A project needs a name.';
  if (!path.isAbsolute(value)) return 'A project needs an absolute path.';
  const resolved = path.resolve(value);
  if (resolved === path.resolve(home)) return 'The home directory is not a project.';
  if (dataRoot && isInside(dataRoot, resolved)) {
    return "BigKiji's own data folder is not a project — a run inside it can read the daemon token.";
  }
  if (isInside(path.join(home, 'Library'), resolved)) return 'Application data is not a project.';
  const relativeToHome = path.relative(path.resolve(home), resolved);
  const underHome = relativeToHome && !relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome);
  if (underHome && relativeToHome.split(path.sep).some((segment) => segment.startsWith('.'))) {
    return 'A hidden folder is not a project.';
  }
  return '';
}

const GITIGNORE = ['node_modules/', '.next/', 'dist/', 'build/', '.env', '.env.local', '.DS_Store', ''].join('\n');

/**
 * Create the folder and make it a git repository.
 *
 * Deliberately NOT a framework scaffold. `create-next-app` is minutes of network install,
 * and running it here would hold an HTTP request open, put npm inside the daemon's process
 * and make failure look like "the button is broken". The folder and its git repo are what
 * the switch actually needs — git because a run's worktree isolation has nothing to isolate
 * without one — and the scaffold is then the project's first BigKiji run, which is the
 * thing the owner asked to watch happen.
 *
 * `exec` is injected so the selftest never shells out.
 *
 * @returns {{path: string, created: boolean, git: boolean}}
 */
function createProject({ parent, name, home = os.homedir(), dataRoot = '', exec = null } = {}) {
  const folder = folderName(name);
  if (!folder) throw new Error('A project needs a name.');
  const base = String(parent || '').trim();
  if (!base) throw new Error('A project needs somewhere to live.');
  const target = path.resolve(base, folder);
  const refused = refuseReason(target, { home, dataRoot });
  if (refused) throw new Error(refused);
  // A parent that does not exist is a typo, not an instruction to build a tree. One level
  // is created — the department folder the owner just named — and no more.
  const parentResolved = path.resolve(base);
  if (!fs.existsSync(parentResolved)) {
    if (!fs.existsSync(path.dirname(parentResolved))) throw new Error(`No such folder: ${path.dirname(parentResolved)}`);
    fs.mkdirSync(parentResolved);
  }
  const created = !fs.existsSync(target);
  fs.mkdirSync(target, { recursive: true });
  // No README, deliberately.
  //
  // It was written here at first, and it broke the very next step. `create-next-app`
  // refuses a directory containing anything outside its own small allowed list, and
  // README.md is not on it: measured 2026-08-15, the first project created through this
  // API could not then be scaffolded — "The directory igataya-rentacar contains files that
  // could conflict: README.md". A welcome file that blocks the most common next action is
  // not a welcome. `.gitignore` IS on that list, so it stays.
  const ignore = path.join(target, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE);
  let git = fs.existsSync(path.join(target, '.git'));
  if (!git) {
    const run = exec || ((file, args, options) => require('child_process').execFileSync(file, args, options));
    // A missing or unhappy git costs the run its worktree isolation. That is worth saying
    // out loud in the response rather than refusing to create the project over.
    try { run('git', ['init', '--quiet'], { cwd: target, stdio: 'ignore' }); git = true; } catch (_) { git = false; }
  }
  return { path: target, created, git };
}

/**
 * The projects BigKiji can see: every registered root that is one itself, plus the folders
 * one level inside a root that carry a project marker.
 *
 * One level, not a walk. `~/Documents/School` alone holds six of these, and a recursive
 * scan of every registered root returns a list nobody can choose from.
 */
function listProjects(roots = [], { markers = ['.git', 'package.json'] } = {}) {
  const found = [];
  const seen = new Set();
  const add = (target, root, label) => {
    const resolved = path.resolve(target);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    found.push({ path: resolved, name: label || path.basename(resolved), root });
  };
  for (const entry of roots) {
    const base = String(entry?.path || entry || '').trim();
    if (!base || !fs.existsSync(base)) continue;
    if (markers.some((marker) => fs.existsSync(path.join(base, marker)))) add(base, base, entry?.label);
    let children = [];
    try { children = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const target = path.join(base, child.name);
      if (markers.some((marker) => fs.existsSync(path.join(target, marker)))) add(target, base);
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { folderName, refuseReason, createProject, listProjects, isInside, stripControl, GITIGNORE };
