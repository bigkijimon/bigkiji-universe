'use strict';
// The application menu, as data.
//
// This app shipped without one: `Menu.setApplicationMenu` appeared nowhere, and the only
// menu in the process was the tray context menu (Open Console / Open Synapse Canvas /
// Quit). Two things followed from that, and neither is cosmetic.
//
//   * Electron installs the native editing commands from the menu. With no application
//     menu there are no ⌘Z / ⌘X / ⌘C / ⌘V / ⌘A responders, so text fields in the console
//     and the settings modal could be typed into but not copied out of.
//   * ⌘, was a keydown listener inside settings-modal.js, which means Settings opened
//     only while a BigKiji window already had focus — the one moment the owner does not
//     need a shortcut for it.
//
// Both fixes are roles. A role is not a label with a click handler: it hands the item to
// the native responder chain, which is what makes ⌘C copy from whichever field has focus,
// including fields this process does not know about. Writing `{ label: 'Copy', click }`
// looks the same in a screenshot and behaves like a dead key.
//
// Tray-resident mode is worth stating explicitly, because it looks like a reason not to
// bother: main.js calls app.dock.hide() in normal use, which makes this an accessory app,
// and an accessory app does not draw a menu bar. The accelerators still fire — AppKit
// dispatches key equivalents through the main menu whether or not it is on screen — so
// the menu has to exist precisely because it is usually invisible.
//
// Nothing here requires electron. The template is a value, the caller supplies Menu, and
// that is the whole reason this file can be tested by `node tools/app-menu-selftest.js`.

const APP_NAME = 'BigKiji Universe';

// Handlers come from main.js and any of them may be absent — openDocs has no destination
// yet, and a caller that only wants the edit roles may pass nothing at all. Resolving the
// handler at click time rather than at build time keeps a missing one harmless and lets
// the caller hand over an object it fills in later.
function invoke(handlers, name) {
  return (...args) => {
    const handler = handlers ? handlers[name] : undefined;
    if (typeof handler === 'function') handler(...args);
  };
}

// A function rather than a shared object: macOS puts Settings in the app menu and every
// other platform puts it under File, and one MenuItem instance must not live in two menus.
const settingsItem = (handlers) => ({
  label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: invoke(handlers, 'openSettings'),
});

// Returns the template array. Pure: no electron, no process state beyond the platform
// default, no mutation of `handlers`.
//
// `isMac` is a parameter and not a constant so the Windows and Linux shapes can be tested
// from a Mac. macOS-only roles (services, hide, hideOthers, unhide, front, zoom,
// pasteAndMatchStyle) stay inside the isMac branches, because Electron's role table is
// platform-dependent and an unsupported role is a construction error, not a missing item.
function buildMenuTemplate({ appName = APP_NAME, isMac = process.platform === 'darwin', handlers = {} } = {}) {
  const name = appName || APP_NAME;

  // Help exists only when it would have something in it. An empty Help menu is worse than
  // none: it reads as a broken app rather than a small one.
  const help = [];
  if (typeof handlers?.openDocs === 'function') help.push({ label: `${name} Documentation`, click: invoke(handlers, 'openDocs') });
  if (!isMac) help.push({ role: 'about' }); // off macOS, About belongs under Help

  return [
    // ---- application menu (macOS only) ---------------------------------------
    // role 'quit' is safe here even though every window's close handler calls
    // preventDefault: main.js sets `quitting = true` on app 'before-quit', so ⌘Q reaches
    // the same state the tray's Quit item does.
    ...(isMac ? [{
      label: name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem(handlers),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),

    // ---- File ------------------------------------------------------------------
    // The console is first because it is where work happens — the same order the tray
    // menu uses, for the same reason. ⌘W closes, which for these windows means hide:
    // main.js keeps them alive so broadcasts still have a target.
    {
      label: 'File',
      submenu: [
        { label: 'New Console Window', accelerator: 'CmdOrCtrl+N', click: invoke(handlers, 'openConsole') },
        { label: 'Open Synapse Canvas', accelerator: 'CmdOrCtrl+O', click: invoke(handlers, 'openMain') },
        { type: 'separator' },
        { role: 'close' },
        // Windows and Linux have no application menu to hold these two.
        ...(isMac ? [] : [{ type: 'separator' }, settingsItem(handlers), { type: 'separator' }, { role: 'quit' }]),
      ],
    },

    // ---- Edit ------------------------------------------------------------------
    // Roles only. This menu is the reason the file exists; a label written by hand here
    // would restore the exact bug it is meant to fix.
    //
    // The native Speech submenu is deliberately left out: this app has its own voice
    // pipeline, and two unrelated ways to make the machine talk is a support question.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },

    // ---- View ------------------------------------------------------------------
    // Zoom is here because the owner reads model output in these windows; reload and the
    // devtools are here because the 3D canvas is the kind of thing that needs restarting
    // without restarting the process.
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // ---- Window ----------------------------------------------------------------
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },

    // ---- Help ------------------------------------------------------------------
    ...(help.length ? [{ role: 'help', submenu: help }] : []),
  ];
}

// app.getName() is a display name only when someone set one. This project keeps
// productName under `build` for electron-builder, so under `npm start` getName() returns
// the package id — "bigkiji-universe" — and a package id in the menu bar reads as a bug.
// It is therefore used only when it looks like a name a person wrote. (macOS shows the
// bundle name for the first menu regardless; this is what the rest of the app sees.)
const looksLikeDisplayName = (value) => typeof value === 'string' && /^[A-Z]/.test(value) && !value.includes('-');

// The only part that touches Electron, kept to three lines so there is nothing in it to
// test. `Menu` and `app` are injected rather than required so this module stays loadable
// under plain node; the guard means a caller that forgets Menu gets null instead of a
// crash during startup.
function applyApplicationMenu({ Menu, app, appName, isMac, handlers = {} } = {}) {
  if (!Menu || typeof Menu.buildFromTemplate !== 'function' || typeof Menu.setApplicationMenu !== 'function') return null;
  const detected = typeof app?.getName === 'function' ? app.getName() : '';
  const name = appName || (looksLikeDisplayName(detected) ? detected : APP_NAME);
  const menu = Menu.buildFromTemplate(buildMenuTemplate({ appName: name, isMac, handlers }));
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { APP_NAME, buildMenuTemplate, applyApplicationMenu };
