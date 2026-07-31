# BigKiji AI Organization Handbook

## Purpose

Keep work moving through model fallback and role delegation without confusing a
claim of completion for verified evidence. System messages, logs, and contracts
are in English. Owner replies follow the owner's input language.

## Evidence from the 2026-07-31 audit

- Role sandboxes for Executive Office, English School, LocalAI, Design Studio,
  Creative Media, and Influencer Studio allowed an in-scope write and denied an
  out-of-scope write at the operating-system boundary.
- A subagent encountered both a Gemini 429 quota response and an unavailable
  model response. Those are provider failures, not task success or failure.
- Several role reports were prose-only. A result therefore requires an
  independent evidence check before it can be marked verified.

Run `node tools/delegation-audit.js` to inventory all retained subagent output
artifacts without modifying them.

## Operating protocol

1. **Maker** receives the owner task plus a five-part contract: purpose,
   authoritative source, deliverable path, verification method, and final
   report format.
2. **D1 continuity** stores a compact task/result/next-action snapshot outside
   the model context. A later instruction containing `continue`, `resume`,
   `続き`, `継続`, or `再開` restores only that summary.
3. **Checker** is automatically queued after a substantive Maker task. It is
   read-only: it may inspect files and run safe verification commands, but may
   not edit, publish, spend money, or change configuration.
4. A task is **verified** only when the Checker returns evidence. Tool errors,
   missing verification, and owner decisions remain explicit residual risks.

## Guardrails

- No secret values are included in prompts, state snapshots, or reports.
- External publication, spending, and destructive operations remain owner
  approval gates.
- Provider quota and unavailable-model errors degrade to the next available
  model tier; they do not bypass the Checker.
