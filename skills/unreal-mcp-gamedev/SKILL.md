---
name: unreal-mcp-gamedev
description: Connect Claude Code to Unreal Engine 5.8+ via the official "Unreal MCP" (ModelContextProtocol) plugin so Claude can drive the editor, and build games (esp. the なつやすみ project). Covers server start, the port-8000/ComfyUI conflict gotcha, client registration, and reconnect. Trigger when working on the Unreal game, connecting Claude to UE, or seeing UE MCP connection failures.
---

> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/unreal-mcp-gamedev/SKILL.md. The Japanese file remains the source of truth.

# Game development with Unreal MCP (connection and practice)

Field notes for having Claude Code drive the Unreal Editor directly through Epic's official experimental "Unreal MCP" plugin.
Project background is in memory [[natsuyasumi-game-project]]. Operating rules are [[stuck-then-research-then-skill]].

## Connection procedure (established by measurement 2026-07-22)

0. **Free memory with `ue-prep` before opening UE** (mandatory). If the 64GB shared memory is exhausted by Ollama/ComfyUI, UE freezes. Details: [[local-ai-memory-mac]].
1. **Open the project in UE** (e.g. `UEIntroProject`). The engine itself is at `/Users/yuma/UE_5.8` (not under Shared).
2. **In the `Cmd` (Enter Console Command) field at the bottom of UE**, start the server:
   - `ModelContextProtocol.StartServer <port>` … specifying the port explicitly is recommended (avoids the conflict described below)
   - Example: `ModelContextProtocol.StartServer 55557`
   - To stop: `ModelContextProtocol.StopServer`; to regenerate: `ModelContextProtocol.GenerateClientConfig ClaudeCode`
3. **Check the connection (Bash on the Claude side)**: hit MCP initialize with `curl`:
   ```
   curl -s -i -X POST http://127.0.0.1:<port>/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}'
   ```
   → Success if it returns HTTP 200 + `Mcp-Session-Id` + `"tools":{"listChanged":true}`.
4. **Register it with Claude Code (global/user scope recommended)**:
   `claude mcp add --transport http --scope user unreal-mcp http://127.0.0.1:<port>/mcp`
   → Confirm `unreal-mcp ... ✔ Connected` with `claude mcp list`.
5. **Restart the session**: MCP tools added while a session is running do not come down into that session.
   Restart Claude Code (`claude --resume` continues the conversation) and the `mcp__unreal-mcp__*` tools become available.

## Connecting to MCP reliably (established 2026-07-28 after stepping on 3 mines)

**Always start it with command-line flags.** Do not rely on config files:
```
"/Users/yuma/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor" \
  "<project>.uproject" -ModelContextProtocolStartServer -ModelContextProtocolPort=55557
```
- ❌ **Writing it in `DefaultEngine.ini` is not read.** The settings class is `UCLASS(config=EditorPerProjectUserSettings)`,
  so `Config/DefaultEditorPerProjectUserSettings.ini` is the correct file. With flags you do not depend on config at all.
- ❌ **If the Terminal plugin is enabled the editor does not respond to quit requests** (measured: a 15-hour hang).
  Set `Terminal` and `AIAssistant` to `Enabled:false` in the `.uproject`.
- ❌ **`pgrep -f "UnrealEditor..."` matches the monitoring shell itself** and falsely reports "still running".
  Judge by process name (`pgrep -x UnrealEditor`).
- ❌ Using `&` inside a background run means it **gets dragged down when the parent exits**. Use `nohup ... & disown` or
  put the driver in a file and run that.

## Using MCP without restarting the session (hitting HTTP directly)
The `mcp__unreal-mcp__*` tools **do not come down unless UE is already running when the session starts**.
MCP is just JSON-RPC over HTTP, so you can hit it directly with `ue_build/mcp_call.py`.
⚠️ This server responds with **text/event-stream + keep-alive**, so Python's urllib gets blocked by buffering and returns
empty or hangs, whether you use read() or iterate. **Throwing it at curl is the reliable way.**

Calls come in 3 stages: `list_toolsets` → `describe_toolset` → `call_tool`.
⚠️ **Pass every required argument even when defaults exist** (`find_actors` requires name/tag/collision_channels).
⚠️ Argument names differ per tool (`exists` takes `path`, `load_asset` takes `asset_path`,
`set_properties` takes `instance`). The error message contains the schema, so always read it.

