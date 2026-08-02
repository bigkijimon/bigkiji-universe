---
name: ltx2-video
description: Generate character video (I2V, lip-sync, audio synchronisation) at high fidelity with LTX-2 / LTX-2.3. Prompt design, sampler settings and audio-driven lip-sync are done through ComfyUI (:8000). Started manually with 「LTX」「LTX-2」「I2V」「動画生成」「口パク」「リップシンク」「キャラクターに声」「ショート動画」. Not for cloud video APIs (Runway/Pika/Sora). Always arbitrate the GPU with gpu-mem-switch before generating.
disable-model-invocation: true
allowed-tools: Bash(bash *), Bash(curl *), Bash(python3 *), Bash(ffmpeg *), Bash(ffprobe *)
---

> Translated from the owner's Japanese original at `~/.claude/skills/ltx2-video/SKILL.md`. The Japanese file remains the source of truth.

# 🎬 LTX-2 / LTX-2.3 Video Generation

Make character video with Lightricks LTX-2 (19B DiT, simultaneous audio+video generation).
Official: https://docs.comfy.org/tutorials/video/ltx/ltx-2 · https://github.com/Lightricks/ComfyUI-LTXVideo

## 🎥 Most important (I2V, landscape and subject) — stopping the drift where it "turns into a different scene" (found in real production 2026-07-18)
**If you write a place, a viewpoint or a composition that is not in the input image into the prompt, within a few frames the output turns into a different world.** In I2V **the image is the first frame** = the model has already seen the subject, the place and the light. In the prompt, **do not re-describe the picture; write only the "movement" you are adding to the elements inside the image**. Add a subject or a viewpoint that is not shown (e.g. `aerial/drone/flying over` on a ground-level photo) and the model rebuilds the frame in order to create it = drift.
- ❌ `aerial shot flying over the canopy` (a viewpoint not in the image = an instruction for a new scene) / ✅ `the camera pushes slowly forward at ground level, foliage slides past the lens, mist drifts, water rushes over the stones`
- If it drifts: **narrow the camera movement down to one**, **length 4–6 seconds**, anchor frame0 with `--image <path> 0 1.0`, and on LTX **raise** `cfg` to strengthen adherence (the opposite of lowering it when nothing moves).
- Real case: on a client site's `/experience` page, "aerial flying over canopy" was written over a ground-level waterfall photo, and LTX turned it into a palm plantation plus mountains. Details and the primary source = `references/prompt-reference.md`, "Most important lesson ②".

## 🎥 Most important (lip-sync, characters) — make it an animation, not a "passport photo" (confirmed against the official docs 2026-07-10)
**The biggest cause of a lip-sync video becoming "a passport photo where only the mouth moves in a fixed pose" is `static locked camera` in the prompt. Never put it in.**
Lip-sync (audio synchronisation) is guaranteed by `modality_scale=3.0` (audio ↔ mouth agreement) = **the mouth does not go out of sync even if you move the camera or the body**. "The lip-sync breaks unless you keep it still" is a misunderstanding. LTX's official troubleshooting states this explicitly too.

The 3-piece set that produces movement (all mandatory):
1. **Delete the stillness words from the prompt** and write the camera work plus the body movement with **concrete verbs** ("dynamic" and other vague words do not work).
   - Camera vocabulary (official): `slow dolly in / push in / pull back / pans across / tracks / circles around / tilts up / crane up / handheld movement / over-the-shoulder / overhead view`
   - Body movement: `waving, bouncing, leaning forward, shoulders shifting with the rhythm of speech, tilting head, pumping fist, jumping, gesturing with one hand` (break it down into micro-actions, present tense)
   - At least one motion cue in every sentence. 4-8 sentences, 1 paragraph.
2. **Increase the movement with parameters** (the official fix for a static avatar): `--cfg-scale 2.3` (lower it to 2.0–2.5 when nothing moves / 3.5-4.0 for low motion), `--stg-scale 0.7` (0.5-0.8 for high motion / raise it to 1.5 when it flickers). **On the audio side, cfg=7.0 and modality=3.0 are kept high internally and hold the lip-sync** = do not lower them.
3. **If you need large body or framing movement, use first-last frame**: on a2v, pass a different pose / different framing to the start and the end with `--image start.png 0 1.0 --image end.png <last> 1.0` → the middle is interpolated and you get large movement (the end is a hint and is not reached exactly; the movement in between increases). Precise control is not possible, though.
   - For purely large movement there is the `keyframe` command (start/end interpolation; the lower `--end-strength`, the more freely it moves), but **keyframe cannot do lip-sync** (it generates audio on its own). If you want to keep the lip-sync, a2v with multiple images is the only choice.
