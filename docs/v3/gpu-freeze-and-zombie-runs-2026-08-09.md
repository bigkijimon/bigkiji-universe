# 2026-08-09 — why the conversation and the agent's work did not line up

Written for the next agent asked "BigKiji is answering nonsense, find out why".
Everything below is measured on the owner's machine on 2026-08-09; nothing here is inferred.

This file is in the repository, not in `~/BigKijiUniverse/knowledge/`, for the same reason
the run ledger is: the global `~/.pi/agent/sandbox.json` denies `/Users` wholesale and its
`allowRead` holes are `.`, this repository, `~/.config`, `~/.local`, `~/.cache`, `~/Library`.
A pi agent cannot read the data folder. If this is ever "tidied" into `knowledge/` it will
still be written and never read again.

---

## The symptom

The owner started the CLI at 10:24, asked two questions, got two replies that answered
neither, and wrote 「指示が通ってないかも。」

They were right, and there were **three separate faults** behind it. None of them was the
conversation model being bad at conversation.

## What the logs actually said

`~/BigKijiUniverse/sessions/session-msl4e80l-d5dd9d.jsonl` — the whole session, 4 lines:

```
01:24:47Z  owner      多分いま全部の課金APIトークンの制限が解除されてると思うから…
01:24:55Z  assistant  （ローカルモデルが応答しませんでした。以下は定型の下書きです）…
                      provider "deterministic-local", latencyMs 8012
01:25:18Z  owner      指示が通ってないかも。
01:25:26Z  assistant  （ローカルモデルが応答しませんでした…）
                      provider "deterministic-local", latencyMs 8007
```

8012 ms and 8007 ms are `ConversationEngine`'s 8 s stall deadline to the millisecond. No
`run`, no `task`, no `idea` — the session contains nothing but those four lines.

## A — the local model was stopped, and the app had never heard of the thing that stops it

```
$ cat /tmp/bigkiji_gpu.lock
u09-final 10:05:45

$ ps -Ao pid,stat,comm | grep -E 'ollama|llama-server'
 1190 T   /Applications/Ollama.app/Contents/Resources/ollama
75226 T   /Applications/Ollama.app/Contents/Resources/llama-server

$ ollama list
(no output after 120 s — the connection is accepted by a stopped process)
```

`T` is **stopped by a signal**. `gpu-signal.sh` (`Executive_Office/経営企画室`) takes the
card for a generation job and SIGSTOPs Ollama; `~/.bigkiji/ollama-watchdog.sh:19` then
refuses to thaw for as long as `/tmp/bigkiji_gpu.lock` exists. The holder was the owner's
own LTX video job (`python3 u09-h3.py`, pid 92986), started 10:05 — nineteen minutes before
they opened the CLI.

**The decisive fact:** `grep -rn 'bigkiji_gpu.lock\|gpu-signal' src tools` returned nothing.
The application had no idea any of this existed. It saw a socket that accepted a connection
and never answered, waited 8 s, and served a template that reads like a considered reply.

Fixed by `src/domain/pi-agent/gpu-lock.js` (new): reads the lock and the process state and
returns one sentence naming the job and the time. `conversation-engine.js` puts that sentence
where the "it did not answer" line used to be, and sets `gpuFrozen` on the turn.
`src/cli/tui/footer.js` draws `degraded` in the status row — the daemon had been publishing
that flag on every turn since the engine could fall back, and no surface in the CLI read it.

**It only reads.** Un-freezing the GPU underneath a running render would be a worse bug
than the one it fixes.

## B — a run from three days earlier was still "in progress"

```
run-mshw0qbn-50f26de5111adc5a
  started    2026-08-06T19:07:03Z    budget 30 min
  status     DIAGNOSING              1 of 3 assignments done, none running
  checkpoint every 10 minutes, still going at 2026-08-09T01:37Z
  overdue    3260 minutes (54 hours)
  groundwork failures: Model "ollama/qwen3.5:35b-a3b" not found
                       gemini — quota exhausted
```

Two of its three lenses had failed *at dispatch*, so no assignment would ever change state
again. `_reportProgress` is deliberately not a guillotine — the owner's decision on
2026-08-03 was "期限で区切って途中経過を出す", and that is still right — but it had no way
to notice there was nothing left to report on. `expireStaleApprovals` did not cover it
(wrong status) and would not have run anyway: it is only called from `submit()`, so it
only sweeps when the owner starts something new.

