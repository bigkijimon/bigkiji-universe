---
name: "Blender Gamedev (headless bpy → UE)"
description: "Drive Blender 5.2 headless (bpy) on Mac to procedurally generate the THIN/LATTICE assets Hunyuan3D can't (fences, window grilles, handrails, power lines, rails, torii crossbars, truss), AND to clean Hunyuan3D GLBs (UV/normals/LOD/scale) for Unreal Engine 5.8. Use when making linear/wire/lattice props for the なつやすみ game, prepping any GLB for UE, or batch-generating assets from JSON specs. Free & local — complements comfyui-image-to-3d (chunky props). All operators verified on Blender 5.2.0 LTS."
---

> Translated from the owner's original at `~/.claude/skills/blender-gamedev/SKILL.md`, which is already largely in English. Only the Japanese heading and gloss were translated; that file remains the source of truth.

# Blender Gamedev — headless bpy for thin/lattice assets + GLB cleanup → UE5.8

**Why this exists.** `comfyui-image-to-3d` (Hunyuan3D) makes great *chunky* props but **fails on thin/linear/lattice** things (wires, antennas, fences, grilles, rails, truss → spaghetti). Blender fills exactly that gap via **curve+bevel+array**, and doubles as the **cleanup station** for Hunyuan GLBs (which have no UV/normals/materials). Operator by an AI, **headless**, on Apple Silicon Mac. Every command below is **verified on Blender 5.2.0 LTS** on this machine (not recalled).

- Binary: `/Applications/Blender.app/Contents/MacOS/Blender` (5.2.0 LTS, bundled Python 3.13).
- Ready-to-run driver: `scripts/gen_one.py` (JSON spec → UE-ready FBX). **Tested end-to-end** (fence 520 / grille 164 / powerline 652 polys).
- Judgment/quality layer (Nanite, texturing, collision, scale, art-direction): `docs/best-practices.md` — **read it before building at scale.**
- GPU discipline: modeling/bpy generation is **CPU** → does NOT fight ComfyUI's GPU. Only Cycles *render* uses GPU, and we never render for assets (we export meshes). See [[local-ai-memory-mac]] signal rules. Complement: [[comfyui-image-to-3d]].

## Quick start (batch-generate thin assets)
```bash
BL=/Applications/Blender.app/Contents/MacOS/Blender
SK=~/.claude/skills/blender-gamedev
"$BL" --background --factory-startup --python $SK/scripts/gen_one.py -- \
      --spec $SK/resources/specs/iron_fence.json --out ./out
# -> out/IronFence_A.fbx (UE axis, UCX_ collision, base-centered origin)
```
Spec types implemented: `fence`, `grille`, `handrail`, `powerline`, `rails`. Example specs in `resources/specs/`. Add a builder to `BUILDERS` for new asset classes.

## Headless invocation rules (verified)
- `--background --factory-startup --python script.py -- <args>`. Read args after the lone `--`: `sys.argv[sys.argv.index("--")+1:]`.
- `--factory-startup` = deterministic (ignores user config/add-ons); glTF & FBX are core add-ons and load fine.
- Clean scene = `bpy.ops.wm.read_factory_settings(use_empty=True)` (wipes ALL datablocks; better than deleting the default cube).
- Wrap `main()` in try/except → `sys.exit(1)` so the batch runner sees failures.
- **`bpy.context` works headless** (`collection`, `view_layer.objects.active`, selection). Prefer `bpy.data`/`bmesh`; use `bpy.ops` only for: `object.convert`, `object.join`, `uv.smart_project`, `object.transform_apply`, `object.shade_smooth_by_angle`, `export_scene.*` — all confirmed working in `--background` if you set active+selection first.

## The atom: curve + bevel = a thin rod
Everything thin is a **POLY/BEZIER curve with a bevel**, optionally **arrayed**, optionally deformed. See `scripts/gen_one.py` for `rod_from_points`, `add_array`, `catenary_points`, and the 5 builders. Key facts:
- `curve.bevel_depth` = radius; `bevel_resolution=0` → 4-sided (square bar), higher → round pipe.
- `curve.bevel_mode` ∈ `ROUND / OBJECT / PROFILE` (5.2). Use `PROFILE` (`bevel_profile.segments`) or a `bevel_object` curve for ornate square/L/moulding sections (handrails, torii).
- POLY spline points are **4D** (`co=(x,y,z,1)`).
- Array: `modifiers.new(n,'ARRAY')` with `use_constant_offset=True`, `constant_offset_displace=(m,0,0)` for fixed metric spacing (pickets, sleepers, bars).
- Power lines: sample a **parabola** `dz=-4·sag·t·(1-t)` (visually identical to a catenary at game scale; no transcendental solve).
- **Verdict: use modifiers + curve-bevel, NOT scripted Geometry Nodes** (GN socket API is a moving target in 5.x; author GN in-GUI and append if ever needed).

