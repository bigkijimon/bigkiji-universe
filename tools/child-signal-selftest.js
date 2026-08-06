'use strict';

// The wall this test exists to stop us walking into again (docs/known-issues.md #1):
// every provider binary is absent on a CI runner, so every spawn there fails, and
// ChildProcess.kill() on a failed spawn signals pid 0 — "every process in my process
// group" — which on a hosted runner includes the agent running the job. CI died for
// four days with no failed assertion anywhere, because the thing being killed was the
// runner rather than the test.
//
// It cannot be tested by asserting on a return value alone: kill() returns true for a
// child that never started. The only honest check is to arrange to be the victim and
// prove the signal never arrives.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { signalChild, signalPid } = require('../src/core/child-signal');

const posix = process.platform !== 'win32';

(async () => {
  // ---- a child whose spawn failed is not a process, and must not be signalled -----
  {
    const child = spawn('bigkiji-no-such-binary-exists', ['--x'], { stdio: 'ignore' });
    const spawnFailed = new Promise((resolve) => child.once('error', resolve));

    assert.equal(child.pid, undefined, 'a failed spawn has no pid — this is the state that used to be signalled');
    assert.equal(signalChild(child, 'SIGTERM'), false, 'refusing to signal it is the whole fix');

    await spawnFailed;
  }

  // ---- and the signal must not have reached this process, or its group ------------
  if (posix) {
    let hit = null;
    const onTerm = () => { hit = 'SIGTERM'; };
    process.on('SIGTERM', onTerm);

    // A sibling in the same process group. If a signal goes to the group rather than
    // to a process, this is what proves it: it dies without anyone naming it.
    const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 1500)'], { stdio: 'ignore' });
    await new Promise((resolve) => sibling.once('spawn', resolve));

    const dead = spawn('bigkiji-no-such-binary-exists', ['--x'], { stdio: 'ignore' });
    const failed = new Promise((resolve) => dead.once('error', resolve));
    signalChild(dead, 'SIGTERM');
    await failed;
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(hit, null, 'signalling a child that never started must not signal this process');
    assert.equal(sibling.exitCode, null, 'nor anything else sharing this process group');
    assert.equal(sibling.signalCode, null, 'and certainly not by signal');

    signalChild(sibling, 'SIGKILL');
    process.off('SIGTERM', onTerm);
  }

  // ---- a real child is still stoppable, or the guard has broken the feature -------
  if (posix) {
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((resolve) => alive.once('spawn', resolve));
    assert.ok(alive.pid > 0, 'a real spawn has a real pid');
    assert.equal(signalChild(alive, 'SIGTERM'), true, 'and it is still asked to stop');
    const [, signal] = await new Promise((resolve) => alive.once('exit', (code, sig) => resolve([code, sig])));
    assert.equal(signal, 'SIGTERM', 'the signal reached the child it named');
    assert.equal(signalChild(alive, 'SIGTERM'), false, 'signalling it again is refused rather than thrown');
  }

  // ---- the guard itself, pinned in the source ------------------------------------
  //
  // The obvious assertion — that Node's own child.kill() returns true for a child that
  // never started — cannot be written here: making that call is the defect, and it
  // would signal the process group of whatever is running this suite. It killed this
  // test's own shell the first time it was written. So the property is pinned by
  // reading the guard instead of by firing the weapon.
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'child-signal.js'), 'utf8');
    assert.match(source, /if \(!child \|\| !child\.pid\) return false;/,
      'the pid check is the fix; without it kill() is handed a pid of 0 and signals the whole group');
    assert.match(source, /if \(!Number\.isInteger\(target\) \|\| target <= 0\) return false;/,
      'and the same for a pid read from a file, where Number(\'\') is 0');
  }

  // ---- the same hazard read from a file: Number('') is 0, and 0 is the group ------
  for (const empty of ['', '   ', 'not-a-pid', '0', '-1', undefined, null, '1.5']) {
    assert.equal(signalPid(empty, 'SIGTERM'), false, `a pid file reading ${JSON.stringify(empty)} must not signal anything`);
  }
  // Signal 0 rather than a real one: it proves the call reached a live process without
  // doing anything to it, and unlike SIGCONT it exists on Windows too — which the first
  // version of this line did not, and Windows said so.
  assert.equal(signalPid(String(process.pid), 0), true, 'a real pid is still signalled');

  console.log('child-signal selftest: PASS · a failed spawn is never signalled · the process group is not the target'
    + ' · a real child still stops · an empty pid file is not process group 0');
})().catch((error) => { console.error(error); process.exit(1); });
