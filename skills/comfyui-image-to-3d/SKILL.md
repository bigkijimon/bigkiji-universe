---
name: comfyui-image-to-3d
description: Generate game-ready 3D assets locally & free with ComfyUI + Hunyuan3D-2 (image→3D→GLB), driven via the ComfyUI HTTP API, then import into Unreal. Covers pro input-image prompt design, background removal, resolution/mesh settings, multi-view, and the GLB→UE pipeline. Trigger when generating 3D props/objects for the なつやすみ game or any local image-to-3D task. Avoid paid Fab/APIs — this is the free local route.
---

> Translated from the owner's Japanese original at `~/.claude/skills/comfyui-image-to-3d/SKILL.md`. The Japanese file remains the source of truth.

# Local image→3D (ComfyUI + Hunyuan3D-2), professional operation

The proper way to **turn objects (houses, props, trees…) into 3D locally and for free**, without buying paid Fab/cloud APIs.
Import into UE with `StaticMeshTools.import_file` ([[unreal-mcp-gamedev]]). **Do not run UE and ComfyUI at the same time** ([[local-ai-memory-mac]]) — close UE while generating.

## Models (models/checkpoints/)
- Shape: `hunyuan3d-dit-v2-0-fp16.safetensors` (Tencent, published on HF as `tencent/Hunyuan3D-2`, ~4.9GB, no auth needed). The fast variant is `hunyuan3d-dit-v2-0-fast`.
- Note: ComfyUI-native Hunyuan3D is **shape only** (no texture/PBR — Hunyuan3D-Paint is separate). Colour comes later from UE-side materials or separately.

## Iron rules for the input image (80% of the quality is decided here; researched)
1 object only / **front or isometric** / **even light, no shadows or reflections** / **clean background (plain white)** / the object fills **50% or more** of the frame / no text, people or logos. PNG recommended, square, high resolution.
- Example generation prompt (SDXL/Flux): "a single <object>, centered, full object visible, plain pure white seamless background, soft even studio lighting, product photograph, photorealistic, sharp focus, no text, no people, no shadow"
- negative: "multiple objects, text, watermark, people, cropped, harsh shadow, reflection, cluttered, dark background"
- **With the front only, the back comes out weak** → if you can, make front+back+side and raise geometric accuracy with **Hunyuan3Dv2ConditioningMultiView** (multi-view).

## Pro node graph (single view)
`LoadImage → ResizeAndPadImage(square) → [background removal] → CLIPVisionEncode → Hunyuan3Dv2Conditioning → KSampler → VAEDecodeHunyuan3D → VoxelToMesh(Basic) → SaveGLB`
- Image prep: square-pad with `ResizeAndPadImage`. **Background removal** = `LoadBackgroundRemovalModel`→`RemoveBackground(image)→mask`→composite white using the mask, or make it alpha (optional; can be skipped if the input is already plain white).
- `ImageOnlyCheckpointLoader(ckpt=hunyuan3d-dit-v2-0-fp16)` outputs = [0]MODEL [1]CLIP_VISION [2]VAE.
- `CLIPVisionEncode(clip_vision=[ckpt,1], image=<prepped>, crop=center)`→CLIP_VISION_OUTPUT.
- `Hunyuan3Dv2Conditioning(clip_vision_output)`→[0]positive [1]negative.
- `EmptyLatentHunyuan3Dv2(resolution=3072, batch_size=1)`.
- `KSampler(model=[ckpt,0], positive, negative, latent, seed, steps=30, cfg=5.5, sampler=euler, scheduler=simple, denoise=1.0)`.
- `VAEDecodeHunyuan3D(samples, vae=[ckpt,2], num_chunks=8000, octree_resolution=256)`→**VOXEL**. **To raise detail, octree_resolution=384〜512** (gets heavy).
- `VoxelToMeshBasic(voxel, threshold=0.6)`→MESH (`VoxelToMesh` requires the algorithm COMBO, so Basic is the safe one).
- `SaveGLB(mesh, filename_prefix)`→ a .glb in `ComfyUI/output/`.

## Driving it over the ComfyUI HTTP API (Claude calls it directly)
- For both image generation and 3D generation: **POST `/prompt` {"prompt": <API graph>}** → `prompt_id` → poll **GET `/history/<id>`** → get the filename from `outputs`. Images are at `/view?filename=..`; the GLB is directly under `output/`.
- Node references are `["<nodeid>", <out_index>]`. Check a node's input spec with `GET /object_info/<NodeName>` (enum/default).
- After downloading a new model, hit `/object_info` once and ComfyUI rescans and recognises it.
- For huge models such as Ollama's, keep `num_ctx` small and run `ollama stop` when you are done. ComfyUI memory is released with `POST /free {"unload_models":true,"free_memory":true}` ([[local-ai-memory-mac]]).

## Importing into UE ([[unreal-mcp-gamedev]])
`StaticMeshTools.import_file(folder_path, asset_name, source_file=<glb full path>, import_materials=true, import_textures=true)` → becomes a StaticMesh → place it with `add_to_scene_from_asset`. Use `generate_lods` / `generate_convex_collisions` / Nanite as needed.

