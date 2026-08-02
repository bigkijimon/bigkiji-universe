# Reference Video Analysis

Frame-by-frame and audio analysis of the 9 reference clips in `~/Downloads/`.

**Method.** Every clip was decoded end-to-end with `ffmpeg`/`ffprobe` (frames sampled at 1–30 fps
depending on the clip) and the extracted PNGs were visually inspected, not guessed from filenames.
Colour, geometry and loop-length figures come from numeric analysis of the decoded pixels (numpy).
Audio was decoded to 22 050 Hz mono and analysed with a 16 384-point FFT (≈1.35 Hz resolution),
mapped to pitch classes, with tempo from spectral-flux autocorrelation.

**Read this first — three briefing assumptions turned out to be wrong.** The analysis below reflects
what is actually in the files:

| Briefing said | Actually is |
|---|---|
| `pixel1.mp4` = chubby tabby **cat** with bat wings + "LOADING…" text | A screen recording titled **"Pixaleted Bat Animation"** — a black pixel-art **bat**, white stage, plus a VS Code pane showing the CSS. No cat, no "LOADING" text. |
| `SE1` and `SE2` are both piano reels needing chord transcription | **SE1 is a cymatics clip** (a C-major *scale*, one note at a time — no chords). **SE2 is the only chord clip**, and it prints every chord on screen. |
| `SE3` is the wave-animation reference | Correct — and **SE1 is a second, cleaner wave reference**. |

---

## 1. `pixel1.mp4` — CSS sprite-sheet bat (screen recording)

| | |
|---|---|
| Source | `~/Downloads/pixel1.mp4` |
| Duration | 11.469 s (video stream 11.333 s) |
| Resolution / fps | 720 × 1280, 30 fps, 340 frames, H.264 |
| Audio | AAC 44.1 kHz stereo present but irrelevant (screen-capture silence) |

### What it actually is

A vertical screen recording of a browser + VS Code, in three stacked bands that **never change layout
for the whole 11.5 s**:

* **y 0–297** — dark charcoal header, white bold italic text `Pixaleted Bat Animation` (sic — the
  source misspells "Pixelated").
* **y 297–672** — white stage. A black pixel-art bat hovers dead centre, flapping in a tight loop.
  This is the only thing that moves in the entire video.
* **y 672–1280** — VS Code (dark, "Tokyo-night"-ish theme), tabs `index.html` / `style.css`,
  breadcrumb `style.css > @keyframes flap`, 16 lines of CSS on screen.

### Timeline

| Time | What happens |
|---|---|
| 0.00 – 11.47 s | Static layout. The bat loops continuously; nothing else animates, no cuts, no camera move, no scroll, no typing. |
| every 0.400 s | One complete wing-flap cycle (verified 28 consecutive identical cycles). |

### The CSS shown on screen (transcribed verbatim from an upscaled crop)

```css
.bat {
    width: 1px;
    height: 1px;

    position: relative;

    transform: translate(-128px, 128px) scale(4);

    animation: flap 0.4s steps(6) infinite;
}

@keyframes flap {
    to {
        background-position: -192px 0;
    }
}
```

> **Note the inconsistency:** `width/height: 1px` cannot render the 32 px sprite that is visibly on
> screen. The rest of the declaration is self-consistent (`-192px ÷ steps(6) = 32px` per cell), so
> the sprite cell is **32 × 32 px** and the `1px` is either a typo in the source video or a value
> that is overridden off-screen. Build against 32 px, not 1 px.

### Sprite sheet

| Property | Value | How it was determined |
|---|---|---|
| Sheet layout | Single horizontal strip, **192 × 32 px** | `background-position: -192px 0` over `steps(6)` |
| Cell size | **32 × 32 px** | 192 ÷ 6 |
| Frame count | **6** | `steps(6)` |
| Loop duration | **400 ms** | `0.4s`; confirmed — the video repeats exactly every 12 frames @30 fps |
| Per-frame hold | **66.67 ms** (15 fps) | 400 / 6 |
| Display scale | `scale(4)` → 128 × 128 CSS px | needs `image-rendering: pixelated` |
| Measured on-screen block size | ≈6.2–6.6 video px per sprite pixel | lattice fit on the decoded frames |
| Measured silhouette bbox | 164–197 px wide, 134–164 px tall (varies by flap frame) | dark-pixel bounding box |

**Distinct poses actually visible.** Per 400 ms cycle the video shows 12 frames. Clustering them
yields **5 clearly distinct silhouettes plus 2 screen-tear blend frames**; the CSS declares 6 cells,
so two adjacent cells are either identical or differ below the H.264 noise floor. The observed
flap sequence, in order:

| # | Pose | bbox W × H | centroid Y |
|---|---|---|---|
| A | wings raised, tucked narrow; small speckles below the body | 170 × 151 | 119 |
| B | wings starting down, body highest in frame | 164 × 155 | 98 |
| C | wings **fully spread horizontally**, ragged/fringed lower edge — widest, flattest | 193 × 134 | 87 |
| D | wings past horizontal, sweeping down; body dropping | 197 × 137 | 113 |
| E | wings **folded down into a crescent**, tallest, narrowest — lowest body position | 173 × 164 | 129 |

The body bobs vertically ~42 px on screen (≈7 sprite px) in anti-phase with the wings: highest when
the wings are up, lowest when the wings are folded down. Two white "eye" holes are punched out of
the silhouette and are visible in every frame.

### Palette (measured, hex)

The pixel art itself is strictly **2 colours** (ink + transparent). The other entries are the
screen-recording chrome.