Fixed by `expireStalledRuns()` and `_failStalled()` in `core-execution-coordinator.js`,
plus a 60 s sweep in `daemon.js`. A run with anything `running`, `dispatching` or
`executing` is never touched — slow work keeps reporting forever, exactly as before.

## C — that run was erasing the company's memory

`knowledge.recordEvent` keeps the last 300 events. On 2026-08-09 `task_state.json` held:

```
events 300 total
  run-checkpoint   244   ← 81%, all from run-mshw0qbn
  everything else   56
  oldest event     2026-08-07T08:58Z   ← everything before this was evicted
```

Consecutive checkpoints from the same run now collapse into one entry carrying `repeat`
and `firstAt`. Nothing is lost: the count and the duration are the only information those
244 rows contained.

Separately, `createTask` wrote `status: 'planned'` and nothing could ever write it again —
81 records, all reading `planned`, including plans for work that had finished days earlier
and one for a run that failed at dispatch. `recordTaskOutcome()` now writes the ending.

## D — and the screen contradicted itself while all of the above was happening

`DIAGNOSING` was in neither `facts()` nor `statusFacts()`, and `facts()` was also missing
`DISPATCHING` that `statusFacts()` had. Three hand-written copies of "which statuses count
as active", three different answers. So the CLI's phase row showed `DIAGNOSING` while
`/status` and the conversation model were both told **"runs in progress: 0"** — about the
same run.

There is now one `ACTIVE_RUN` exported from the coordinator that sets those statuses, and
`tools/stalled-run-selftest.js` asserts the daemon imports it rather than keeping a copy.

## E — 1,446 worktrees, 35 GB, and the owner's own edits reported as a provider's

Found the same day, in the same repository, by measuring before moving it.

```
app/.bigkiji/worktrees   1,446 directories, 35 GB      git worktree list: 1,447 lines
created                  Aug4:190  Aug5:496  Aug6:493  Aug7:182  Aug9:85
app/                     36 GB   →  612 MB after cleanup
CEOBigKiji (Vault)       67 GB   →  32 GB
```

**Mechanism.** `isolate()` carries the repository's uncommitted work into each worktree
(`git diff HEAD --binary`, worktree.js) so the provider does not start from a state nobody
is looking at. That is correct. But `collectDiff()` then measured from **HEAD**, so the
carried patch counted as the provider's output: `files` was non-zero the instant a worktree
existed, and `release({keep: diff.files > 0})` kept every single one. Not one was ever
deleted in five days.

Proof it was the carried patch and not anyone's work: three sampled worktrees produced
**byte-identical diffs** (`cc8911c8a012`), same eleven files. Across all 1,446 there were
only **109 distinct contents**, 129 of them completely empty. Archived as patches, the
whole 35 GB came to **2.8 MB** — `~/BigKijiUniverse/reports/worktree-archive-2026-08-09/`
(`index.json` maps every one of the 1,446 names to its content hash).

**The second bug in the same line.** Because the baseline was wrong, the run report showed
the owner *their own uncommitted edits* as changes a paid provider had made.

**Fix.** `isolate()` records a baseline with `git write-tree` — a tree object, no commit,
no ref, nothing moved, which is what lets it coexist with the selftest that forbids this
module from running any porcelain command that could combine or relocate work.
`collectDiff()` measures against that tree. Both problems end at once.

**Two things this cost while being found**, recorded because the next person will hit them:

- 85 of the 1,446 were created by `npm test` itself — daemon-selftest runs a real
  DaemonEngine with `workspace: process.cwd()`. Fixed with `BIGKIJI_WORKTREE_ROOT`.
- Pointing that variable at `os.tmpdir()` looks obviously right and **breaks the whole
  suite**: `SandboxPolicyResolver` refuses any cwd outside the Vault, so every task came
  back `SECURITY_BLOCKED`. It must relocate *within* the repo — `.bigkiji/test-worktrees`.
  worktree.js already warned about this in a comment; it was read too late.

### …and it was being shipped inside the product

`BIGKIJI/dist/mac-arm64/BigKiji Universe.app` was **12 GB**, built 2026-08-05. Of that,
**11.94 GB was `Contents/Resources/app/.bigkiji`** — the leaked worktrees, packaged into
the application. Everything that is actually the app came to about 56 MB.