## MPS (Apple Silicon) caution
Whether Hunyuan3D runs on Mac (MPS) has to be measured (3D things have a track record of dying on MPS over conv3d and such: [[seedvr2-unusable-on-mps]]). **Confirm feasibility with 1 test generation first**, then mass-produce. Note: the graph in this skill must be updated with the measured MPS result after verification (below).

## Measured log (verified 2026-07-22)
- **★It runs to completion on MPS = yes**: successfully generated a vending machine with `hunyuan3d-dit-v2-0-fp16`(4.9GB). **About 368 seconds each** (res3072, steps30, octree256). GPU utilisation measured at 100% = it is alive on the Mac's MPS (unlike the earlier case [[seedvr2-unusable-on-mps]], it does not fall over). Output = a real mesh with 709,200 vertices / 354,600 faces. **The core of free local 3D conversion is proven.**
- **★Input-directory trap**: the running ComfyUI's cwd is `ComfyUI/ComfyUI-clean/`, so inputs go in `ComfyUI-clean/input/` (in `ComfyUI/input/` LoadImage returns 400 "Invalid image file"). To check where the running process reads from: `lsof -a -p <pid> -d cwd`. Output is `--output-directory ~/Documents/ComfyUI/output`.
- **★Background baked into the mesh (needs a countermeasure)**: even on a white background, **the floor under the object got solidified into a feather-shaped fin** (visible in the side/top views). Cause = the object touches the bottom edge of the frame and the floor is mistaken for ground.
  - **Free countermeasures** (background-removal models are not installed = the `LoadBackgroundRemovalModel` list is empty, and `BriaRemoveImageBackground`/`Recraft...` are paid APIs = rejected [[no-paid-gen-api-without-approval]]):
    1. **Generate the input image floating** (floating, centered, ~55% size, not touching the edges, strengthen no ground/floor/shadow/reflection in the negative).
    2. Insert **`ResizeAndPadImage(target 1024², padding_color=white)`** into the graph to add white margin = the object no longer touches the edge → the baked-in floor disappears.
    3. If you do need a threshold mask on the white background, `ImageColorToMask(color=16777215白)`→`InvertMask`→`JoinImageWithAlpha` produces alpha without any model (CLIPVisionEncode does not support masks, so padding takes priority).
- Image generation (SDXL/RealVisXL) works fine over the API. The 3-view silhouette check is done by hand-plotting vertices with matplotlib (hand-parsing the GLB: JSON chunk→POSITION accessor→`np.frombuffer('<f4')`) = a light inspection that needs no trimesh.
- **Pro-version verification (2026-07-22, 2nd run)**: floating input + `ResizeAndPadImage` + octree320. **The floor fin is gone (padding works)**. However, **a round bulge appeared on the side** = **the intrinsic limit of a single viewpoint** (the model invents the side and back). The front is extremely good (it even reproduces the product shelves). Took 508 seconds at octree320 (heavier than the 368 seconds at octree256). 1,100,000 vertices.
  - **Conclusion = accept the trade-off per use case**: ①things placed against a wall or along a street (vending machines/postboxes/shopfronts/bus stops) are **fine with a single front-3/4 view** (sides and back are hidden or far away). ②things you walk around (houses, shrine halls) need sides and back → **strictly this calls for multi-view** (`Hunyuan3Dv2ConditioningMultiView`), but generating viewpoint-consistent front/back/side images **requires an MV diffusion model (separate download, not yet verified on MPS)** = for now we accept "good front, soft sides and back" from a single viewpoint. For houses, decide after generation based on how they look in UE.
  - An input closer to **true frontal (orthographic)** reduces the guesswork drift on the sides and back (3/4 tends to make the side ambiguous). Even if shadows are faint, strengthen `no shadow/ground` in the negative.

