---
name: token-saver
description: A high-compression mode that saves the token consumption of replies and of the work itself to the absolute limit (also known as: LostTokenSkiller). It drops greetings, preambles and re-quoting whole files of code, and answers immediately, with summaries and bullet points. It also governs how much is read, how many agents are launched, and how often things are retried. Use it when the user says 「トークン節約」「簡潔に答えて」「圧縮モード」「token-saver」, or when it is started manually with /token-saver. Not for situations that call for a polite explanation or an educational commentary.
disable-model-invocation: true
---

> Translated from the owner's Japanese original at `~/.claude/skills/token-saver/SKILL.md`. The Japanese file remains the source of truth.

# ⏱️ Token-Saver (LostTokenSkiller) v3

> Role map: **this skill is the canon for token-saving policy**. The execution procedure for throwing the heavy lifting at a local model is [[ollama-qwen]]. Arbitrating GPU contention is a separate skill, gpu-mem-switch (nothing to do with saving).

## 0. What is being saved = the billed LLM only; the real target is model choice (highest priority)
- **The only thing to be saved is tokens on the billed LLM (Claude Code and other cloud).** Local AI (Ollama/Qwen) is billed at zero = use it to the full without worrying about volume.
- So the first move with high-volume mechanical work (drafting, conversion, aggregation, bulk processing) is to **offload it to local without hesitating** (the procedure is §6 and [[ollama-qwen]]).
- **Token volume and cost are different things.** On the billed side, the first thing to cut is not the volume but the **model (the unit price)**. Measured, 91% of the cost came off from changing the model and 9% from consolidation ($41.68→$5.12, [[blog-token-cost-decomposition]]).
- A higher model only where quality is needed; a cheap model or local for mechanical work. Design goes to Fable ([[design-changes-use-fable5]]).
- A cache **write** is **12.5× more expensive than a read** (3.75 vs 0.30 /M). A write (a re-prefill) happens every time you cross an agent boundary = consolidating makes it disappear. But reads accumulate as turns × context and consolidation actually increases them = **the effect of consolidation is limited** (the real worth of consolidation is traceability, not cost).

## 1. Cut the output
- No greetings, no preamble, no boilerplate closing lines. Answer with the conclusion on the first line
- Show only the changed lines of code (re-quoting the whole thing is forbidden). Write long deliverables to a file and put only the path plus a 3-line summary in the conversation
- Prefer bullet points, one line per item. Tables only when a comparison is needed. Do not overuse decorative headings

## 2. Cut how much you read (the input side is the biggest source of waste)
- Do not read a file in full: locate the lines with grep first → then Read only that part with offset/limit
- Do not re-read a file you have already read, or re-confirm a fact you have already confirmed
- Put independent tool calls in one message and run them in parallel (the number of round trips = the number of times the context is re-sent)
- Narrow huge logs with tail/head. Do not paste screenshots or full dumps into the conversation

## 3. Govern the sub-agents (revised 2026-07-10 on the assumption of Fable 5)
- Delegating independent sub-tasks in parallel is what Fable 5 is good at = do not forbid it. Cut the waste instead (in line with the company constitution's cost rule)
- Do not do the same investigation twice, in the main session and in an agent (once you have delegated, wait)
- Do not bring every result back to main (have it return only the key points; have it write the deliverable to a file and take the path)
- For an agent doing mechanical work, specify a lightweight model (haiku etc.) plus low effort
- An agent that died mid-way is resumed with SendMessage, not launched anew (do not rebuild the context)

## 4. Extend the life of the session
- When the conversation gets long, suggest /compact. Before a big job, cut the topics you do not need
- For work that crosses sessions, leave a "handoff note" (current state, remaining tasks, paths) in a file, so the next session resumes with zero re-reading

## 5. Exceptions (they take priority over saving; omitting them is forbidden)
- Factual accuracy / safety confirmation (approval for publishing, sending, billing, deleting) / reporting what the error actually said / verification (a build and a check of real behaviour before you say it is done)
- **Readability of the final report**: the report at the end of a turn is the one thing written in complete sentences (do not compress it into fragments, chains of arrows or invented abbreviations). What gets compressed is the intermediate progress and the working notes between tools (the Fable 5 guide: readability > brevity)

## 6. Local offloading = the main force of saving (2026-07-11; the renderer caveat added 07-17)
- Local is free, so offload mechanical work aggressively. **This is where the reduction in billed tokens bites hardest.** High-volume mechanical work (drafting, conversion, aggregation) goes to local Qwen.
- **[[ollama-qwen]] is the canon for how to start it correctly** (only the method that connects ANTHROPIC_BASE_URL directly works. `--model ollama/…` and the like go quietly to the cloud = the trap where you think you saved and actually wasted)
- For a new local model, **always confirm a 200 before you use it** (`/v1/messages?beta=true`). An unofficial GGUF has no renderer support and returns 400 = it goes quietly to the cloud = what you thought you had offloaded comes back as billing and the saving backfires ([[ollama-claude-code-renderer-requirement]]).
- The only evidence that it ran locally is an increase in `POST /v1/messages` in ~/.ollama/logs/server.log

## 7. Cut the weight of the first load and of MCP (added 2026-07-21, a lesson from measurement)
- **Do not register an MCP with `npx -y <pkg>`.** It resolves on a cold start every session = startup is slow. `npm i -g` it and register it by the **absolute path of the fixed binary** (e.g. `~/.npm-global/bin/n8n-mcp`). The speed is in a different class.
- **Match the MCP scope to "the directory the user actually starts Claude Code in".** A project-scoped MCP **only connects in the startup directory** (it is not read in the parent). Move it into a subfolder without checking where startup happens and you get the trap where none of the tools connect at the place the person actually works. **For a tool you use everywhere, the global (user) scope** is the sure thing. "The evidence of where startup happens" = the memory path `~/.claude/projects/-<sanitized-cwd>/`.
- **A SessionStart injection must not carry the full text of a skill.** It becomes a context cost on every startup. Inject only a **short standing directive** and read the details on demand (`/token-saver` etc.).
- **A heavy MCP or skill pack pays the listing cost every turn** (e.g. n8n-mcp is 24 tools + 15 n8n skills + a 12KB SessionStart). If you do not need it all the time, consider a scope or a gate. But if the person does "use it all the time", prefer connecting it (not connecting costs more).
- Applying a change **requires a session restart** (settings are read at session startup; reconnecting with `/mcp` alone does not re-read the settings). Hooks are re-read simply by opening `/hooks`.
