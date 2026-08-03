'use strict';

// Two providers writing the same file at once, and what the owner is shown afterwards.
//
// The run splits into roles and hands them to different providers in parallel, sharing
// one working directory. Two of them editing the same file is a race the last writer
// wins, and nothing records that anything was overwritten. This checks the isolation and
// — just as important — that it never merges, never commits, and never touches the
// owner's own working tree.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const worktree = require('../src/domain/pi-agent/worktree');

let failures = 0;
const ok = (name, body) => {
  try { body(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-wt-'));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A real repository, because the whole point is what git actually does. */
function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@bigkiji.local'], dir);
  git(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1;\n');
  fs.writeFileSync(path.join(dir, 'keep.md'), '# keep\n');
  git(['add', '.'], dir);
  git(['commit', '--quiet', '-m', 'base'], dir);
  return dir;
}
const parent = path.join(root, 'worktrees');

ok('two providers writing the same file no longer overwrite each other', () => {
  const dir = repo('race');
  const leader = worktree.isolate({ cwd: dir, runId: 'run-1', role: 'leader', root: parent });
  const ui = worktree.isolate({ cwd: dir, runId: 'run-1', role: 'ui', root: parent });
  assert.ok(leader.isolated && ui.isolated, 'both are isolated');
  assert.notStrictEqual(leader.path, ui.path, 'and not into the same directory');

  fs.writeFileSync(path.join(leader.path, 'app.js'), 'const value = 2; // leader\n');
  fs.writeFileSync(path.join(ui.path, 'app.js'), 'const value = 3; // ui\n');

  assert.match(fs.readFileSync(path.join(leader.path, 'app.js'), 'utf8'), /leader/,
    'shared, the second writer silently replaced the first');
  assert.match(fs.readFileSync(path.join(ui.path, 'app.js'), 'utf8'), /ui/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'const value = 1;\n',
    'and the owner’s own checkout is untouched by either of them');
  worktree.release(leader); worktree.release(ui);
});

ok('what changed is reported as measurements, not as a merge', () => {
  const dir = repo('diff');
  const space = worktree.isolate({ cwd: dir, runId: 'run-2', role: 'leader', root: parent });
  fs.writeFileSync(path.join(space.path, 'app.js'), 'const value = 1;\nconst added = 2;\n');
  fs.writeFileSync(path.join(space.path, 'new.js'), 'module.exports = {};\n');
  fs.rmSync(path.join(space.path, 'keep.md'));

  const diff = worktree.collectDiff(space);
  assert.strictEqual(diff.files, 3, `changed, added and deleted all count: ${JSON.stringify(diff.names)}`);
  assert.strictEqual(diff.insertions, 2, 'one line into app.js and one new file');
  assert.strictEqual(diff.deletions, 1, 'the deleted file is a deletion');
  assert.ok(diff.names.includes('new.js'), 'a file git has never seen still has to appear');
  assert.match(diff.patch, /const added = 2;/, 'the patch is the evidence the owner reads');

  // Nothing is merged and nothing is committed: the report names the directory, the
  // owner decides. Every published tool that runs agents in parallel stops here too.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'const value = 1;\n');
  assert.ok(fs.existsSync(path.join(dir, 'keep.md')), 'a file deleted in a worktree is not deleted for the owner');
  assert.strictEqual(git(['log', '--oneline'], dir).trim().split('\n').length, 1, 'no new commit on the owner’s branch');
  assert.strictEqual(git(['status', '--porcelain'], dir).trim(), '', 'and the owner’s tree is still clean');
  worktree.release(space);
});

ok('uncommitted work travels with the provider, and what cannot is counted', () => {
  // A worktree starts from HEAD. Isolating naively hands the provider code the owner is
  // not looking at — the most expensive kind of quiet wrongness.
  const dir = repo('dirty');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1;\nconst inProgress = true;\n');
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'not yet added to git\n');

  const space = worktree.isolate({ cwd: dir, runId: 'run-3', role: 'debug', root: parent });
  assert.ok(space.isolated);
  assert.match(fs.readFileSync(path.join(space.path, 'app.js'), 'utf8'), /inProgress/,
    'the provider must see the work in progress, not the last commit');
  assert.strictEqual(space.carried, 1, 'and it says how many files it carried');
  assert.strictEqual(space.untracked, 1,
    'an untracked file cannot ride on a diff, so it is counted rather than lost silently');
  assert.ok(!fs.existsSync(path.join(space.path, 'scratch.txt')));

  // Carrying the change must not consume it.
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /inProgress/, 'the owner still has their own edit');
  worktree.release(space);
});

ok('a directory that is not a repository is told so, not faked', () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const space = worktree.isolate({ cwd: plain, runId: 'run-4', role: 'leader', root: parent });
  assert.strictEqual(space.isolated, false);
  assert.strictEqual(space.path, plain, 'the caller keeps the directory it had');
  assert.match(space.reason, /not a git repository/, 'and is told why, so the report can say so');
  assert.deepStrictEqual(worktree.collectDiff(space), { files: 0, insertions: 0, deletions: 0, names: [], patch: '', truncated: false });
  assert.deepStrictEqual(worktree.release(space), { removed: false, kept: false }, 'releasing it is a no-op');
});

