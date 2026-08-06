'use strict';

/**
 * Signal a child process — and refuse when there is no process to signal.
 *
 * `ChildProcess.kill()` looks like it checks. It does not. A child whose spawn failed
 * has `pid === undefined`, and kill() still hands libuv a handle whose pid is 0.
 * `kill(0, sig)` is not a no-op: POSIX defines it as "every process in my process
 * group". So asking a child that never started to stop asks the whole process group
 * to stop instead — and the caller is in that group.
 *
 * Measured 2026-08-06 (docs/known-issues.md #1). Every provider binary is absent on a
 * CI runner, so every spawn there fails, and the first cleanup that signalled one of
 * those children took the runner agent down with it. The job reported
 * "The runner has received a shutdown signal" and cancelled, with no failed assertion
 * anywhere and the selftest printing PASS on its way out. It ran green on the
 * maintainer's machine for the same reason it failed on CI: there the binaries exist,
 * so the spawns succeed and the pid is real. Windows never saw it — it has no POSIX
 * process group to signal.
 *
 * The exit checks come from the Windows fix of 2026-08-05: signalling a child that has
 * already exited is ignored on POSIX and throws EINVAL on Windows, and it took a whole
 * shutdown with it. Stopping something already stopped is the outcome we wanted anyway.
 *
 * @returns {boolean} true only when a signal was actually delivered to a real child
 */
function signalChild(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return false;
  if (child.exitCode != null || child.signalCode != null) return false;
  try { return child.kill(signal); } catch (_) { return false; }
}

/**
 * The same hazard, one layer up: a pid read from a file. `Number('')` is 0, and an
 * empty or half-written pid file is ordinary — so the guard has to be on the value,
 * not on whether the read threw.
 */
function signalPid(pid, signal = 'SIGTERM') {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  try { process.kill(target, signal); return true; } catch (_) { return false; }
}

module.exports = { signalChild, signalPid };
