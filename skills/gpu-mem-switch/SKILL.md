---
name: gpu-mem-switch
description: Arbitrates GPU contention on M1 Max 64GB unified memory between the resident Ollama and ComfyUI/LTX video generation or ACE-Step music generation. Hands Ollama's GPU over temporarily before image, video or music generation, and restores it fully afterwards. Use it before you hit a timeout / Metal watchdog on 「画像生成」「動画生成」「音楽生成」「ComfyUI」「LTX」「I2V」「ACE-Step」. Not for cloud GPUs or NVIDIA environments (Apple Silicon unified memory only).
disable-model-invocation: true
allowed-tools: Bash(bash *), Bash(launchctl *), Bash(kill *), Bash(pgrep *), Bash(ps *), Bash(curl *)
---

> Translated from the owner's Japanese original at `~/.claude/skills/gpu-mem-switch/SKILL.md`. The Japanese file remains the source of truth.

# 🔀 GPU Memory Switch (Ollama ↔ ComfyUI/LTX)

**The problem**: the M1 Max 64GB has unified memory. If you generate images or video with ComfyUI/LTX-I2V while Ollama (qwen, about 27GB) is resident,
you run out of VRAM and get **a timeout / an instant Metal watchdog kill**.
This is the root cause of "video generation freezing".

**The solution**: use the `mem-switch` script to hand Ollama's GPU over before generating and restore it fully afterwards.

- The actual script: `~/Documents/CEOBigKiji/Creative_Media/VideoStudioJustin/scripts/mem-switch.sh`
- Origin: established and proven during the Coffee HQ video production on 2026-07-09 (`Lessons_Learned/session-2026-07-09-coffee-hq-v1.md`)

## ⚠️ GPU contention includes "the work next door" (found in the field 2026-07-10)
The things that eat GPU (unified memory) on this Mac are not only Ollama/ComfyUI/LTX. **AI work running in parallel next door, such as the blog generation pipeline, fights over the same GPU.**
- There is a real case where the cause of "GPU stuck at 70% when nothing is supposed to be running" was in fact **blog generation running next door**. It was initially misdiagnosed as WindowServer/UI drawing = a lesson in looking only at the surface.
- **How to isolate it when GPU usage is high** (pin down the real cause with primary evidence):
  1. `ioreg -r -d1 -c IOAccelerator | grep 'Alloc system memory'` → **tens of GB means AI generation is running** (UI drawing is a few GB). This is the most important discriminator.
  2. `ps aux | sort -k3 -rn | head` to see the high-CPU processes. If python/mlx/ltx/ComfyUI/a blog generation script is there, generation is in progress. If it is only WindowServer/Stats.app/Claude.app, it is UI drawing.
  3. `pgrep -fl "ltx|mlx|blog|hs-blog|comfy|ollama"` to sweep for every AI process.
- **The lesson**: before you start something heavy, check whether another AI job is running next door. Running video, blog and image generation at the same time makes all of them slow or OOM. Run them in order, or wait for one to finish.
- GPU monitors such as Stats.app themselves eat GPU just to monitor (open them only when you want to look). At ProMotion 120Hz (FPS reading 123) the GPU load from UI drawing also goes up.

## 🎵 Music generation (ACE-Step) is arbitrated too (added 2026-07-10)
Video and images are not the only generation that eats GPU. **The ACE-Step music generation server (`acestep-api` :8001, MusicStudioKakao) also consumes a lot of unified memory.**
- 3 systems fight over the GPU: **Ollama (qwen resident, 27GB) / ComfyUI and LTX (image and video) / ACE-Step (music)**. Run them together and they all OOM or crawl.
- **Check before generating**: if `Alloc system memory` is tens of GB, something is already generating → wait your turn. Sweep every generator with `pgrep -fl "ltx_pipelines|mlx|acestep|ComfyUI"`.
- **Order**: if you are running video or images, make the music server wait or stop it. If you are running music, freeze Ollama and stop video. `mem-switch comfyui` frees Ollama, but ACE-Step and ComfyUI together may still not fit → **running 1 kind at a time** is the safe option.
- ACE-Step is sometimes started by another session or another department (music ran for the first time on 2026-07-10). If GPU is tight, suspect the music or video generation next door. For details of music production, see the `music-gen` skill.

## How it works (in 2 layers)
1. **`OLLAMA_GPU_OVERHEAD`** (a launchctl environment variable) = "how much VRAM Ollama leaves free for other processes"
   - `0` → Ollama at full (default)
   - `16000000000`(16GB) → Ollama hands over 16GB = ComfyUI/LTX can use it
2. **freeze/thaw** (`kill -STOP`/`-CONT`) = hands the llama-server's GPU compute over entirely
   - The process stays in memory = thaw brings it **back instantly with no model reload** (the conversation is not cut)

## Usage (keep to this order strictly)
```bash
SW=~/Documents/CEOBigKiji/Creative_Media/VideoStudioJustin/scripts/mem-switch.sh

# 1. 生成の「前」に必ず — GPUをComfyUI/LTXへ譲る
bash "$SW" comfyui

# 2. ComfyUI API投入 / LTX-I2Vバッチ を実行（この間Ollamaは凍結）

# 3. 生成が「終わったら」必ず — Ollamaにフル復帰（忘れると会話が固まる）
bash "$SW" ollama
```
(The block is byte-identical to the Japanese original. Its comments say: always, *before* generating, hand the GPU over to the generator; then run the generation job, during which Ollama stays frozen; then always, *after* generating, bring Ollama fully back — forget this and the conversation locks up.)

**One-stop** (recommended, stops you forgetting to switch back):
```bash
bash "$SW" run 'python3 gen_keyframes.py && python3 run_ltx_i2v.py'
# → comfyui化 → cmd実行 → 完了通知 → ollama復帰 を自動で一括
```
(The comment says it does the whole sequence automatically: switch to comfyui mode, run the command, notify on completion, restore Ollama.)

**Checking the state**:
```bash
bash "$SW" status
# OLLAMA_GPU_OVERHEAD の値 と llama-serverのstate(T=凍結/S=稼働)を表示
```
(The comment says it prints the value of OLLAMA_GPU_OVERHEAD and the llama-server state, where T means frozen and S means running.)

## Iron rules
- **Always run them as a pair, before and after generating.** Once you have done `comfyui`, always come back with `ollama` (`run` does it for you).
- If you forget to switch back, Ollama (Claude Code's local model / your conversation) stays frozen = it hangs.
- ComfyUI is resident under launchd (:8000), so it does not need restarting. The only thing being switched is the Ollama side.
- `RESERVE_BYTES` (16GB by default) is sized for the measured peak of LTX q8. If you OOM at 4K or large resolutions,
  raise it inside the script to `24000000000`(24GB) or similar.
- Verified round trip: comfyui (frozen T) → ollama (revived S) → `curl :11434/api/version` responds OK.

## Related
- For the whole video production flow, use it together with the `comfyui-workflow` (:8000 images) / `ollama-qwen` (:11434 LLM) skills.
- For details of LTX-2 video generation, see the `ltx2-video` skill (if present).