## Bulk operations in practice (established 2026-07-28 by moving 669 actors)
- Define `run()` in `ProgrammaticToolset.execute_tool_script` for bulk processing. **Split into 80-150 actors at a time**
  (beyond that the SSE times out and you get an empty response).
- ⚠️ **Trace the ground "before" placing.** If you measure after placing, it **hits the actor itself** and the actor floats tens of thousands of cm into the sky.
- ⚠️ The `name` of `add_to_scene_from_asset` **only goes into the label; it is not reflected in refPath**.
  When you delete it later you cannot search by refPath, so **identify it by label or coordinates**.
- ⚠️ `trace_world` returns **the distance from the start point**, not coordinates. Hit-surface Z = start Z − distance.
- ⚠️ Actor labels sometimes have **the number attached directly** with no underscore, like `Riv14`.
  Prefix detection via `split("_")[0]` fails across the board → `re.sub(r"[0-9_].*$","",label)`.
- ⚠️ **Shrinking the world breaks terrain-following tiles.** Only the position moves while the tilt stays as it was, so
  roads/fields/rivers stick out of the ground. A pass that **re-measures pitch/roll with a 3-point trace** is mandatory.
- ❌ **Media assets (MediaPlayer/MediaTexture/FileMediaSource/MediaPlaylist) cannot be created from MCP.**
  `DataAssetTools.create` can only create UDataAsset subclasses. This part alone is manual work in the editor.

## Traps and lessons (where you get stuck)

- **The default port 8000 conflicts with ComfyUI.** On the owner's machine ComfyUI occupies 8000 (not 8188).
  If you start on 8000 it will not connect, and hitting 8000 returns ComfyUI's HTML. → **Always specify a free port (e.g. 55557)** at startup.
  Check for a free port: `for p in 8000 8188 55557; do curl -s -o /dev/null -w "$p:%{http_code}\n" --max-time 2 http://127.0.0.1:$p/; done` (000=free).
- **Auto-start is OFF by default.** Closing the editor also kills the server. Every time you reopen it you need `StartServer <port>`.
  To make it permanent: Project Settings → Plugins → Model Context Protocol, `ServerPortNumber`=55557 & `Auto Start Server`=ON.
  (config: `ServerPortNumber` / `bAutoStartServer` under `[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]`)
- The connection is only valid while the editor is running. If you close UE, run StartServer again before reconnecting.
- UE's Terminal plugin garbles Japanese → run Claude Code in a normal Mac terminal (not inside UE).
- **Closing the in-UE Terminal freezes/hangs the editor** (the experimental plugin waits for the child process to exit on the main thread; UE5.8 also has many reports of UI freezes).
  → Permanent fix: **disable the `Terminal` plugin in Edit→Plugins** and do not run Claude inside UE. Work only from an external Mac terminal + MCP. If you do not use it, `AIAssistant` can be disabled too.
  → If it hangs, force-quit UnrealEditor with `⌘+Option+Esc` → free memory with `ue-prep` → reopen.

## Practical operating tips (measured)
- The tools are 3-layered: `list_toolsets` → `describe_toolset` → `call_tool(tool_name, toolset_name, arguments)`.
- **CaptureViewport has a required-argument trap**: it is rejected unless you explicitly pass `captureTransform` (get it with GetCameraTransform), `annotations` (all 0 plus classFilter:null if you do not need them) and `bShowUI`.
- **The returned image is huge** (inline base64 over 4MB → context overflow). Take the .txt in tool-results, `json.loads` it in python → base64-decode `returnValue.image.data` into a png → shrink with `sips -Z 1100` → view with Read. **Capture only at key moments.**
- There is no API for creating/saving a level → **ask the user to create a new level and do the first save (Cmd+S)**. Claude does the actor placement and so on afterwards via MCP.
- Do not build while unsaved (/Temp/Untitled). Have it saved as e.g. `Lvl_Natsuyasumi` first, then build (crash resilience).

## Recipe for flat-colour materials (established by measurement, for colouring greybox)
1. `MaterialTools.create_material(folder, "M_X")`
2. `MaterialTools.add_expression(mat, {refPath:"/Script/Engine.MaterialExpressionConstant3Vector"})` → node
3. `ObjectTools.set_properties(node, values='{"Constant":{"R":..,"G":..,"B":..}}')` (linear colour, 0 to 1)
4. `MaterialTools.connect_to_output(node, "", "MP_BaseColor")`
5. `MaterialTools.recompile(mat)`
6. Assignment: on the target actor's component (`<actor>.StaticMeshComponent0`),
   `ObjectTools.set_properties(comp, values='{"OverrideMaterials":["/Game/.../M_X.M_X"]}')`
