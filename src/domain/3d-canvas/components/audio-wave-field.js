// Audio-reactive background wave field.
//
// A faint cymatic disc that sits BEHIND the synapse canvas and reacts to whatever the
// app is actually playing. Every playback bus (owner TTS, agent TTS, ui/alert/ambient
// SFX) is routed through window.BKAudio.analyser, so a single getByteFrequencyData read
// per frame is enough. Microphone capture lives on a separate AudioContext in
// voice-live.js and is deliberately NOT visualised here.
//
// The look follows docs/reference-analysis.md §5 (`SE3.mp4`, strumsurfer.com/play):
//   * a full-height disc of ADDITIVE point splats, re-sampled every single frame — the
//     per-frame grain is the signature, a smooth interpolated mesh reads as dead;
//   * 2–7 concentric rings / radial webs, ring spacing = the audible wavelength;
//   * one saturated hue per cue, SNAPPED rather than cross-faded.
// The note→hue lookup comes from §3 (`SE1.mp4`), measured off the lit disc.
//
// House rules honoured here: no new dependencies (three is already vendored), no
// backdrop-filter (it breaks Electron vibrancy), transform/opacity only on the DOM side,
// and no rAF loop at all while the app is silent.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Pure functions — all covered by tools/audio-wave-selftest.mjs
// ---------------------------------------------------------------------------

// Measured hue per pitch class from SE1.mp4 (C major scale, one sustained note at a time).
// Only the seven naturals were ever sounded, so only those are measurements.
export const MEASURED_HUES = Object.freeze({ 0: 32, 2: 99, 4: 163, 5: 241, 7: 278, 9: 340, 11: 25 });

// Points sampled per frame. "performance" is cut hard; graphics approaches the
// reference's 30 000-per-batch budget.
export const POINT_BUDGETS = Object.freeze({ auto: 14000, performance: 3200, graphics: 26000 });

export const MIN_RINGS = 2;
export const MAX_RINGS = 7;

// Ring mapping anchors. RING_BASE_BIN matches dominantBin's minBin; five octaves above it
// is bin 64, i.e. ~5.5 kHz at the shipped fftSize 512 / 44.1 kHz. Measured playback lives
// between those two: a 740 Hz chime peaks at bin 9, speech and the handset cue at bin 2-4.
export const RING_BASE_BIN = 2;
export const RING_SPAN_OCTAVES = 5;

const TAU = Math.PI * 2;
const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

/**
 * Pitch class (0 = C) → hue in degrees.
 * Naturals return the measured value; accidentals were never sounded in the reference,
 * so they sit halfway between their two measured neighbours, walking the wheel forwards
 * so the ramp stays monotonic (≈ the `pitchClass / 12 * 360 + 32` approximation).
 */
export function pitchClassToHue(pitchClass) {
  const raw = Math.round(Number(pitchClass));
  if (!Number.isFinite(raw)) return MEASURED_HUES[0];
  const pc = ((raw % 12) + 12) % 12;
  if (MEASURED_HUES[pc] !== undefined) return MEASURED_HUES[pc];
  const low = MEASURED_HUES[pc - 1];
  let high = MEASURED_HUES[(pc + 1) % 12];
  if (high < low) high += 360; // wrap A♯ across the B→C seam
  return ((low + high) / 2) % 360;
}

/** Frequency in Hz → 12-TET pitch class (0 = C), A4 = 440. -1 when there is no pitch. */
export function frequencyToPitchClass(hz) {
  const frequency = Number(hz);
  if (!Number.isFinite(frequency) || frequency <= 0) return -1;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return ((midi % 12) + 12) % 12;
}

/** Analyser bin index → centre frequency in Hz. */
export function binToFrequency(bin, sampleRate, fftSize) {
  const size = Number(fftSize);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return (Number(bin) || 0) * (Number(sampleRate) || 0) / size;
}

/**
 * Loudest bin of a getByteFrequencyData buffer.
 * `minBin` skips DC and room rumble; `floor` is the silence gate. When nothing clears the
 * floor the index is -1 (caller must not derive a hue) but the peak value is still reported.
 */
