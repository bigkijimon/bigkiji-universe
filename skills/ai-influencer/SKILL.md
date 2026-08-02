> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/ai-influencer/SKILL.md. The Japanese file remains the source of truth.

# ai-influencer — AI influencer production and operations skill

Established 2026-07-11. Canonical research: analysis of all 4 NOCT video transcripts + monetization market research + local inventory audit (consolidated report done).
Project: `Creative_Media/VideoStudioJustin/成果物/AIInfluencer01/` (キャラ設計書.md is the canon)
Goal: 30,000 yen/month on Instagram (memory `ai-influencer-project`)

## Fundamental principles (BigKiji's decisions; changes require owner approval)
1. **Disclosed AI** (AI label in the profile). IG officially says "the label does not affect reach". The Aitana/imma approach.
2. **Roster rollout (2026-07-12)**: in addition to Elena (European), run several characters — Asian/Thai/Latina/Indian and so on — in parallel with **1 reference face each via PuLID = no training, zero cost**. Each character should be broadly appealing. Deliverable = AIInfluencer_Roster/.

## Character design (the legal parts of the NOCT method)
- **"A face that is too perfect is worthless"** — it gets buried in the scroll. Imperfection is the differentiator: freckles, moles, plump cheeks, pores.
- **Contrast design**: looks × an unexpected inner self (e.g. curvy beauty × big eater who is bad at cooking). 4 elements: trait/fantasy/angle/niche.
- Hair colour and hairstyle must be **identical every time until the LoRA is finished** (the biggest source of drift).

## Photoreal generation prompt technique (for Flux; ⚗ marks items still awaiting proof)
- Write in natural sentences. Quality tags (masterpiece etc.) do not work.
- State the imperfections explicitly: `natural skin texture, visible pores, slight imperfections, faint freckles, small mole, catchlight in eyes`. `flawless/perfect face` is counterproductive.
- iPhone look: `shot on iPhone, candid, amateur, off-center composition, not a professional photo` plus the ⚗ filename trick of putting `IMG_9999.JPG` in the prompt.
- Light: `soft morning light, natural sunlight`. Plastic skin → add `crisp` / `raw`.
- **Lower FluxGuidance: 3.5→1.5〜2.5** to escape the "typical Flux face" (use together with a long, detailed prompt).
- Slight blur and softness are welcome as amateur feel. A passport-photo-style straight-on gaze into the camera is a no.
- Scene vocabulary: mirror selfie / cafe / messy bedroom / outfit check / gym mirror / studying story.

## Face consistency (local, everything already in stock as of 2026-07-11)
- Base face: flux1-dev-Q6_K.gguf + ae.safetensors(models/vae/) + t5xxl_fp8 + clip_l. 832×1216.
- Mass-producing the same face: a 2-stage setup of **InstantID**(models/instantid/ip-adapter.bin + controlnet/instantid/ + antelopev2) + **IPAdapter FaceID-PlusV2**(in stock), plus a fixed seed. Note: for photoreal faces, buffalo_l/antelopev2 can detect them (3D chibi cannot — the lesson from SNSShort01).
- A dataset of 15-50 images → character LoRA training (the Mac is slow → a few hundred yen for 1 cloud run is the only paid item). Do not change the hairstyle or outfit before training.
- Matching clothes and props: add a reference image cropped to just the object (a human face in the shot causes misdetection).

## Content planning technique (using Claude, the legal parts)
- Turn **only the structure** of a viral post into JSON and reuse it: "Analyze this image → reusable JSON prompt. Keep pose/camera/outfit logic/environment, strip person-specific information" → then rebuild it with our own AI character.
- Persona-consistent post ideas: "Based on this branding style and persona, generate a casual, soft, authentic, not overproduced IG post prompt."

## 🚦 GPU priority = lowest (yield to other departments; owner instruction 2026-07-12)
AI influencer generation is **the lowest priority**. When another department's generation (music/video/blog/image) comes in, yield to it and resume afterwards.
- **Image generation**: run through the signal with `AIInfluencer01/polite_batch.sh <script> <prefix> <item...>`, **1 item at a time**. After each generation it re-queues at the tail, so waiting jobs from other departments run first in FIFO order = it yields automatically. The only window in which it cannot yield is the 1 item being generated (~15 min). **Do not merge the batch into 1 run** (merging holds the lock for a long time and prevents yielding).
- **LoRA training (long-running)**: save checkpoints in small increments (e.g. every 100 steps). When monitoring detects another department's ticket → kill the trainer and release the lock → let the other job finish → restart the trainer (it auto-resumes from the latest checkpoint). SIGSTOP alone keeps the VRAM held and causes OOM, so yield with **kill+resume**.

