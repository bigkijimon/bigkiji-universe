'use strict';

// Several providers write at once, so each one writes somewhere else.
//
// A run splits into roles and hands them to different providers in parallel. Today they
// all share one working directory, so two of them editing the same file is a race the
// last writer wins — silently, with no record that anything was overwritten.
//
// Every tool that does parallel agent work stops at the same place: isolate, then show a
// human the diffs. claude-squad, herdr and parallel-code all do exactly that, and none of
// them merges automatically. This module is the isolate half. Nothing here merges, and
// nothing here commits: the report names the branchless worktree and the owner decides.
//
// Two honest limits, both surfaced rather than hidden:
//   * A worktree starts from HEAD, not from the working tree. If the owner has
//     uncommitted work, a provider isolated naively would edit code the owner is not
//     looking at. So the tracked diff is carried across, and the count of untracked files
//     that could NOT be carried is reported.
//   * If the directory is not a git repository there is nothing to isolate with. The
//     caller is told so and keeps the shared directory, rather than being handed a fake
//     isolation that quietly does nothing.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { canonical } = require('../pi-core/security/security-policy');

const GIT_TIMEOUT_MS = 30000;
const MAX_PATCH_CHARS = 20000;
const MAX_LISTED_FILES = 40;
// The file SandboxPolicyResolver walks up to find. Isolation moves the working
// directory, so this has to travel with it or the policy silently changes.
const POLICY_FILE = path.join('.pi', 'sandbox.json');
// Where the isolated copies live. Relative to the repository root on purpose — see
// isolate(). Add it to .gitignore of any repo this runs in; it is working space.
const WORKTREE_DIR = path.join('.bigkiji', 'worktrees');

// The mark the provider's work is measured against.
//
// `write-tree` writes a tree object from the index and nothing else. It creates no ref,
// no branch, and moves nothing. That distinction is the point: the selftest keeps this
// module away from every porcelain command that could combine or relocate work, because a
// module able to quietly fold several providers' edits together would be the most
// expensive thing in this repository. Recording where the provider started is not
// combining anything, and this is the one plumbing command that cannot.
const BASELINE_TREE = ['write-tree'];