export function dominantBin(bins, options = {}) {
  const { minBin = 2, floor = 18 } = options;
  if (!bins || typeof bins.length !== 'number') return { index: -1, value: 0 };
  let index = -1;
  let value = 0;
  for (let i = Math.max(0, minBin); i < bins.length; i++) {
    if (bins[i] > value) { value = bins[i]; index = i; }
  }
  return value < floor ? { index: -1, value } : { index, value };
}

/** Mean magnitude of a getByteFrequencyData buffer, normalised to 0..1. */
export function averageLevel(bins) {
  if (!bins || !bins.length) return 0;
  let total = 0;
  for (let i = 0; i < bins.length; i++) total += bins[i];
  return total / bins.length / 255;
}

/**
 * Points to sample this frame.
 * Zero under reduced motion (the field is not rendered at all), otherwise the priority
 * budget scaled by how loud the moment is, so quiet passages cost less than loud ones.
 */
export function pointBudget(renderPriority, options = {}) {
  const { reduceMotion = false, activity = 1 } = options;
  if (reduceMotion) return 0;
  const base = POINT_BUDGETS[renderPriority] ?? POINT_BUDGETS.auto;
  const level = clamp(Number(activity) || 0, 0, 1);
  return Math.round(base * (0.3 + 0.7 * level));
}

/**
 * Build an id → { hue, durationMs } lookup from src/components/UI/assets/sfx/manifest.json.
 *
 * The shipped analyser runs at fftSize 512, i.e. ~94 Hz bins, which cannot separate
 * semitones anywhere near the C3–C5 region the cue pack lives in: derived spectrally,
 * all ten cues collapse onto three hues. The manifest states the intended hue per cue
 * (SE1's note→hue LUT applied to the moving voice), so cue playback reads it directly and
 * the spectral path is kept only for audio with no manifest entry — TTS and the chime.
 * The manifest is owned by the sound-design work; this only ever reads it.
 */
export function cueHueMap(manifest) {
  const map = new Map();
  const cues = Array.isArray(manifest?.cues) ? manifest.cues : [];
  for (const cue of cues) {
    const id = cue && cue.id != null ? String(cue.id) : '';
    const hue = Number(cue?.hue);
    if (!id || !Number.isFinite(hue)) continue;
    const durationMs = Number(cue?.durationMs);
    map.set(id, { hue: ((hue % 360) + 360) % 360, durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0 });
  }
  return map;
}

/**
 * Dominant bin → number of concentric rings (the reference never leaves 2–7).
 * Ring count sets the ring spacing, i.e. the wavelength, so it has to follow pitch — and
 * pitch is logarithmic. A linear or square-root map over all 256 bins would spend the whole
 * range on the top octave and pin real playback (speech peaks around bin 2–4, a 740 Hz
 * chime at bin 9) at MIN_RINGS forever. One ring per octave above RING_BASE_BIN instead.
 */
