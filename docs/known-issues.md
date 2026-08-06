# Known issues

Measured from run logs, not inferred. Kept here rather than hidden, because until
2026-08-05 CI had been red since 2026-08-02 for an unrelated reason (`npm ci`
refused an out-of-sync lock file) and nothing off macOS was being checked at all.

`npm test` is 62 selftests, 0 failures, exit 0 on the maintainer's macOS machine.

## 1. Linux and macOS runners are shut down mid-suite — intermittently

Across 12 consecutive runs on `main`:

| Runner | `npm test` outcome |
|---|---|
| ubuntu-latest | **succeeded 5 times**, cancelled 7 |
| macos-latest | cancelled **12 times out of 12** |
| windows-latest | always ran to completion (and then hit problem 2) |

So the suite *can* pass on Linux — this is not a test that is simply broken, and
not a regression from any one commit. It is intermittent, and macOS has never once
got through. When it does die, it dies inside `test:daemon`, at 33-42s:

```
> node tools/daemon-selftest.js
[BIGKIJI DAEMON READY] http://127.0.0.1:0
##[error]The runner has received a shutdown signal. This can happen when the
runner service is stopped, or a manually started runner is canceled.
daemon selftest: PASS · ...
##[error]The operation was canceled.
Cleaning up orphan processes
```

The selftest itself passes — the signal arrives while it is running. Windows gets
past this point in the same run, so it is not the assertions.

Ruled out by measurement:

- Not matrix `fail-fast`; it is `false`.
- Not `concurrency: cancel-in-progress`; identical with it `false` and no other
  run in flight.
- Not the repository being private and out of Actions minutes; it persists after
  the repository was made public.

The daemon selftest starts a real detached daemon, and "Cleaning up orphan
processes" appears in the same log. A detached child holding the runner's process
group or stdio is the thread to pull first.

## 2. Windows crashes at teardown

Windows gets further, then aborts inside libuv after `test:assets` passes:

```
assets route selftest: PASS · ...
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

A handle closed twice during shutdown. POSIX tolerates it; Windows asserts.
Until this is closed, treat Windows as unsupported.

## Fixed on the way here

All real, all invisible while CI was red, all now covered by a test:

- The sandbox compared 8.3 short names against natively-expanded ones, so every
  read inside the sandbox was refused on Windows (`SECURITY_PATH_OUTSIDE_READ`).
  It failed closed, so it was never a hole — but the app could not read its own
  working directory. Both sides now canonicalise through one function, pinned by
  a source-level assertion in the security selftest.
- Aborting a task whose child had already exited threw `EINVAL` on Windows and
  took daemon shutdown with it.
- `listAbandoned` returned git's spelling of a path — forward slashes, even on
  Windows — while everything it is compared against is natively resolved, so a
  worktree left behind by a crashed run would not have been found again.
- `npm ci` refused an out-of-sync `package-lock.json`. This was the original red,
  and it hid everything above.
- The Electron smoke job could not start Chromium's SUID sandbox, and then could
  not get a WebGL context on a GPU-less runner. Both fixed without `--no-sandbox`,
  which would have gone green while proving less.

## Status by runner

| Runner | State |
|---|---|
| electron-smoke | Passing |
| ubuntu-latest | Passed once; otherwise shut down mid-run during `test:daemon` |
| macos-latest | Same shutdown as ubuntu, at a similar elapsed time |
| windows-latest | Runs the whole suite, then the libuv assertion at teardown |

Timings from one run, which is the clearest evidence of the shape of problem 1:

```
electron-smoke        17:56:25 → 17:56:54   success
test (ubuntu-latest)  17:56:24 → 17:57:00   killed at 36s, inside test:daemon
test (macos-latest)   17:56:24 → 17:57:06   killed at 42s, inside test:daemon
test (windows-latest) 17:56:24 → 18:00:00   ran 3m36s, reached teardown
```

The Electron job on the same infrastructure finishes normally, so this is not the
runner being generally unhealthy, and Windows gets past the same test.

Checked and ruled out while narrowing it:

- The selftest spawns nothing detached — it calls `startDaemon` in-process and
  closes the server and engine at the end.
- The only place in the codebase that signals a pid read from a file
  (`src/core/main.js`) fires solely after a daemon answers on the expected port,
  and is not on this path. In particular nothing calls `process.kill(0, …)`,
  which would signal the whole process group including the runner and would have
  explained the message exactly.
- Not a regression: ubuntu succeeded both before and after every candidate commit.

What is left points at the environment rather than the code — a resource ceiling
or a preemption that `test:daemon` is simply the longest-running thing to be
sitting in when it arrives. Confirming that needs instrumentation inside the job
(signal handlers and a heartbeat) rather than more guesses from outside.