function git(args, cwd, { input = null } = {}) {
  return execFileSync('git', args, {
    cwd,
    input: input === null ? undefined : input,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: input === null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

/** The repository root, or '' when cwd is not inside one. */
function repoRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch (_) { return ''; }
}

/** Files git does not track. They cannot ride along on a diff, so they are counted. */
function untrackedFiles(root) {
  try {
    return git(['ls-files', '--others', '--exclude-standard'], root).split('\n').filter(Boolean);
  } catch (_) { return []; }
}

// A worktree per writer, named after the run and role so `git worktree list` reads as the
// run does. Detached on purpose: a branch per role would leave refs behind on every run,
// and nothing here is meant to be merged by name.
function isolate({ cwd, runId = 'run', role = 'task', root = null, policyFile = POLICY_FILE } = {}) {
  const repo = repoRoot(cwd);
  if (!repo) return { path: cwd, isolated: false, reason: 'not a git repository', carried: 0, untracked: 0 };

  // Inside the repository, not in os.tmpdir(). SandboxPolicyResolver refuses any task
  // whose cwd is outside the configured Vault (sandbox-policy.js:49), so a worktree in
  // /tmp would block every task it was meant to help.
  // BIGKIJI_WORKTREE_ROOT keeps a test suite out of the production worktree directory.
  // daemon-selftest runs a real DaemonEngine with `workspace: process.cwd()`, so every run
  // it submits isolates into this repo — 85 of the 1,446 leaked copies were made by
  // `npm test`, not by any real work.
  //
  // It must still point INSIDE the Vault. Pointing it at os.tmpdir() was tried and every
  // task came back SECURITY_BLOCKED: SandboxPolicyResolver refuses a cwd outside the
  // configured Vault, which is the same reason the default is inside the repo rather than
  // in /tmp (see the comment below). The override relocates; it does not escape.
  const parent = root || process.env.BIGKIJI_WORKTREE_ROOT || path.join(repo, WORKTREE_DIR);
  const target = path.join(parent, `${slug(runId)}-${slug(role)}`);
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    git(['worktree', 'add', '--detach', '--quiet', target, 'HEAD'], repo);
  } catch (error) {
    // Isolation is an improvement, not a precondition. Failing it must not fail the run —
    // but the caller has to know it is back to sharing one directory with everyone else.
    return { path: cwd, isolated: false, reason: firstLine(error.message), carried: 0, untracked: 0 };
  }

  // Carry the owner's uncommitted tracked work across, or the provider starts from a
  // state nobody is looking at.
  //
  // …and then RECORD IT AS THE BASELINE, which is the whole difference between this
  // working and not.
  //
  // The carried patch used to be left in the working tree with nothing marking it as
  // pre-existing, so `git diff` in this worktree reported it forever. Two things broke on
  // that, both measured 2026-08-09:
  //
  //   1. collectDiff() returned files > 0 the instant the worktree was created, so
  //      release({keep: diff.files > 0}) kept every single one. 1,446 worktrees, 35 GB,
  //      not one deletion — and the diffs of three sampled worktrees hashed identical
  //      (cc8911c8a012) because it was the same carried patch in all of them.
  //   2. The run report showed the owner their own uncommitted work as though a paid
  //      provider had written it.
  //
  // Both go away once git is told where the provider actually started.
  let carried = 0;
  let baseline = '';
  try {
    const patch = git(['diff', 'HEAD', '--binary'], repo);
    if (patch.trim()) {
      git(['apply', '--whitespace=nowarn', '-'], target, { input: patch });
      carried = countChangedFiles(patch);
    }
    git(['add', '--all'], target);
    baseline = git(BASELINE_TREE, target).trim();
  } catch (error) {
    release({ path: target, isolated: true, repo });
    return { path: cwd, isolated: false, reason: `could not carry local changes: ${firstLine(error.message)}`, carried: 0, untracked: 0 };
  }

  // The sandbox policy is resolved by walking up from the working directory, so moving
  // the working directory moves which policy is found. A worktree checks out HEAD, so a
  // policy file that is committed comes along and everything resolves as it should — but
  // one that is untracked or ignored does NOT, and SandboxPolicyResolver then falls
  // through to its safe-default: write access to the whole tree and every paid provider
  // allowed. Isolating into weaker permissions than the run was approved under is worse
  // than not isolating at all, so it refuses instead.
  if (policyFile && fs.existsSync(path.join(repo, policyFile)) && !fs.existsSync(path.join(target, policyFile))) {
    release({ path: target, isolated: true, repo });
    return { path: cwd, isolated: false, carried: 0, untracked: 0,
      reason: `${policyFile} is not committed, so an isolated copy would run under the permissive default` };
  }

  // What this directory is, written where it outlives the process that made it.
  //
  // `baseline` is the whole of the cleanup decision — the tree the provider started from,
  // so a later diff can tell its work from the owner's carried-in changes — and it lived
  // only on the run object, in the daemon's memory. `forgetRun()` is the sole caller of
  // release(), and it needs the run to still be in `this.runs`. Restart the daemon and
  // every waiting run's worktree becomes unattributable: nothing knows what it was, so
  // nothing dares remove it. Measured 2026-08-10 after five restarts in one evening: 87
  // directories, 2.2 GB, and not one of them ever written to.
  //
  // Beside the worktree, never inside it. `collectDiff()` runs `git add --all` before
  // diffing, so a marker in the tree would be staged, counted as work, and keep the
  // directory alive forever — which is the 35 GB failure above wearing a different hat.
  try {
    fs.writeFileSync(markerPath(parent, path.basename(target)),
      JSON.stringify({ runId: String(runId || ''), role: String(role || ''), baseline, repo, createdAt: new Date().toISOString() }));
  } catch (_) { /* the sweep falls back to filesystem evidence without it */ }

  return { path: target, isolated: true, repo, reason: '', carried, baseline,
    untracked: untrackedFiles(repo).length };
}

/** Where a worktree's marker lives: beside the directory, never inside it. */
function markerPath(parent, name) { return path.join(parent, `${name}.json`); }

/**
 * Has anything been written in here since it was made?
 *
 * The fallback for a worktree with no marker — every one that existed before markers did.
 * Filesystem evidence rather than git's, deliberately: `collectDiff()` without a baseline
 * compares against HEAD, which counts the owner's carried-in work as the provider's, and
 * that is precisely the misreading that kept 1,446 directories alive. A provider that ran
 * wrote something; a run that was never approved did not.
 *
 * Five seconds of grace covers the writes git makes while creating the copy. Measured
 * against the 87 real leaked worktrees on 2026-08-10: all 87 read as untouched at this
 * threshold, and the number does not change at 30s — there is no cliff here to fall off.
 *
 * (The word for what git does to make that copy is avoided on purpose: worktree-selftest
 * greps this file for it, and a guard against the most expensive mistake available here
 * is not worth loosening to fit a comment.)
 */
function touchedSince(dir, graceMs = 5000) {
  let born = 0;
  try { const st = fs.statSync(dir); born = st.birthtimeMs || st.mtimeMs; } catch (_) { return true; }
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      // .git in a worktree is a file pointing at the parent repo, and git rewrites it for
      // its own bookkeeping. It says nothing about whether a provider did any work.
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { if (fs.statSync(full).mtimeMs > born + graceMs) return true; } catch (_) {}
    }
  }
  return false;
}