export function ringCountFromBin(bin, binCount) {
  const total = Math.max(2, Math.floor(Number(binCount) || 2));
  const index = clamp(Math.floor(Number(bin) || 0), 0, total - 1);
  const octaves = index <= RING_BASE_BIN ? 0 : Math.log2(index / RING_BASE_BIN);
  const normalized = clamp(octaves / RING_SPAN_OCTAVES, 0, 1);
  return Math.round(MIN_RINGS + (MAX_RINGS - MIN_RINGS) * normalized);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const RENDER_PRIORITIES = ['auto', 'performance', 'graphics'];
const ANALYSER_WAIT_MS = 1200;  // AudioContext is lazy: poll for it, never assume it
// The silent-state poll has to be shorter than the shortest cue in the pack (send.wav is
// 153 ms) or a short one-shot would finish before the loop even wakes up. 90 ms is ~11
// reads of a 256-byte array per second — far cheaper than a 60 fps rAF loop.
const IDLE_WATCH_MS = 90;
const IDLE_TAIL_MS = 900;       // keep drawing after the last sound so the fade completes
const FADE_OUT_MS = 620;        // must match the CSS transition on #audioWaveField
const SILENCE_FLOOR = 0.014;    // mean level below this counts as silence
const PEAK_DECAY = 0.998;       // adaptive normaliser: quiet cues still read clearly
const MIN_PEAK = 0.06;
const SNAP_HOLD_MS = 130;       // a new pitch class must hold this long before the hue snaps
// A fired cue is a real event, so it is allowed to lift the field immediately instead of
// waiting for the analyser: play() resolves after a fetch + decode, and send.wav would
// otherwise be over before the first non-zero spectrum arrives.
const CUE_KICK = 0.34;
const CUE_HUE_TAIL_MS = 260;    // how long past a cue's own length its hue stays authoritative
const SFX_MANIFEST_URL = './assets/sfx/manifest.json';

export class AudioWaveField {
  constructor({ host, priority = 'auto' } = {}) {
    this.host = host || null;
    this.renderPriority = RENDER_PRIORITIES.includes(priority) ? priority : 'auto';
    this.reduceMotion = false;
    this.ready = false;
    this.running = false;
    this.frame = 0;
    this.watchTimer = 0;
    this.stopTimer = 0;
    this.analyser = null;
    this.bins = null;
    this.level = 0;
    this.amp = 0;
    this.peak = MIN_PEAK;
    this.spacing = 0.2;
    this.swirl = 0;
    this.hue = MEASURED_HUES[0];
    this.cueHues = new Map();   // id -> { hue, durationMs } from the sfx manifest
    this.hueLockUntil = 0;      // while a cue owns the hue, the spectral fallback stands down
    this.pendingClass = -1;
    this.pendingSince = 0;
    this.lastSound = 0;
    this.lastFrameAt = 0;
    this.disposed = false;
    this.onVisibility = () => { if (document.hidden) this.pause(); else this.watch(); };
    this.onCue = (event) => {
      const state = event?.detail?.state;
      if (state === 'playing') { this.pendingSince = 0; this.pendingClass = -1; this.start(); }
    };
  }

  /** Build the GL surface. Returns false (never throws) when WebGL is unavailable. */
  init() {
    if (this.ready || this.disposed || !this.host) return this.ready;
    try {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, depth: false });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.canvas = this.renderer.domElement;
      this.canvas.id = 'audioWaveField';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.host.prepend(this.canvas);

      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

      const capacity = POINT_BUDGETS.graphics;
      this.positions = new Float32Array(capacity * 3);
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
      this.geometry.setDrawRange(0, 0);
      this.material = new THREE.PointsMaterial({
        size: 1.8,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,   // additive splats must never occlude one another
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      this.points = new THREE.Points(this.geometry, this.material);
      this.points.frustumCulled = false;
      this.scene.add(this.points);

      this.resize();
      if (typeof ResizeObserver === 'function') {
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.host);
      } else {
        window.addEventListener('resize', () => this.resize());
      }
      this.ready = true;
    } catch (error) {
      console.info('[audio-wave] disabled:', error?.message || error);
      this.ready = false;
    }
    return this.ready;
  }

  resize() {
    if (!this.renderer || !this.host) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.left = -aspect; this.camera.right = aspect;
    this.camera.top = 1; this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
  }

  setRenderPriority(priority) {
    if (RENDER_PRIORITIES.includes(priority)) this.renderPriority = priority;
    if (this.material) this.material.size = this.renderPriority === 'performance' ? 2.6 : 1.8;
  }

  setReduceMotion(reduce) {
    this.reduceMotion = !!reduce;
    if (this.reduceMotion) { this.pause(); this.hide(); this.clearSurface(); }
    else this.watch();
  }

  show() { this.canvas?.classList.add('on'); }

  /** Opacity only — the CSS transition does the fade, the surface is cleared after it. */
  hide() { this.canvas?.classList.remove('on'); }

  clearSurface() { try { this.renderer?.clear(); } catch (_) { /* context lost */ } }

  /** Read the shipped cue hues once. Silently does nothing if the pack is not present. */
  async loadCueManifest() {
    try {
      const response = await fetch(SFX_MANIFEST_URL);
      if (!response.ok) return;
      this.cueHues = cueHueMap(await response.json());
    } catch (_) { /* the sfx pack ships separately — spectral hue stays the fallback */ }
  }

  /**
   * A sound effect just fired. The manifest hue is authoritative (the analyser cannot
   * resolve these pitches at fftSize 512), so it snaps in immediately and holds for the
   * cue's own duration; short cues also get an amplitude kick so they are actually seen.
   */
  noteCue(id) {
    const cue = this.cueHues.get(String(id || ''));
    const now = performance.now();
    if (cue) {
      this.hue = cue.hue;
      this.hueLockUntil = now + (cue.durationMs || 800) + CUE_HUE_TAIL_MS;
      this.pendingClass = -1;
    }
    this.amp = Math.max(this.amp, CUE_KICK);
    this.lastSound = now;
    this.start();
  }

  /** Cheap silent-state poll. No rAF runs while this is the only thing alive. */
  watch() {
    if (this.disposed || this.reduceMotion) return;
    clearTimeout(this.watchTimer);
    const analyser = window.BKAudio?.analyser || null;
    if (!analyser) {
      this.watchTimer = setTimeout(() => this.watch(), ANALYSER_WAIT_MS);
      return;
    }
    if (this.analyser !== analyser) {
      this.analyser = analyser;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
    }
    if (!this.running) {
      this.analyser.getByteFrequencyData(this.bins);
      if (dominantBin(this.bins).index >= 0) { this.start(); return; }
    }
    this.watchTimer = setTimeout(() => this.watch(), IDLE_WATCH_MS);
  }

  start() {
    if (this.disposed || this.reduceMotion || this.running || document.hidden) return;
    if (!this.ready && !this.init()) return;
    clearTimeout(this.watchTimer);
    clearTimeout(this.stopTimer);
    this.running = true;
    this.lastSound = performance.now();
    this.lastFrameAt = performance.now();
    this.show();
    this.frame = requestAnimationFrame(this.tick);
  }

  pause() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.running = false;
    clearTimeout(this.watchTimer);
  }

  /** Fade out, then drop the loop entirely and go back to the cheap poll. */
  settle() {
    if (!this.running) return;
    this.pause();
    this.hide();
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.amp = 0; this.level = 0; this.peak = MIN_PEAK;
      this.clearSurface();
      this.watch();
    }, FADE_OUT_MS);
  }

  tick = (now) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    try {
      const dt = Math.min(0.05, (now - this.lastFrameAt) / 1000 || 0.016);
      this.lastFrameAt = now;
      const analyser = window.BKAudio?.analyser || this.analyser;
      if (!analyser) { this.settle(); return; }
      if (this.analyser !== analyser) {
        this.analyser = analyser;
        this.bins = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this.bins);

      // A single hot bin is the honest "something is sounding" test: a pure chime barely
      // moves the mean across 256 bins but pins its own bin near the top of the range.
      const peakBin = dominantBin(this.bins);
      if (peakBin.index >= 0) this.lastSound = now;
      else if (now - this.lastSound > IDLE_TAIL_MS) { this.settle(); return; }

      const level = averageLevel(this.bins);
      this.level += (level - this.level) * 0.3;
      // Adaptive normaliser: a quiet ui chime and a loud TTS line both read clearly.
      this.peak = Math.max(this.peak * PEAK_DECAY, this.level, MIN_PEAK);
      const target = clamp((this.level - SILENCE_FLOOR) / Math.max(0.02, this.peak - SILENCE_FLOOR), 0, 1);
      // Asymmetric: rise fast so a 150 ms one-shot is visible, fall slowly so the field
      // relaxes instead of flickering between syllables.
      this.amp += (target - this.amp) * (target > this.amp ? 0.42 : 0.16);

      const sampleRate = analyser.context?.sampleRate || 48000;
      const rings = peakBin.index >= 0 ? ringCountFromBin(peakBin.index, this.bins.length) : MIN_RINGS;

      // Hue snaps on a new cue — it never cross-fades (reference §5). A manifest cue owns
      // the hue while it sounds; the spectral derivation is the fallback for TTS/chime.
      if (peakBin.index >= 0 && now >= this.hueLockUntil) {
        const pitchClass = frequencyToPitchClass(binToFrequency(peakBin.index, sampleRate, analyser.fftSize));
        if (pitchClass >= 0) {
          if (pitchClass !== this.pendingClass) { this.pendingClass = pitchClass; this.pendingSince = now; }
          else if (now - this.pendingSince >= SNAP_HOLD_MS) this.hue = pitchClassToHue(pitchClass);
        }
      }

      this.paint(rings, dt);
    } catch (error) {
      console.info('[audio-wave] frame failed, stopping:', error?.message || error);
      this.pause();
      this.hide();
    }
  };

  paint(rings, dt) {
    const amp = this.amp;
    const radius = 0.98 * (0.55 + 0.45 * amp);   // full-height disc, breathing with loudness
    const spacingTarget = radius / rings;         // ring spacing IS the wavelength
    this.spacing += (spacingTarget - this.spacing) * 0.3;
    const spacing = this.spacing;
    const ringWidth = spacing * 0.15; // narrow enough that the annuli read as rings, not haze
    const spokes = rings * 2;
    const spokeStep = TAU / spokes;
    this.swirl += dt * 0.16 * amp;                // motion only while something is sounding

    const count = pointBudget(this.renderPriority, { reduceMotion: this.reduceMotion, activity: amp });
    const positions = this.positions;
    const webMix = 0.34 + 0.22 * amp;
    let written = 0;
    for (let i = 0; i < count; i++) {
      const ring = (Math.random() * rings) | 0;
      const jitter = (Math.random() + Math.random() - 1) * ringWidth;
      const r = (ring + 0.5) * spacing + jitter;
      if (r <= 0 || r > radius) continue;
      let theta;
      if (Math.random() < webMix) {
        const spoke = (Math.random() * spokes) | 0;
        theta = (spoke + (Math.random() + Math.random() - 1) * 0.17) * spokeStep + this.swirl;
      } else {
        theta = Math.random() * TAU;
      }
      const offset = written * 3;
      positions[offset] = Math.cos(theta) * r;
      positions[offset + 1] = Math.sin(theta) * r;
      positions[offset + 2] = 0;
      written++;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.setDrawRange(0, written);
    this.material.color.setHSL(this.hue / 360, 0.42, 0.54);
    // Ceiling measured against the live window: any higher and the field stops reading as
    // texture behind the data and starts competing with it.
    this.material.opacity = 0.034 + 0.062 * amp;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.pause();
    clearTimeout(this.stopTimer);
    this.observer?.disconnect();
    window.removeEventListener('bk-audio-state', this.onCue);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.geometry?.dispose();
    this.material?.dispose();
    this.renderer?.dispose();
    this.canvas?.remove();
  }
}

