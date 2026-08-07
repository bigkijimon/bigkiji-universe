# Prompt improvements — proposals, not changes

This is where a proposal to change the prompts BigKiji generates goes to be reviewed.
It is deliberately separate from the code: **nothing here is live until the owner moves
it.**

## Where to get the evidence

`docs/v3/run-ledger.md` — every finished run, in English: the prompt exactly as it was
given, what shipped, the gap between the two, and one line on what that implies for the
prompt. `bigkiji ledger --gaps` groups the repeats.

## What a proposal needs

A proposal with one example is an anecdote. Bring the count.

| | |
|---|---|
| **Pattern** | The lesson line, as it appears in the ledger |
| **How often** | The number from `bigkiji ledger --gaps`, and the run ids |
| **Where it lands** | The exact file and symbol — usually `ROLE_BLUEPRINT` in `src/domain/pi-agent/core-execution-coordinator.js`, or the front desk prompt |
| **Proposed wording** | The new text, in full. Not a description of it |
| **What would prove it worked** | Which ledger line should stop appearing |

## Rules

- **Do not edit `ROLE_BLUEPRINT` directly.** Each of those five roles, and the provider
  pinned to it, was decided for a reason written in the comments beside it — one of them
  records a role that silently never ran for weeks because its provider had a quota of
  zero. Changing them without reading those comments repeats that.
- **One pattern per proposal.** A proposal that changes four things cannot be judged.
- **Say what it costs.** Longer role prompts are paid for on every run, by every agent.
- A pattern seen **fewer than three times** is not yet a pattern. Leave it in the ledger
  and wait.

---

## Proposals

_(none yet — the ledger needs to accumulate first)_
