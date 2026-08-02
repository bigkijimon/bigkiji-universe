---
name: music-gen
description: Local music generation (ACE-Step 1.5, songs with vocals). Required reading before starting any music production, vocal song generation, BGM production or teaching-material song task. Accumulates the startup procedure, switching to local, design principles for children's songs, and technical lessons (append-only). Trigger: 音楽制作, 歌, ソング, BGM, music generation, ACE-Step.
---

> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/music-gen/SKILL.md. The Japanese file remains the source of truth.

# music-gen — local music generation skill (created 2026-07-10)

## What it is and how it is put together
- Main body: `~/Documents/CEOBigKiji/Creative_Media/MusicStudioKakao/ACE-Step-1.5/` (MIT, commercial use allowed)
- Backend: LM side = MLX / DiT side = PyTorch MPS (officially supported on Apple Silicon)
- LM model: **0.6B (acestep-5Hz-lm-0.6B) is the default**. 1.7B has been reported to peak at 42GB, so on a 64GB machine that also hosts Ollama (qwen32b resident) it has to be measured first
- Jurisdiction: Creative_Media (CEO Justin) / MusicStudioKakao. Research records = knowledge/2026-07-10_*, 2 files

## Startup (API server, port 8001)
```bash
cd ~/Documents/CEOBigKiji/Creative_Media/MusicStudioKakao/ACE-Step-1.5
ACESTEP_LM_BACKEND=mlx TOKENIZERS_PARALLELISM=false \
  uv run acestep-api --host 127.0.0.1 --port 8001 --lm-model-path acestep-5Hz-lm-0.6B
# 起動確認: lsof -nP -iTCP:8001 -sTCP:LISTEN / モデルは初回リクエスト時に自動DL(約10GB)
```
(Block kept byte-identical to the Japanese original; its comment explains how to confirm the server is listening and notes that the model is downloaded automatically on the first request.)

## Generation (through the bundled skill CLI, recommended)
```bash
cd ~/Documents/CEOBigKiji/Creative_Media/MusicStudioKakao/ACE-Step-1.5/.claude/skills/acestep
bash scripts/acestep.sh generate -c "<caption>" -l "<構造タグ付きフル歌詞>" \
  --duration 100 --bpm 100 --key-scale "C major" --language en
# 出力: ACE-Step-1.5/acestep_output/<job_id>.json + <job_id>_1.mp3
```
(Block kept byte-identical to the Japanese original; the lyrics argument takes the full lyrics with structure tags, and the comment names the output files written per job.)

## ⚠️ Traps and lessons (append-only — when something fails, add 1 line here)
- **The bundled CLI's default points at the cloud API (acemusic.ai)**. Always do this on the first run:
  `bash scripts/acestep.sh config --set api_url "http://127.0.0.1:8001"` ＋ `--set api_mode native`
  (Local generation only = owner instruction 2026-07-10. It is hard to notice because the cloud health check answers "OK".)
