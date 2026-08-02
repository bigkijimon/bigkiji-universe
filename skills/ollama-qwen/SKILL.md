---
name: ollama-qwen
description: The execution arm (Executor) of token-saver. token-saver is the canon for token-saving policy; this skill takes that policy and is the actual procedure for throwing mechanical code rewriting and bulk text processing at a local LLM (qwen3.5 etc.) on Ollama at port 11434. Claude does design and review (Architect), Qwen does the heavy lifting (Executor). Started manually with 「Qwenに投げて」「ローカルLLMで」「ollama」 (/ollama-qwen). Not for calling the Claude API or cloud models, nor for code where quality matters most.
disable-model-invocation: true
allowed-tools: Bash(ollama *), Bash(curl *)
---

> Translated from the owner's Japanese original at `~/.claude/skills/ollama-qwen/SKILL.md`. The Japanese file remains the source of truth.

# 💻 Ollama QwenCoder Offloading (:11434)

- Models: **`qwen3.5:latest`** (6.6GB, light and fast, supports vision/tools. The default for simple work) / `qwen3.6:latest` (23GB, for heavy work) / `qwen3.6-uncensored-cc:latest` (21GB, the same body as `lama`)
  - Note: in the big clean-out of 2026-07-17, `qwen3-coder-next`(45GB) was deleted. Reason: its architecture was the previous generation (qwen3next), its quantization was coarse (Q4_K_S) and it had no thinking support, so it was inferior across the board to the current `qwen3.6`(qwen35moe/Q4_K_M/with thinking) while eating 2× the disk space. `qwen32b-long`/`gemma3:27b`/`nomic-embed-text`/`bge-m3` were also deleted as unused (60GB freed in total).
  - Note: **hitting this skill directly (`/api/generate`) returns in 1〜2 seconds**. `lama`, which goes through Claude Code, takes about 53 seconds because of a minimum 26,500-token prefill, so **for simple work this route is overwhelmingly faster** (measured 2026-07-17).
  - Note: **the brain of head office (CEO BigKiji) = the combination of "API Claude Code (cloud) + Local API (local)"**. The Ollama (:11434) in this skill is the actual body of that **Local API side** = the mouth you hit to reach the Executor (local LLM = heavy lifting) that pairs with the Architect (Claude Code API = design/review). Ollama is not head office. The models installed change with the environment, so **confirm what actually exists with `ollama list` before naming one** (if it is stopped, run `open -a Ollama` first). The model names in memory `localai-lama-sibling-company` (Gemma4/Qwen MoE, LTX-2) are **the configuration on the sister company LocalAI_lama's side** (a separate company that runs fully locally when the cloud API is unavailable), so do not copy them over here. Details = memory `company-brain-architecture`
- Division of labour: Claude = Architect (requirements, chunking, review, integration) / Qwen = Executor (mechanical bulk processing)

Procedure:
1. Check it is up: `curl -s http://127.0.0.1:11434/api/version`. If it is down, `open -a Ollama`
2. Split the task into chunks (1 chunk = a unit that fits in Qwen's context; rule of thumb, 3,000 lines or fewer)
3. Generate:
   ```
   curl -s http://127.0.0.1:11434/api/generate \
     -d '{"model":"qwen3.5:latest","prompt":"<指示>","stream":false}'
   ```
   (The block is byte-identical to the Japanese original; the prompt field holds your instruction.)
   **`"stream": false` is required** (so you get stable text back in one piece)
4. Claude must always review the output (bugs, conventions, security) before it is adopted

Caution: do not put Qwen's output into production code unverified. Where quality is required, Claude writes it itself (correctness beats saving cost)

## 🔌 Full local mode (fully revised 2026-07-11; the only method confirmed by measurement)
**The only method that works = connecting straight to ollama's Anthropic-compatible API (/v1/messages)**:
```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
ANTHROPIC_AUTH_TOKEN=ollama-local \
ANTHROPIC_SMALL_FAST_MODEL=qwen3.6-uncensored-cc:latest \
claude --model qwen3.6-uncensored-cc:latest [-p "…"]
```
This is what `lama` (.zshrc) actually is. **There are constraints on which model you can pick (measured 2026-07-17)**:
- Claude Code sends to `/v1/messages?beta=true` **with a system role (system-reminder) appended at the end**
- A model that has Ollama's own renderer (`RENDERER/PARSER qwen3.5`) accepts that, but
  a model without one falls through to the Jinja template baked into the GGUF and returns **400** with `raise_exception('System message must be at the beginning.')`
- ✅ Works: `qwen3.6-uncensored-cc` (a derivative with RENDERER declared) / `qwen3.6` / `qwen3.5` (all measured 200 OK on 2026-07-17)
- ❌ Does not work: `qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive` (a plain unofficial GGUF = always dies with 400)
- Whenever you install a new model, **always** post `messages:[user, system]` to `curl "…/v1/messages?beta=true"` and confirm a 200 before using it
Wrapper already implemented: `~/.local/bin/bigkiji_run_session.sh <mode>` (for the daily blog runs; the model is switched in model.conf)
- **⚠️ All of the following are traps that "silently fall back to the cloud" (measured 2026-07-11; a real incident that burned API budget)**:
  - `claude --model ollama/qwen32b-long` (either an error, or quietly the cloud)
  - `CLAUDE_CODE_SETTINGS_OVERRIDE='{"model":"ollama/…"}'` (you get a reply, but it is the cloud)
  - `"model": "ollama/…"` in `settings.local.json` (same)
  - `/model ollama/…` inside a session is likely the same → always run the verification below
- **The rule of verification (code of conduct 9): the only evidence for the claim "it ran locally" is an increase in `POST /v1/messages` in `~/.ollama/logs/server.log`.** The fact that a reply came back is not evidence
- Prerequisites: Ollama running (:11434), `qwen3.6-uncensored-cc` (num_ctx 131072 baked in). **Rule of thumb: `lama` takes about 53 seconds per call** (measured 2026-07-17; about 51 seconds of that is prefill, because Claude Code sends at least 26,500 tokens. The generation itself is fast at 59 tok/s)
- ⚠️ **Multi-stage agent pipelines are a bad fit for local** (measured 2026-07-17). The prompt cache only works inside a subagent, so you pay the full prefill again every time you cross an agent boundary. The tech blog run (14 agents launched) was still not finished after 31 minutes = running on the cloud (`BLOG_MODEL=` empty) is the right answer. Local's winning move is not speed but **zero API billing**, so use it for one-off jobs
- ⚠️ Do not write `"model"` back into settings.local.json (the lesson from 2026-07-10 still applies)
