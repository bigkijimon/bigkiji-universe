# Run ledger — what BigKiji actually did, in English

Read this when you are asked to improve the prompts BigKiji generates.

Each entry is one run: the prompt exactly as it was given, what actually shipped, the
**gap** between the two, what broke, how it was fixed, and what that implies for the
next prompt.

**Why the gap line matters.** A run is marked COMPLETED when every assignment finishes.
That is not the same as delivering what was asked — a run can cleanly produce the wrong
thing. `quality.checks` only asks "did the assignments complete" and "was there an
independent read-only checker". Nobody checks the order against the goods. That is what
the Gap line is for.

**How to use it.** Group the "Prompt lesson" lines, find the ones that repeat, and
propose a change to the role instructions in
`src/domain/pi-agent/core-execution-coordinator.js` (ROLE_BLUEPRINT) or to the front
desk prompt. Put proposals in `docs/v3/prompt-improvements.md`. **Do not edit
ROLE_BLUEPRINT without the owner** — those five roles and their providers were each
decided for a reason recorded in the comments there.

`bigkiji ledger --gaps` aggregates the repeats for you.

Newest first. Full machine-readable detail, one JSON object per line, same folder:
`run-ledger.jsonl` (gitignored — it is on disk, it is just not worth a diff).

---

## run-msioj7re-24ea4df6c829a0d7 · 2026-08-07T08:25:14.089Z · COMPLETED

**Prompt as given (verbatim):**
> BigKijiが主役の簡単な3Dシューティングゲームをつくって。

**Prompt (en):** Create a simple 3D shooting game with BigKiji as the main character.
**Acceptance as given:** BigKijiを操作できる · 移動、照準、射撃が動作する · 敵、スコア、体力、再スタートがある · デスクトップとタッチ入力に対応する · 保存した変更がオーナー画面へ反映される · 実行時JavaScriptエラーがない
**Issued to:** leader/claude-code:claude-opus-5 · ui/codex:gpt-5.6-sol · debug/glm:glm-4.7-flash

**Delivered:** leader completed · ui completed · debug completed

**Gap (asked vs delivered):** (cannot tell from this run record — no file changes were captured, so there is nothing to compare the request against)

**Prompt lesson:** (no lesson — delivered as asked)