/**
 * Learn which sound effect just fired.
 *
 * The audio engine emits `bk-sfx-cue` when it starts a cue, so the id arrives by event
 * rather than by wrapping someone else's method. The cue id is what selects the hue:
 * at fftSize 512 the bins are ~86 Hz wide and cannot resolve these pitches, so a hue
 * derived from the spectrum would collapse every cue onto the same few colours.
 */
function tapSfxCues(field) {
  window.addEventListener('bk-sfx-cue', (event) => {
    try { field.noteCue(event.detail?.id); } catch (_) { /* never break audio for a visual */ }
  });
}

/**
 * Mount the field into `host` and wire it to playback, settings and reduced motion.
 * Always safe to call: returns null instead of throwing when the host or WebGL is missing.
 */
export function mountAudioWaveField(host) {
  try {
    if (!host) return null;
    const field = new AudioWaveField({ host });
    if (!field.init()) return null;

    const reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let settingsReduce = false;
    const applyMotion = () => field.setReduceMotion(!!reducedMq?.matches || settingsReduce);
    reducedMq?.addEventListener?.('change', applyMotion);

    const applyAppearance = (appearance = {}) => {
      field.setRenderPriority(appearance.renderPriority);
      settingsReduce = appearance.reduceMotion === true;
      applyMotion();
    };
    try {
      const cached = localStorage.getItem('bk.renderPriority');
      if (cached) field.setRenderPriority(cached);
    } catch (_) { /* private mode */ }
    window.bigkiji?.settingsGet?.().then((settings) => applyAppearance(settings?.appearance)).catch(() => {});
    window.bigkiji?.onSettingsChanged?.((settings) => applyAppearance(settings?.appearance));

    window.addEventListener('bk-audio-state', field.onCue);
    document.addEventListener('visibilitychange', field.onVisibility);
    field.loadCueManifest();
    tapSfxCues(field);
    applyMotion();
    return field;
  } catch (error) {
    console.info('[audio-wave] mount skipped:', error?.message || error);
    return null;
  }
}
