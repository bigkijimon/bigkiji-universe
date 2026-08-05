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
  const parent = root || path.join(repo, WORKTREE_DIR);
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
  let carried = 0;
  try {
    const patch = git(['diff', 'HEAD', '--binary'], repo);
    if (patch.trim()) {
      git(['apply', '--whitespace=nowarn', '-'], target, { input: patch });
      carried = countChangedFiles(patch);
    }
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

  return { path: target, isolated: true, repo, reason: '', carried, untracked: untrackedFiles(repo).length };
}

/** What the provider actually changed, as numbers plus a bounded patch. */
function collectDiff(workspace) {
  if (!workspace || !workspace.isolated) return { files: 0, insertions: 0, deletions: 0, names: [], patch: '', truncated: false };
  let stat = '';
  let patch = '';
  try {
    git(['add', '--all'], workspace.path);
    stat = git(['diff', '--cached', '--numstat'], workspace.path);
    patch = git(['diff', '--cached'], workspace.path);
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
  return out.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((dir) => realpath(dir).startsWith(real));
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

module.exports = { isolate, collectDiff, release, listAbandoned, repoRoot, POLICY_FILE, WORKTREE_DIR, MAX_PATCH_CHARS, MAX_LISTED_FILES };
