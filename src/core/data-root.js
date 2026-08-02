'use strict';
// Single source of truth for where BigKiji Universe keeps its own data.
//
// This module is loaded by three different processes — the Electron main process,
// the standalone daemon (plain node) and the `bigkiji` CLI — so it must stay pure
// Node. Never require('electron') here.
//
// Resolution order, highest priority first:
//   1. env.BIGKIJI_DATA_ROOT   explicit override; also how Electron tells child processes
//   2. <userData>/data-root.json   pointer written by the first-run setup wizard
//   3. ~/BigKijiUniverse           the one owner-independent default
//
// Before V2.5 the app scattered its state across ~/.bigkiji, ~/.pi/agent/knowledge,
// <userData> and the owner's personal Obsidian vault, and path-config hardcoded that
// vault as a default — so every fresh install inherited one person's folder layout.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Must match package.json "name" so that defaultUserData() equals app.getPath('userData').
const APP_DIR_NAME = 'bigkiji-universe';
const DEFAULT_DIR_NAME = 'BigKijiUniverse';
const POINTER_FILE = 'data-root.json';
const SETUP_FILE = 'setup-state.json';
const ROOT_MARKER = 'bigkiji-data.json';

function defaultUserData(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_DIR_NAME);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR_NAME);
}

function defaultDataRoot(home = os.homedir()) {
  return path.join(home, DEFAULT_DIR_NAME);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// Atomic: write a sibling temp file, fsync it, then rename. A crash mid-write must
// never leave a truncated pointer, because a truncated pointer means the app loses
// track of where the owner's data went.
function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2));
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(tmp, file);
}

function pointerFile(userData) { return path.join(userData, POINTER_FILE); }
function setupFile(userData) { return path.join(userData, SETUP_FILE); }

function readPointer(userData) {
  const value = readJson(pointerFile(userData));
  if (!value || typeof value.dataRoot !== 'string' || !value.dataRoot) return null;
  return {
    version: 1,
    dataRoot: path.resolve(value.dataRoot),
    mode: value.mode === 'reference' ? 'reference' : 'own',
    overrides: value.overrides && typeof value.overrides === 'object' ? value.overrides : {},
    migratedAt: value.migratedAt || '',
  };
}

function writePointer(userData, { dataRoot, mode = 'own', overrides = {}, migratedAt = '' }) {
  const value = { version: 1, dataRoot: path.resolve(dataRoot), mode: mode === 'reference' ? 'reference' : 'own', overrides, migratedAt };
  writeJsonAtomic(pointerFile(userData), value);
  return value;
}

function resolveDataRoot({ userData = defaultUserData(), env = process.env, home = os.homedir() } = {}) {
  const override = String(env.BIGKIJI_DATA_ROOT || '').trim();
  if (override) return { dataRoot: path.resolve(override), userData, mode: 'own', overrides: {}, source: 'env' };
  const pointer = readPointer(userData);
  if (pointer) return { dataRoot: pointer.dataRoot, userData, mode: pointer.mode, overrides: pointer.overrides, source: 'pointer' };
  return { dataRoot: defaultDataRoot(home), userData, mode: 'own', overrides: {}, source: 'default' };
}

