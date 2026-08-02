---
name: ai-influencer-still-director
description: A prompt-design skill for shooting AI influencer stills with "zero AI smell and a consistent face". It projects the CTRL Hunters banana-pro method (Frame Map→Subject Lock→lighting = physics→camera in 1 line→anti-plastic skin→mid-grey background→volumetric light) onto our local Flux+PuLID pipeline. Required reading before producing a character reference sheet, a product commercial still or a brand editorial cut. Trigger: AIインフルエンサー静止画, 参照シート, banana-pro, Frame Map, Subject Lock, 商品カット, キャラ一貫.
---

> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/ai-influencer-still-director/SKILL.md. The Japanese file remains the source of truth.

# ai-influencer-still-director — stills director (Flux+PuLID edition)

The house style for stills production at InfluencerStudioCoco (in charge: Coco). Take in the canonical skill `ai-influencer` (fundamental principles 7 and the boundaries) first. Analysis of the reference material = `Creative_Media/InfluencerStudioCoco/参考資料/参考動画分析_2026-07-12.md`.

## First principle: prep decides the hit rate
The core of CTRL Hunters is **taste and prep**. A picture whose reference sheet, wardrobe and environment plate were locked in advance lands in one take. A picture that skips the lock takes 6 retakes. Keep to the order.

## The 8 principles of prompt design (stills)
1. **Frame Map first (composition before the face)**: before you write identity (the face), fix the subject's position in frame, depth layer, points of contact and eyeline. "The subject is in the right 2/3 of the frame, looking at the camera, elbow resting on the desk, the background falls out of focus 3m behind." → The face does not drift within the frame.
2. **Subject Lock (locked to the reference; write only what changes)**: the face/hair/body are carried by the reference image (PuLID's ref=`elena_signature.png`). In the prompt, **do not rewrite what the reference already carries — write only what changes in this cut** (pose, wardrobe, props, expression). Identity markers (freckles, moles, a scar in the eyebrow) get 1 short mention only.
3. **Write the light as physics (do not name equipment)**: direction, quality, colour temperature, motivation. "A warm hard rim from upper camera-right, a cool ambient fill from behind, a faint uplight under the jaw." Do not name fixtures or brands (the model renders behaviour).
4. **Condense the camera into 1 line at the end (write it as behaviour)**: body/lens/aperture/bokeh/film/grade. "wide-latitude cinema capture, 85mm at wide aperture, shallow DOF, oval bokeh, color-negative rendition, fine 35mm grain". If you are going for an iPhone-photo look: "shot on iPhone, ~26mm equiv, candid, slight barrel distortion, flat clean digital color, faint shadow noise".
5. **Anti-plastic skin (the most important one; the main source of the AI smell)**: kill the specular zone by zone = zero gloss on the forehead, bridge of the nose, cheekbones, temples and jaw. Real peach fuzz at the jaw and hairline. SSS (subsurface scattering). "skin reads matte without going harsh, real fine pore texture, peach fuzz at hairline, subsurface scattering, zero specular on forehead/nose bridge/cheekbones". **No excessive retouching.**
6. **Build the character on a mid-grey background**: reference sheets and face builds go on **mid-grey seamless**, not pure white. Pure white turns the skin plastic. Grey makes it render the gradation and shadows of skin correctly.
7. **Volumetric light (give the air a body)**: flat air is the tell of AI. Put in haze density, particulate in the air, shafts of light, and falloff between subject and background. "atmospheric haze, particulate in air, light falloff between subject and background". Use it lightly even for editorial or clean studio work.
8. **A face that is too perfect is worthless**: freckles, moles, pores, asymmetry, soft cheeks. "natural imperfect beauty, not a model face, girl-next-door".

## Projecting this onto our local pipeline (the execution side)
- Generation: `AIInfluencer01/gen_flux_pulid.py <concept...> [--seed N]` (the photoreal LoRA strength comes from the REALISM_LORA env var).
- The settled workflow values (`ai-influencer` skill, §photoreal pipeline): UnetLoaderGGUF(flux1-dev-**Q6_K**) → LoraLoaderModelOnly(**flux_realism_xlabs.safetensors 0.6**) → **ApplyPulidFlux(weight0.85, start0, end0.85, ref=elena_signature.png)** → KSampler(**steps30, cfg1, dpmpp_2m, beta, denoise1**) ← **FluxGuidance 2.5** + DualCLIP(t5xxl_fp8+clip_l) → VAEDecode(ae). **832×1216**.
- Write the prompt in natural sentences; quality tags are forbidden (do not write "masterpiece" and the like). Tokens for realness: `natural skin texture, visible pores, faint freckles, small mole, catchlight`. The trick for the iPhone-photo look: `shot on iPhone, candid, amateur, off-center` plus the filename `IMG_9999.JPG`.
- Keep FluxGuidance low (2.0-2.5) for photoreal. Set PuLID's end_at to 0.8-0.85 (hand the back half over to Flux's photoreal rendering = the face stays locked while the skin gets real).
- Post-processing: `post_process.py` (saturation -10%, gentle S-curve, fine grain/vignette, JPEG without EXIF). **Use the raw, pre-post-processing images for LoRA training data** (grain belongs to the later stage only).
- **Always go through the GPU signal**: `gpu-signal.sh run <name> "<cmd>"`. AI influencer work is **the lowest priority** = `polite_batch.sh` re-queues it at the tail of the FIFO, and it yields whenever another department's generation comes in.

## The 6-panel character reference sheet (the source for Subject Lock; make it first)
6 panels in 3 columns × 2 rows on 1 image, separated by white gutters. Mid-grey seamless shared by all panels, relit (1 broad diffuse light from slightly above and to the upper left; no rim or hair light).
- P1 full body, front (cocked-hip; the whole style readable from hair to shoes)
- P2 left profile close-up (collarbone up; accessories/jaw/hairline)
- P3 full body, back (how the hair falls, the back of the clothes, the shoes)
- P4 right profile close-up (the mirror of P2)
- P5 front face close-up (facial structure, skin quality, eyeline readable, nothing occluding)
- P6 detail (the ring on the hand, the chain at the neck and so on, in 1 panel)
Identity/wardrobe/accessories/proportions stay fixed in every panel. `real fine even pore texture, peach fuzz, subsurface scattering, real fabric weave, soft film grain, photographed not generated, identical character identity locked across all six panels`. → This becomes the Subject Lock reference for every later cut.

## Product commercial still template (the v1 K-beauty type = the mainstay for product introduction)
Input = the signature face + the product image. The goal = the face-consistent model holding / using / seen through a mirror with the product.
`Frame Map: the subject is centre-slightly-right, chest up, eyeline on the camera or on the product. She holds the product in her right hand at chest height, with a small mirror reflection to the upper left.` + `Subject Lock (the signature face ref)` + `Lighting: a catchlight on the product, a soft key on the subject, a clean warm-pink studio` + `Camera: 85mm at wide aperture, shallow DOF, soft studio, clean minimal background` + anti-plastic skin. **Do not write the real name on the product label** (composite it separately, or drop in the real object). Always finish with 1 more cut that is a hero shot of the product.

## The boundary between the 2 lines (strict)
- **A line (school, children)**: fully G-rated. Do not write swimwear, bodycon or any sexual vocabulary at all. Wholesome, clean, bright.
- **B line (Elena / creative)**: clothed SFW sensuality is allowed (`full soft feminine bust, natural generous cleavage, soft décolletage`). Nudity and anything explicit are permanently forbidden.

## Append rule
Winning patterns and failures get appended each time to this skill and to `InfluencerStudioCoco/knowledge/` (never delete anything).
