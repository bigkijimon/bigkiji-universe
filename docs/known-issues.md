# Known issues

Measured from run logs, not inferred. Kept here rather than hidden, because until
2026-08-05 CI had been red since 2026-08-02 for an unrelated reason (`npm ci`
refused an out-of-sync lock file) and nothing off macOS was being checked at all.

`npm test` is 63 selftests, 0 failures, exit 0 on macOS, Linux and Windows.

## 1. Linux and macOS runners were shut down mid-suite — **fixed, 2026-08-06**

**The suite was killing the runner.** Asking a child process that never started to
stop asks the entire process group to stop instead, and on a hosted runner that group
contains the agent running the job.

Before the fix, across 12 consecutive runs on `main`:

| Runner | `npm test` outcome |
|---|---|
| ubuntu-latest | **succeeded 5 times**, cancelled 7 |
| macos-latest | cancelled **12 times out of 12** |
| windows-latest | always ran to completion (and then hit problem 2) |

It always died inside `test:daemon`, and the selftest always printed PASS on its way
out, with no failed assertion anywhere:

```
##[error]The runner has received a shutdown signal. This can happen when the
runner service is stopped, or a manually started runner is canceled.
daemon selftest: PASS · ...
[selftest] 4.3s SIGTERM received · rss=197MB
##[error]The operation was canceled.
```

### The cause

`ChildProcess.kill()` looks like it checks whether there is a process to signal. It
does not. A child whose spawn failed has `pid === undefined`, and `kill()` still hands
libuv a handle whose pid is `0` — and POSIX defines `kill(0, sig)` as *every process in
my process group*.

Every provider binary (`pi`, `gemini`, `ollama`, `graphify`) is absent on a CI runner,
so every spawn there fails. The first cleanup that signalled one of those children
signalled the runner agent with it.

That accounts for every part of the shape this had:

- **Green on the maintainer's machine, red on CI.** The binaries exist locally, so the
  spawns succeed, the pid is real, and only the child is signalled.
- **Windows never affected.** It has no POSIX process group to signal — which is why
  the platform carrying six real defects (problem 2) was also the only one finishing.
- **Intermittent on Linux, certain on macOS.** It is a race between the ENOENT error
  clearing the handle and the cleanup path reaching it, and the macOS runners are
  slower (3 cores, 7GB, against 4 and 16).
- **The runner's message arriving *before* the test's own.** One SIGTERM reached both
  at the same instant; the test could not run its JS handler until the event loop it
  was blocking came free, 94ms later.

### The fix

`src/core/child-signal.js` — `signalChild()` refuses a child with no pid, and
`signalPid()` refuses a pid that is not a positive integer, which is the same hazard
one layer up: `Number('')` is `0`, so an empty pid file asked the daemon to stop and
stopped the process group instead (`src/core/main.js`). Five call sites that each had
their own version now use it.

`npm run test:child-signal` is the regression test. It cannot demonstrate the defect
by firing it — doing so kills whatever is running the suite, which it did the first
time it was written — so it proves the property from the victim's side: a sibling in
the same process group must survive, this process must not receive the signal, and a
real child must still stop.

### Measured, before and after

| | ubuntu | macOS | windows |
|---|---|---|---|
| Before (12 runs on `main`) | 5/12 green | **0/12** | 12/12 |
| After (5 consecutive reruns of `9ada81a`) | **5/5** | **5/5** | **5/5** |

### What was ruled out on the way, and what the wrong guess cost

- Not matrix `fail-fast` (`false`), not `concurrency: cancel-in-progress` (`false`,
  with no other run in flight), not Actions minutes (it outlived the repo going public).
- Not resource exhaustion: at the moment of the kill, fds peaked at **22** against a
  limit of **1048575**, and rss at **206MB** of **7GB**.
- Not the network: no socket ever left the loopback interface.
- Not an external event hitting the runner pool: in one run the two macOS jobs died
  **33 seconds apart**, each while running the daemon selftest.

This file previously said *"The daemon selftest starts a real detached daemon … A
detached child holding the runner's process group or stdio is the thread to pull
first."* That was wrong, and it was wrong in a way worth remembering: the selftest
starts its daemon **in-process** (`startDaemon({ bind: '127.0.0.1', port: 0 })`) and
contains no `spawn` at all. The word "detached" came from `daemon-client.js`, a path
the test never takes. The hypothesis was about the right subsystem and the wrong
mechanism, and following it would have found nothing — the actual children came from
the engine, transitively, and were named only once the instrumentation printed them.

## 2. Windows — **fixed, 2026-08-06**

Windows now runs all 63 selftests green. Getting there took six defects, every one
of them invisible while the suite could not run anywhere but macOS:

