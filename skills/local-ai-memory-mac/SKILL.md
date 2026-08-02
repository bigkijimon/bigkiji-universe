---
name: local-ai-memory-mac
description: Prevent Unreal Engine (and other heavy GPU apps) from freezing on this 64GB Apple-Silicon Mac by freeing unified memory before use. Unreal + Ollama + ComfyUI cannot run at full load concurrently — they share RAM/VRAM. Run `ue-prep` before opening UE; alternate generation (ComfyUI) and building (UE) instead of running both. Trigger on: UE freeze/beachball/hang, "固まる", ComfyUI+UE+Ollama together, out-of-memory, before opening Unreal.
---

> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/local-ai-memory-mac/SKILL.md. The Japanese file remains the source of truth.

# Mac shared-memory operations (keeping UE / ComfyUI / Ollama from fighting each other)

On Apple Silicon, **RAM and GPU memory are shared**. The owner's machine has 64GB.
Unreal Editor (needs 10〜20GB) / Ollama (model resident; with keep_alive=Forever it squats on 15GB) / ComfyUI (heavy during generation)
**running at full load at the same time exhausts free memory → swap → beachball (freeze)**. Measured: free memory was already squeezed down to the 4GB range even with UE not running.

## Iron rules
1. **Always run `ue-prep` before opening UE** to free memory (script below).
2. **Do not run them at the same time**. Alternating is fine:
   - Asset-generation day → ComfyUI ON / UE OFF
   - Assembly-in-UE day → UE ON / ComfyUI and Ollama released
3. Keep UE itself light: **work in an empty/Basic level** (the 405-actor `Lvl_IntroRoom` is heavy), and lower Scalability if needed.

## Tool: `ue-prep` (`/Users/yuma/.local/bin/ue-prep`)
Frees memory non-destructively (Ollama models auto-reload on next use / ComfyUI is not closed, only its VRAM is released).
- `ue-prep` … run the release + show free memory before and after (measured: recovered 4.3GB→19GB)
- `ue-prep status` … only check the current state (memory/Ollama/ComfyUI) without releasing anything
- Environment variable `COMFYUI_URL` (default `http://127.0.0.1:8000`. ComfyUI on the owner's machine is on 8000)

Key points of what it does (the release primitives we learned):
- Ollama: list loaded models with `ollama ps` → `ollama stop <model>` for each (non-destructive, reloadable).
- ComfyUI: release VRAM/RAM with `POST /free {"unload_models":true,"free_memory":true}` (if that is not available, `/api/free`). You do not have to close it.
- Check: look at `NNNN unused` from `top -l 1 -n 0 | grep PhysMem`. UE wants around 20G free.

## How Claude operates (automated in this project)
- Before "opening/restarting UE", first run `ue-prep` to secure free memory, confirm that `... unused` is around 20G, and only then prompt the user to launch UE.
- When a freeze is reported ("固まる"), do not guess at the cause — measure with `ue-prep status` and `top ... PhysMem` → release with `ue-prep`.
- Stopping Ollama temporarily unloads the mothership model for UPCLASS translation, but it is automatically reloaded on the next request ([[upclass-translate-mothership-bridge]]). This is not destructive.

Related: Unreal connection and operation is [[unreal-mcp-gamedev]]; operating rules are [[stuck-then-research-then-skill]].