ok('empty work is cleaned up; work with something in it is kept and named', () => {
  const dir = repo('cleanup');
  const empty = worktree.isolate({ cwd: dir, runId: 'run-5', role: 'context', root: parent });
  worktree.release(empty);
  assert.ok(!fs.existsSync(empty.path), 'a provider that changed nothing leaves nothing behind');

  const used = worktree.isolate({ cwd: dir, runId: 'run-5', role: 'leader', root: parent });
  fs.writeFileSync(path.join(used.path, 'app.js'), 'changed\n');
  const kept = worktree.release(used, { keep: true });
  assert.strictEqual(kept.kept, true);
  assert.strictEqual(kept.path, used.path, 'the owner is given the path, because it is the only copy');
  assert.ok(fs.existsSync(used.path));
  // git reports resolved paths, and on macOS /var/folders is a symlink to
  // /private/var/folders, so the comparison has to resolve too.
  assert.deepStrictEqual(worktree.listAbandoned(dir, { parent }), [fs.realpathSync(used.path)],
    'and a later run can find what was left');
  worktree.release(used);
  assert.deepStrictEqual(worktree.listAbandoned(dir, { parent }), []);
});

ok('it refuses to isolate into weaker permissions than the run was approved under', () => {
  // SandboxPolicyResolver finds .pi/sandbox.json by walking up from the working
  // directory. A worktree checks out HEAD, so a committed policy travels with it — an
  // untracked one does not, and the resolver then falls through to its safe-default:
  // write access to the whole tree and every paid provider allowed.
  const dir = repo('policy');
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pi', 'sandbox.json'), JSON.stringify({ filesystem: { allowWrite: ['./src'] } }));

  const uncommitted = worktree.isolate({ cwd: dir, runId: 'run-6', role: 'leader', root: parent });
  assert.strictEqual(uncommitted.isolated, false, 'an untracked policy must stop isolation, not be ignored');
  assert.match(uncommitted.reason, /not committed/, 'and the reason has to name the file');
  assert.strictEqual(uncommitted.path, dir, 'the run continues where it was, under the policy it was approved with');

  git(['add', '.'], dir); git(['commit', '--quiet', '-m', 'policy'], dir);
  const committed = worktree.isolate({ cwd: dir, runId: 'run-6', role: 'leader', root: parent });
  assert.strictEqual(committed.isolated, true, 'a committed policy travels with the worktree');
  assert.ok(fs.existsSync(path.join(committed.path, '.pi', 'sandbox.json')), 'and is there to be resolved');
  worktree.release(committed);
});

ok('this module cannot merge, commit or push', () => {
  // The step with no working precedent is combining several providers' edits
  // automatically. Every published parallel-agent tool stops at "a human reviews the
  // diffs", and a module that could quietly cross that line would be the most expensive
  // thing in this repository.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'worktree.js'), 'utf8');
  for (const forbidden of ['merge', 'commit', 'push', 'rebase', 'cherry-pick', 'reset']) {
    assert.ok(!new RegExp(`'${forbidden}'`).test(source), `worktree.js must never run git ${forbidden}`);
  }
  assert.ok(!/checkout/.test(source), 'and must never move the owner’s HEAD');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`worktree selftest: ${failures} FAILED`); process.exit(1); }
console.log('worktree selftest: PASS · parallel writers no longer race · owner tree untouched · uncommitted work carried and untracked counted · not-a-repo is reported not faked · empty cleaned, used kept and named · refuses to isolate under a weaker policy · cannot merge, commit or push');
