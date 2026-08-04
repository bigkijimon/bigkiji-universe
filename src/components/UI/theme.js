'use strict';

// One attribute, three windows.
//
// `appearance.theme` decides the design language — Paper or Quiet Studio — and
// every window styles itself from `document.documentElement.dataset.theme`. The setting
// existed before this file did, as a <select> with one option that normalize() overwrote
// on every save; it is validated and persisted now (settings-store.js THEMES), so this is
// the piece that carries it to the glass.
//
// It is a plain script on purpose, following markdown.js: tray.html and main.html can
// only load plain scripts with <script src>, and the console renderer imports it for its
// side effect. One implementation, no second copy to drift.
//
// This does NOT touch synapse.js. The 3D scene reads `appearance` through its own
// `applyAppearanceSettings` and keeps doing so; 2507 lines that grab DOM ids at module
// scope are not somewhere to add a second concern.
(function () {
  const THEMES = ['paper', 'studio'];
  const FALLBACK = 'paper';

  /** Put the theme on <html>, where CSS can see it. Idempotent. */
  function apply(theme) {
    const value = THEMES.includes(theme) ? theme : FALLBACK;
    const root = document.documentElement;
    if (root.dataset.theme !== value) root.dataset.theme = value;
    return value;
  }

  function applySettings(settings) {
    return apply(settings && settings.appearance ? settings.appearance.theme : null);
  }

  // Applied before the first paint where possible: a window that renders in Studio's
  // near-black and then flips to Paper is a flash the owner would see on every launch.
  // The attribute is set from the last known value immediately, then corrected when the
  // real settings arrive — the two agree except on the very first run.
  function start() {
    try { apply(localStorage.getItem('bk:theme')); } catch (_) { apply(null); }
    const bridge = window.bigkiji;
    if (!bridge) return;
    const remember = (settings) => {
      const value = applySettings(settings);
      try { localStorage.setItem('bk:theme', value); } catch (_) { /* private mode */ }
    };
    bridge.settingsGet && bridge.settingsGet().then(remember).catch(() => {});
    bridge.onSettingsChanged && bridge.onSettingsChanged(remember);
  }

  window.BKTheme = { THEMES, apply, applySettings, start };
  start();
}());