## Operations (legal parts only)
- 3 reels/week (10-15 s) + 2 stills/week. Formats that get saved (outfit breakdowns / before-after).
- Warm up a new account (view only for a few days; do not rush to post).
- 90-day KPI: 2,000 followers, ER 3%, (once 1,000 is reached) decide whether to open Fanvue.
- Turning into video: Wan2.2 I2V (in stock) → reels. GPU work always goes through the signal (gpu-signal.sh run).

## Pitfalls of setting up Flux+PuLID (2026-07-12, from the field)
- Node = lldacing/ComfyUI_PuLID_Flux_ll. After requirements, **install `facenet_pytorch` separately with `pip install facenet-pytorch --no-deps`** (it is imported unconditionally but is missing from requirements, so you get IMPORT FAILED).
- This ComfyUI fork (comfy_kitchen line, system version 0.25.0) passes extra kwargs such as `timestep_zero_index` into the Flux forward → absorb them by adding **`**kwargs,`** at the end of the `pulid_forward_orig` arguments in `PulidFluxHook.py` (this is the fix for `TypeError: pulid_forward_orig() got an unexpected keyword argument 'timestep_zero_index'`).
- Startup is launchd `com.virtualitystaff.comfyui` (restart with `launchctl kickstart -k gui/$UID/...`). `PYTORCH_ENABLE_MPS_FALLBACK=1` is already set. insightface provider=CPU.
- Node input names (measured): PulidFluxModelLoader(pulid_file) / PulidFluxEvaClipLoader() / PulidFluxInsightFaceLoader(provider) / ApplyPulidFlux(model,pulid_flux,eva_clip,face_analysis,image,weight,start_at,end_at).

## ✅ Photoreal pipeline confirmed (2026-07-12, roughly 92-95 points / the AI smell is almost gone)
**Flux + PuLID + XLabs photoreal LoRA + post-process grain**:
- UnetLoaderGGUF(flux1-dev-Q6_K) → LoraLoaderModelOnly(flux_realism_xlabs.safetensors, strength **0.6**) → ApplyPulidFlux(weight0.85, start0, end0.85, reference=elena_signature.png) → KSampler(steps30, cfg1, dpmpp_2m, **beta**, denoise1) ← FluxGuidance **2.5** + DualCLIP(t5xxl_fp8+clip_l) → VAEDecode(ae). 832×1216.
- Post-processing: post_process.py (saturation -10% / gentle S-curve / fine grain / vignette / JPEG without EXIF) removes the digital smell that remains. **Use the raw, un-post-processed images for LoRA training data** (grain only at posting time).
- XLabs photoreal LoRA = huggingface `XLabs-AI/flux-RealismLora` (lora.safetensors, no token needed). The single biggest lever for turning Flux's characteristic glossy skin into real skin with pores.
- Script: `gen_flux_pulid.py <concept...> [--seed N]`. Strength is adjustable via the REALISM_LORA env var.

## Measured generation figures (updated each time)
- (2026-07-11) Flux Q6 832×1216 20steps ≈ **13 min/image** (M1 Max, guidance2.2, via the signal). Quality = photoreal, passing; freckles and skin texture excellent.
- (2026-07-12) Flux+PuLID+realismLoRA ≈ **15-25 min/image** (including PuLID's insightface CPU processing).
- Going from guidance 3.0→2.2 made the body instruction (plus-size soft curvy) take effect cleanly. For "plump" you have to spell it out all the way — plus-size / full soft body / fuller arms / round plump cheeks — or she comes out thin.
- Signature face fixed: AIInfluencer01/elena_signature.png (**= seed404**, owner's final call 2026-07-12: "I prefer 404". The old 202 is elena_signature_202_backup.png). From 5 candidates the owner preferred 202/303/404 → 202 at first → updated to 404. Canon = キャラ設計書.md.
- Photoreal SDXL: added RealVisXL V5.0 fp16 to checkpoints/ (the base for FaceID/InstantID; plain sd_xl_base is not photoreal enough).