| Role | Hex | Notes |
|---|---|---|
| **Bat ink** | `#1D1D1F` | Modal value. Darkest sampled pixel `#0F0F0F`. Source art is almost certainly pure `#000000`; the lift is H.264 black-level. |
| **Stage / transparent** | `#FCFCFC` | Modal value; peaks at `#FFFFFF`. Source is `#FFFFFF`. |
| Header band | `#1D1D21` | 91 % of the top band |
| VS Code background | `#000201` | ≈pure black |
| Anti-alias midtones | `#454448`, `#7D7D81`, `#B7C2C2` | only 2.5 % of stage pixels — compression, **not** part of the sprite |

`ffmpeg palettegen -max_colors=8` over the whole clip returns exactly:
`#010201 · #0B0B0E · #1D1D21 · #454448 · #E5EAEA · #FCFCFC` (+2 padding entries) — i.e. the clip is
effectively black/white with 4 intermediate greys.

### Implementation notes

**(a) CSS sprite-sheet animation.** Author or trace a **192 × 32 px** PNG strip, 6 cells of 32 × 32,
pure black on transparent. Then:

```css
.bat {
  width: 32px;
  height: 32px;
  background: url(/sprites/bat-192x32.png) 0 0 / 192px 32px no-repeat;
  image-rendering: pixelated;          /* required — without it scale(4) blurs */
  transform: scale(4);
  transform-origin: center;
  animation: flap 400ms steps(6) infinite;
}
@keyframes flap { to { background-position: -192px 0; } }
@media (prefers-reduced-motion: reduce) { .bat { animation: none; } }
```

Use `steps(6)`, **not** `steps(6, end)`/`start` variants casually — the reference holds each cell for
a full 66.67 ms and never shows an interpolated frame. Add the vertical bob inside the sprite art
(as the reference does), not as a second CSS transform, so the two stay locked in phase.

**(b) ANSI terminal spinner.** Same 6 frames, same 400 ms loop → advance every **67 ms** (≈15 fps).
Because the art is 1-bit, render it as half-blocks: each `▀` cell carries a foreground colour (upper
row pixel) and a background colour (lower row pixel), so a 32 × 32 sprite becomes **32 columns × 16
rows**. That is too tall for an inline spinner — downsample the art to **16 × 16** (→ 16 cols × 8
rows) or **8 × 8** (→ 8 cols × 4 rows) for a compact badge. Emit `\x1b[38;2;29;29;31m` for ink and
reset for transparent; redraw with cursor-up (`\x1b[{n}A`) rather than clearing the screen, and hide
the cursor (`\x1b[?25l`) for the duration. Gate on `process.stdout.isTTY` and on truecolor support
(`COLORTERM=truecolor`); fall back to a 6-frame Unicode/ASCII spinner at the same 67 ms cadence
otherwise.

Suggested single-line fallback keyed to the same 5 observable poses:
`ᵕ ‸ ᵕ` style is not necessary — a plain 6-state Braille or `⠋⠙⠹⠸⠼⠴` cycle at 67 ms matches the
reference's felt rhythm.

---

## 2. `BigkijiUniverse.mp4` — Three.js spiral-galaxy particle system

| | |
|---|---|
| Source | `~/Downloads/BigkijiUniverse.mp4` |
| Duration | 9.263 s (video stream 9.067 s) |
| Resolution / fps | 720 × 1280, 30 fps, 272 frames |

### What it actually is

A vertical Instagram reel from **`code_wars_official`**, titled **"Interactive **Galaxy**"** (the word
"Galaxy" in lime green `#B4F461`-ish). Layout:

* **y 0–190** — dark navy page background `#121A26`, white + lime title.
* **y 210–583** — a white-bordered viewport containing the live WebGL canvas (614 × 373 px in the
  video). **A mouse cursor is visible inside the canvas throughout** → the camera is being driven by
  hand (OrbitControls + scroll-wheel dolly), not by a scripted path.
* **y 640–1100** — a mock code panel (`#242732`, macOS traffic lights) showing the generator.
* **y 1150–1280** — the account row: avatar, `code_wars_official`, LIKE / SAVE / SHARE.

### Code shown on screen (verbatim)

```js
const generateGalaxy = () => {

if(points !== null){
    geometry.dispose();
    material.dispose();
    scene.remove(points);
}
material = new THREE.PointsMaterial({
    size: parameters.size,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true
})

    geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(parameters.count * 3);

    const colors = new Float32Array(parameters.count * 3);
    const colorInside  = new THREE.Color(parameters.insideColor);
    const colorOutside = new THREE.Color(parameters.outsideColor);
```

This is the standard "galaxy generator" pattern (dispose-and-rebuild on parameter change,
`BufferGeometry` + `PointsMaterial`, per-vertex colour lerped from an inside colour to an outside
colour by normalised radius).

### How the particles are distributed

Not clustered, not shelled, not filamentary — it is a **flat logarithmic-spiral disc**:

* Points are laid on a **disc** (thin in Y), with a strong radial density falloff toward the centre —
  the core is a saturated bright blob, the outskirts a sparse halo.
* **Branches:** angular FFT of the inner annulus gives a dominant **m ≈ 5** harmonic at every sampled
  time (secondary support at 3 and 4 — the elliptical projection injects an m = 2 term). The
  contrast-enhanced face-on frame shows a clear **5-lobed pinwheel** in the core. Call it **5
  branches**; 3 or 4 would also be defensible from the compressed footage.
