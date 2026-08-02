'use strict';
// Selftest for the audio-reactive background wave (src/domain/3d-canvas/components/audio-wave-field.js).
//
// The pure functions are exercised against known inputs taken from docs/reference-analysis.md
// (note -> hue measured off SE1.mp4, ring counts and point budgets from SE3.mp4). The source
// text is then checked for the two house rules this layer could plausibly break: no
// backdrop-filter (it destroys Electron vibrancy) and no new third-party dependency.
//
// The module is ESM and pulls in three, so it is imported dynamically from this CJS entry.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'src', 'domain', '3d-canvas', 'components', 'audio-wave-field.js');
const source = fs.readFileSync(modulePath, 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'components', 'UI', 'main.html'), 'utf8');

// ---------------------------------------------------------------------------
// Static policy: nothing here may reintroduce backdrop-filter or a new dependency.
// ---------------------------------------------------------------------------
// (the `\s*:` guards the declaration itself — both files mention the ban in prose)
assert.doesNotMatch(source, /backdrop-filter\s*:/i, 'backdrop-filter breaks Electron vibrancy');
assert.doesNotMatch(html, /backdrop-filter\s*:/i, 'main.html must stay free of backdrop-filter');

// Every module specifier must be relative or the already-vendored three.
const specifiers = [...source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
assert.ok(specifiers.length > 0, 'the module is expected to import something');
for (const specifier of specifiers) {
  const allowed = specifier.startsWith('./') || specifier.startsWith('../')
    || specifier === 'three' || specifier.startsWith('three/');
  assert.ok(allowed, `unexpected third-party import "${specifier}" — no new dependencies allowed`);
}
assert.doesNotMatch(source, /\brequire\s*\(/, 'the renderer module must stay pure ESM');

// The wave layer must actually be wired into the page.
assert.match(html, /mountAudioWaveField/, 'main.html must mount the wave field');
assert.match(html, /#audioWaveField\s*\{/, 'main.html must style the wave layer');
assert.match(html, /#audioWaveField[^}]*z-index:\s*-1/, 'the wave layer must sit behind the synapse canvas');
assert.match(html, /prefers-reduced-motion: reduce\s*\)\s*\{\s*#audioWaveField/, 'reduced motion must hide the layer');
// It must never keep animating a dead analyser.
assert.match(source, /bk-audio-state/, 'the field must react to the playback cue event');
assert.match(source, /cancelAnimationFrame/, 'the rAF loop must be stoppable while silent');
assert.match(source, /depthWrite:\s*false/, 'additive splats must not write depth');
assert.match(source, /AdditiveBlending/, 'the grain relies on additive blending');
// The cue hue comes from the manifest, not from a spectrum the analyser cannot resolve.
assert.match(source, /assets\/sfx\/manifest\.json/, 'cue hues must come from the sfx manifest');
// audio-engine.js belongs to another agent: this layer may observe it, never edit it.
assert.doesNotMatch(source, /this\.settings\s*=|analyser\.fftSize\s*=/, 'the audio engine must not be reconfigured');

// A manifest shaped like the real one but with the edge cases the real one does not have.
function cueHueMapInput() {
  return {
    cues: [
      { id: 'alpha', hue: 32, durationMs: 153 },
      { id: 'beta', hue: 309, durationMs: 1354 },
      { id: 'wrapped', hue: 390, durationMs: 100 },
      { id: 'nodur', hue: 99 },
      { id: 'negdur', hue: 25, durationMs: -4 },
      { id: 'nohue', durationMs: 400 },
      { hue: 200, durationMs: 400 },
      null,
    ],
  };
}

(async () => {
  const wave = await import(pathToFileURL(modulePath).href);

  // -------------------------------------------------------------------------
  // pitch class -> hue (measured from SE1.mp4, docs/reference-analysis.md §3)
  // -------------------------------------------------------------------------
  assert.equal(wave.pitchClassToHue(0), 32, 'C -> 32deg');
  assert.equal(wave.pitchClassToHue(2), 99, 'D -> 99deg');
  assert.equal(wave.pitchClassToHue(4), 163, 'E -> 163deg');
  assert.equal(wave.pitchClassToHue(5), 241, 'F -> 241deg');
  assert.equal(wave.pitchClassToHue(7), 278, 'G -> 278deg');
  assert.equal(wave.pitchClassToHue(9), 340, 'A -> 340deg');
  assert.equal(wave.pitchClassToHue(11), 25, 'B -> 25deg');
  // Octave wrap and negative input land on the same class.
  assert.equal(wave.pitchClassToHue(12), wave.pitchClassToHue(0));
  assert.equal(wave.pitchClassToHue(-12), wave.pitchClassToHue(0));
  assert.equal(wave.pitchClassToHue(NaN), 32, 'a broken reading must fall back to C, not NaN');
  // Accidentals were never sounded: they interpolate between measured neighbours and
  // must stay inside a legal hue range.
  for (const pc of [1, 3, 6, 8, 10]) {
    const hue = wave.pitchClassToHue(pc);
    assert.ok(Number.isFinite(hue) && hue >= 0 && hue < 360, `hue for pitch class ${pc} out of range: ${hue}`);
  }
  assert.equal(wave.pitchClassToHue(1), 65.5, 'C# sits halfway between C and D');
  assert.equal(wave.pitchClassToHue(10), 2.5, 'A# wraps across the B->C seam');

  // -------------------------------------------------------------------------
  // frequency -> pitch class (A4 = 440, 12-TET) using the SE1 measurements
  // -------------------------------------------------------------------------
  assert.equal(wave.frequencyToPitchClass(261.6), 0, 'C4');
  assert.equal(wave.frequencyToPitchClass(293.7), 2, 'D4');
  assert.equal(wave.frequencyToPitchClass(329.5), 4, 'E4');
  assert.equal(wave.frequencyToPitchClass(349.0), 5, 'F4');
  assert.equal(wave.frequencyToPitchClass(391.9), 7, 'G4');
  assert.equal(wave.frequencyToPitchClass(439.0), 9, 'A4');
  assert.equal(wave.frequencyToPitchClass(493.9), 11, 'B4');
  assert.equal(wave.frequencyToPitchClass(523.4), 0, 'C5 folds onto C');
  assert.equal(wave.frequencyToPitchClass(0), -1, 'silence has no pitch');
  assert.equal(wave.frequencyToPitchClass(-40), -1);
  assert.equal(wave.frequencyToPitchClass(undefined), -1);

  // -------------------------------------------------------------------------
  // bin -> frequency (the shipped analyser is fftSize 512 / 256 bins)
  // -------------------------------------------------------------------------
  assert.equal(wave.binToFrequency(0, 48000, 512), 0);
  assert.equal(wave.binToFrequency(1, 48000, 512), 93.75);
  assert.equal(wave.binToFrequency(8, 48000, 512), 750);
  assert.equal(wave.binToFrequency(4, 44100, 512), 344.53125);
  assert.equal(wave.binToFrequency(4, 44100, 0), 0, 'a zero fft size must not divide by zero');

  // -------------------------------------------------------------------------
  // dominant-bin extraction
  // -------------------------------------------------------------------------
  const silence = new Uint8Array(256);
  assert.deepEqual(wave.dominantBin(silence), { index: -1, value: 0 }, 'silence has no dominant bin');

  const tone = new Uint8Array(256);
  tone[7] = 210; tone[8] = 120; tone[14] = 90; // a fundamental plus a partial
  assert.deepEqual(wave.dominantBin(tone), { index: 7, value: 210 });

  // Bin 0/1 carry DC and rumble and are skipped by default.
  const rumble = new Uint8Array(256);
  rumble[0] = 255; rumble[1] = 240; rumble[19] = 64;
  assert.deepEqual(wave.dominantBin(rumble), { index: 19, value: 64 }, 'DC and rumble must not win');
  assert.equal(wave.dominantBin(rumble, { minBin: 0 }).index, 0, 'minBin is configurable');

  // Everything below the noise floor reports no index but still reports the peak.
  const whisper = new Uint8Array(256);
  whisper[30] = 9;
  assert.deepEqual(wave.dominantBin(whisper), { index: -1, value: 9 });
  assert.equal(wave.dominantBin(whisper, { floor: 5 }).index, 30, 'floor is configurable');
  assert.deepEqual(wave.dominantBin(null), { index: -1, value: 0 }, 'a missing buffer must not throw');

  // Mean level, used for amplitude.
  assert.equal(wave.averageLevel(silence), 0);
  assert.equal(wave.averageLevel(new Uint8Array([255, 255, 255, 255])), 1);
  assert.equal(wave.averageLevel(null), 0);

  // -------------------------------------------------------------------------
  // cue id -> hue, read from the shipped sfx manifest.
  // At fftSize 512 (~94 Hz bins) the analyser cannot resolve the C3-C5 cue pack into
  // distinct semitones, so the manifest hue is authoritative for effects and the spectral
  // path is only the fallback for TTS and the chime.
  // -------------------------------------------------------------------------
  const synthetic = cueHueMapInput();
  const map = wave.cueHueMap(synthetic);
  assert.equal(map.get('alpha').hue, 32);
  assert.equal(map.get('alpha').durationMs, 153);
  assert.equal(map.get('beta').hue, 309);
  assert.equal(map.get('wrapped').hue, 30, 'hues are normalised into 0..360');
  assert.equal(map.get('nodur').durationMs, 0, 'a missing duration falls back to 0, not NaN');
  assert.equal(map.has('nohue'), false, 'a cue without a usable hue is skipped');
  assert.equal(map.size, 5);
  assert.equal(wave.cueHueMap(null).size, 0, 'a missing manifest must not throw');
  assert.equal(wave.cueHueMap({}).size, 0);
  assert.equal(wave.cueHueMap({ cues: 'nope' }).size, 0);

  // Against the real pack, when it is present.
  const manifestPath = path.join(root, 'src', 'components', 'UI', 'assets', 'sfx', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const shipped = wave.cueHueMap(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    assert.ok(shipped.size >= 10, `expected the full cue pack, got ${shipped.size}`);
    for (const [id, cue] of shipped) {
      assert.ok(cue.hue >= 0 && cue.hue < 360, `cue "${id}" has an illegal hue ${cue.hue}`);
      assert.ok(cue.durationMs > 0, `cue "${id}" has no duration`);
    }
    // send.wav is the shortest cue in the pack and the one that stresses the idle poll.
    assert.equal(shipped.get('send').hue, 32, 'send resolves to C');
    assert.ok(shipped.get('send').durationMs < 200, 'send is the short one-shot');
  }
  assert.equal(map.get('negdur').durationMs, 0, 'a negative duration falls back to 0');
  // The idle poll must be shorter than the shortest shipped cue or it would be missed.
  const watchMs = Number(/const IDLE_WATCH_MS = (\d+)/.exec(source)?.[1]);
  assert.ok(watchMs > 0 && watchMs < 153, `idle poll ${watchMs}ms must be under the 153ms send cue`);

  // -------------------------------------------------------------------------
  // point budget per appearance.renderPriority
  // -------------------------------------------------------------------------
  const loud = { activity: 1 };
  assert.equal(wave.pointBudget('performance', loud), 3200);
  assert.equal(wave.pointBudget('auto', loud), 14000);
  assert.equal(wave.pointBudget('graphics', loud), 26000);
  assert.ok(wave.pointBudget('performance', loud) < wave.pointBudget('auto', loud),
    'performance must cut the point count hard');
  assert.ok(wave.pointBudget('performance', loud) * 4 < wave.pointBudget('graphics', loud),
    'performance must be far below graphics, not a token reduction');
  assert.equal(wave.pointBudget('nonsense', loud), 14000, 'an unknown priority falls back to auto');
  assert.equal(wave.pointBudget(undefined, loud), 14000);

  // Reduced motion means the field is not sampled at all.
  assert.equal(wave.pointBudget('graphics', { activity: 1, reduceMotion: true }), 0);

  // Quiet moments cost less than loud ones, and the floor is never negative.
  assert.equal(wave.pointBudget('auto', { activity: 0 }), 4200);
  assert.equal(wave.pointBudget('auto', { activity: 0.5 }), 9100);
  assert.ok(wave.pointBudget('auto', { activity: 0.2 }) < wave.pointBudget('auto', { activity: 0.9 }));
  assert.equal(wave.pointBudget('auto', { activity: 4 }), 14000, 'activity is clamped to 1');
  assert.equal(wave.pointBudget('auto', { activity: -3 }), 4200, 'activity is clamped to 0');
  assert.equal(wave.pointBudget('auto', {}), 14000);

  // -------------------------------------------------------------------------
  // ring count = wavelength coupling (reference never leaves 2..7 rings)
  // -------------------------------------------------------------------------
  assert.equal(wave.ringCountFromBin(0, 256), wave.MIN_RINGS);
  assert.equal(wave.ringCountFromBin(255, 256), wave.MAX_RINGS);
  // One ring per octave above the base bin — verified against the spectra measured live
  // through window.BKAudio.analyser at 44.1 kHz / fftSize 512 (86.13 Hz per bin).
  assert.equal(wave.ringCountFromBin(wave.RING_BASE_BIN, 256), wave.MIN_RINGS, 'the base bin is the floor');
  assert.equal(wave.ringCountFromBin(4, 256), 3, '~345 Hz — one octave up');
  assert.equal(wave.ringCountFromBin(9, 256), 4, '~775 Hz — the measured chime tone');
  assert.equal(wave.ringCountFromBin(16, 256), 5, '~1.4 kHz');
  assert.equal(wave.ringCountFromBin(32, 256), 6, '~2.8 kHz');
  assert.equal(wave.ringCountFromBin(64, 256), wave.MAX_RINGS, '~5.5 kHz saturates the range');
  let previous = -Infinity;
  for (let bin = 0; bin < 256; bin++) {
    const rings = wave.ringCountFromBin(bin, 256);
    assert.ok(rings >= wave.MIN_RINGS && rings <= wave.MAX_RINGS, `ring count ${rings} out of range at bin ${bin}`);
    assert.ok(rings >= previous, 'ring count must rise monotonically with frequency');
    previous = rings;
  }
  assert.equal(wave.ringCountFromBin(999, 256), wave.MAX_RINGS, 'out-of-range bins clamp');
  assert.equal(wave.ringCountFromBin(-5, 256), wave.MIN_RINGS);
  // A higher dominant bin means tighter ring spacing, i.e. a shorter wavelength.
  const lowRings = wave.ringCountFromBin(4, 256);
  const highRings = wave.ringCountFromBin(200, 256);
  assert.ok(1 / highRings < 1 / lowRings, 'a higher dominant bin must shorten the wavelength');

  console.log('audio wave field selftest: PASS');
})().catch((error) => {
  console.error('audio wave field selftest: FAIL');
  console.error(error);
  process.exit(1);
});