// The directory contract. Every consumer derives its paths from here rather than
// building its own os.homedir() string, which is how the old fragmentation happened.
// `overrides` lets reference-mode keep individual roots pointing at their legacy
// location without moving a single byte.
function dataLayout(dataRoot, overrides = {}) {
  const at = (key, ...parts) => (overrides[key] ? path.resolve(overrides[key]) : path.join(dataRoot, ...parts));
  const stateRoot = at('stateRoot', 'state');
  // State files follow the (possibly overridden) stateRoot, but each may also be
  // overridden individually — in reference mode the legacy CLI config is named
  // config.json, not cli-config.json, so a stateRoot override alone is not enough.
  const stateAt = (key, name) => (overrides[key] ? path.resolve(overrides[key]) : path.join(stateRoot, name));
  return {
    dataRoot,
    rootMarkerFile: path.join(dataRoot, ROOT_MARKER),
    stateRoot,
    sessionsRoot: at('sessionsRoot', 'sessions'),
    ideasRoot: at('ideasRoot', 'ideas'),
    logsRoot: at('logsRoot', 'logs'),
    reportsRoot: at('reportsRoot', 'reports'),
    knowledgeRoot: at('knowledgeRoot', 'knowledge'),
    recordingsRoot: at('recordingsRoot', 'recordings'),
    generatedMediaRoot: at('generatedMediaRoot', 'generated-media'),
    ttsCacheRoot: at('ttsCacheRoot', 'cache', 'tts'),
    modelsRoot: at('modelsRoot', 'models'),
    migrationsRoot: at('migrationsRoot', 'migrations'),
    // Individual state files, so nothing has to re-join these names by hand.
    systemMemoryFile: stateAt('systemMemoryFile', 'system_memory.json'),
    remoteConfigFile: stateAt('remoteConfigFile', 'remote.json'),
    daemonPidFile: stateAt('daemonPidFile', 'daemon.pid'),
    mobileDevicesFile: stateAt('mobileDevicesFile', 'mobile-devices.json'),
    cliConfigFile: stateAt('cliConfigFile', 'cli-config.json'),
  };
}

function ensureLayout(layout) {
  for (const key of ['stateRoot', 'sessionsRoot', 'ideasRoot', 'logsRoot', 'reportsRoot',
    'knowledgeRoot', 'recordingsRoot', 'generatedMediaRoot', 'ttsCacheRoot', 'migrationsRoot']) {
    try { fs.mkdirSync(layout[key], { recursive: true }); } catch (_) {}
  }
  if (!fs.existsSync(layout.rootMarkerFile)) {
    try {
      writeJsonAtomic(layout.rootMarkerFile,
        { version: 1, appId: 'com.bigkiji.universe', createdAt: new Date().toISOString() }, 0o644);
    } catch (_) {}
  }
  return layout;
}

// ---- first-run detection -------------------------------------------------
// The marker is setup-state.json, NOT "does dataRoot exist" — a data root can exist
// from a half-failed migration, and treating that as "already set up" would strand
// the owner with no way back into the wizard.
function readSetupState(userData) { return readJson(setupFile(userData)); }

function writeSetupState(userData, value) {
  writeJsonAtomic(setupFile(userData), { version: 1, completedAt: new Date().toISOString(), ...value });
}

function setupStatus({ userData = defaultUserData(), env = process.env } = {}) {
  if (String(env.BIGKIJI_SKIP_SETUP || '') === '1' || env.SMOKE || env.SNAP) return { needed: false, kind: 'suppressed' };
  if (readSetupState(userData)) return { needed: false, kind: 'done' };
  const hasSettings = fs.existsSync(path.join(userData, 'settings.json'));
  return { needed: true, kind: hasSettings ? 'upgrade' : 'fresh' };
}

// ---- vault detection -----------------------------------------------------
// Generic: any directory containing `.obsidian/` is a candidate. This deliberately
// replaces the old hardcoded ~/Documents/CEOBigKiji default — a third party with
// ~/Documents/MyVault/.obsidian gets exactly the same treatment.
function findVaultCandidates(home = os.homedir(), extra = []) {
  const roots = [path.join(home, 'Documents'), home, ...extra];
  const seen = new Set(); const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      if (seen.has(dir) || !fs.existsSync(path.join(dir, '.obsidian'))) continue;
      seen.add(dir);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch (_) {}
      found.push({ path: dir, mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
}

module.exports = {
  APP_DIR_NAME, DEFAULT_DIR_NAME, ROOT_MARKER,
  defaultUserData, defaultDataRoot, resolveDataRoot,
  readPointer, writePointer, pointerFile,
  dataLayout, ensureLayout,
  readSetupState, writeSetupState, setupStatus, setupFile,
  findVaultCandidates, writeJsonAtomic,
};