* **Spin:** each arm wraps roughly one full turn between the core and the rim (tight log spiral).
* **Randomness:** a power-law scatter perpendicular to and along each arm — arms read as sharp bright
  ridges near the core and dissolve into an isotropic haze past ~70 % of the radius.
* **Thickness:** essentially zero. At t ≈ 6.8 s, seen from inside, the whole galaxy collapses into a
  **razor-thin bright horizontal band** — the disc has almost no Y extent.

### Colour

Radial gradient, additive-blended over pure black `#040204`:

| Radius | Measured mean | Measured hot (brightest 20 %) | Reads as |
|---|---|---|---|
| Core (r < 25 px) | `#935439` | `#DA976D` | white-hot yellow-orange |
| Inner (25–60) | `#794336` | `#B0715E` | orange |
| Arms (60–110) | `#663E3C` | `#9B6966` | crimson / salmon |
| Outer (110–170) | `#51393C` | `#7A585C` | dusty mauve-violet (blue mixing in) |

Consistent with `insideColor ≈ #FF6030`, `outsideColor ≈ #1B3984`. **No depth of field** — no bokeh,
no focus falloff; the only size cue is `sizeAttenuation`, which is what makes near particles render
as large soft squares when the camera is inside the disc.

### Camera path (measured: mean luminance, lit-pixel fraction, and median bright-pixel radius per frame)

| Time | Camera | Measurements |
|---|---|---|
| 0.0 – 1.7 s | **Hold.** Distant, near face-on, tilted ~20–25° off the disc normal. Galaxy occupies the middle third of the viewport. Slow disc rotation only. | lum 21, lit 8.8–9.2 %, r₅₀ 0.37→0.42 |
| 1.7 – 2.6 s | **Fast dolly-in** (scroll-wheel zoom). ~0.9 s, ease-in then ease-out — the change is steepest around 2.0–2.4 s, then decelerates. This is the single biggest visual event. | lum 21→54, lit 9 %→34 %, r₅₀ 0.42→0.72 |
| 2.6 – 6.4 s | **Inside the disc.** Particles fill the frame; individual points now render as large soft additive squares. Slow drift + orbit — the view tilts progressively from face-on toward edge-on. | lum ≈55 flat, lit ≈35 %, r₅₀ saturates at 0.82 |
| 6.4 – 7.0 s | **Plane crossing.** The disc lines up edge-on and becomes a blinding thin horizontal bar across the frame. Peak brightness of the whole clip at **t ≈ 6.8 s**. | lum peaks 62.5 |
| 7.0 – 8.2 s | **Dolly back out**, slightly faster than the way in (~1.2 s), decelerating. | lum 54→21, lit 34 %→9 %, r₅₀ 0.83→0.70 |
| 8.2 – 9.07 s | **Settle.** Distant again, more face-on than the opening, still creeping outward at the cut. | r₅₀ 0.70→0.60 |

### Implementation notes

* `THREE.Points` + `BufferGeometry`, `count` on the order of 100 k–200 k (the arm ridges stay
  resolvable at rim radius, so not 10 k). Per-vertex colour, `vertexColors: true`.
* Material exactly as in the reference: `size ≈ 0.01–0.02` world units, `sizeAttenuation: true`,
  `depthWrite: false`, `blending: THREE.AdditiveBlending`. `depthWrite: false` is what makes the
  interior look like glowing gas instead of z-fighting squares — do not omit it.
* Generation per particle: `r = Math.random() * radius`; `branchAngle = (i % branches) / branches *
  2π`; `spinAngle = r * spin`; scatter `= Math.pow(Math.random(), randomnessPower) * (Math.random() <
  .5 ? 1 : -1) * randomness * r` applied independently on X/Y/Z (Y scatter much smaller — the disc is
  thin). Colour `= colorInside.clone().lerp(colorOutside, r / radius)`.
* **For the BIGKIJI "files scattered in a universe" use case:** map each file to one particle,
  `branch = hash(topLevelDir) % branches` so a directory becomes an arm, and `r = f(depth)` or
  `f(lastModified)` so the radius encodes hierarchy or recency. The reference's readability comes
  from the fact that *angle is categorical and radius is continuous* — preserve that.
* Camera: reproduce the hold → fast dolly-in → interior drift → plane crossing → dolly-out arc
  (≈1.7 s / 0.9 s / 3.8 s / 0.6 s / 1.2 s / 0.9 s). The "wow" is entirely the plane crossing; keep
  the disc thin enough that it happens.
* Do **not** add DOF/bokeh — the reference has none, and adding it kills the point-sprite look.
* If the camera is user-driven (the reference is), OrbitControls with damping plus scroll dolly is
  the right control scheme.

---

## 3. `SE1.mp4` — Cymatics: note → pattern → colour  *(WAVE REFERENCE #1)*

| | |
|---|---|
| Source | `~/Downloads/SE1.mp4` |
| Duration | 30.811 s (video 30.708 s) |
| Resolution / fps | 720 × 1280, 24 fps, 737 frames |
| Audio | Present, clean, monophonic synth |

### What it actually is

A Spanish-language reel: heading **"¿Cómo se pueden VER los sonidos?"** ("How can you *see* sounds?"),
footer caption **"Cimática"** (Cymatics), and a per-shot solfège label bottom-left (`Do`, `Re`, `Mi`,
`Fa`, `Sol`, `La`, `Si`, `Do`). Each note plays a sustained synth tone while a glowing spherical
Chladni/cymatic pattern is displayed, one hue per note, on pure black.

**This is not a chord clip.** It is a monophonic **C-major scale**, one note at a time.

