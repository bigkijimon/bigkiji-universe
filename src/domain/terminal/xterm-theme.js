'use strict';
// One place that decides what a terminal in this app looks like.
//
// There are two xterm instances mirroring the same pty — one in the console window, one in
// the Synapse Canvas — and until now each carried its own hardcoded palette, so they
// disagreed about the colour of the same session. The values now come from CSS custom
// properties, which means the stylesheet is the single source of truth and a theme switch
// is a re-read rather than a second copy of the colours in JavaScript.
//
// Written as a plain script with a guarded dual export, the same shape as markdown.js:
// main.html can only load it with <script src>, and the console renderer imports it for
// the side effect and reads window.BKXtermTheme. No build step is involved either way.
//
// THE TRUECOLOR CAVEAT — the reason minimumContrastRatio is here.
//
// src/domain/terminal/cli-theme.js emits 24-bit colour (\x1b[38;2;R;G;Bm), not the ANSI 16.
// Its `ink` is rgb(243,232,216), which is very nearly white. Neither theme.foreground nor
// the 16 palette slots can touch a cell that carries its own RGB, so on a light background
// BigKiji's own CLI output would be unreadable. xterm's minimumContrastRatio raises the
// contrast of any foreground — truecolor included — that falls below the ratio against the
// background it is drawn on, which is exactly this problem.
//
// It is set to 4.5 (WCAG AA) on light and 1 (disabled) on dark, so the dark terminal is
// pixel-for-pixel what it has always been and only the light theme is corrected.
//
// Residual, and not fixed here: cells already painted before a switch keep their original
// RGB, so the top of the scrollback can stay low-contrast until it scrolls away. The real
// fix is a light palette in cli-theme.js, which is deliberately out of scope for now.

(function (root) {
  const FALLBACK = {
    dark: {
      background: '#0b0a08', foreground: '#f3e8d8', cursor: '#f28c28',
      selectionBackground: 'rgba(242,140,40,.28)',
    },
    light: {
      background: '#faf9f5', foreground: '#29261b', cursor: '#c2600f',
      selectionBackground: 'rgba(194,96,15,.20)',
    },
  };
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
    'brightCyan', 'brightWhite'];

  function prefersDark() {
    return !!root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function readVars(element) {
    const style = root.getComputedStyle(element || root.document.documentElement);
    const get = (name) => String(style.getPropertyValue(name) || '').trim();
    const theme = {};
    const bg = get('--term-bg');
    const fg = get('--term-fg');
    const cursor = get('--term-cursor');
    const selection = get('--term-selection');
    if (bg) theme.background = bg;
    if (fg) theme.foreground = fg;
    if (cursor) theme.cursor = cursor;
    if (selection) theme.selectionBackground = selection;
    ANSI.forEach((name, index) => {
      const value = get(`--term-ansi-${index}`);
      if (value) theme[name] = value;
    });
    return theme;
  }

  /**
   * The theme object to hand to xterm. Falls back to the built-in palette when the CSS
   * variables are absent, so a window that has not adopted tokens.css still gets the
   * colours it had before rather than xterm's defaults.
   */
  function themeFor(element) {
    const dark = prefersDark();
    return Object.assign({}, dark ? FALLBACK.dark : FALLBACK.light, readVars(element));
  }

  /** Apply to a live terminal. xterm 5.x re-renders on options.theme assignment. */
  function applyTheme(term, element) {
    if (!term) return;
    term.options.theme = themeFor(element);
    // Only the light theme needs correcting; see the truecolor note above.
    term.options.minimumContrastRatio = prefersDark() ? 1 : 4.5;
  }

  /**
   * Re-apply whenever the resolved scheme changes. Returns an unsubscribe function.
   * nativeTheme.themeSource in the main process drives prefers-color-scheme here, so this
   * one listener covers the OS changing *and* the owner picking light or dark by hand.
   */
  function watchTheme(term, element) {
    applyTheme(term, element);
    if (!root.matchMedia) return function () {};
    const query = root.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(term, element);
    query.addEventListener('change', onChange);
    return function () { query.removeEventListener('change', onChange); };
  }

  const api = { themeFor, applyTheme, watchTheme, prefersDark, FALLBACK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BKXtermTheme = api;
}(typeof window !== 'undefined' ? window : globalThis));
