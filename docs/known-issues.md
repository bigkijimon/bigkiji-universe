# Known issues

Measured from run logs, not inferred. Kept here rather than hidden, because until
2026-08-05 CI had been red since 2026-08-02 for an unrelated reason (`npm ci`
refused an out-of-sync lock file) and nothing off macOS was being checked at all.

`npm test` is 62 selftests, 0 failures, exit 0 on the maintainer's macOS machine.

## 1. Linux and macOS runners are shut down mid-suite

Both die inside `test:daemon`, at 33s (ubuntu) and 46s (macOS):

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
| ubuntu-latest | Passes when the runner is not shut down mid-run |
| electron-smoke | Passing |
| macos-latest | Same shutdown as ubuntu |
| windows-latest | Reaches teardown, then the libuv assertion |