## Hunyuan3D GLB cleanup → UE-ready
Import + clean chain (all verified; real Hunyuan GLB round-trips):
```python
bpy.ops.import_scene.gltf(filepath=p, merge_vertices=True, import_shading='NORMALS')
# then: merge_by_distance(bmesh) → shade_smooth_by_angle(radians(30)) →
#       smart_project UV → origin_set BOUNDS + drop to Z=0 → transform_apply
```
- Hunyuan GLBs = **no UV, no materials, ~hundreds-of-k verts, near-dupe verts** (confirmed: abacus.glb = 774k verts, uv=0, mats=0). `merge_vertices=True` + bmesh `remove_doubles` cleans them.
- `bpy.ops.object.shade_smooth_by_angle(angle=...)` (NOT `mesh.use_auto_smooth` — removed in 4.1).
- LODs via `DECIMATE` modifier (`decimate_type='COLLAPSE'`, `ratio=`) — optional (UE auto-LODs too).

## Export to UE5.8 — FBX (not glTF into UE)
```python
bpy.ops.export_scene.fbx(filepath=p, use_selection=True, object_types={'MESH'},
  mesh_smooth_type='FACE', use_tspace=True, add_leaf_bones=False,
  apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',
  axis_forward='-Z', axis_up='Y', bake_space_transform=True)  # static meshes only
```
- **FBX for into-UE** (UCX collision / LOD / socket conventions are FBX-native). Keep GLB for preview only. Hunyuan gives GLB in; Blender exports FBX out.
- `bake_space_transform=True` bakes the axis conversion so the mesh lands upright at rot (0,0,0) — **static meshes only** (breaks armatures; set False for skeletal).
- **UE collision:** name a simple collider `UCX_<MeshName>_00` (`UBX_`/`USP_`/`UCP_` for box/sphere/capsule), export in the same selection. **NEVER auto-convex a holey lattice** — the convex hull fills the holes into a wall. `gen_one.py` auto-adds a `UCX_` box.

## Opinionated verdicts (full rationale + sources in `docs/best-practices.md`)
- **Scale discipline = the #1 bug source.** Model in meters, **Apply All Transforms** (scale=1,1,1 / rot=0), **origin base-centered at Z=0** so props ground-snap in UE. `finalize()` does this.
- **Do NOT Nanite thin/wire/faceted low-poly** (fences, wires, grilles, rails). Epic's docs: holey/aggregate/faceted geo = overdraw + slow paths. Use plain static meshes + **HISM instancing + cull distances**.
- **Texturing: UV-unwrap the ~200 Blender props onto ONE shared trim sheet** (consistency + ~3-4 master materials for the whole town). Keep **triplanar only for the no-UV Hunyuan GLBs** and organic surfaces.
- **Collision: simple boxes / hand-authored UCX_**; never per-poly; server-cheap.
- **Art direction: clean low-poly + warm light beats a heavy PSX pixel post-process** — real Boku-no-Natsuyasumi was clean/warm, and true pixelation forces TAA off (worse thin-geo aliasing on low-spec). Treat PSX as an optional toggle, not the base. (Owner decision pending — see [[blender-role]].)
- **Low-spec server (4GB):** decorative props must be **non-replicated/instanced**; the server budget is memory+replication+collision, not rendering.

## Measurement required (verify on real UE before trusting in production)
1. **UE import axis/scale** — import one `gen_one` FBX into UE5.8; confirm upright at rot(0,0,0) and real size (6 m fence ≈ 600 cm). If tilted, toggle `bake_space_transform` / "Force Front XAxis". *Only thing not verifiable without UE.*
2. `UCX_<name>_00` auto-attaches as simple collision on 5.8 import.
3. smart_project texel density on dense Hunyuan meshes (may need Decimate first / `island_margin` tuning).
4. Real Hunyuan GLB normals after `import_shading='NORMALS'`+`shade_smooth_by_angle` (faceting check).
5. Actual dedicated-server RSS with a town loaded (4GB is the weak link).
6. PSX compositor route socket strings (if ever used) — the render-small + external nearest-upscale path avoids it.

## Cinematics (non-gameplay only)
Blender grey-box + animated camera → render 24fps mp4 → feed as **motion reference** to local
`ltx-2-mlx ic-lora --video-conditioning` (🟢 Stable, free, no API key). Text prompts can't control
camera/timing/space — the blockout does. Rough blockouts beat detailed models. **Never for gameplay
footage or trailers** (use UE Sequencer). Full method, the IC-LoRA blocker and the first smoke test:
`docs/blockout-to-ai-video.md`.

## Related
[[comfyui-image-to-3d]] (chunky props) · [[unreal-mcp-gamedev]] (UE import) · [[local-ai-memory-mac]] (GPU signal) · vault: `参考資料/blender-role.md` (the reference-materials folder), `MASTER-ROADMAP.md`.
