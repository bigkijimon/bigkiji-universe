---
name: comfyui-workflow
description: API-control the local ComfyUI running on port 8000 to generate images, anime and art assets. Covers replacing the prompt in the workflow JSON, submitting it, waiting for completion and collecting the output. Started manually with "ComfyUIで生成", "画像を生成して", "キャラ画像", "comfyui" (/comfyui-workflow). Not for cloud image APIs such as DALL-E/Gemini, nor for driving Canva.
disable-model-invocation: true
allowed-tools: Bash(curl *), Bash(bash *)
---

> Translated from the owner's Japanese original at /Users/yuma/.claude/skills/comfyui-workflow/SKILL.md. The Japanese file remains the source of truth.

# 🤖 ComfyUI API Control (:8000)

- Connection: `http://127.0.0.1:8000` (resident under launchd as `com.virtualitystaff.comfyui`)
- Installation: `~/Documents/ComfyUI` (workflow JSON: `user/default/workflows/`)

## 🚦 GPU arbitration (mandatory, top priority, 2026-07-11 global optimisation)
This Mac has 1 physical GPU on unified memory. If Ollama/Qwen (blog writing, lama) or another generation job (LTX video, ACE-Step music) runs while ComfyUI is generating, it crashes with a Metal GPU error/OOM. **Always acquire the GPU before generating, and always release it when you are done**:
```
S=~/Documents/CEOBigKiji/Executive_Office/経営企画室/gpu-signal.sh
# 【推奨】単発生成は run が安全（取得→Ollama凍結→生成→解放を自動ペア・失敗しても解放される）
bash "$S" run comfyui-img "<POST /prompt して /history 完了までポーリングする1コマンド>"
# 【手動】複数ステップに分けるなら acquire…release で挟む（解放し忘れ厳禁）
bash "$S" acquire comfyui-img   # 順番待ち→Ollama凍結(GPU確保)
#   …下記手順で生成…
bash "$S" release               # 必ず解放(Ollama復帰)。中断・失敗時も必ず実行
```
(The fenced block above is kept byte-identical to the Japanese original. Its comments read: RECOMMENDED — for a one-shot generation the run subcommand is the safe one, because it pairs acquire → freeze Ollama → generate → release automatically and releases even on failure. MANUAL — if you split the work into several steps, wrap them in acquire … release, and never forget to release.)
- **If you acquire, you must release.** Forget to release and Ollama stays frozen — the watchdog also respects the lock, so it will not bring Ollama back either.
- When calling from inside a blog-writing session, `BIGKIJI_BLOG_SELF=1` is already inherited = you are exempt from waiting on your own marker (avoids self-deadlock).
- Check congestion: `bash "$S" status` (GB of GPU held, who is running, blog priority, the wait queue).

Procedure:
1. Check it is up: `curl -s http://127.0.0.1:8000/system_stats`. If it is down, `launchctl kickstart -k gui/$(id -u)/com.virtualitystaff.comfyui`
2. Read the workflow JSON and replace the text of the prompt node. **Always JSON-escape newlines, quotes and backslashes** (breaking the structure is the most frequent failure).
3. Submit with `POST /prompt` → poll `GET /history/{prompt_id}`. **The timeout must be 180 seconds or more** (the first model load for SDXL/Flux/LoRA is slow).
4. Output lands in `ComfyUI/output/`. Copy deliverables into the requesting department's `成果物/` and attach Japanese alt text.

## 🎓 Pro-grade workflow design (2026-07-13 owner instruction; textbook workflows forbidden)
The owner's verdict: "the workflows so far have an amateur's simplicity and do not produce good pictures/video". **A single one-shot KSampler is forbidden.** The following is the standard:

0. **Before designing, survey the installed nodes with `GET /object_info`** (is Impact Pack/IPAdapter_plus/ControlNet/Ultimate SD Upscale present or not). Do not build JSON that assumes nodes you do not have. If a useful node is missing, consider installing it locally through ComfyUI-Manager and report the result.
1. **Multi-stage pipeline** (the standard shape for stills):
   ① base generation (for SDXL-family, native 1024 class; match the aspect ratio to the use)
   ② **Hires fix 2nd pass**: latent upscale 1.4〜1.6x → resample with the same model at denoise 0.30-0.45 (the detail density is on a different level)
   ③ if there is a face, **FaceDetailer/Impact** (or crop the face → i2i denoise0.35 → paste back)
   ④ finishing: model upscale (4x-UltraSharp etc.) → 0.5x down = a sharp final resolution
2. **The correct settings per model** (mixing them breaks the image):
   - realcartoon-xl-v4 / RealVisXL_V5.0 (SDXL): CFG 4.5〜7 / dpmpp_2m_sde + karras / 28-35steps / the usual photoreal negatives (worst quality, deformed hands, extra fingers…)
   - flux1-dev-Q6_K (GGUF): CFG=1 fixed + FluxGuidance 3.0〜4.0 / euler + simple / 20-28steps / negatives are effectively inert (do not write them) / LoRA=flux_realism_xlabs
3. **When a face has to stay consistent, IPAdapter FaceID-PlusV2** (the whole set is already in stock, no download needed): insightface face reference + weight 0.6-0.8. Do not mass-produce character work without it.
4. **When you need control over composition, consider ControlNet** (depth/pose/canny) first. Do not rack up attempts leaving it to prompt luck.
5. **Seed management**: exploration = random; once you adopt one, fix the seed and only tweak the prompt/parameters (stay in a state where you can tell what made the difference).
6. **Video (Wan2.2-I2V-A14B)**: for the input keyframe, use a high-quality image polished through ①-④ above (if the input is an amateur picture, the video will be amateur too). Use the proper 480p/720p sizes, and check the model's recommended cfg/shift for real. If a frame-interpolation node (RIFE etc.) is available, make the final fps 2×. For LTX-2, follow the lessons in the `ltx2-video` skill (no static camera / cfg2.3 / stg0.7 / first-last frame).
   - **In an I2V prompt, "do not re-describe the picture; write only the motion you are adding to the elements in the image".** If you write a viewpoint or place that is not in the image (`aerial/flying over` on a ground-level photo etc.), the output drifts into a completely different scene because it has to build that (measured 2026-07-18). Fix the background explicitly, use 1 camera move, and keep the length to 4〜6 seconds. Details = the `ltx2-video` skill, "The most important lesson ②". **Do not use SeedVR2 for video upscaling on Apple Silicon** (conv3d is unimplemented so it never finishes — see below) → ffmpeg lanczos.
7. **Quality gate**: generate → look at it with Read → if it fails, put "what is wrong" into words, change only the parameter responsible and regenerate (up to 3 rounds). Do not ship the 1st round as it is.
8. **Steady-state running goes in n8n** (localhost:5678, node@22): build scheduled generation and approval-gated pipelines as an n8n workflow (Schedule→ComfyUI API→Telegram approval→placement) so they do not depend on a terminal session.

Notes:
- When generation fails, check `ComfyUI/user/comfyui_service.err.log`
- Brand consistency: use past work (the LOGO and characters in `~/Documents/HSAcademyApp/Pictuers/`) as reference
- **Look at the real thing before delivery**: always open the generated image with Read (image) and check it before delivering ("it generated" ≠ "it is what we wanted"). Verify how it looks once published on the web with a Playwright(Brave) screenshot (memory `screenshot-brave-playwright`)
- **Teacher-coach character project** (started the week of 2026-07-13, Mona pilot first) = free ComfyUI generation of "3D-look" coach characters for the lobby/mypage. Be considerate about consent for anyone's likeness (memory `upclass-teacher-coach-characters`)

