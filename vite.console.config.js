'use strict';
// Build config for the console renderer, and only the console renderer.
//
// This app is Electron + electron-builder, and stays that way. Vite is used here as a
// static output tool for one window: it never touches the main process, never touches
// preload, and never replaces the signing or notarisation pipeline. The tray, the
// Synapse Canvas and the setup wizard remain plain scripts loaded by <script src>.
//
// Two settings below are load-bearing rather than stylistic, and both fail in ways that
// are hard to read if they are changed:
//
//   base: './'      The window is opened with loadFile(), so the page runs on file://.
//                   With Vite's default base of '/', every asset reference resolves to
//                   the filesystem root and the whole window 404s with an empty body.
//
//   modulePreload.polyfill: false
//                   The polyfill is emitted as an inline <script>. Dropping it means the
//                   built HTML carries no inline script at all, which is what lets the
//                   production CSP keep script-src at 'self' with no 'unsafe-inline' —
//                   stricter than the window this replaces.

const path = require('path');
const react = require('@vitejs/plugin-react');
const { defineConfig } = require('vite');

const APP_ROOT = path.join(__dirname, 'src/components/UI/console-app');
const DEV_PORT = 5173;

// The dev server needs a looser CSP than the built page: Vite's client uses eval for
// HMR and talks back over a websocket. Rather than shipping that relaxation and hoping
// nobody notices, the strict policy lives in index.html and is swapped *only* while
// serving. apply:'serve' is what guarantees it cannot reach a build — and
// console-window-selftest asserts the built HTML contains neither 'unsafe-eval' nor a
// loopback address, so a regression here fails the test suite rather than shipping.
const devCsp = () => ({
  name: 'bku-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/,
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
      + `script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; `
      + `img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${DEV_PORT} http://127.0.0.1:${DEV_PORT}">`,
  ),
});

module.exports = defineConfig({
  root: APP_ROOT,
  base: './',
  plugins: [react(), devCsp()],
  server: { host: '127.0.0.1', port: DEV_PORT, strictPort: true },
  build: {
    outDir: path.join(__dirname, 'src/components/UI/console-dist'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    // Data URIs would need img-src/font-src to allow them for types the CSP does not
    // list. Emitting every asset as a file keeps the policy as narrow as it is.
    assetsInlineLimit: 0,
    // Measured, not assumed: electron 43.2.0 reports chrome 150.0.7871.129 / node 24.18.0.
    target: 'chrome150',
  },
});