- Make it feel animated through structure: cut between several short shots (close / wide / lateral tracking / overhead), vary the framing, move the light (`lights dim as we approach`). Flat lighting is the single biggest source of "AI-ness".
- When the official primary source cannot be fetched with WebFetch because of oversized HTTP headers → get it through the `https://r.jina.ai/<URL>` proxy.
- Sources: ltx.io/model/model-blog/prompting-guide-for-ltx-2 · ltx.io/blog/how-to-build-talking-ai-avatars-from-audio · ltx.io/blog/how-to-fix-slow-motion-in-ai-generated-video

## ⚡ Essential knowledge fixed by measurement on 2026-07-10 (`~/ltx-2-mlx`, MLX local a2v)
Break these and you will get stuck, every time. All of it is backed by real data.
- **Always run it by hitting the arm64 venv python directly**: `arch -arm64 ~/ltx-2-mlx/.venv/bin/python -u -m ltx_pipelines_mlx a2v ...`.
  The venv python is a universal binary, but **calling it as a subprocess from anaconda (x86_64) inherits x86_64 and mlx (arm64) dies with `incompatible architecture`**. Wrapping it in `python3 script.py` (anaconda) is equally guilty.
- **The a2v frames formula (strict)**: `frames = 8*floor((audio_sec*fps - 1)/8) + 1` and `frames/fps ≤ audio_sec`. Round up and it dies with `broadcast_shapes (…,69,…) vs (…,73,…)`. fps=24.
- **Both width and height must be multiples of 64** (the half-res processing of the two-stage pipeline).
- **Model `dgrauet/ltx-2.3-mlx-q8`** (a complete audio_vae encoder, 44 keys). `notapalindrome/ltx23-mlx-av-q4` has **0 keys in the audio encoder = a2v impossible** (dies with `Missing 46 parameters`).
- **Do not use `--low-ram` on a 64GB machine**: it streams the transformer blocks from disk and is brutally slow (RSS pinned at 3-5GB, still not finished after 23 minutes). Drop it and it loads fully onto the GPU (Alloc 30GB) and behaves.
- **Measured speed of a2v (q8 two-stage) (M1 Max 64GB, GPU Utilization 100%)**:
  | Resolution | stage1 steps | Speed | stage1 time |
  |---|---|---|---|
  | 768×1344 | 30 | **72 s/it** | 36 min (not usable) |
  | 512×896 | 16 | **34.5 s/it** | about 9 min |
  → Local a2v is heavy. Even for a short social clip it is 9 minutes and up per cut. **Over 45 minutes for 5 cuts.** You must adjust by lowering the resolution, lowering steps and lowering the number of cuts. If you scale up with lanczos at final compositing, even 512×896 is usable quality.
- **The trap where you cannot see progress**: with `subprocess.run(capture_output=True)` the child's tqdm (stderr) is invisible until it finishes. Confirm it is alive with a `tail -f` on the Monitor log, or by measuring the GPU (`ioreg -r -d1 -c IOAccelerator | grep 'Device Utilization'` = 100 means it is generating).
- **In a2v the whole frame reacts to the audio** = you cannot have only one of two people standing side by side speak (both mouths move). **A close-up of one character per cut** is the right answer for lip-sync. Two people only for a cut where they sing in unison.
- You may **pass the character to `--image` with the white background still on it** (LTX generates the background). A birefnet cut-out easily picks up speckle noise. 9:16 is centre-cropped so the edges get cut — put the face in the middle.

## ✅ Measured success 2026-07-10 (lip-sync works perfectly at this setting)
On cut01 (mascot character, seg_01 2.757s) the lip-sync audio synchronisation was a **complete success**. Extracting 4 frames, the mouth clearly opens and closes as closed → "o" → smile → "wa", blinking occurs, the character does not turn into a different person, and the white background was automatically converted into a moving pastel background. The exact command for reproduction:
```
arch -arm64 ~/ltx-2-mlx/.venv/bin/python -u -m ltx_pipelines_mlx a2v \
  --model dgrauet/ltx-2.3-mlx-q8 --gemma mlx-community/gemma-3-12b-it-4bit \
  --prompt "<subj>, clear synchronized lip movements matching the speech, mouth opening and closing naturally with each word, expressive lips, bright eyes with natural blinking, small friendly head nods, static locked camera, soft warm studio lighting, cute stylized 3D animation, lively friendly mood" \
  --audio seg.wav --image cut_kf.png \
  --frames <8floor式> --frame-rate 24 --width 512 --height 896 \
  --stage1-steps 16 --stage2-steps 3 --cfg-scale 3.0 --stg-scale 1.0 --seed 777 -o out.mp4
```
(The block is byte-identical to the Japanese original. The placeholder `<8floor式>` means "the value from the 8*floor frames formula above".)
- **512×896 with stage1=16 steps is the practical point** (34.5 s/it, about 9 min per cut, GPU 100%). Quality is sufficient = scale 1080×1920 → 4K with ffmpeg lanczos at the end.
- The lip-sync prompt words ("clear synchronized lip movements...") are working = evidence that a2v synchronisation depends on how concrete the prompt is.
- The keyframe is the original white-background image trimmed to a chest-up close-up with the face centred (`compose_keyframes.py` close_up_single: crop 55% of the full body from the top of the face, width 92%, top 20%).