- Colours actually used: grass=0.10/0.26/0.09, wall (cream)=0.62/0.58/0.50, roof (dark blue tile)=0.06/0.08/0.11, wood=0.30/0.17/0.08, earth=0.34/0.26/0.15.
- Greybox placement: place `/Engine/BasicShapes/Cube` with `add_to_scene_from_asset` and build boxes with the xform scale (1=100cm).
- Evening light: set the DirectionalLight rotation to pitch≈-13, yaw≈-55 (long shadows = dusk).

## How to make terrain (Landscape) (established by measurement; MCP has no sculpting API)
Creating/sculpting a Landscape via MCP is impossible. The reliable procedure is **generate a 16bit heightmap → import it in UE**:
1. Claude generates a 16bit greyscale heightmap (RAW with pure python `array('H')`; PNG too if PIL is available). Hills = add a Gaussian, rivers = subtract a Gaussian valley, rolling = sin composition. Value 32768 = sea level. Example: `/Users/yuma/Documents/natsu_heightmap_505.png` (505×505).
2. **User operation** (not possible over MCP): New Level(Basic) → save → set the top-left mode to **Landscape** → **New → Import from File** → pick the PNG → **Scale X/Y=100, Z=40** (height adjustment) → **Import** → back to Selection Mode → save.
3. Post-processing on the Claude side: get `Landscape_0` with `find_actors(name="Landscape")`. **Greening** = `ObjectTools.set_properties(Landscape_0, {"LandscapeMaterial":"/Game/.../M_Grass.M_Grass"})`. Delete Basic's `Floor_0` with `remove_from_scene`.
4. Placing things on the terrain: use `snap_to_ground:true` on `add_to_scene_from_asset`, or get the ground height with `SceneTools.trace_world(start_up, end_down)` and place accordingly.
- 505 is the recommended size (8×8 components). Adjust the strength of the relief with the Z scale (40 gives about ±26m). Proven level = `/Game/Lvl_Natsu`.

## Town building in practice (established 2026-07-24, the run where all districts were built in `/Game/Lvl_Natsu`)

### The placement rulebook (do it any other way and it will be off)
Imported meshes are **all tiny** (Blender FBX=1/100, Hunyuan GLB≈2cm class after normalization). Do not guess — always measure:

1. Spawn with `add_to_scene_from_asset`
2. **Measure the real size** with `get_actor_bounds`
3. **Compute the scale factor** from the target height/width and apply it
4. **Lift it up to Z=200000** once (definitely above the terrain)
5. Get the ground height with `SceneTools.trace_world` (top → down)
6. Set Z so that the **bottom of the bbox** sits on the ground and call `set_actor_transform` (send yaw/scale at the same time)

### Traps in `ProgrammaticToolset.execute_tool_script`
This is the fast way to do bulk work, but writing it like plain Python will break:
- **You cannot pass a default to `_StrictDict.get()`** → `d.get("k", 0)` is not allowed. Access directly with `d["k"]` and
  test existence with `if "k" in d:`.
- **`execute_tool` sometimes throws RuntimeError** → catch it with `try/except` and you can carry on.
  Write it so that 1 failed actor does not stop the whole run.

### Terrain-following tiles (fields, rivers, roads) = laying them flat is strictly forbidden
When you represent fields/rivers/roads with thin slabs, **laying them flat buries them in the slope and they get clipped into triangles**.
→ **Trace `trace_world` at 3 points of the tile, derive the terrain normal, compute pitch/roll and tilt the tile flush.** Then it sits on the slope.
(Roads are `Slab_Road` with an earth material. Lining up square tiles looks zigzag, so **stretching them into rectangles** is smoother.)

### Splitting up the materials
- Canon = `/Game/Natsu/Mat/M_Master_Surface` (BaseColor/Roughness/Metallic) + the MI family
  (Wood/Tile/Plaster/Metal/Stone/Plastic/Glass/Kawara瓦/TinRust錆/Brick/Rail/Botayama)
- If you use **`join_all_mat` in Blender's `gen_one.py` to put the roof parts in a separate slot**,
  you can paint **walls = plaster/wood and roof = tile/rusted tin** in UE. The building suddenly starts looking like a building.
- **Do not use Nanite/Lumen** (settled 2026-07-23; clean low-poly and low-spec take priority). Hunyuan blobs get a bulk
  DECIMATE in Blender → plain StaticMesh + **HISM**.

