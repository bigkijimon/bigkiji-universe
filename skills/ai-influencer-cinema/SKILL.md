---
name: ai-influencer-cinema
description: A prompt-design skill for making the video (I2V) of AI influencers / AI idol units cinematic and character-consistent. It projects the CTRL Hunters cinema-worldbuilder method (Frame Map→Subject Lock per shot→Cross-Frame Rules→Movement timeline→ambient sound only→Camera Capture) onto local I2V (Wan2.2/LTX-2 etc., to be chosen in Phase3). Required reading before starting a product commercial, a music MV, a brand ad or a multi-character group-dance piece. Trigger: AIインフルエンサー動画, MV, 商品CM動画, cinema-worldbuilder, I2V, 群舞, アイドルユニット動画, ブランド広告動画.
---

> Translated from the owner's Japanese original at `~/.claude/skills/ai-influencer-cinema/SKILL.md`. The Japanese file remains the source of truth.

# ai-influencer-cinema — cinema worldbuilder (local I2V edition)

The house style for video production at InfluencerStudioCoco (in charge: Coco). **Before you start, you must also read the `ltx2-video` skill** (no static camera / cfg/stg / first-last frame / GPU arbitration with `gpu-mem-switch`). The stills style is the sibling skill `ai-influencer-still-director`. Analysis of the reference material = `InfluencerStudioCoco/参考資料/参考動画分析_2026-07-12.md`.

## Premise: I2V animates a "locked still"
Consistency in the video **is decided by the quality of the input still**. First lock the reference sheet → the keyframe stills (start/end of each shot) with `ai-influencer-still-director`, and only then animate. The more of that locking you skip, the more the footage falls apart (CTRL Hunters: "hit rate scales with prep").

## Prompt structure (put all of it into 1 video prompt)
Reference = the structure of the rainy-hero prompt. Consistency across shots is guaranteed by this structure.

1. **Scene & Mood**: 1 line for the world, time of day, weather, air and story.
2. **Frame Map**: per shot, the subject's on-screen position, depth layer, points of contact and eyeline, and the binding of each subject to a reference image `@image_N`. "Shot1=@image_5(the car) in the mid-ground, Shot2=@image_1(woman A) from the chest up, mirrored to the upper left, Shot3=@image_2(woman B) tight in the driver's seat". **Fix the composition before identity = multiple characters do not drift within the frame (the most important point)**.
3. **Subject Lock — @image_N (per character/object)**: lock the identity/wardrobe/accessories carried by that character's reference and write only what changes. Always end with `@image_N keeps the same face, hair, identity markers, wardrobe, and silhouette throughout.`
4. **Cross-Frame Rules**: declare what stays fixed across every shot. "@image_2 stays in the driver's seat in the same state through Shot2-5. Cabin interior/lighting/time of day/weather are fixed across all shots. The dome light is the dominant light in every interior." → prevents drift between shots.
5. **Movement (a timeline with timecodes)**: the length and the motion of each shot, in seconds. "Shot1(0-3s) handheld with operator breath, slow push-in / Hard cut to Shot2(3-6s) ...". The camera **must move** (static = it turns into an ID photo; the `ltx2-video` lesson).
6. **Last Frame**: state the condition of the final frame explicitly (this matters for I2V first-last operation). "No on-screen text, no captions, no rendered typography".
7. **World Plate**: a consistent plate for the environment (3 layers of volumetric haze = foreground/mid-ground/deep background). "foreground volumetric haze between camera and subject giving the closest air real body".
8. **Sound Bed (ambient sound only)**: footsteps, cloth, breath, room tone, rain, engine. Short dialogue may be specified 1 line at a time ("in Shot3 woman B says '…' in a dry voice"). **No music. No score.** (Music is laid over later in the edit using a MusicStudioKakao track. Do not write the song or lyrics into the prompt.)
9. **Camera Capture (collected at the end, per shot)**: write it as behaviour. "Shot1 — 35mm anamorphic wide aperture, soft diffusion bloom, shallow DOF, foreground volumetric haze, handheld slow push-in / teal-amber grade, fine 35mm grain, 24fps, 15s total". Do not write equipment brand names.