---

## 🚨 Always before generating (GPU arbitration)
M1 Max unified memory fights over VRAM with the resident Ollama. **Always, before running LTX**:
```bash
bash ~/Documents/CEOBigKiji/Creative_Media/VideoStudioJustin/scripts/mem-switch.sh comfyui
# …LTX generation…
bash ~/Documents/CEOBigKiji/Creative_Media/VideoStudioJustin/scripts/mem-switch.sh ollama  # always switch back
```
Details are in the `gpu-mem-switch` skill. Skip this and you get an **instant Metal watchdog kill / timeout** (= the cause of the freezes in the past).

## Choosing a model
| Model | Use | steps/CFG |
|---|---|---|
| ltx-2-19b-distilled | **Fast, the default** (8 steps) | 8 steps / CFG=1 |
| ltx-2-19b-dev-fp8 | Quality first, low VRAM | 30-50 / CFG 4-7 |
| ltx-2-19b-dev (bf16) | Highest quality, needs 40GB+ | 30-50 / CFG 4-7 |
| ltx-2-spatial-upscaler-x2 | 2× resolution (→4K) | — |
| ltx-2-temporal-upscaler-x2 | 2× FPS | — |

## Sampler settings (measured best)
- **steps**: 30-50 (8 for distilled) | **CFG**: 4.0-7.0 (5.5 for audio synchronisation) | 10+ makes the movement robotic = forbidden
- **scheduler**: `euler_ancestral` (the most natural movement) | for vid2vid lip-sync, `euler_ancestral_cfg_pp` CFG=1 + 8-step custom sigma
- **resolution**: 1920×1080(HD) / 3840×2160(4K) | 1080×1920 for vertical social video
- **fps**: 25 (standard) or 50 (twice the time) | **duration**: 2-10 seconds (<5 seconds is best for lip-sync)
- **start_frame_strength**: 1.0 = faithful to the input image / 0.7-0.9 = free movement

## Audio-driven lip-sync (giving a character a voice)
- **Input audio**: clean **mono 16kHz** speech, no background noise; **<5 seconds** is the most accurate
- **temporal_smoothing**: 0.1 (speech = prioritise the accuracy of the mouth sync) / 0.3 (music video)
- **spectrogram_resolution**: 128 (default, recommended) / 256 (finer detail, more VRAM)
- **sync_strength**: 0.6-0.75 (a looser value is stable; 0.85+ jitters)
- Compose the face **front-on to a slight 3/4, with the mouth clearly visible**. **⚠️ But do not write camera-fixing words (static/fixed camera)** = it turns into a passport photo. The lip-sync is guaranteed by modality_scale, so you may move the camera and the body (→ the "do not make it a passport photo" section above)
- MelBand Roformer separates the vocals out of music automatically (audio with music in it is fine)
- For long takes, see the chunk-splitting workflow in GeekatplayStudio/LTX-2-3-LipSync

## 📎 Detailed reference (read before starting)
- `references/prompt-reference.md` — the 6 elements of prompt structure, camera/movement vocabulary, the parameter quick-reference table, per-genre templates, how to produce movement (the complete version)
- `references/character-consistency.md` — one image → a character sheet of multiple angles/expressions, identity lock, FaceID/InstantID/PuLID compared, Qwen-Image-Edit, first-last frame, voice consistency, what is in stock locally