| What broke | Why only Windows |
|---|---|
| `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | `startDaemon`'s `close` also called `process.exit`, so the tests hand-rolled a partial teardown and exited over a closing handle. POSIX tolerates that |
| Sandbox refused every read inside itself | Roots resolved with `fs.realpathSync`, targets with `fs.realpathSync.native` — only the native one expands 8.3 short names |
| `EINVAL` aborting a task | Signalling an already-exited child throws on Windows and is ignored on POSIX |
| Worktrees not found again | `listAbandoned` returned git's spelling (forward slashes) while everything else is natively resolved |
| Permission assertions | Windows has no POSIX mode bits; `fs.stat` reports a fixed value from the read-only flag |
| Fixtures written as POSIX literals | `'/tmp/ComfyUI'` resolves to `D:\tmp\ComfyUI`; a `#!/bin/sh` script is not executable; a fake file list must be joined the way the code joins |

Two of those — the sandbox comparison and the `EINVAL` — were real product defects
rather than test problems. The sandbox one failed closed, so it was never a hole,
but the app could not read its own working directory on Windows.

Where a check genuinely cannot apply, it is skipped with the reason stated rather
than deleted. The credential-lending suite goes further: read-only lending is a
security property, so on Windows its summary line reads
`read-only NOT CHECKED (no POSIX modes on this platform)`. A green tick that
quietly stopped checking a security property would be worse than a red one.

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
| ubuntu-latest | **Green.** All 63 selftests pass |
| macos-latest | **Green.** All 63 selftests pass |
| windows-latest | **Green.** All 63 selftests pass |

Measured 2026-08-06: five consecutive reruns of the same commit, all six jobs green
every time. Before the fix in problem 1, macOS had never once finished the suite.

### How this was nearly filed as "not our bug"

Before the fix, this section concluded that the kill was *"a GitHub infrastructure
condition, not a defect here, and no further change to this code will fix it."* It is
worth keeping why that was wrong, because the reasoning was careful and still landed
in the wrong place.

The mechanism had already been guessed. This file used to say:

> nothing calls `process.kill(0, …)`, which would signal the whole process group
> including the runner and would have explained the message exactly.

That sentence names the cause and then dismisses it, because the search was for the
literal call. Nothing calls `process.kill(0, …)`. What the code calls is
`child.kill()` — which becomes `kill(0, …)` on its own, whenever the child never
started, without the digit appearing anywhere in this repository.

Two other things kept the answer out of reach:

- **The evidence pointed at the victim.** The runner's message is logged before the
  test's, so the test looked like collateral. It was — of one signal that hit both.
- **"It passes locally" was read as reassurance.** It was the clue. The suite passed
  on the one machine where the provider binaries exist, which is exactly the machine
  where the defect cannot fire.

What broke it open was measurement rather than reasoning: printing the open handles
by kind, and naming the child processes instead of counting them. The line
`ChildProcess×1 · children: undefined:pi --print` — a child with no pid, still being
held — is the whole bug, and no amount of reading the selftest would have produced it,
because the selftest contains no `spawn`. The children came from the engine it starts.

---

## A daemon run can read the whole home directory, including the pairing token

**Measured 2026-08-07 by `tools/sandbox-reachability-audit.js`.**

The OS-enforced boundary (`~/.pi/agent/sandbox.json`) grants `.` — the run's cwd — in
both `allowRead` and `allowWrite`. The daemon starts with `BIGKIJI_WORKSPACE=/Users/yuma`
and `daemon.js` hard-wires every run's cwd to it (`:229`, `:864`; there is no `cwd` field
on `/api/prompt`). So `.` resolves to the home directory and a pi agent in a daemon run
can read everything under it, `~/BigKijiUniverse/state/remote.json` included.

**Writes are closed.** `remote.json` is now in the global `denyWrite`, which is absolute
and never prompted — the same treatment as `.env`, `*.pem` and `*.key`.

**Reads are not, and cannot be from a config file.** `denyRead` is soft: `allowRead`
overrides it, and `.` is in `allowRead`. A project `.pi/sandbox.json` cannot help either,
because project files only ever ADD to the global.

### The fix, when someone can restart the daemon

Start it with a workspace that is not the home directory:

```
BIGKIJI_WORKSPACE=/Users/yuma/Documents/CEOBigKiji <start the daemon>
```

Then `.` resolves to the vault rather than to `$HOME`, and `~/BigKijiUniverse/` falls
outside every `allowRead` hole — which is also why the run ledger lives in `docs/v3/`
rather than in the data folder (see `run-ledger.js`).

This was not done at the time it was found: the daemon was holding a run that had been
stuck in DIAGNOSING for 13 hours, and that run may be the reproduction case for the
branch then in progress (`fix/session-never-progresses`). Restarting would have destroyed
it. Re-run the audit after any workspace change.