### Audio: exact pitch content (FFT, ±2 cents, A4 = 440 equal temperament)

| Time | Label | Note | Measured f₀ | Cents off |
|---|---|---|---|---|
| 0.0 – 1.45 s | Do | **C4** | 261.6 Hz | 0 |
| 1.5 – 3.45 s | Re | **D4** | 293.7 Hz | 0 |
| 3.5 – 5.45 s | Mi | **E4** | 329.5 Hz | −1 |
| 5.5 – 7.95 s | Fa | **F4** | 349.0 Hz | −3 |
| 8.0 – 9.95 s | Sol | **G4** | 391.9 Hz | −1 |
| 10.0 – 12.45 s | La | **A4** | 439.0 Hz | −4 |
| 12.5 – 14.95 s | Si | **B4** | 493.9 Hz | 0 |
| 15.0 – 17.95 s | Do | **C5** | 523.4 Hz | +1 |
| 18.0 – 20.95 s | Do | **low C** — f₀ ≈ 65 Hz (**C2**) with harmonics 1–8 all strongly present (C2·C3·G3·C4·E4·G4·C5). Reads on a chromagram as a C-major spectrum but it is one note with a rich timbre. |
| 21.0 – 22.45 s | Do | **C4** (261.5 Hz) |
| 22.5 – 23.95 s | Do | **C5** (523.3 Hz) |
| 24.0 – 25.45 s | Do | **C6** (1047.3 Hz) |
| 25.5 – ≈27 s | Do | **C7** (2093 Hz) |
| 27 – 30.81 s | — | decay / room tone, fades to silence |

**Tempo: not applicable.** There is no beat — sustained tones, ~2 s each, no percussion, no rhythmic
onsets. Reporting a BPM here would be meaningless.

**Confidence: very high.** Monophonic sustained tones, single dominant partial per window, all
fundamentals within 4 cents of 12-TET at A4 = 440.

### Note → colour mapping (measured from the lit disc)

| Note | Mean colour | Hot (brightest 5 %) | Hue° | Disc coverage |
|---|---|---|---|---|
| Do (C4) | `#A67946` | `#E2C299` | 32 | 68 % |
| Re (D4) | `#5D9E3A` | `#8FD16A` | 99 | 43 % |
| Mi (E4) | `#37826D` | `#6ABBA4` | 163 | 41 % |
| Fa (F4) | `#3D3BBA` | `#8684F5` | 241 | 35 % |
| Sol (G4) | `#7B36A3` | `#D492F0` | 278 | 60 % |
| La (A4) | `#D63B6F` | `#FCA5CE` | 340 | 61 % |
| Si (B4) | `#A8693C` | `#E5A879` | 25 | 29 % |
| Do (C5) | `#A27745` | `#E1C29A` | 32 | 42 % |

The hue walks **monotonically around the wheel** with pitch — amber (32°) → green (99°) → teal (163°)
→ blue (241°) → violet (278°) → magenta (340°) → back to amber for B/C. It is effectively
`hue = (pitchClass / 12) * 360 + 32°` — a clean, directly reusable mapping.

### Pattern behaviour

* Always a **sphere-shaped** (not flat) glowing mesh: a circular disc with concentric + radial
  interference structure, shaded so the edges fall off like a globe. Roughly 62 % of the frame width.
* **Pattern complexity rises with frequency.** Low C4 → ~10 large lobes around a wide dark hub.
  Rising through the scale the cell count increases and cells shrink. The C5/C6/C7 tail is the whole
  point of the clip: the same note name, three octaves apart, produces visibly finer and finer mesh.
* Everything is additive glow on `#000000`; the pattern has a soft outer bloom.
* Rotation is minimal — the pattern breathes/shimmers in place rather than spinning.

### Implementation notes

* This is the cleanest reference for **"one sound → one visual state"**. Use it for the note→colour
  LUT above and for the "resolution scales with frequency" rule: cell/ring count ∝ f₀.
* Renderable as a fragment shader on a disc: `sin(k·r + φ) · cos(n·θ)`-style Chladni sum with `k` and
  `n` driven by the frequency, tone-mapped through the hue LUT, plus an outer bloom pass.
* Reuse the ~2 s hold per state — the reference gives the eye time to read the pattern before
  changing. Do not cross-fade faster than ~300 ms or the structure becomes mush.

---

## 4. `SE2.mp4` — Circle of Fifths: diminished-7th substitutions  *(THE CHORD CLIP)*

| | |
|---|---|
| Source | `~/Downloads/SE2.mp4` |
| Duration | 19.014 s (video 18.933 s) |
| Resolution / fps | 720 × 1280, 30 fps, 568 frames |
| Audio | Piano, present from ≈2.5 s, fades out by ≈17 s |

### What it actually is

