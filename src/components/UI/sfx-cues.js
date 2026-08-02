'use strict';
// Binds the sound-effect cues to the events that already exist, in one place.
//
// Deliberately centralised: scattering BKAudio.play() calls through the renderer is how
// an app ends up either silent in the cases that matter or chattering on every tick.
// Every cue here answers "something happened that the owner would want to know about
// without looking", which is the only justification for making noise.
//
// Nothing here throws. BKAudio.play() already fails quietly and logs once when an asset
// is missing, and the whole module is a no-op when the audio engine is absent.
(() => {
  const api = window.bigkiji;
  if (!api) return;

  const manifestUrl = './assets/sfx/manifest.json';
  const cues = new Map();

  // Repeat guards, per cue. Sub-agent traffic arrives in bursts; without this the
  // completion of five specialists inside one second is five overlapping chords.
  const lastPlayed = new Map();
  const MIN_GAP_MS = { 'agent-done': 900, 'agent-start': 900, phase: 1200, notify: 1500, error: 1500 };

  function play(id) {
    const engine = window.BKAudio;
    if (!engine || typeof engine.play !== 'function') return;
    const now = performance.now();
    const gap = MIN_GAP_MS[id] || 250;
    if (now - (lastPlayed.get(id) || -Infinity) < gap) return;
    lastPlayed.set(id, now);
    engine.play(id, cues.get(id)?.category || 'ui');
  }

  // The manifest is the source of truth for a cue's category and hue. The wave layer
  // reads the same file, so the sound and its colour cannot drift apart.
  fetch(manifestUrl).then((response) => (response.ok ? response.json() : null)).then((manifest) => {
    for (const cue of manifest?.cues || []) cues.set(cue.id, cue);
    window.BKSfxCues = { get: (id) => cues.get(id) || null, play };
    // Announce the app is up only once the cue table is loaded, so the very first sound
    // is not the one that silently misses its category.
    play('startup');
  }).catch(() => { window.BKSfxCues = { get: () => null, play }; });

  // ---- bindings to events that already exist -------------------------------
  // Owner submitted something. Short and quiet by design — this fires most often.
  window.addEventListener('bk:prompt-sent', () => play('send'));

  api.onPhaseUpdate?.((phase) => {
    const name = String(phase?.phase || '');
    if (name === 'AWAITING_APPROVAL' || name === 'AWAITING_OWNER_DIRECTIVE') play('approval');
    else if (name === 'COMPLETED') play('report');
    else if (name) play('phase');
  });

  api.onRunEvent?.((run) => {
    const status = String(run?.status || '');
    if (status === 'AWAITING_APPROVAL') play('approval');
    else if (status === 'FAILED' || status === 'SECURITY_BLOCKED') play('error');
  });

  api.onTaskEvent?.((task) => {
    const status = String(task?.status || '');
    if (status === 'running') play('agent-start');
    else if (status === 'completed') play('agent-done');
    else if (status === 'failed' || status === 'blocked') play('error');
  });

  // The completion report is the one moment the owner is explicitly asked to look.
  window.addEventListener('bk:task-report-shown', () => play('report'));

  window.addEventListener('beforeunload', () => play('shutdown'));
})();
