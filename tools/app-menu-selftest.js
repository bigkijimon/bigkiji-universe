'use strict';
// What the missing application menu cost, pinned so it cannot come back.
//
// Before app-menu.js there was no `Menu.setApplicationMenu` anywhere in the process, so
// ⌘C / ⌘V had no responders and ⌘, was a keydown listener inside settings-modal.js that
// only fired while a window already had focus. Neither failure raises an error — the
// shortcut simply does nothing — so the checks below are the only place they show up.
//
// The whole point of building the menu as data is that this file needs no Electron: it
// inspects the template directly, which is also the only way to tell a real role from a
// hand-written label that looks like one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MODULE = path.resolve(__dirname, '../src/core/app-menu');
const { APP_NAME, buildMenuTemplate, applyApplicationMenu } = require(MODULE);

// ---- helpers -----------------------------------------------------------------
const items = (template) => {
  const out = [];
  const walk = (list, trail) => {
    for (const item of list || []) {
      out.push({ item, trail });
      if (item.submenu) walk(item.submenu, [...trail, item.label || item.role]);
    }
  };
  walk(template, []);
  return out;
};
const menuNamed = (template, label) => template.find((entry) => entry.label === label);
const roleIn = (menu, role) => (menu?.submenu || []).find((entry) => entry.role === role);
const spy = () => { const fn = (...args) => { fn.calls.push(args); }; fn.calls = []; return fn; };

// ---- the module must stay loadable without Electron ---------------------------
// A stray `require('electron')` would make the menu untestable and would also break any
// tool that loads this file outside the app. Checked two ways: the source, and what the
// require of it actually dragged into the cache.
const source = fs.readFileSync(`${MODULE}.js`, 'utf8');
assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(source), 'app-menu.js must not require electron — Menu is injected');
assert.ok(!Object.keys(require.cache).some((file) => /node_modules[\\/]electron[\\/]/.test(file)),
  'loading app-menu.js pulled Electron into the process');

// ---- macOS: the app menu is first, and Settings lives in it -------------------
const mac = buildMenuTemplate({ isMac: true, handlers: {} });
assert.strictEqual(mac[0].label, APP_NAME, 'on macOS the first menu is the application menu, named after the app');
for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']) {
  assert.ok(roleIn(mac[0], role), `the application menu is missing the ${role} role`);
}

// This is the central regression: ⌘, was renderer-local, so Settings was unreachable
// unless a BigKiji window already had focus.
const settings = items(mac).map(({ item }) => item).filter((item) => /^Settings/.test(item.label || ''));
assert.strictEqual(settings.length, 1, 'exactly one Settings item, or the accelerator is ambiguous');
assert.strictEqual(settings[0].accelerator, 'CmdOrCtrl+,', 'Settings must carry the standard ⌘, accelerator');
assert.strictEqual(typeof settings[0].click, 'function', 'and something has to happen when it is chosen');
assert.ok(mac[0].submenu.includes(settings[0]), 'on macOS Settings belongs in the application menu, not under File');

// ---- Edit is roles, never labels ----------------------------------------------
// `{ label: 'Copy', click: ... }` renders identically and loses the responder chain,
// which is the exact state this app was in.
const edit = menuNamed(mac, 'Edit');
assert.ok(edit, 'there is an Edit menu');
for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']) {
  const entry = roleIn(edit, role);
  assert.ok(entry, `Edit is missing the ${role} role — that shortcut will silently do nothing`);
  assert.strictEqual(entry.label, undefined, `${role} must not be re-labelled by hand; the native label is part of the role`);
  assert.strictEqual(entry.click, undefined, `${role} must not carry a click handler — it would fight the native command`);
  assert.strictEqual(entry.accelerator, undefined, `${role} keeps the platform's own key equivalent`);
}

// ---- View and Window ----------------------------------------------------------
const view = menuNamed(mac, 'View');
for (const role of ['reload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']) {
  assert.ok(roleIn(view, role), `View is missing the ${role} role`);
}
const windowMenu = menuNamed(mac, 'Window');
for (const role of ['minimize', 'zoom', 'front']) {
  assert.ok(roleIn(windowMenu, role), `Window is missing the ${role} role`);
}

// ---- File: the two windows the owner actually opens ---------------------------
const file = menuNamed(mac, 'File');
const byLabel = (menu, label) => (menu.submenu || []).find((entry) => entry.label === label);
assert.ok(byLabel(file, 'New Console Window'), 'the console is reachable from the menu bar');
assert.ok(byLabel(file, 'Open Synapse Canvas'), 'and so is the 3D canvas');
assert.ok(roleIn(file, 'close'), 'File offers Close Window');

// ---- explicit accelerators must not collide -----------------------------------
// Two items on one key equivalent is a coin flip at runtime, and reusing one a role
// already owns (⌘C, ⌘W, ⌘Q…) shadows the native command this file exists to restore.
const RESERVED = new Set(['CmdOrCtrl+Z', 'CmdOrCtrl+X', 'CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+A',
  'CmdOrCtrl+W', 'CmdOrCtrl+Q', 'CmdOrCtrl+R', 'CmdOrCtrl+M']);
const seen = new Set();
for (const { item } of items(mac)) {
  if (!item.accelerator) continue;
  assert.ok(!seen.has(item.accelerator), `${item.accelerator} is bound twice`);
  assert.ok(!RESERVED.has(item.accelerator), `${item.accelerator} already belongs to a native role`);
  seen.add(item.accelerator);
}