## Multi-character consistency (idol unit, group dance = the v3/v4 type)
- Each member = an independent `@image_N` slot + a dedicated reference sheet (the 6 panels from `ai-influencer-still-director`).
- Pin each member to a position on screen in the Frame Map first, then load identity on top = harder to break with several people in 1 frame.
- Use Cross-Frame Rules to "fix each member's wardrobe state across every shot".
- Take the centre (Elena=seed404) as the axis and state the other members' relative positions and eyelines.
- For a group dance, writing each member's motion separately and briefly breaks less often than "all members do the same choreography".

## Running local I2V (★settled by measurement 2026-07-13 = the workflow that succeeded first time)
- **The favourite = Wan 2.2 I2V-A14B GGUF (Q5_K_M, High+Low, 2 experts) + LightX2V Lightning 4step MoE two-stage**. **Measured = 480×832×33f (about 2s) in 12.0 minutes on an M1 Max** (data that exists nowhere else in the world). Plain 20 steps is 82 minutes for 2s = not realistic. **fp8 is dead on Metal → GGUF is mandatory; a native node with no restart needed.**
- **Execution = `InfluencerStudioCoco/成果物/bench_wan22.py`** (through `gpu-signal.sh run`). The settled workflow: UnetLoaderGGUF(High/Low)→LoraLoaderModelOnly(Lightning high/low_noise_model.safetensors, 1.0) for each→CLIPLoaderGGUF(umt5-xxl-encoder-Q5_K_M.gguf, **type=wan**)→WanImageToVideo(start_image=the Flux+PuLID Elena still, vae=wan_2.1_vae)→KSamplerAdvanced×2 (two-stage MoE: High step0→split with add_noise/leftover enable; Low split→steps disable), cfg1.0, euler, simple→VAEDecode→SaveAnimatedWEBP 16fps. **The face is kept from the input still** (the quality of Flux+PuLID seed404 carries straight over).
- **The challenger = Draw Things (Metal-native, Wan2.2 6bit SVDQuant)**. It may be 20-40% faster than ComfyUI = settle it head-to-head.
- **The rough-draft slot = LTX-2 (already installed)**: for speed/audio tests. Not adopted for the final photoreal face (its quality ceiling is low). Fallback = CogVideoX-5B (512×384, ≤30f).
- **Face consistency**: the first frame holds, then it drifts on head turns and smiles. → **make the input still (Flux+PuLID seed404) better, and add a character LoRA if needed**. Build a multi-character group dance as a **composite / keyframes**, not as a 1-shot generation.
- **Always through the GPU signal, at the lowest priority**: `gpu-signal.sh run <name> "<cmd>"`. Long jobs = take the late-night slot or yield to other departments. MPS: `PYTORCH_ENABLE_MPS_FALLBACK=1`. Black frames = out of memory → lower the resolution/frames.
- Keep each take short, split it up and join it in the edit (1 shot of 3-5s at a time). Pin the keys with first-last frames.
- Wan2.5 = API-only and cannot run locally; Wan2.7 = assumes 24GB NVIDIA and Apple quantization is not established = watch only.

## Use-case templates (4 quadrants)
- **Product commercial (the v1 type)**: 15s. The face-consistent model holds/uses the product/appears via a mirror → finish on a hero shot of the product. The 1-word-per-1-cut telop (the rapid-fire style referenced from ElevenLabs) is added in the edit.
- **Music MV (the v4 type)**: the unit or Elena performing to a MusicStudioKakao track. Set design such as a mirror maze + group dance + the hero shot of the product (the song).
- **Fashion editorial (the v2 type)**: the brand's world, artistry, hero shot of the product.
- **Trial-lesson ad for the school (the A line)**: wholesome, G-rated. If a 3D character is used, render from the rig → edit. Pricing and campaign claims need the account owner's approval before publishing.

## Append rule
Winning patterns, failures and measured results for the models we pick get appended each time to this skill and to `InfluencerStudioCoco/knowledge/` (never delete anything).