`build.files` began with `**/*` and excluded `.env`, `recordings`, `graphify-out`, backups,
`fixtures`, `__pycache__` and the console source — but nothing excluded the working
directory. `!.bigkiji/**` added, plus `!docs/v3/run-ledger.*`: the ledger records the
owner's prompts verbatim and **this repository is published**
(`git@github.com:bigkijimon/bigkiji-universe.git`, with LICENSE / CONTRIBUTING / FUNDING).

`tools/worktree-selftest.js` now asserts both exclusions.

Running total for the day: **CEOBigKiji 67 GB → 20 GB**, with nothing lost —
35 GB of worktrees (archived to 2.8 MB of patches) and 12 GB of rebuildable output.

## F — a TASK only becomes a run if BigKiji has planned that exact sentence before

Found while isolating the test suite from the owner's real memory, which is the only reason
it was visible at all.

`FastFacilitatorRouter.facilitate()` opens with `knowledge.findPlan(text)`
(`fast-api-router.js:121`). On a cache hit it returns a ready spec and `daemon.js` submits
the run. On a miss it asks a model, and a model that asks anything back yields
`status: 'needs_clarification'` — at which point daemon.js holds the run and asks the
owner a question instead of starting.

Measured, same input, everything else identical:

| `task_state.json` contents | `a TASK turn submits a run` |
|---|---|
| the owner's real file (79 cached plans) | **passes** |
| same file with `plans: []` | **fails** — no run |
| only `tasks` / `events` / `ideas` kept | fails |

So `tools/paste-turn-selftest.js` had been passing on the owner's private plan cache for
months: point `BIGKIJI_KNOWLEDGE_ROOT` anywhere else and the assertion dies. It now stubs
the facilitator, because what that block tests is that one run is published once.

**The product question this exposes is the owner's actual complaint.** Combined with the
14-word `heuristicKind` gate, a request has to clear two doors to become work: the right
verb, *and* a plan already in the cache. A first-time request that clears the first door
still stops at a question. That is deliberate — a plan built on a guess is what the owner
kept rejecting — but nothing on screen says "I am asking instead of starting", and the
question itself is only registered on TASK turns (see the daemon.js:665 note above).

## Still open — the 8 s stall deadline has almost no margin

Measured immediately after the render finished and the watchdog thawed Ollama
(2026-08-09 11:20, same machine, `qwen3.5:latest`):

| | |
|---|---|
| cold load (`load_duration`) | **9.2 s** |
| first turn after the thaw | `deterministic-local`, 8036 ms — degraded |
| second turn (model warm) | `local-qwen`, ttft **7233 ms**, a real answer |
| `ConversationEngine.timeoutMs` | **8000 ms** |

So the first question after any render — or after the 60 s `keep_alive` window closes —
degrades even with the GPU free, because loading the weights costs more than the whole
deadline. And a warm turn came back 767 ms inside it. `timeoutMs` is a *stall* deadline
(silence between tokens), but a model that has not been loaded yet is silent for the load
too, so the load is charged against it.

Not fixed here — it is a different decision from the three faults above, and it is the
owner's: raise the deadline, exclude load time from it, or keep the model resident.
Recorded so the next person does not re-measure it.

---

## How to check any of this yourself

```bash
cat /tmp/bigkiji_gpu.lock                      # who holds the GPU, since when
ps -Ao pid,stat,comm | grep -E 'ollama|llama'  # T means SIGSTOPped, not busy
node -e "console.log(require('./src/domain/pi-agent/gpu-lock').freezeExplanation())"

# how many replies the model never served, in the newest session
ls -t ~/BigKijiUniverse/sessions/*.jsonl | head -1 | xargs grep -c deterministic-local

# runs the coordinator still thinks are alive
python3 -c "import json,collections; d=json.load(open('$HOME/BigKijiUniverse/knowledge/task_state.json')); print(collections.Counter(e['type'] for e in d['events']))"

npm run test:stalled-run
```

## Related

- `09-security.md` — the two sandbox layers and which one wins.
- `run-ledger.md` — the same "write it where a pi agent can read it" constraint, with the
  measurement that established it.
- `Executive_Office/knowledge/gpu-lock-freezes-ollama.md` — the company-wide operating rule
  that comes out of fault A, readable from every department's pi.