## 🏭 Confirmed pro WF templates (2026-07-13, proven; the canon for reproduction)
The canon of the pro multi-stage WF built from nodes that actually exist. The templates live at `ComfyUI/user/default/workflows/_pro_templates/` (persistent). Registered in the GUI as `user/default/workflows/PRO_01_RealVisXL_2pass_Hires.json`.
- **PRO_01 photoreal portrait (no face, high detail) proven**: `pro_gen_realvisxl_2pass.py` = RealVisXL_V5.0→FreeU_V2→KSampler(dpmpp_2m_sde/karras/32steps/cfg5.5)→**LatentUpscaleBy 1.5x→2nd-pass KSampler(denoise0.42)**→VAEDecode→**UpscaleModelLoader(4x-UltraSharp)→ImageScaleBy0.5** = 2688×3456 in high detail. 28× the pixels of an amateur 512×512. Ran for real through the GPU signal run on 2026-07-13 and passed visual inspection.
- **API→GUI conversion**: `api2ui_converter.py <api.json> "<title>" <out.json>` = uses object_info to get the slot/widget order exactly right and converts to the litegraph UI format → drop it in `user/default/workflows/` and it lines up in the GUI (so the owner can inspect it).
- **Node/model inventory survey (2026-07-13)**: usable = IPAdapter/IPAdapterFaceID, PulidFlux*, FreeU_V2, LatentUpscale, UpscaleModelLoader(4x-UltraSharp), ControlNet*, SeedVR2*(⚠️**does not finish on MPS**, see below), WanImageToVideo, detail-daemon, GGUF. **Not present** = FaceDetailer(Impact not installed)/UltimateSDUpscale/AnimateDiff/RIFE/InstantID nodes → do not build a WF that assumes them (for the missing ones, install via ComfyUI-Manager with approval). checkpoints=RealVisXL_V5.0/realcartoon-xl-v4/dreamshaper_8/sd_xl_base. unet=flux1-dev/schnell GGUF, Wan2.2 High/Low. lora=flux_realism_xlabs/ip-adapter-faceid-plusv2_sdxl_lora/Wan2.2-4step. pulid=pulid_flux_v0.9.1. clip for flux=clip_l+t5xxl_fp8 in stock.
- **⚠️ SeedVR2 VideoUpscaler does not run to completion on Apple Silicon (MPS) (measured 2026-07-18, found after burning 1 hour 42 minutes)**:
  The VAE decoder uses `F.conv3d` and **MPS has not implemented that operator** = it always dies with `NotImplementedError: convolution_overrideable not implemented`.
  **It is not a memory shortage, so lowering the resolution or batch size does not fix it.** For both `SeedVR2LoadDiTModel` and `SeedVR2LoadVAEModel`,
  **the only device choice is `['mps']`**, there is no CPU inference path, `offload_device` is only for parking while idle and `decode_tiled` is just tile splitting, so there is no way around it.
  The nasty part is that **the encode stage (≈104 s/batch) and the DiT upscale stage (≈20 s/batch) do finish all 27 batches** = it looks like it is going fine and then the final decode wipes everything out.
  → **Do not put SeedVR2 in the plan for video upscaling on Apple Silicon. The alternative = ffmpeg lanczos** (`scale=W:-2:flags=lanczos`).
- **Iron rule: in a multi-stage WF, "Save the raw output before the upscaling step".** Even if the upscale side dies, the sampling result survives.
  (The run with SeedVR2 downstream still left an artefact after a 1h42m failure, whereas the run before this ordering was introduced lost 41 minutes' worth entirely.)
- **Face consistency (Satoko/Mia family, Elena family)**: for SDXL use IPAdapterFaceID(ip-adapter-faceid-plusv2_sdxl + insightface buffalo); for Flux use PulidFlux(pulid_flux_v0.9.1). **Always make the master sheet first (multiple angles and expressions) → lock with FaceID → pose with ControlNet → I2V**, in that order (one-shot generation is forbidden).