/**
 * Reconcile the worktree directory against the runs that actually exist.
 *
 * `listAbandoned()` has been able to name these since it was written, and nothing ever
 * called it — the comment above it says "so a later run can offer to clean them up", and
 * no later run did. This is that caller.
 *
 * Work is never deleted. A directory with provider work in it is kept and reported, which
 * is the same judgement `forgetRun()` makes and for the same reason: that work is the only
 * copy of itself.
 *
 * `parent` defaults exactly as `isolate()`'s does, override included. Without that, this
 * swept the production directory while running under `npm test`: daemon-selftest builds a
 * real DaemonEngine with `workspace: process.cwd()`, so the sweep in its constructor ran
 * against the owner's own repository and deleted 87 real directories. They were all
 * provably untouched, so nothing was lost — but a suite that reaches into the owner's
 * working space is a defect whether or not it got away with it this time, and
 * BIGKIJI_WORKTREE_ROOT is the mechanism that already exists to stop it.
 *
 * @param {string} repo
 * @param {{parent?: string, live?: Set<string>}} options `live` holds the directory names
 *   of worktrees belonging to runs this process still owns — they are never touched.
 * @returns {{removed: string[], kept: string[]}}
 */
function sweepAbandoned(repo, { parent = process.env.BIGKIJI_WORKTREE_ROOT || path.join(repo, WORKTREE_DIR), live = new Set() } = {}) {
  const removed = []; const kept = [];
  for (const dir of listAbandoned(repo, { parent })) {
    const name = path.basename(dir);
    if (live.has(name)) continue;
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath(parent, name), 'utf8')); } catch (_) { marker = null; }
    // With a baseline, ask git what the provider changed. Without one, ask the filesystem
    // whether anyone wrote at all — never git, which would compare against HEAD and read
    // the owner's own uncommitted work as the provider's.
    const worked = marker?.baseline
      ? (collectDiff({ path: dir, isolated: true, repo, baseline: marker.baseline }).files || 0) > 0
      : touchedSince(dir);
    if (worked) { kept.push(dir); continue; }
    release({ path: dir, isolated: true, repo });
    try { fs.rmSync(markerPath(parent, name), { force: true }); } catch (_) {}
    removed.push(dir);
  }
  return { removed, kept };
}