### Screenshot workflow
`EditorToolset.EditorAppToolset.CaptureViewport` (annotations disabled with all 0) → the base64 is huge and gets
offloaded into tool-results → decode the newest file to PNG with `scratchpad/shot.py` → view with Read.
Decide the angle with `SetCameraTransform` / `FocusOnActors` before shooting.

## Asset pipeline (the policy for this project)

Every asset is generated locally, zero paid APIs ([[no-paid-gen-api-without-approval]]): 3D=ComfyUI(TRELLIS2/Hunyuan3D),
images/textures=Flux, BGM=ACE-Step(`music-gen`), SFX=Stable Audio Open and the like. → Details of image→3D are in a separate skill, `comfyui-to-3d` (to be written).

## Required reading before touching a level in bulk (established 2026-07-29, rebuilding the town)

### ⚠️ The 3 most important ones (each of them broke the town 1 time)

1. **The `xform` of `set_actor_transform` cannot be partially updated.**
   The description says "omitted fields are left unchanged", but **in reality omitted fields revert to their initial values**.
   Send only the location and the scale goes to 1.0; send only the scale and the location goes to the origin.
   All 762 actors collapsed to (0,0,0) with scale 1.0.
   → **Always send all 3 of location / rotation / scale.**

2. **While PIE (play) is running, `find_actors` returns the PIE duplicate world.**
   The refPath becomes `/Game/UEDPIE_0_...` and anything you write **disappears the moment you stop PIE**.
   The previous session's PIE had been left on for 15 hours and 15 minutes of extraction work was wasted entirely.
   → Scripts that read or write a level must **stop PIE at the very beginning** (`mcp_call.ensure_no_pie()`).

3. **`MaterialTools.delete_expression` crashes the whole editor** (measured on UE5.8).
   The crash dump call stack is `BreakLinksToExpression`.
   → When you want to rebuild a material, **create a new material and swap the MI's parent**
   (`create_material` → `MaterialInstanceTools.set_parent`). **Do not delete it.**

### How to recover from a crash (2 mines here)
- **CrashReportClient keeps holding the MCP port.** A newly launched UE will not connect.
  Check with `lsof -nP -iTCP:55557` and `kill -9`.
- **Startup stalls on the "Restore Packages" modal** (the autosave restore confirmation). It never gets past frame 0.
  Slate buttons are not exposed to AX, so even osascript cannot press them.
  → Move `Saved/Autosaves/PackageRestoreData.json` out of the way before starting and it will not appear.
- **After a restart the default map opens.** Reopen the level you are working on with `SceneTools.load_level`
  (I once shot screenshots of a different level without noticing).

### Sandbox limits and speed
- `execute_tool_script` **does not allow `import unreal`** (only copy/re/datetime/json/time/math).
  Everything goes through `execute_tool` = **1 call ≈ 0.4 seconds**. 774 actors × 3 calls ≈ 16 minutes.
  → **Split it into chunks**, run them as several requests, and run in the background.
- For embedding, use **`repr()`. `json.dumps` is forbidden** (JSON's `true/false` become undefined names in Python).
- Return shapes differ between versions: `get_actor_bounds` returns **`{min,max}`** (not origin/extent).
  `ObjectTools.get_properties` returns a **JSON string** (you need `json.loads`).
- The argument names are all over the place: `exists`→`path` / `load_asset`→`asset_path` / `set_properties`→`instance` /
  `get_expressions`→`material_or_function` / `delete_expression`→`material_or_function`+`expression`.
  The error contains the schema, so always read it.
- Even on success, **warning text can get mixed into the body**. Pick up the final `{"returnValue"...}` and you still get the result.

### Minimal setup for wiring a texture into a material
`TextureCoordinate × TexScale(Scalar)` → 3 `TextureSampleParameter2D`
(`AlbedoTex`/`NormalTex`/`RoughTex`) → BaseColor is `Albedo.RGB × BaseColor(Vector)`.
- **Always give them a default texture.** If you make white (`/Engine/EngineResources/WhiteSquareTexture`) the default,
  "multiplying changes nothing", so any MI you have not assigned yet **keeps the look it had until now** = you can migrate safely.
- The white default is sRGB, so **the sampler must be `SAMPLERTYPE_Color`**. Specifying Linear fails to compile.
- The normal default is `/Engine/EngineMaterials/DefaultNormal`.
- Fix the sRGB / compression settings after importing a texture with `ObjectTools.set_properties` (`import_file` has no arguments for them).