## Evolution log = evaluate every generation and feed it back (owner's policy: raise quality in steps)
Operation = generate 1 item → **visually evaluate the input image plus the 3-view silhouette** (front fidelity / hallucinated sides and back / baked-in floor / proportions / text) → feed the improvement into the next prompt/angle/octree/threshold → append what you learned here. Helper = `scratchpad/gen_one.py` (a JSON config drives image→3D→GLB cleanup and outputs `eval_<name>.png` with the 3 views, `in_<name>.png` with the input thumbnail, and vertex/bbox statistics).
- **★Pick the angle from the shape** (proven): **boxy/flat things (vending machine, TV, house) = close to true frontal** (suppresses the hallucinated side bulge); **cylinders and round things (round postbox etc.) = 3/4** (lets it recognise roundness and produce a true circle). The round postbox at 3/4 came out with a perfect circular side and no baked-in floor = success.
- **★Absolutely no Japanese text** (explicit owner instruction, important): SDXL **mangles Japanese and mixes in Chinese**. Ask for text on a sign or nameplate and you get garbled characters baked in as relief ("MOROI" and the like appeared on the round postbox). → **positive `blank unmarked surfaces, no writing, no text` / negative `text, letters, chinese characters, japanese text, garbled text, gibberish, watermark, logo`**. **Real Japanese signage goes in later and correctly as a UE-side texture/decal** (3D is shape only, so this is no problem).
- octree 256 = about 356 seconds each (240,000-480,000 vertices), 320 = about 508 seconds (more detail). Mass-produce at 256 and re-generate hero assets at 320 later.
- **★Baked-in floor from "things that sit on a stand"** (recurs with TVs and other appliances): SDXL turns `television` and friends into a product photo on a desk with reflections on its own → the stand haloes into a floor. `floating` alone loses. → **Strengthen COMMON to "levitating in an empty pure white void, nothing underneath, no surface/table/desk/shelf" and add `table, desk, surface underneath, reflection` to the negative**. Padding alone does not remove the reflection, so the key is to keep the surface out of the prompt entirely.
- **★Display stands / plinths creeping in** (frequent with small gadgets): SDXL adds the white pedestal of a product shot on its own → in 3D it becomes a base slab plus a halo blob around it (measured on flip_phone/pager). → negative `podium, plinth, display stand, riser, base slab, object on a block`; COMMON "levitating in mid air, absolutely nothing underneath, no plinth/podium/stand".
- **★Small props should fill the frame**: floating with a big margin makes the object too small → not enough information and it blobs. Add "large and prominent, fills most of the frame" to COMMON. ResizeAndPad does not add margin to a square input (it only looks like it does), so make it big on the SDXL side.
- **★★What it is and is not good at (most important, settled by measurement)**: **thick, solid masses = good** (round postbox / TV / vending machine / boombox / appliances / furniture / stone statues / lanterns / cars / buildings). **Thin, small or flat things = bad; they pancake or blob** (feature phones, pagers, cassettes, thin toys… prompt improvements do not give them thickness = a fundamental limit of the single viewpoint). → **Do not put thin small props through Hunyuan3D; make them as simple primitives (small boxes) in UE** — faster and cleaner. Point the AI generation at solid masses.
- **★Thin attachments (cords/cables/antennas/strings) scatter into spaghetti in mid-air** (measured on the Famicom controller cable). → Remove cord/cable/wired/antenna and so on from the prompt and draw only the body. For a torii and similar, say "thick pillars" explicitly.
- Measured evaluation: ✅postbox ✅vending ✅crt_tv ✅boombox ✅electric_fan (excellent: blades/guard/stand) ✅vhs_deck ✅twin_tub_washer 🔶gameboy (thick enough, OK) ❌flip_phone/pager (thin and small → blob) ❌famicom (cord scatters). **Yield on solid masses ≈ 80%.** Aim at appliances/furniture/statues/buildings/cars and mass production is viable.

## 137-item QA summary (2026-07-23, settled across every category)
- **★Vehicles are better than expected**: tricycle / tractor / Super Cub / wheelbarrow / bus / sedan / kei van = all excellent. **When there is a clear structural hint such as wheels, even a fairly flat shape does not collapse** (the wheels compensate for the weakness with thin small things).
- **★The core なつやすみ icons succeeded**: wooden bridge (arch + railing) / hand pump / festival yagura / taiko drum / dog house / food stall / mikoshi = excellent. Solid masses with a distinctive silhouette are strong.
- **Display set pieces excellent**: dagashi shelf / display case / Umaibō box / a pile of Butamen / bottles = making individually wrapped thin items "together with the box or shelf" works (individual thin sweets are impossible, so group them).
- **For statues, saying "only 1" removes the duplication** (jizo / fox / komainu). Organic things (garden stones, hay) come out noisy but are fine for their purpose (rocks/straw).
- **Flat signboards (illuminated or wooden) come out thin with a halo** = usable but needs care. **Adding volume for a frame or stand stabilises it.** Do not put the text in the generation; use a UE decal.
- **Deep boxes (TV/fridge/chest of drawers/microwave) get a slight depth halo on the sides** = practical for a wall-side placement where the front is what matters.
- **The overall yield holds at ≈85% across every category.** The failures are limited to thin small things (phones, pagers) and thin attachments (cords, antennas) = already removed from the catalogue.
- Inspection method = montage each category's `eval_*.png` (3 views) into 2 columns → look at them. Read them together with the input thumbnails `in_*.png` to identify the cause.

## Complementary split = thin/lattice structures and GLB cleanup go to Blender ([[blender-gamedev]])
- The area **this skill excludes** (cords/antennas/**window grilles/fences/handrails/power lines/rails/steel-bridge trusses/torii detail**) = thin small things and thin attachments — those get **generated procedurally in bpy with Blender curves + bevel + array** (the `blender-gamedev` skill; the driver `gen_one.py` is verified on the real machine). Strengths (solid masses) go to this skill, weaknesses (thin/linear) go to Blender.
- **Hunyuan3D GLBs have no UV, no normals and no materials** (measured: abacus.glb = 770,000 vertices / UV0 / mat0) → besides triplanar colouring in UE, there is also the route of **unwrapping UVs, fixing normals, LODs, scale and origin in Blender and exporting FBX** (`blender-gamedev`). The standard for UE import is: solid-mass GLB = triplanar; Blender-made thin structures = UV + trim sheet.