- `scripts/acestep.sh` has no executable bit → call it as `bash scripts/acestep.sh`
- The repository-bundled `.claude/skills/acestep*` is directory-scoped and sometimes cannot be name-resolved by the Skill tool → Read the SKILL.md directly
- start_api_server_macos.sh can throw up an interactive prompt during its git update check → calling `uv run acestep-api` directly is the sure thing
- Long jobs and the first download require Bash's run_in_background (synchronously it is cut off by the 2-minute timeout)
- Measured speed (M1 Max 64GB / 0.6B LM / turbo DiT): **58.5s for 2 variants of a 100-second track** (LM 15.7s + DiT 42.8s). 1 request automatically generates 2 tracks (different seeds = usable for A/B listening)
- The actual result JSON is the array elements inside `data[0].result` (which is a JSON string). This differs from the "top-level lyrics" written in the skill document (native mode). The lyrics actually used = result[0].lyrics, the metadata = result[0].metas
- The first model download is about 7GB in total (checkpoints/) and takes about 4 minutes on a 47MB/s line
- Scoring (an objective measure of intelligibility): local mlx-whisper transcription → lyric match rate. **The default python3 on this Mac is anaconda (x86/Rosetta), which makes uvx fail** → solved by naming arm64 explicitly: `uvx --python cpython-3.12-macos-aarch64-none --from mlx-whisper mlx_whisper <mp3> --model mlx-community/whisper-large-v3-turbo`
- Quality rule: do not score your own track yourself → 3 layers: an objective layer (Whisper match rate) + rubric scoring by an independent subagent + the owner's ears
- **⚠️ gpu-signal and acestep-api falsely detect themselves (found 2026-07-13, be careful)**: `gen_running()` in `gpu-signal.sh` includes `pgrep -f "...acestep-api..."`. **If the music-generation API server (:8001) is resident, the server itself matches "currently generating" forever**, so `[ -z "$(gen_running)" ]` in `my_turn` never becomes true and the acquire in `gpu-signal run` spins for up to 30 minutes before force-acquiring (= effectively a hang). `check`/`status` also always return 🔴 while the server is resident. **Workaround**: before generating, manually confirm "real contention" with `gpucheck.sh` and `pgrep -f "ltx_pipelines|mlx_video|generate_av|stable_diffusion"` + ComfyUI `/queue` + `/tmp/bigkiji_gpu.lock` + the blog MARK → if there is no contention, write `/tmp/bigkiji_gpu.lock` yourself and generate directly → release with `rm` after generating (reproducing acquire by hand). 0.6B LM+DiT can coexist and generate with Ollama (qwen32b) still resident (no need to freeze with mem-switch). **The permanent fix is a matter for the Corporate Planning Office**: drop `acestep-api` (the server) from the pgrep in gen_running and decide on an actually-generating flag (raised only while a job is running). It is the same shape of fix as comfy_busy deciding via `/queue`.
- **⚠️ acestep.sh has no `--help`**: `generate --help` interprets "--help" as the caption value and generates 1 throwaway job. To check the arguments, read SKILL.md / api-reference.md.

## Key points for children's English songs (details = MusicStudioKakao/knowledge/2026-07-10_子ども向け英語ソング設計原則.md)
- Centre key F4-G4 (C/D/F major), BPM 95-110, 1 song ≈ 2 minutes, chorus repeated exactly
- Lyrics: 1 line = 4-8 words (6-10 syllables, parallel lines ±1-2), letters separated as `A - B - C`, numbers as English words, parentheses = chorus
- For enumerations (ABC / numbers / days of the week), avoid the LMNOP problem = even spacing and grouping (ABCD/EFG/HIJK/LMN/OPQ...)
- caption example: `children's song, cheerful, playful, simple melody, ukulele, glockenspiel, acoustic guitar, clear female vocals, warm, sing-along`
- Never contradict between the caption and the lyric tags; do not put BPM/key in the caption — use the dedicated parameters
- Cross-cutting prohibitions found during scoring (from the independent scoring on 2026-07-10): **do not put "and" inside an enumeration** (twenty-nine and thirty ✗) / **do not make the English unnatural for the sake of rhyme** ("but fun, all right!" ✗) / **change the chorus in at most 1 place** (changing 3 lines breaks the repetition principle) / keep the wording of the same enumeration consistent within a song (mixing fall and autumn ✗)

## Quality and operating rules
- Rights: record the licence of the model used for each deliverable (Kakao quality standard). Have a human check for similarity to existing songs before release
- Finished work goes into `MusicStudioKakao/成果物/<project>/` (lyrics md + mp3 + generation metadata JSON)
- Self-learning loop: for every 1 song, append what you learned to this skill (same method as video-selflearning-loop)
- Principle for judging v1 vs v2 (2026-07-10): a lyric-corrected version (v2) and seed luck are independent. Intelligibility can drop in v2 (the ABC song went 75.3→53.2), so **do not throw away the old take — pick the best per song by Whisper match rate × rubric**. Sung letters (A-B-C) are easily mistranscribed by Whisper and drag the match rate down, so the final call is by ear