// ---- Windows and Linux get a template that Electron can build -----------------
// Electron's role table is platform-dependent: a macOS-only role on Windows is a
// construction error, so the whole menu would fail to build rather than lose one item.
const other = buildMenuTemplate({ isMac: false, handlers: {} });
assert.strictEqual(other[0].label, 'File', 'off macOS there is no application menu; File comes first');
assert.ok(!other.some((menu) => menu.label === APP_NAME), 'and no menu named after the app');
const MAC_ONLY = new Set(['about', 'services', 'hide', 'hideOthers', 'unhide', 'front', 'zoom', 'pasteAndMatchStyle']);
for (const { item, trail } of items(other)) {
  if (item.role === 'about' && trail[0] === 'help') continue; // About lives under Help off macOS
  assert.ok(!MAC_ONLY.has(item.role), `${item.role} is macOS-only and must not appear in the ${process.platform} template`);
}
// Settings still has to be reachable — it moves to File rather than disappearing.
const otherSettings = items(other).map(({ item }) => item).find((item) => /^Settings/.test(item.label || ''));
assert.ok(otherSettings && otherSettings.accelerator === 'CmdOrCtrl+,', 'Settings keeps its accelerator off macOS');
assert.ok(menuNamed(other, 'File').submenu.includes(otherSettings), 'and moves under File, where Windows and Linux expect it');
for (const role of ['copy', 'paste', 'selectAll']) {
  assert.ok(roleIn(menuNamed(other, 'Edit'), role), `Edit is missing ${role} off macOS`);
}

// ---- no handlers is a supported state -----------------------------------------
// main.js may wire the menu before every window factory exists, and openDocs may never
// exist at all. Building must not throw, and neither must choosing an item.
for (const template of [mac, other]) {
  for (const { item } of items(template)) {
    if (typeof item.click !== 'function') continue;
    assert.doesNotThrow(() => item.click(item, undefined, {}), `${item.label} threw with no handler behind it`);
  }
}
assert.doesNotThrow(() => buildMenuTemplate(), 'no arguments at all must still produce a menu');
assert.doesNotThrow(() => buildMenuTemplate({ handlers: { openSettings: 'not a function' } }),
  'a handler of the wrong type must not blow up construction');
assert.doesNotThrow(() => items(buildMenuTemplate({ handlers: { openSettings: 'not a function' } }))
  .forEach(({ item }) => (typeof item.click === 'function' ? item.click() : null)),
  'nor blow up on click');
assert.ok(!buildMenuTemplate({ isMac: true, handlers: {} }).some((menu) => menu.role === 'help'),
  'an empty Help menu is worse than none — it is omitted when there is nothing to open');

// ---- with handlers, the right one is called -----------------------------------
const handlers = { openSettings: spy(), openConsole: spy(), openMain: spy(), openDocs: spy() };
const wired = buildMenuTemplate({ isMac: true, handlers });
const click = (label) => items(wired).map(({ item }) => item).find((item) => (item.label || '').startsWith(label)).click();

click('Settings');
assert.strictEqual(handlers.openSettings.calls.length, 1, 'Settings… opens settings');
click('New Console Window');
assert.strictEqual(handlers.openConsole.calls.length, 1, 'New Console Window opens the console');
click('Open Synapse Canvas');
assert.strictEqual(handlers.openMain.calls.length, 1, 'Open Synapse Canvas opens the canvas');
const helpMenu = wired.find((menu) => menu.role === 'help');
assert.ok(helpMenu, 'Help appears once there is somewhere for it to go');
helpMenu.submenu[0].click();
assert.strictEqual(handlers.openDocs.calls.length, 1, 'and Help opens the documentation');
assert.strictEqual(handlers.openSettings.calls.length, 1, 'no item fires a handler that is not its own');

// ---- applyApplicationMenu installs exactly what it built ----------------------
// The three lines that touch Electron, driven by a fake Menu so the real one is never
// needed. The failure this catches is building a menu and never installing it.
const installed = [];
const FakeMenu = {
  buildFromTemplate: (template) => ({ template }),
  setApplicationMenu: (menu) => installed.push(menu),
};
const built = applyApplicationMenu({ Menu: FakeMenu, app: { getName: () => 'Test App' }, isMac: true, handlers });
assert.strictEqual(installed.length, 1, 'the menu is set as the application menu, not merely constructed');
assert.strictEqual(installed[0], built, 'and the menu that was installed is the one that was returned');
assert.strictEqual(built.template[0].label, 'Test App', 'the app menu is titled from app.getName()');

// …but only when getName() is a display name. productName lives under `build` in this
// project, so in development getName() returns the package id, and "bigkiji-universe" in
// the menu bar looks like a bug rather than a product.
const id = applyApplicationMenu({ Menu: FakeMenu, app: { getName: () => 'bigkiji-universe' }, isMac: true });
assert.strictEqual(id.template[0].label, APP_NAME, 'a package id is not a display name; the constant wins');
assert.strictEqual(
  applyApplicationMenu({ Menu: FakeMenu, app: { getName: () => 'bigkiji-universe' }, appName: 'Explicit', isMac: true }).template[0].label,
  'Explicit', 'an explicit appName always wins');
assert.strictEqual(applyApplicationMenu({}), null, 'a caller that forgets Menu gets null, not a startup crash');
assert.strictEqual(applyApplicationMenu(), null, 'and so does a caller that passes nothing');

console.log('app menu selftest: PASS · macOS app menu present · Settings… on ⌘, in the menu bar, not in a renderer keydown · Edit is roles so ⌘C/⌘V/⌘Z reach the native responders · Windows/Linux template carries no macOS-only role · builds and clicks safely with no handlers · every item calls only its own handler · applyApplicationMenu installs what it built');