A music-theory reel. A white circle-of-fifths wheel on pure black; major keys labelled outside
(C·G·D·A·E·B·Gb·Db·Ab·Eb·Bb·F) and relative minors inside (Am·Em·Bm·F#m·C#m·G#m·Ebm·Bbm·Fm·Cm·Gm·Dm).
**Red** chords connect the notes of the current C°7; **blue** chords connect the notes of the
substituted dominant. A caption at y ≈ 1050 names each chord. Piano plays each chord as it appears.

### Timeline (captions transcribed verbatim from upscaled crops; chords cross-checked against the audio)

| Time | On-screen caption | Chord | Confirmed in audio (chroma / partials) |
|---|---|---|---|
| 0 – 2 s | `The Circle of Fifths...` | — | (near-silent) |
| 2 – 4 s | `C°7 [C-Eb-Gb-A]. Flatten C... →` | **C°7** = C–E♭–G♭–A | C3, D♯4, D♯5, C5, C4 |
| 4 – 5 s | *(building)* | | F♯5, A4, D♯4 → full C°7 |
| 5 – 6 s | `C°7 becomes a B7. [B-F#-G#-A]...` | **B7** | B2/B3/B4, D♯4, F♯4, A — i.e. **B–D♯–F♯–A** |
| 6 – 7.5 s | `C°7 [C-Eb-Gb-A]. Flatten Eb... →` | **C°7** | C5, D♯4, F♯4 |
| 7.5 – 9 s | `C°7 becomes a D7/C. [C-D-F#-A]` | **D7/C** = C–D–F♯–A | C3, D3/D4/D5/D6, A3, F♯ |
| 9 – 10.5 s | `C°7 [C-Eb-Gb-A]. Flatten Gb... →` | **C°7** | C5, D♯4/5, F♯4/5 |
| 10.5 – 12 s | `C°7 becomes an F7/C. [C-Eb-F-A]` | **F7/C** = C–E♭–F–A | F5/F6, C5/C6, D♯4, A3 |
| 12 – 13.5 s | `C°7 [C-Eb-Gb-A]. Flatten A... →` | **C°7** | C5, D♯4, F♯5 |
| 13.5 – 17 s | `C°7 becomes an Ab7/C.` → `Ab7/C = [C-Eb-Gb-Ab]` | **A♭7/C** = C–E♭–G♭–A♭ | G♯4/G♯5, C3/C4, D♯4/D♯5, F♯ |
| 15 – 19 s | `Free Circle of Fifths PDF,` → `link in bio. :)` | — | fade to silence |

### Chord progression (final answer)

```
C°7  →  B7      (flatten the C  → B)
C°7  →  D7/C    (flatten the Eb → D)
C°7  →  F7/C    (flatten the Gb → F)
C°7  →  Ab7/C   (flatten the A  → Ab)
```

C°7 = **C–E♭–G♭–A**. Lower any one of its four notes by a semitone and you get a different dominant
7th — the reel's whole point. Each substitution is stated, played, and returned to C°7.

**Confidence: very high.** Both the on-screen text and the FFT of the piano agree on every chord.

> ⚠️ **The source reel has a typo.** The caption reads `B7. [B-F#-G#-A]`, but B7 is **B–D♯–F♯–A**, and
> the piano audibly plays D♯, not G♯ (chroma at t = 4.5–5.5 s: B 0.68 / D♯ 0.39 / F♯ / A). Use
> **[B-D♯-F♯-A]**. Do not copy the reel's spelling.

### Tempo

Spectral-flux autocorrelation peaks at **≈79.5 BPM** (equivalently 159–162 BPM at the half-note
level), autocorrelation strength 0.40 — **moderate confidence only**. The playing is arpeggiated and
rubato with no percussion. What is solid is the *chord rate*: one chord roughly every **1.5 s**
(≈2 beats at 80 BPM).

### Implementation notes

* This is a **harmonic** reference, not a visual one. Seed sound-effect generation from the four
  substitution pairs: a C°7 "tension/query" state resolving into one of B7 / D7 / F7 / A♭7 depending
  on outcome gives four distinguishable-but-related cues that all share three common tones — ideal
  for a family of related UI sounds (e.g. four different "done" variants that still sound like the
  same product).
* Voice them over a **C pedal** (three of the four are notated `/C`) so the family has a constant
  root; only the moving voice changes. That is exactly why the reel works.
* Chord change every ~1.5 s at ~80 BPM if you need a musical bed rather than one-shots.

---

## 5. `SE3.mp4` — "Strum Surfer" live cymatics visualiser  *(WAVE REFERENCE #2)*

| | |
|---|---|
| Source | `~/Downloads/SE3.mp4` |
| Duration | 34.827 s (video 34.700 s) |
| Resolution / fps | **1108 × 720** (landscape — this is why it looked different), 30 fps, 1041 frames |
| Audio | Live MIDI-keyboard performance, present 1.5 – 34 s |

### What it actually is

A macOS desktop screen recording (menu bar reads `Photo Booth`, `Tue Jul 14 10:43 AM`), containing:

* **Left, x 0–645, y 115–700 — the wave canvas.** Brave browser at **`strumsurfer.com/play/`**,
  tab title "Strum Surfer — Play", a `60 FPS` counter top-left, a `Show UI` button bottom-right.
  Everything else is the visualisation on pure black.
* **Top-right — a Photo Booth window** showing the performer at a full-size MIDI keyboard in a room
  with a plant shelf and a sofa.
* **Bottom-right — VS Code**, `main.js > workerCode`, showing an inlined Web Worker:

```js
// --- Inlined Web Worker Code ---
const workerCode = `
let running = false;
let alpha = 0.003;
let beta  = 0.010;
let dim   = 3;
let dist  = 'beta';
let batchSize = 30000;

// Standard Normal Random Vari...
function randomNormal() {
    let u = 0, v = 0;
    while(u === 0) u = Math.ra...
    while(v === 0) v = Math.ra...
    return Math.sqrt(-2.0 * Ma...
}

// Log-domain Gamma distributi...
function sampleLogGamma(a) {
```

So the visual is a **particle cloud of 30 000 samples per batch** drawn from a Beta/Gamma
distribution in `dim = 3`, computed off-thread in a Worker and splatted additively to a canvas — not
a shader, not a mesh.

### Wave shape, amplitude, speed, colour

* **Shape.** Always a **filled disc** centred in the canvas, radius ≈290 px (it fills the canvas
  height edge-to-edge in every single sampled frame — `r₉₀` stayed 284–299 px for all 69 samples).
  Within the disc the structure alternates between two families:
  * **Concentric rings** — clean, sharply defined annuli, 2–7 of them (measured by FFT of the radial
    luminance profile). Ring count changes with what is played.
  * **Radial webs / rosettes** — spokes + lattice, like a Chladni figure or a spider web, with a
    bright focal knot at the centre.
* **Amplitude / density.** Lit-pixel coverage swings between **24 % and 58 %** of the canvas.
  Sparse and delicate on single notes, dense and blown-out on full chords. Mean luminance of lit
  pixels stays 123–167 (i.e. the material is always near-blown-out white at the ridges — additive).
* **Speed.** The canvas runs at 60 fps and the pattern re-solves essentially **instantly** on a new
  chord (<100 ms). There is no easing or morph between states — it snaps, then shimmers/grains in
  place because each frame is a fresh 30 000-sample draw. The grain is the signature look.
* **Colour.** One hue per chord, cycling as the performer moves through keys. Always a saturated hue
  at mid-radius blowing out to near-white at the ridges:

| State | Mid colour | Hot colour |
|---|---|---|
| Gold rosette (opening & closing) | `#D6BF5A` | `#FEF9B5` |
| Violet web | `#A384C6` | `#FEF6FE` |
| Cyan rings | `#75C6CE` | `#E9FCFE` |
| White/green web | `#9BA389` | `#F8FEE7` |
| Teal rings | `#48A7BA` | `#89FCFE` |

### Timeline (hue and structure measured every 0.5 s; audio pitch content from FFT)

| Time | Visual | Audio (tonal centre) |
|---|---|---|
| 0 – 1.5 s | **Gold** radiating rosette, sparse | silent |
| 1.5 – 3 s | shifts to teal / green, ~6 rings | **C major** (C–E–G) |
| 3 – 4.5 s | blue, 5 rings, then amber | A / E-B area |
| 4.5 – 6 s | **magenta → violet**, 4–7 rings, coverage rises | B / F♯ / C♯ |
| 6 – 9 s | **deep violet web**, densest of the early section (47 %) | B–F♯–A–C♯ sustaining, decaying |
| 9 – 12 s | **cyan concentric rings**, 6–7 clean annuli, then washes to white | back to **C major**, then D♭ area |
| 12 – 15 s | violet, then grey-blue, coverage peaks 53 % | E♭ / F / A♭ cluster — loudest passage of the clip (RMS 0.32 at 12 s) |
| 15 – 18 s | **cyan, 7 tight rings** — the cleanest ring frame in the clip | F/C then C major |
| 18 – 21 s | violet → teal, 6 rings, coverage 53 % | D♭ / A♭, then F/C |
| 21 – 27 s | **sustained cyan/teal ring family**, saturation peaks (`#41A1B5`), 6–7 rings | E minor / C, then D♭, then E♭–G |
| 27 – 30 s | teal loosens to 2–5 rings, coverage 47 % | E–B–G–A (E minor / A minor) |
| 30 – 34.8 s | **returns to gold**, 4 rings, coverage falls 48 % → 25 % as the performance thins out | **F♯–C♯–A–B** (F♯ minor / B minor) |

### Chord progression — **could not be determined reliably**

This is a free, rubato improvisation demoing a visualiser, **not a loop with a transcribable chord
chart**. The tonal centre wanders (C → B/F♯ → C → D♭ → F/C → D♭ → E♭ → Em/Am → F♯m) and never
repeats a cycle. Per-window chroma is reported in the table above as *tonal centres only*; I am
**not** issuing a bar-by-bar chord transcription for SE3, because any such chart would be invented
rather than measured.

**Tempo: ≈129 BPM, low confidence** (autocorrelation strength 0.375, no percussion, free-time
playing). Treat this as "roughly moderate tempo", not a value to sync anything to.

### Implementation notes

* Structurally the closest thing to a "BIGKIJI background wave": **a full-bleed disc of additive
  particles on black, re-sampled every frame, whose ring count and hue are driven by a scalar
  input.** Reuse that contract directly — feed it activity level / build status / audio instead of
  MIDI.
* Compute in a **Web Worker** (as the reference does) and transfer positions via a transferable
  `Float32Array`; ~30 000 points per batch is the reference's budget and holds 60 fps.
* Draw with `globalCompositeOperation = 'lighter'` on a 2D canvas (or additive `THREE.Points`) —
  the blown-out white ridges over saturated mid-tones only happen with additive accumulation.
* **Keep the per-frame resample.** The living grain is what sells it; a smooth interpolated mesh
  reads as dead by comparison.
* Ring count 2–7 and coverage 24–58 % are the useful dynamic range: anything denser blows out,
  anything sparser reads as noise.
* Hue: one saturated hue per state, held; snap between states rather than cross-fading.

---

## 6. `動画1.mp4` — approaching light-sphere in a warp starfield *(archive)*

| | |
|---|---|
| Source | `~/Downloads/動画1.mp4` |
| Duration | 25.108 s (video 25.033 s) |
| Resolution / fps | 720 × 1280, 30 fps, 751 frames |

Two shots, hard cut at **t ≈ 18 s**.

| Time | Content |
|---|---|
| 0 – 2 s | Black. Dense starfield only. |
| 2 – 8 s | Camera flies forward through the starfield — stars streak **radially outward** from the centre (classic warp-blur). A point of light in the centre grows and develops a four-point anamorphic flare. |
| 8 – 13 s | The light resolves into a **translucent crystalline / soap-bubble sphere**, lavender-pink shell (`#AC8BA5`) with a hot golden core and internal facet highlights. Peak size and brightness ≈ t 9–12 s. Horizontal lens streak across the frame. |
| 13 – 17 s | Sphere dims and shrinks; starfield streaking slows. Fades to near-black. |
| 17.5 – 18.5 s | **Cut.** |
| 18.5 – 25.1 s | Second shot: cooler blue-grey starfield (`#4C5360`, hue ≈220°) with the stars streaking outward again — a pure warp-tunnel plate, no central object. Streak length grows steadily to the end (r₉₀ 95 → 145 px), i.e. accelerating forward motion. |

Overall: very low key (mean frame luminance 3–8), ≤2 % of pixels lit. Palette: black, blue-white
stars, lavender-pink `#A491A6` → `#AC8CA5`, golden core.

**Implementation notes.** Already-implemented reference. Two reusable ideas: (a) radial star streaks
whose length maps to forward speed; (b) a translucent refractive sphere with an internal emissive
core and an anamorphic flare — cheapest as a billboarded sprite plus a horizontal streak, not real
refraction.

---

## 7. `動画2.mp4` — cosmic ink / accretion-cloud abstract *(archive)*

| | |
|---|---|
| Source | `~/Downloads/動画2.mp4` |
| Duration | 21.638 s (video 21.520 s) |
| Resolution / fps | 720 × 1280, **25 fps**, 538 frames |

The brightest and most saturated of the four (mean frame luminance 60–140, 22–88 % of pixels lit).
Reads as macro fluid/ink photography (or a very good simulation of it) used as a cosmic effect.

| Time | Content |
|---|---|
| 0 – 3 s | A huge **crimson-pink nebula** (`#DA6176`) fills the frame with a dark circular cavity punched in the middle. Inside the cavity: a starfield and a tiny **blue-ringed sun with a golden core** — an eclipse/accretion motif at small scale. |
| 3 – 7 s | The cavity collapses into a **radial filament burst** — thousands of thin white/pink/red streaks exploding outward from a small blue-white ringed centre. Saturation peaks (`#C6241F` at t 6 s). |
| 7 – 11 s | Camera is inside the filaments; they sweep past as directional streaks. A **cyan/blue lobe** (`#6274AA`, hue 225°) cuts across the red — the strongest colour contrast in the clip. |
| 11 – 17 s | Curtains of vertical white/pink/red filaments flowing downward and outward, dense and unbroken; dark fissures between them. Coverage 72–85 %. |
| 17 – 21.6 s | Resolves into a **bright ring / eclipse**: a warm-white annulus (`#F2C7B4` → `#D1AE9D`) around a dark violet centre on black, blooming to a fully blown-out disc at the end. |

Palette: crimson `#C6241F`, rose `#DA6176`, pink-mauve `#C8798F`, cyan-blue `#6274AA`, warm white
`#F2C7B4`, black.

**Implementation notes.** Already implemented. The transferable structure is the **arc**: wide soft
cloud → radial filament explosion → interior pass-through → resolve to a clean ring. It is the same
dramatic shape as the galaxy clip (§2), which suggests standardising on that beat pattern for
BIGKIJI's cosmic transitions.

---

## 8. `動画3.mp4` — gravitationally-lensed black hole *(archive — the real accretion-disk reference)*

| | |
|---|---|
| Source | `~/Downloads/動画3.mp4` |
| Duration | 8.101 s (video 7.967 s) |
| Resolution / fps | 720 × 1280, 30 fps, 239 frames |

The canonical *Interstellar*-style Gargantua look, and the only one of the four that is genuinely a
black hole with an accretion disk.

**Structure of the image.** A near-black oblate shadow (the event horizon, vertically elongated by
the near-edge-on view), ringed by a photon ring. The disk is seen almost edge-on and gravitationally
lensed, so it appears **both in front of and arcing over/under** the shadow. Strong left/right colour
asymmetry:

* **Left limb — hot gold/amber** ring, `#AC917E` mean, saturating to `#FFC64A`-class yellow at the
  ridge; surrounded by orange-red streaked plasma.
* **Right limb — cool blue-white**, `#6F95CD` mean, hottest pixels `#E4F2FC`; broad blue lensed
  sheets sweeping vertically above and below the shadow.
* Background: deep navy-black, no starfield.

| Time | Content |
|---|---|
| 0 – 3.9 s | **Shot A.** The hole small and distant, ring radius steady. Very low key (mean luminance 20–24, ~8 % lit). Slow inward creep only. |
| ≈3.9 s | **Hard cut.** |
| 3.9 – 7.97 s | **Shot B.** Same object, dramatically closer (ring radius jumps 2.6×). A steady, gently accelerating **dolly-in** for the remaining 4 s: ring radius 126 → 153 px (in a 180 × 320 proxy), lit fraction 40 % → 65 %, mean luminance 67 → 100. Ends still pushing in. |

**Implementation notes.** Already implemented. The three things that make it read correctly:
(1) the disk must be drawn **in front of and lensed over** the shadow, not just around it;
(2) the Doppler/temperature asymmetry — one limb gold, the other blue-white — is what sells the
rotation; (3) the photon ring must be a thin, near-blown-out line distinct from the thick disk.

---

## 9. `動画4.mp4` — armillary sphere over snow peaks *(archive)*

| | |
|---|---|
| Source | `~/Downloads/動画4.mp4` |
| Duration | 16.855 s (video 16.733 s) |
| Resolution / fps | **720 × 900** (the odd one — 4:5, not 9:16), 30 fps, 502 frames |

**Not a black hole.** A photoreal 3D shot: a floating **armillary sphere / gyroscope** of ~6
interlocking segmented metal rings (bronze and steel, beaded/vertebra-like segments) orbiting a
**disembodied eye** at the centre, suspended above snow-covered mountain peaks and a bright cloud
deck. Backlit by a low sun that flares through the ring gaps.

| Time | Content |
|---|---|
| 0 – 4 s | Rings tumbling on multiple axes; the eye at the centre is dark/amber, iris barely visible. Sun behind the sphere, blooming through the gaps. |
| 4 – 9 s | Rings continue to precess; the sphere reads as more open and spherical. The eye rotates toward camera and the iris turns **pale blue-cyan**. |
| 9 – 12 s | A hard lens flare crosses as a ring passes the sun. Rings swing into a wider, flatter configuration. |
| 12 – 16.9 s | Ring material shifts to a **red/white banded** look; the eye is now fully forward-facing, pale blue, and the rings settle into a slower, wider orbit. |

Illumination is essentially constant throughout (mean frame luminance 132–149, 92–99 % of the frame
lit, mean hue locked at 219–222° — cold blue-grey `#7E889E`). No camera zoom (bounding radius flat at
115 px across all 17 samples): **the camera is locked; only the rings and the eye rotate.**

**Implementation notes.** Already implemented. Archive value: the "locked camera + complex slowly
precessing object" staging is the opposite of §2/§7 (moving camera, static subject) and is the calmer
option if a long-lived idle/ambient scene is needed.

---

## Open questions for the owner

1. **`pixel1.mp4` is a bat, not a cat, and there is no "LOADING…" text.** The brief describes "a
   chubby black/brown tabby cat with small bat-like wings … with pixel text LOADING…". The file is a
   screen recording titled *"Pixaleted Bat Animation"* of a black bat on white with the CSS visible.
   Is this the intended reference (and the cat/LOADING copy is aspirational for what we build), or is
   there a different `pixel1` file that did not get copied to `~/Downloads`?
2. **Bat colours.** The reference sprite is strictly black on white — no brown, no tabby. Should the
   BIGKIJI sprite stay 1-bit black (matching the reference) or be re-coloured to a warm brown/amber
   tabby palette? If re-coloured, how many colours (2, 4, or 8)?
3. **`width: 1px` in the reference CSS.** As shown it cannot render the visible sprite. I have
   assumed 32 × 32 cells from `-192px ÷ steps(6)`. Confirm 32 px is the intended cell size.
4. **Sprite frame count: 6 declared, 5 distinct.** The CSS says `steps(6)` but only 5 visually
   distinct silhouettes survive H.264 compression. Do we author 6 cells (two nearly identical, as the
   original apparently does) or simplify to 5?
5. **ANSI spinner size.** 32 × 32 half-block rendering is 32 cols × 16 rows — far too big for an
   inline spinner. Downsample to 16 × 16 (16 × 8 chars) or 8 × 8 (8 × 4 chars)? Or is this meant to
   be a full-screen boot splash rather than an inline spinner?
6. **`BigkijiUniverse.mp4` is someone else's reel**, not a recording of our app — an Instagram post
   by `code_wars_official`. Confirm that we are rebuilding *from* it rather than reproducing an
   existing BIGKIJI screen.
7. **Galaxy branch count.** Measurement supports 5 (with 3–4 defensible). Is there a required number
   — e.g. one arm per top-level company/repo — that should override the visual reference?
8. **File→particle mapping.** The reference encodes nothing; it is decorative. For BIGKIJI, what
   should angle, radius and colour actually mean (directory / depth / recency / size / owner)? This
   decides the generator, so it is worth fixing before implementation.
9. **Camera: scripted or user-driven?** The reference is hand-driven with OrbitControls (the mouse
   cursor is in frame). Do we want an interactive camera, an autoplaying cinematic, or an autoplay
   that yields to the user on first input?
10. **SE1 vs SE3 as the wave reference.** Both are cymatics. SE1 is a polished vertical reel with a
    clean note→hue LUT; SE3 is a live 60 fps particle implementation with source code visible. Which
    is the target look — SE1's smooth glowing mesh or SE3's grainy resampled particle cloud?
11. **SE2 source typo.** The reel prints `B7 = [B-F#-G#-A]`; the correct set (and what the piano
    plays) is `[B-D#-F#-A]`. Confirm we use the corrected spelling.
12. **What are the sound effects actually for?** SE2 gives a four-way substitution family over a C
    pedal, which maps naturally onto four related UI states. Knowing the target events (success /
    error / notify / transition?) would let the four chords be assigned deliberately rather than
    arbitrarily.
13. **SE3 tempo.** 129 BPM at low confidence, from free-time playing. If anything needs to sync to a
    beat, we need a tempo specified by you rather than inferred from this clip.
14. **`動画4.mp4` is not a black hole** (armillary sphere + eye over mountains), and `動画1`/`動画2`
    are abstract cosmic footage rather than accretion disks. Only `動画3` is a true lensed black
    hole. Is the "already implemented" note meant to cover all four, or only `動画3`?
15. **`動画4` is 720 × 900 (4:5)** while everything else is 9:16 or landscape. Was it cropped, and
    does the target composition need a specific aspect ratio?
