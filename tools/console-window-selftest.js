'use strict';
// The console window is markup in one file and behaviour in another, joined only by
// string ids. A renamed id fails silently — no error, just a control that stops working
// — and Electron windows are not covered by the smoke test beyond tray and main. So the
// contract between the two files is checked here, statically, where it is cheap.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('src/components/UI/console.html');
const js = read('src/components/UI/console.js');
const main = read('src/core/main.js');
const preload = read('src/core/preload.js');

// ---- every id the behaviour asks for exists in the markup -------------------
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
for (const id of referenced) {
  assert.ok(declared.has(id), `console.js reads #${id}, which console.html does not define`);
}
assert.ok(referenced.size > 15, 'the id sweep should be finding the real control set');

// ---- the files the window loads are actually on disk ------------------------
for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
  if (src.startsWith('http')) continue;
  assert.ok(fs.existsSync(path.resolve(root, 'src/components/UI', src)), `console.html loads a missing script: ${src}`);
}
for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
  assert.ok(fs.existsSync(path.resolve(root, 'src/components/UI', href)), `console.html loads a missing stylesheet: ${href}`);
}

// ---- house rules ------------------------------------------------------------
// backdrop-filter and vibrancy destroy each other (electron#39529, measured in
// glass-lab). This window sets no vibrancy, and must not start using the other half.
// Matches the declaration, not the word: this file explains the rule in a comment, and
// a test that cannot tell prose from CSS would forbid documenting the reason.
assert.ok(!/(?:^|[;{\s])(?:-webkit-)?backdrop-filter\s*:/im.test(html), 'console.html must not use backdrop-filter');
assert.ok(/Content-Security-Policy/.test(html), 'the window that renders model output needs a CSP');
assert.ok(!/vibrancy/.test(main.slice(main.indexOf('function createConsoleWindow'), main.indexOf('function createConsoleWindow') + 1200)),
  'the console window is opaque on purpose — adding vibrancy would break its stylesheet');

// Model output is escaped before it is marked up, and never assigned raw.
assert.ok(/renderMarkdown/.test(js), 'assistant replies go through the escaping renderer');
assert.ok(/bubble\.textContent = text/.test(js), "the owner's own text is set as text, never parsed");

// Motion discipline: transitions rather than keyframes for anything retriggered, and a
// reduced-motion escape hatch that follows the app setting as well as the OS one.
assert.ok(/prefers-reduced-motion/.test(html), 'the OS reduced-motion setting is honoured');
assert.ok(/reduce-motion/.test(html) && /reduce-motion/.test(js), "and so is the app's own appearance.reduceMotion");
assert.ok(/button:active\s*\{\s*transform:\s*scale\(\.97\)/.test(html), 'buttons acknowledge the press');

// ---- main process wiring ----------------------------------------------------
assert.ok(/function createConsoleWindow\(\)/.test(main), 'main.js creates the console window');
assert.ok(/consoleWin\.loadFile\(path\.join\(UI_ROOT, 'console\.html'\)\)/.test(main), 'and loads console.html');
assert.ok(/for \(const w of \[trayWin, mainWin, consoleWin\]\)/.test(main),
  'the console window must receive broadcasts, or it shows a frozen snapshot of a live system');
assert.ok(/ipcMain\.on\('open-console'/.test(main), 'something has to be able to open it');
assert.ok(/openConsole: \(\) => ipcRenderer\.send\('open-console'\)/.test(preload), 'and the renderer needs the door');
assert.ok(/Open Console/.test(main), 'the tray menu offers it');

// Closing hides rather than destroys, matching the other windows: a destroyed window
// would drop the broadcast target and take the terminal mirror with it.
const block = main.slice(main.indexOf('function createConsoleWindow'));
assert.ok(/consoleWin\.on\('close'.*e\.preventDefault\(\); consoleWin\.hide\(\)/s.test(block.slice(0, 1400)),
  'close hides the console window instead of destroying it');

// ---- the switch the owner asked for ----------------------------------------
assert.ok(/setView\('terminal'\)/.test(js) && /setView\('chat'\)/.test(js), 'both views are reachable');
assert.ok(/event\.key === '1'/.test(js) && /event\.key === '2'/.test(js), 'and reachable from the keyboard');
assert.ok(/bk\.ptyInput/.test(js) && /bk\.onPtyData/.test(js), 'the terminal is wired to the real pty');
assert.ok(/openMain\(\)/.test(js), 'the 3D scene is one button away rather than underneath');

console.log('console window selftest: PASS · markup and behaviour agree on every id · assets exist · opaque with no backdrop-filter · CSP present · broadcasts reach it · chat and terminal both reachable');