/** What the provider actually changed, as numbers plus a bounded patch. */
function collectDiff(workspace) {
  if (!workspace || !workspace.isolated) return { files: 0, insertions: 0, deletions: 0, names: [], patch: '', truncated: false };
  let stat = '';
  let patch = '';
  // Against the baseline tree isolate() recorded, not against HEAD. HEAD is the commit the
  // worktree was checked out from, and the owner's carried-in work sits between the two —
  // measuring from HEAD counts it as the provider's, which is both a 35 GB leak and a lie
  // in the report. `against` stays empty for a workspace made before this existed, and the
  // old HEAD comparison is what it gets.
  const against = workspace.baseline ? [workspace.baseline] : [];
  try {
    git(['add', '--all'], workspace.path);
    stat = git(['diff', '--cached', ...against, '--numstat'], workspace.path);
    patch = git(['diff', '--cached', ...against], workspace.path);
  } catch (_) { return { files: 0, insertions: 0, deletions: 0, names: [], patch: '', truncated: false }; }

  let insertions = 0;
  let deletions = 0;
  const names = [];
  for (const line of stat.split('\n')) {
    if (!line.trim()) continue;
    const [added, removed, name] = line.split('\t');
    // A binary file reports "-" for both counts. Adding it as zero would be a lie about a
    // file that did change, so it is named and left out of the totals.
    if (added !== '-') insertions += Number(added) || 0;
    if (removed !== '-') deletions += Number(removed) || 0;
    if (name) names.push(name);
  }
  return {
    files: names.length,
    insertions,
    deletions,
    names: names.slice(0, MAX_LISTED_FILES),
    patch: patch.slice(0, MAX_PATCH_CHARS),
    truncated: patch.length > MAX_PATCH_CHARS,
  };
}

// Empty worktrees are removed; ones with work in them are kept, because that work is the
// only copy and the owner has not looked at it yet.
function release(workspace, { keep = false } = {}) {
  if (!workspace || !workspace.isolated || !workspace.repo) return { removed: false, kept: false };
  if (keep) return { removed: false, kept: true, path: workspace.path };
  try {
    git(['worktree', 'remove', '--force', workspace.path], workspace.repo);
    return { removed: true, kept: false };
  } catch (_) {
    try { fs.rmSync(workspace.path, { recursive: true, force: true }); } catch (__) {}
    try { git(['worktree', 'prune'], workspace.repo); } catch (__) {}
    return { removed: true, kept: false };
  }
}

/** Worktrees this module left behind, so a later run can offer to clean them up. */
function listAbandoned(repo, { parent = path.join(repo, WORKTREE_DIR) } = {}) {
  let out = '';
  try { out = git(['worktree', 'list', '--porcelain'], repo); } catch (_) { return []; }
  // git reports resolved paths, and on macOS the temp directory is a symlink
  // (/var/folders -> /private/var/folders), so comparing the two as written never matches.
  const real = realpath(parent);
  // Resolve before returning, not only before filtering. git prints forward slashes
  // even on Windows, so handing its spelling back meant a caller comparing against a
  // resolved path — which is what every other path in this codebase is — never
  // matched: 'C:/Users/.../run-5-leader' against 'C:\Users\...\run-5-leader'.
  // The filter was already right; only the value being returned was not.
  return out.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpath(line.slice('worktree '.length)))
    .filter((dir) => dir.startsWith(real));
}

function countChangedFiles(patch) {
  return (patch.match(/^diff --git /gm) || []).length;
}

function slug(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
}

function realpath(dir) {
  // Same resolver as the sandbox check uses, so a path compared across the two
  // subsystems cannot be two spellings of one place (8.3 short names on Windows).
  try { return canonical(dir); } catch (_) { return String(dir || ''); }
}

function firstLine(text) {
  return String(text || '').split('\n')[0].slice(0, 200);
}

module.exports = { isolate, collectDiff, release, listAbandoned, sweepAbandoned, touchedSince, repoRoot, POLICY_FILE, WORKTREE_DIR, MAX_PATCH_CHARS, MAX_LISTED_FILES };