## Prompt design (9 principles, per the official guide)
Write it as **a single flowing paragraph** (bullet lists forbidden). Structure:
`[scene] + [lighting/atmosphere] + [camera movement] + [character action] + [audio description] + [technical specification]`
1. One paragraph, no line breaks | 2. **Present-tense verbs** (walks/tilts, not walked) | 3. State the camera behaviour explicitly (slow dolly in, etc.)
4. Measurable physical description | 5. Lighting, texture, ambient sound | 6. Smooth it with connectives (as/then/while)
7. Genre vocabulary | 8. Observable features only (age/clothes/posture) | 9. **Show emotion through the body's reaction** (sad is forbidden → describe it)
- **Within 200 words**, 4-8 sentences | Put dialogue in quotation marks ("...", you may specify language/accent)
- ❌ Avoid: abstract emotion words / text and logos / complex physics / overcrowded scenes / frame specifications / quality tags such as "masterpiece" (they are ignored)
- Usable camera words: `stable dolly movement` `smooth gimbal tracking` `constant speed pan` `natural motion blur` `180-degree shutter` `tripod locked stability`

## ComfyUI nodes (LTX-2.3)
Required: `LTXAudioVideoLoader` / `LTXAudioConditioner` / `LTXVideoSampler`
Dependencies: `pip install librosa==0.10.2 soundfile==0.12.1 torchaudio`
ComfyUI v0.16+ supports LTX 2.3 natively. Get the workflow JSON from the Template Library.

## Generate → composite flow (proven, the CoffeeOnTheWall pattern)
1. Generate the keyframe images in ComfyUI (SDXL/Flux; 1080×1920 for 9:16)
2. `mem-switch comfyui` → each cut through LTX-I2V (conditioned on the audio wav) → `mem-switch ollama`
3. With ffmpeg: concatenate the cuts, subtitle plates (a transparent PNG overlay made with PIL), BGM mix, upscale to 4K
4. **Look at the real thing with your own eyes before delivery** (check the video/frames with Read). "It generated" ≠ "it is what you aimed for"

## Apple Silicon cautions
- fp8 is not supported on MPS. Use **GGUF / q4 or q8 quantization** (q8 704p runs for real on M1 Max 64GB, about 8 min per cut)
- `dgrauet/ltx-2-mlx` (q8+two-stages-hq+STG) **does not get killed by the Metal watchdog even with the display on** (unlike the old mlx-video-with-audio) = you can run it in a terminal during the day
- For 4K, use LTX native or ffmpeg lanczos upscaling. The UltraSharp family breaks on MPS and is not adopted

## Reference links
- Official: docs.comfy.org/tutorials/video/ltx/ltx-2 | Next Diffusion (lip-sync), ltxworkflow.com
- Detailed reference: `references/prompt-reference.md`

## ⚠️ Field lessons from SNSShort01 (2026-07-11, for character video / AI influencers)
The flaws that "make it smell amateur", found through the owner's scoring feedback. Avoid them next time without fail:
1. **An extreme close-up of only the face loses points** = the character's appeal, the costume and the world do not come across. 9:16 is tall, and with only a face the empty space looks lonely. → Show the whole character plus hand/body movement, **from waist-up to knee-up**. An influencer is sold with their styling included.
2. **The costume breaking between cuts = a different person, and it feels amateur.** Even for the same character, the collar, the colour and the details change. → **Generate every cut from a single canonical character image (identity lock).** A costume that is "simple and distinctive" is resistant to a2v's small variations. **For an AI influencer, consistency of face + hair + costume is the lifeline** = you must lock it with InstantID/PuLID/LoRA (FaceID gives "no face" on a chibi 3D character, but it works on a semi-photoreal face).
3. **A white or plain background is boring.** On social media you pull people in with the world. → A fun, built-out background that fits the theme (classroom / café / street / pastel space). In a2v the whole frame reacts to the audio and the background moves too, so make it a **"built-out but simple" scene that is hard to break**.
4. **a2v hallucinates fake text inside the frame** ("Ywtheu geotit" was burned into the top of cut04). → Always put `text, letters, words, typography, writing, captions, watermark` in the negative. As insurance, hide the top edge at compositing time with a **9:16 centre zoom crop** (crop=ih*0.45:ih*0.8:(iw-ih*0.45)/2:ih*0.2).
5. **Emoji in subtitles turn into tofu (□).** Arial and similar fonts have no emoji glyphs. → Composite emoji as a separate layer in Apple Color Emoji, or substitute a monochrome symbol such as `★` (U+2605).
6. **What succeeded and should be kept**: the expression matching the story (a troubled face ←→ "hard") / avoiding the passport photo with a push-in and hand gestures / on-model from the very first frame (keyframe conditioning has none of the LoRA-like "first second falls apart").
→ Flow improvement: **character sheet (1 canonical image, waist-up, fixed costume) → img2img each cut with a different expression/pose → composite onto a fun background → a2v**.
