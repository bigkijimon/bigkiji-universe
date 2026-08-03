'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, globalShortcut, systemPreferences, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
// v13: dotenv-expandで.env APIキーをprocess.envへ（model-routerが検知する）
const { expand } = require('dotenv-expand');
const dotenv = require('dotenv');
const APP_ROOT = path.resolve(__dirname, '..', '..');
// The packaged app's root is Contents/Resources/app, where a secrets file correctly
// is not. Read the data root first — see env-file.js.
{
  const { resolveDataRoot, defaultUserData } = require('./data-root');
  const { loadEnvFiles } = require('./env-file');
  let dataRoot = '';
  try { dataRoot = resolveDataRoot({ userData: defaultUserData() }).dataRoot; } catch (_) {}
  loadEnvFiles({ dataRoot, appRoot: APP_ROOT, dotenv, expand });
}
const { createPathConfig } = require('./path-config');
let savedPaths = {};
try { savedPaths = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).paths || {}; } catch (_) {}
const PATHS = createPathConfig({ appRoot: APP_ROOT, userData: app.getPath('userData'), saved: savedPaths });
const UI_ROOT = PATHS.uiRoot;
// These exports are the contract between this process and its children (the standalone
// daemon and the CLI). They MUST be set before the requires below, because several of
// those modules compute their storage roots at module-load time.
process.env.BIGKIJI_DATA_ROOT = PATHS.dataRoot;
if (!process.env.BIGKIJI_KNOWLEDGE_ROOT) process.env.BIGKIJI_KNOWLEDGE_ROOT = PATHS.knowledgeRoot;
const dataRootModule = require('./data-root');
const { WorkspaceRegistry, candidates: candidateWorkspaces, DEFAULT_EXCLUDE: WORKSPACE_DEFAULT_EXCLUDE } = require('./workspace-registry');
const { drainTouchQueue } = require('./watch-queue');
const { applyApplicationMenu } = require('./app-menu');
const SETUP_STATUS = dataRootModule.setupStatus({ userData: PATHS.userData });
// Do not materialise the default data root while the first-run wizard may still send
// the owner somewhere else — an abandoned empty ~/BigKijiUniverse would be confusing.
// 'suppressed' (SMOKE/SNAP) is not the same as 'done' — a smoke run must not leave a
// data root behind either. Every writer already mkdir's recursively, so skipping this
// costs nothing.
if (SETUP_STATUS.kind === 'done' || PATHS.dataRootSource !== 'default') dataRootModule.ensureLayout(PATHS);
const { Orchestrator } = require('./orchestrator');
const { PiBridge, MODEL: PI_MODEL } = require('../domain/pi-agent/pi-bridge');
// v13: model-routerを直接インポート（Ollamaウォームアップ等）
const router = require('../domain/pi-agent/model-router');
const { C } = require('./commentary'); // v12: 英語実況の単一情報源（crawl/PWA/CLI共用）
const taskCache = require('../domain/pi-agent/task-cache'); // v12: Swarm合意形成＋JSONナレッジキャッシュ
const governance = require('./governance'); // D1/D2: 状態圧縮とMaker–Checker検収
const knowledge = require('../domain/pi-agent/pi-knowledge-orchestrator');
const { TaskRunner } = require('../domain/pi-agent/task-runner');
const { CoreExecutionCoordinator } = require('../domain/pi-agent/core-execution-coordinator');
const fastRouter = require('../domain/pi-agent/fast-api-router');
const { ComfyUIMediaBridge } = require('../domain/telemetry/components/comfyui-media-bridge');
const { ModelStatusStore } = require('../domain/hud/model-status-store');
const { RelationshipSnapshotService } = require('./relationship-snapshot-service');
const { sanitizeOwnerSpeech, detectSpeechLanguage, StreamingSpeechFilter } = require('./tts-policy');
const { SettingsStore } = require('./settings-store');
const { NaturalTTSService } = require('./natural-tts-service');
const { CmuxBridge } = require('./cmux-bridge');
const { PreviewServer } = require('./preview-server');
const { readiness: providerReadiness, survey: providerSurvey } = require('../domain/pi-agent/provider-readiness');
const { DaemonClient } = require('../domain/server/daemon-client');
const { TailscaleRemoteAccess } = require('./tailscale-remote-access');
const { TaskReportBuilder } = require('./task-report-builder');
const stt = require('../domain/server/speech-to-text');
const facilitator = new fastRouter.FastFacilitatorRouter();
// Single source of truth for the displayed version: package.json. Overridable for CI builds.
const APP_VERSION = require('../../package.json').version;
// The build identity is stamped into src/core/build-info.json at pack time by
// tools/stamp-build.js. Reading it from the environment alone was the reason a
// forty-five-commit-old .app displayed the same BUILD string as the source it
// had drifted away from: a packaged app has no BIGKIJI_BUILD_ID to read.
const BUILD_INFO = (() => { try { return require('./build-info.json'); } catch (_) { return null; } })();
const APP_BUILD_ID = process.env.BIGKIJI_BUILD_ID || BUILD_INFO?.buildId || `v${APP_VERSION}-dev`;

const SMOKE = !!process.env.SMOKE;
const SNAP = process.env.SNAP || ''; // SNAP=<出力dir> で5秒後に両画面をPNG撮影して終了
const SHOW_MAIN = process.argv.includes('--show-main') || process.env.BIGKIJI_SHOW_MAIN === '1';
// Opens the working window directly, the way `--show-main` opens the 3D scene.
const SHOW_CONSOLE = process.argv.includes('--show-console') || process.env.BIGKIJI_SHOW_CONSOLE === '1';
const E2E_FIXTURE = process.env.BIGKIJI_E2E_FIXTURE || '';
const bus = new Orchestrator();
const taskRunner = new TaskRunner({ cwd: PATHS.vaultRoot, vaultRoot: PATHS.vaultRoot, graphPath: PATHS.graphPath, maxParallel: 5 });
const fleetMetrics = new ModelStatusStore({ knowledge });
// settingsStore is not constructed until app.whenReady(); the name is applied there.
const { FleetMetricsStore } = require('./fleet-metrics-store');
const piFleet = new FleetMetricsStore({}); // 13 Pi agents — persistence stays with fleetMetrics (same knowledge slot)
const relationshipService = new RelationshipSnapshotService({
  graphPath: PATHS.graphPath,
});

let tray = null;
let trayWin = null;
let mainWin = null;
let consoleWin = null;
let quitting = false;
let pty = null;
let ptyMode = 'none'; // 'pty' | 'pipe'
let comfy = null;
let settingsStore = null;
let ttsService = null;
let cmuxBridge = null;
let coordinator = null;
let previewServer = null;
let daemonClient = null;
let daemonState = null;
let remoteAccess = null;

if (!app.requestSingleInstanceLock()) {
  console.log('BigKiji Universe is already running in the menu bar (❖). Exiting the duplicate instance.');
  app.quit();
} else {
  app.on('second-instance', () => { if (trayWin) toggleTrayWindow(); }); // 再度npm startしたら小窓を開いて応える
}

// ---------- pty（失敗時は pipe モードへ自動降格） ----------
function spawnShell() {
  const shell = process.env.SHELL || process.env.COMSPEC || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const loginArgs = process.platform === 'win32' ? ['-NoLogo'] : ['-l'];
  const onData = (data) => {
    broadcast('pty:data', data);
    bus.ingest(data);
  };
  try {
    const nodePty = require('node-pty');
    pty = nodePty.spawn(shell, loginArgs, {
      name: 'xterm-256color', cols: 100, rows: 24,
      cwd: os.homedir(), env: process.env,
    });
    pty.onData(onData);
    pty.onExit(() => { if (!quitting) setTimeout(spawnShell, 500); });
    ptyMode = 'pty';
  } catch (err) {
    const { spawn } = require('child_process');
    const child = spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : ['-i'], { cwd: os.homedir(), env: process.env });
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('exit', () => { if (!quitting) setTimeout(spawnShell, 500); });
    pty = { write: (d) => child.stdin.write(d), resize: () => {}, kill: () => child.kill() };
    ptyMode = 'pipe';
    bus.push({ source: 'system', type: 'info', text: `node-pty unavailable — running in pipe mode (${err.code || err.message})` });
  }
  bus.push({ source: 'system', type: 'info', text: `shell ready (${ptyMode} mode, ${shell})` });
}

function broadcast(channel, payload) {
  if (channel === 'pi:stats') { fleetMetrics.ingestStats(payload); piFleet.ingestStats(payload); }
  else if (channel === 'bk:swarm') { fleetMetrics.ingestSwarm(payload); piFleet.ingestSwarm(payload); }
  else if (channel === 'voice:live-state') { fleetMetrics.ingestVoice(payload); piFleet.ingestVoice(payload); }
  else if (channel === 'vault:touch') { fleetMetrics.ingestSync({ text: payload?.[0] || 'Vault sync' }); piFleet.ingestSync({ text: payload?.[0] || 'Vault sync' }); }
  for (const w of [trayWin, mainWin, consoleWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
taskRunner.on('task', (task) => {
  fleetMetrics.ingestTask(task); piFleet.ingestTask(task); broadcast('task:event', task);
  if (['running', 'completed', 'failed', 'awaiting_approval'].includes(String(task.status || ''))) {
    const label = String(task.agent || task.provider || 'Pi agent');
    speakAgent(`${label}. ${String(task.status).replaceAll('_', ' ')}. ${String(task.title || task.prompt || '').slice(0, 90)}`, label);
  }
});
taskRunner.on('log', (log) => broadcast('task:log', log));
fleetMetrics.on('update', (snapshot) => broadcast('model:status:update', snapshot));
piFleet.on('update', (snapshot) => broadcast('pi:fleet', snapshot));
relationshipService.on('update', (snapshot) => {
  broadcast('relationship:snapshot', snapshot);
  if (snapshot.state === 'ready') fleetMetrics.ingestSync({ text: `Graphify ${snapshot.nodes.length} nodes`, ms: snapshot.loadMs });
});
// LIVE COMMENTARY（英語実況）: デスクトップの実況バー・モバイルPWA・CLIが同じ行を受ける
function liveComment(text, sev = 'info') {
  if (!text) return;
  broadcast('bk:commentary', { text, sev, ts: Date.now() });
}

// ---------- 成果物スキャナ（各社 成果物/ の実ファイルを監視・新着はバスイベント化） ----------
const VAULT = PATHS.vaultRoot;
const COMPANY_AGENT = {
  English_School: 'marble', Creative_Media: 'justin', Design_Studio: 'risa',
  LocalAI: 'biglama', Executive_Office: null, // Exec直轄はCore扱い
};
let seikaDirs = [];
let latestDeliverables = [];
const knownDeliverables = new Set();
let firstScan = true;

function findSeikaDirs() {
  const dirs = [];
  for (const comp of Object.keys(COMPANY_AGENT)) {
    const base = path.join(VAULT, comp);
    const direct = path.join(base, '成果物');
    if (fs.existsSync(direct)) dirs.push({ dir: direct, comp });
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
        const p = path.join(base, d.name, '成果物');
        if (fs.existsSync(p)) dirs.push({ dir: p, comp });
      }
    } catch (_) {}
  }
  return dirs;
}

// ---------- Vault実ファイル地図（銀河の粒子＝実ファイル）＋リアルタイムfs監視 ----------
const VAULT_EXCLUDE = /node_modules|\.git|_archive|graphify-out|\.next|ComfyUI|recordings|\.obsidian|package-lock/;
let vaultFiles = [];

// The galaxy is made of the folders the owner registered, not of one hardcoded root.
// With nothing registered this is exactly the previous single-root behaviour — same
// paths, same clusters — so the map cannot change shape until the owner asks it to.
function scanRoots() {
  const all = workspaces.list();
  const usable = all.filter((root) => root.status === 'ok');
  // "Nothing registered" and "everything registered is unreachable" are different
  // answers. Treating them the same silently re-pointed every read at the built-in
  // vault the moment an external volume was unmounted — the exact behaviour the
  // Settings copy promises does not happen.
  if (!all.length) return [{ path: VAULT, label: path.basename(VAULT), prefix: '' }];
  if (!usable.length) return [];
  // Two roots can share a basename (~/A/app and ~/B/app). An ambiguous prefix makes
  // the map resolve a click to whichever one happens to hold a file of that name.
  const seen = new Map();
  for (const root of usable) seen.set(root.label, (seen.get(root.label) || 0) + 1);
  const labelOf = (root) => (seen.get(root.label) > 1
    ? `${path.basename(path.dirname(root.path))}/${root.label}` : root.label);
  return usable.map((root) => ({ path: root.path, label: labelOf(root),
    prefix: usable.length > 1 ? `${labelOf(root)}/` : '', exclude: root.exclude || [] }));
}

async function scanVaultFiles() {
  const out = [];
  const walk = async (root, dir, depth) => {
    if (out.length > 4200) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (VAULT_EXCLUDE.test(p) || (root.exclude || []).includes(e.name)) continue;
      if (e.isDirectory()) { if (depth < 4) await walk(root, p, depth + 1); continue; }
      try {
        const st = await fs.promises.stat(p);
        const rel = `${root.prefix}${p.slice(root.path.length + 1)}`;
        out.push({ p: rel, c: rel.split('/')[0], t: st.mtimeMs, size: st.size });
      } catch (_) {}
    }
  };
  for (const root of scanRoots()) await walk(root, root.path, 0);
  vaultFiles = out;
  broadcast('vault:files', vaultFiles);
}

// pi-sandbox.json を実際に読み、役割ごとの権限トポロジーを作る（表示は全て実設定由来）
function sandboxTopology() {
  const topo = {};
  for (const [comp, agent] of Object.entries(COMPANY_AGENT)) {
    const f = path.join(VAULT, comp, '.pi', 'sandbox.json');
    if (!fs.existsSync(f)) continue;
    let reads = [];
    try { reads = (JSON.parse(fs.readFileSync(f, 'utf8')).filesystem || {}).allowRead || []; } catch (_) {}
    topo[agent || 'core'] = {
      company: comp,
      write: [comp],
      read: reads.map((r) => r.replace(/^~\/Documents\/CEOBigKiji\//, '').replace(/\.md$/, '')),
    };
  }
  return topo;
}

// fs.watch（FSEvents・再帰）: 実際に触られたファイルをリアルタイムで可視化へ
const touchQueue = new Map();
async function refreshVaultPaths(paths, root = scanRoots()[0]) {
  let changed = false;
  for (const raw of paths) {
    const relative = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || VAULT_EXCLUDE.test(relative) || relative.split('/').some((part) => part.startsWith('.'))) continue;
    const absolute = path.resolve(root.path, relative);
    if (!absolute.startsWith(path.resolve(root.path) + path.sep)) continue;
    const rel = `${root.prefix || ''}${relative}`;
    const index = vaultFiles.findIndex((file) => file.p === rel);
    try {
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile()) continue;
      const next = { p: rel, c: rel.split('/')[0], t: stat.mtimeMs, size: stat.size };
      if (index >= 0) vaultFiles[index] = next; else vaultFiles.push(next);
      changed = true;
    } catch (_) {
      if (index >= 0) { vaultFiles.splice(index, 1); changed = true; }
    }
  }
  if (changed) broadcast('vault:files', vaultFiles);
}
// One watcher per registered root, torn down and rebuilt when the list changes. The
// queue carries the root each path belongs to, because two roots can hold the same
// relative path and resolving it against the wrong one silently points at the wrong file.
const vaultWatchers = new Map();
let vaultWatchFlush = null;
function startVaultWatch() {
  const wanted = new Map(scanRoots().map((root) => [root.path, root]));
  for (const [key, watcher] of vaultWatchers) {
    if (wanted.has(key)) continue;
    try { watcher.close(); } catch (_) {}
    vaultWatchers.delete(key);
  }
  for (const [key, root] of wanted) {
    if (vaultWatchers.has(key)) continue;
    try {
      vaultWatchers.set(key, fs.watch(key, { recursive: true }, (_ev, fname) => {
        if (!fname || VAULT_EXCLUDE.test(fname)) return;
        const base = path.basename(fname);
        if (base.startsWith('.') || base.endsWith('.tmp')) return;
        // Keyed by a Map, not by packing the root into the string. The delimiter used
        // to be a NUL — correct, since a POSIX path cannot contain one, but invisible:
        // every tool that reads this file renders it as a space, so the encode/decode
        // pair reads as an obvious bug that it is not. No delimiter, nothing to misread.
        if (!touchQueue.has(key)) touchQueue.set(key, new Set());
        touchQueue.get(key).add(String(fname));
      }));
    } catch (_) { /* an unreadable root is reported in Settings, not retried in a loop */ }
  }
  if (vaultWatchFlush) return;
  vaultWatchFlush = setInterval(() => {
    if (!touchQueue.size) return;
    const drained = drainTouchQueue(touchQueue);
    if (drained.mode === 'idle') return;
    // Too much changed to track file by file — a branch switch, a build, a bulk rename.
    // Draining that six at a time would take minutes, so say so and rescan rather than
    // let the incremental path look like it is keeping up.
    if (drained.mode === 'rescan') {
      bus.push({ source: 'system', type: 'fs', text: `✎ ${drained.backlog} files changed at once — rescanning instead of tracking each` });
      scanVaultFiles().catch((error) => bus.push({ source: 'system', type: 'degrade', text: `Vault rescan failed: ${error.message}` }));
      return;
    }
    const byRoot = drained.byRoot;
    const roots = new Map(scanRoots().map((root) => [root.path, root]));
    const shown = [];
    for (const [key, paths] of byRoot) {
      const root = roots.get(key); if (!root) continue;
      for (const relative of paths) shown.push(`${root.prefix || ''}${relative}`);
      // Incremental metadata refresh avoids a 4,200-file rescan on every edit.
      refreshVaultPaths(paths, root).catch((error) => bus.push({ source: 'system', type: 'degrade', text: `Vault refresh failed: ${error.message}` }));
    }
    if (!shown.length) return;
    broadcast('vault:touch', shown);
    for (const rel of shown.slice(0, 3)) {
      const agent = COMPANY_AGENT[rel.split('/')[0]] ?? null;
      bus.push({ source: 'vault', agent, type: 'fs', text: `✎ ${rel.slice(0, 110)}` });
    }
  }, 900);
  vaultWatchFlush.unref();
}

function scanDeliverables() {
  const cutoff = Date.now() - 30 * 86400000; // 直近30日
  const items = [];
  const walk = (dir, comp, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(p, comp, depth + 1); continue; }
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) items.push({ name: e.name, path: p, company: comp, ts: st.mtimeMs });
      } catch (_) {}
    }
  };
  for (const { dir, comp } of seikaDirs) walk(dir, comp, 0);
  items.sort((a, b) => b.ts - a.ts);
  latestDeliverables = items.slice(0, 20);
  for (const it of latestDeliverables) {
    if (knownDeliverables.has(it.path)) continue;
    knownDeliverables.add(it.path);
    if (!firstScan) {
      bus.push({ source: 'vault', agent: COMPANY_AGENT[it.company], type: 'result', text: `deliverable: ${it.name}` });
    }
  }
  firstScan = false;
  broadcast('vault:deliverables', latestDeliverables);
}

// ---------- メニューバーガラス小窓 ----------
function createTrayWindow() {
  trayWin = new BrowserWindow({
    width: 350, height: 680, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    // Owner requirement: allow the tray dashboard to be resized with the cursor
    // while keeping it a compact, usable control surface.
    resizable: true, minWidth: 324, minHeight: 420,
    movable: false, fullscreenable: false, minimizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, roundedCorners: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false }, // 非表示中もメニューバー・ダッシュボード描画を継続
  });
  trayWin.loadFile(path.join(UI_ROOT, 'tray.html'));
  trayWin.on('blur', () => { if (!SMOKE && !SNAP && trayWin.isVisible()) trayWin.hide(); });
  trayWin.on('close', (e) => { if (!quitting) { e.preventDefault(); trayWin.hide(); } });
}

function positionTrayWindow() {
  const tb = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const width = trayWin?.getBounds().width || 350;
  const x = Math.min(Math.round(tb.x + tb.width / 2 - width / 2), display.workArea.x + display.workArea.width - width - 10);
  trayWin.setPosition(Math.max(x, display.workArea.x + 10), display.workArea.y + 6, false);
}

function toggleTrayWindow() {
  if (trayWin.isVisible()) { trayWin.hide(); return; }
  positionTrayWindow();
  trayWin.show();
  trayWin.focus();
}

// ---------- メイン シナプスキャンバス ----------
function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 620,
    show: !SMOKE ? false : true, backgroundColor: '#05080f',
    titleBarStyle: 'hiddenInset', title: 'BigKiji Universe — Synapse Canvas',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(UI_ROOT, 'main.html'),
    process.env.SNAP_DIST ? { hash: process.env.SNAP_DIST } : undefined); // SNAP用LOD距離プリセット
  mainWin.once('ready-to-show', () => {
    mainWin.show();
    mainWin.focus();
    if (SHOW_MAIN) app.focus({ steal: true });
  });
  mainWin.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
}

// ---------- Console: the window work actually happens in ----------
// The Synapse Canvas is the story BigKiji tells about itself. It is also 6,000 lines of
// particles behind everything the owner is trying to read, which is fine to look at and
// tiring to work in. The console is the opposite: opaque, light, one surface at a time,
// with the 3D scene one button away instead of underneath.
//
// Opaque and with no vibrancy set, so its stylesheet may use ordinary backgrounds
// without colliding with a material — the same reasoning as the setup window.
function createConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); return consoleWin; }
  consoleWin = new BrowserWindow({
    width: 1080, height: 760, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#f5f5f7',
    titleBarStyle: 'hiddenInset', title: 'BigKiji Console',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  consoleWin.loadFile(path.join(UI_ROOT, 'console.html'));
  consoleWin.once('ready-to-show', () => { consoleWin.show(); consoleWin.focus(); });
  consoleWin.on('close', (e) => { if (!quitting) { e.preventDefault(); consoleWin.hide(); } });
  return consoleWin;
}

// ---------- Tray ----------
function createTray() {
  tray = new Tray(nativeImage.createEmpty()); // バイナリ資産ゼロ：テキストTray
  tray.setTitle('❖');
  tray.setToolTip('BigKiji Universe OS');
  tray.on('click', toggleTrayWindow);
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      // Console first: it is where work happens, and it is what should open by reflex.
      { label: 'Open Console', accelerator: 'Alt+Shift+Space', click: () => createConsoleWindow() },
      { label: 'Open Synapse Canvas', click: () => createMainWindow() },
      { type: 'separator' },
      { label: 'Quit BigKiji Universe', click: () => { quitting = true; app.quit(); } },
    ]));
  });
}

// ---------- IPC ----------
// メニューバーアイコン: trayレンダラが描いた画像を反映（オーブはカラー＝template無効）
ipcMain.on('tray:render', (_e, { dataURL, title, template }) => {
  if (!tray) return;
  try {
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 2.0, dataURL });
    if (template !== false) img.setTemplateImage(true);
    tray.setImage(img);
    tray.setTitle(title || '', { fontType: 'monospacedDigit' });
  } catch (_) {}
});

// ---------- Natural multi-track voice: local Qwen3-TTS + macOS neural fallback ----------
const { execFile } = require('child_process');
let voiceOn = true;
const liveVoice = { active: false, owner: null }; // owner = webContents.id（マイク所有は常に1窓）
const speechQueues = { owner: [], agent: [] };
const speechBusy = { owner: false, agent: false };
const speechActive = { owner: null, agent: null };
const speechFilter = new StreamingSpeechFilter();
let ttsSeq = 0;
let ttsDiscard = false;
let speechUtterance = 0;
let speechFirstQueued = false;
let speechAnyQueued = false;
let speechFirstPlayed = false;
let speechRequestAt = 0;
let speechFallbackTimer = null;
let speechRescueTimer = null;
let speechDeadlineTimer = null;
const agentSpeechAt = new Map();

function audioTarget() {
  if (liveVoice.owner) {
    for (const w of [mainWin, trayWin]) if (w && !w.isDestroyed() && w.webContents.id === liveVoice.owner) return w;
  }
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) return mainWin;
  if (trayWin && !trayWin.isDestroyed() && trayWin.isVisible()) return trayWin;
  return mainWin && !mainWin.isDestroyed() ? mainWin : trayWin;
}
function sendAudio(result, item) {
  const target = audioTarget();
  if (!target || target.isDestroyed()) return false;
  const buf = result.buffer;
  target.webContents.send('voice:tts-chunk', {
    seq: ++ttsSeq, owner: target.webContents.id, track: item.track, agent: result.agent,
    first: item.first, utteranceId: item.utteranceId, requestedAt: item.requestedAt,
    synthesizedAt: result.synthesizedAt, synthesisMs: result.synthesisMs, engine: result.engine,
    language: result.language, speed: result.speed,
    buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
  broadcast('voice:live-state', { live: liveVoice.active, state: 'SPEAK', track: item.track,
    engine: result.engine, synthesisMs: result.synthesisMs });
  return true;
}
async function processSpeech(track) {
  if (speechBusy[track] || !speechQueues[track].length || !voiceOn || !ttsService) return;
  const token = Symbol(track); speechActive[track] = token; speechBusy[track] = true;
  const item = speechQueues[track].shift();
  try {
    const cfg = settingsStore.get().audio;
    const age = Date.now() - item.requestedAt;
    const result = await ttsService.synthesize({ ...item, forceSystem: item.first && age >= cfg.systemFallbackAtMs - 3000 });
    if (speechActive[track] === token && (track === 'agent' || (!ttsDiscard && item.utteranceId === speechUtterance))) sendAudio(result, item);
  } catch (error) {
    bus.push({ source: 'system', type: 'info', text: `🔇 speech synthesis failed: ${String(error.message).slice(0, 120)}` });
  } finally {
    if (speechActive[track] === token) {
      speechActive[track] = null; speechBusy[track] = false; processSpeech(track);
    }
  }
}
function queueSpeech(text, { track = 'owner', agent = 'codex', requestedAt = Date.now(), utteranceId = speechUtterance,
  countsAsAnswer = true } = {}) {
  if (!voiceOn || !text || (track === 'owner' && ttsDiscard)) return false;
  if (speechQueues[track].length >= (track === 'owner' ? 10 : 3)) speechQueues[track].shift();
  const first = track === 'owner' && !speechAnyQueued;
  if (track === 'owner') speechAnyQueued = true;
  if (track === 'owner' && countsAsAnswer) speechFirstQueued = true;
  speechQueues[track].push({ text, track, agent, requestedAt, utteranceId, first });
  broadcast('pi:event', { kind: 'speak', track, agent, text: sanitizeOwnerSpeech(text, 40), queuedMs: Date.now() - requestedAt });
  processSpeech(track);
  return true;
}
function speak(text, opts = {}) {
  const clean = sanitizeOwnerSpeech(text, 900);
  if (!clean) return;
  const requestedAt = opts.requestedAt || Date.now(); speechFirstQueued = false; speechAnyQueued = false; speechFirstPlayed = false;
  speechRequestAt = requestedAt; speechUtterance++;
  queueSpeech(clean, { track: 'owner', agent: opts.agent || 'codex', requestedAt, utteranceId: speechUtterance });
}
function speakAgent(text, agent = 'pi') {
  const cfg = settingsStore?.get().audio;
  if (!cfg?.agentChatter) return;
  const now = Date.now(); const key = String(agent || 'pi');
  if (now - (agentSpeechAt.get(key) || 0) < 9000) return;
  agentSpeechAt.set(key, now);
  queueSpeech(text, { track: 'agent', agent: key, requestedAt: now, utteranceId: `agent-${now}` });
}
ipcMain.handle('voice:toggle', () => {
  voiceOn = !voiceOn;
  if (!voiceOn) { ttsKill(); ttsService?.stop(); }
  if (voiceOn) speak('Voice is on. BigKiji is ready.', { agent: 'codex' });
  return { on: voiceOn };
});

// ---------- full-duplex voice: VAD + pipelined final-answer sentences + barge-in ----------
function ttsReset(requestedAt = Date.now()) {
  ttsDiscard = false; speechQueues.owner.length = 0; speechFilter.reset();
  speechFirstQueued = false; speechAnyQueued = false; speechFirstPlayed = false; speechRequestAt = requestedAt; speechUtterance++;
  clearTimeout(speechFallbackTimer); clearTimeout(speechRescueTimer); clearTimeout(speechDeadlineTimer);
}
function ttsKill() { // Barge-in: 合成中プロセスとキューを即破棄（次のturn_startまで追補も破棄）
  speechQueues.owner.length = 0;
  speechActive.owner = null; speechBusy.owner = false;
  ttsDiscard = true;
  clearTimeout(speechFallbackTimer); clearTimeout(speechRescueTimer); clearTimeout(speechDeadlineTimer);
  for (const w of [mainWin, trayWin]) if (w && !w.isDestroyed()) w.webContents.send('voice:stop', { track: 'owner' });
}
function ttsEnqueue(sentence, opts = {}) {
  const s = sanitizeOwnerSpeech(sentence);
  if (!s || ttsDiscard) return;
  queueSpeech(s, { track: 'owner', agent: opts.agent || 'codex', requestedAt: opts.requestedAt || speechRequestAt || Date.now(), utteranceId: speechUtterance });
}
function ttsFlushRemainder(fullText) {
  for (const sentence of speechFilter.flush()) ttsEnqueue(sentence);
  // If no deltas were available (provider-specific protocol), use the final
  // owner-facing result only after agent_end.
  if (!speechFirstQueued) {
    const rest = sanitizeOwnerSpeech(fullText);
    if (rest) ttsEnqueue(rest);
  }
}
// WAV(16k mono PCM16)→二段STT→Pi。デスクトップIPCとモバイルPWA(/api/voice)の共用経路
async function handleUtterance(buf, via) {
  const requestedAt = Date.now();
  const dir = PATHS.recordingsRoot;
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `live-${Date.now()}.wav`);
  fs.writeFileSync(wav, Buffer.from(buf));
  const r = await whisperTranscribe(wav);
  try { fs.unlinkSync(wav); } catch (_) {}
  if (r.error) return r;
  const text = (r.text || '').trim();
  if (!stt.isMeaningful(text)) return { text: '', lang: r.lang }; // ノイズ/空は送らない
  liveComment(C.stt(text, r.lang));
  piSendPrompt(text, { raw: true, via, voice: true, requestedAt }); // 音声は会話＝分類スキップで即応答
  return { text, lang: r.lang };
}
ipcMain.handle('voice:live-toggle', (e) => {
  const on = !liveVoice.active;
  // マイク所有はメイン窓優先（トレイは閉じると隠れるため）。無ければ要求元
  const mainId = (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) ? mainWin.webContents.id : null;
  liveVoice.active = on;
  liveVoice.owner = on ? (mainId || e.sender.id) : null;
  if (!on) ttsKill();
  // 各窓に「あなたが所有者か」を個別通知（所有窓だけがgetUserMedia/再生する）
  for (const w of [trayWin, mainWin]) {
    if (w && !w.isDestroyed()) {
      w.webContents.send('voice:live-own', { live: on && w.webContents.id === liveVoice.owner });
    }
  }
  broadcast('voice:live-state', { live: liveVoice.active, state: on ? 'LISTEN' : 'OFF', owner: liveVoice.owner });
  liveComment(C.voice(on ? 'LISTEN' : 'OFF'));
  return { live: liveVoice.active, owner: liveVoice.owner };
});
ipcMain.handle('voice:live-utterance', (_e, buf) => handleUtterance(buf, 'desktop'));
ipcMain.on('voice:interrupt', () => {
  ttsKill();
  liveComment('🔊 Barge-in — TTS cut, listening');
  broadcast('voice:live-state', { live: liveVoice.active, state: 'CAPTURE', owner: liveVoice.owner });
});
ipcMain.on('voice:state', (_e, s) => {
  broadcast('voice:live-state', { live: liveVoice.active, owner: liveVoice.owner, ...s });
  const c = C.voice(s && s.state);
  if (c && s.state !== 'LISTEN') liveComment(c);
});

const WHISPER_BIN = PATHS.whisperBin;
const WHISPER_MODEL = PATHS.whisperModel;
// v12二段STT: -dl で言語検出（en/ja/th以外はenへ矯正＝-l auto のEN→JA誤検出の再発防止）→検出言語で本走。
// 動的言語ミラー（JA入力→JA返答）に必要な入力言語判定もここで得る
// The transcription itself lives in src/domain/server/speech-to-text.js so the
// standalone daemon can run the same two-pass pipeline for the phone.
async function whisperTranscribe(wav) {
  const result = await stt.transcribeWav({ wav, whisperBin: WHISPER_BIN, whisperModel: WHISPER_MODEL });
  if (result.text) bus.push({ source: 'system', type: 'log', text: `🎙 STT(${result.lang}): ${result.text.slice(0, 120)}` });
  return result;
}
ipcMain.handle('transcribe', (_e, webmPath) => new Promise((resolve) => {
  const wav = webmPath.replace(/\.webm$/, '.wav');
  execFile('/opt/homebrew/bin/ffmpeg', ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', wav], { timeout: 30000 }, (err) => {
    if (err) { resolve({ error: 'ffmpeg conversion failed: ' + err.message }); return; }
    whisperTranscribe(wav).then(resolve);
  });
}));

// 録音の保存（会話音声メモ → app/recordings/。実ファイルとしてバスにも記録）
ipcMain.handle('mic-permission', async () =>
  process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true);
ipcMain.handle('save-recording', (_e, buf) => {
  const dir = PATHS.recordingsRoot;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
  fs.writeFileSync(f, Buffer.from(buf));
  bus.push({ source: 'system', type: 'result', text: `recording saved: ${path.basename(f)}` });
  return f;
});

// ---------- Pi RPC（Core=Pi・計画はローカルQwen。確定実行のみClaude Code/GLM） ----------
const pi = new PiBridge({ cwd: PATHS.vaultRoot, piBin: PATHS.piBin });
// Assigned during the boot sequence; the settings handler calls it when a key lands.
let refreshFleetAvailability = null;
let piTurnOpen = false;
let piTouched = new Set();
let piIdleTimer = null;
let piDeltaBuf = '';
let piDeltaTimer = null;
let piAnswerText = ''; // ターンの全回答（ログへ恒久記録するため蓄積）
let piLastPrompt = ''; // フォールバック再送用
let piAwaitingAnswer = false;
let piFallbackN = 0;
let piTurnT0 = 0;                // ターン所要時間の実測（TOKEN VELOCITY用）
let piCurrentTask = null;        // D1/D2: 現在のMakerまたはCheckerの責務
const toolT0 = new Map();        // toolName → 開始時刻（TRAVERSAL LATENCY実測）
const lastToolArgs = new Map();  // toolName → 直近引数（エラー構造化記録用）

// ---------- Auto-Heal（v11）: ツールエラーの構造化記録と修復タスクの自動生成 ----------
// 同一ツールが3回失敗したら「最新仕様を調査して修正案を作る」修復タスクを修復キューへ生成。
// アプリコードへの自動直書きはしない（検収ゲート＝オーナー/Claude Code承認後に適用）。
// Piへの調査委任は実行中ターンを乗っ取らないよう、ターン終了後に送る（上限2回/セッション）。
const ERRLOG_DIR = PATHS.logsRoot;
const ERRLOG_FILE = path.join(ERRLOG_DIR, 'tool-errors.jsonl');
const HEAL_DIR = path.join(PATHS.knowledgeRoot, 'repair-queue');
const toolFails = {};
const healedTools = new Set();
const healPending = [];
let healSent = 0;
function recordToolError(toolName, ms, argsStr) {
  try {
    fs.mkdirSync(ERRLOG_DIR, { recursive: true });
    fs.appendFileSync(ERRLOG_FILE,
      JSON.stringify({ ts: Date.now(), tool: toolName, ms, model: pi.model, args: (argsStr || '').slice(0, 300) }) + '\n');
  } catch (_) {}
  toolFails[toolName] = (toolFails[toolName] || 0) + 1;
  if (toolFails[toolName] < 3 || healedTools.has(toolName) || process.env.BIGKIJI_AUTOHEAL === '0') return;
  healedTools.add(toolName);
  try {
    fs.mkdirSync(HEAL_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const qfile = path.join(HEAL_DIR, `${day}-${toolName.replace(/[^\w-]/g, '_')}.md`);
    fs.writeFileSync(qfile, [
      `# Repair task: repeated failure of \`${toolName}\` (generated ${new Date().toLocaleString('en-US')})`,
      '',
      `- Failures: ${toolFails[toolName]} in this session / model: ${pi.model}`,
      `- Latest arguments: \`${(lastToolArgs.get(toolName) || '—').slice(0, 300)}\``,
      `- Error log: \`${ERRLOG_FILE}\` (entries for tool=${toolName})`,
      '',
      '## Investigation instructions (Auto-Heal)',
      '1. Check the tool\'s current specification using primary sources (official docs/web search).',
      '2. Classify the failure: 429/quota already handled by degradation, type error, API change, or permission.',
      '3. Append a proposed code diff to this file. **Do not modify application code directly.**',
      '4. Apply only after owner/Claude Code review.',
      '',
      '## Delegation command',
      '```bash',
      `pi -p --session-id bigkiji-heal "Research why the tool '${toolName}' keeps failing (see ${ERRLOG_FILE}), check current specs via web/docs, and append a proposed fix to ${qfile}. Do NOT modify app code."`,
      '```',
      '',
    ].join('\n'));
    bus.push({ source: 'system', type: 'info', text: `⚕ Auto-Heal: ${toolName} failed 3× → repair task queued: ${path.basename(qfile)}` });
    healPending.push(`[AUTO-HEAL] The tool "${toolName}" failed ${toolFails[toolName]} times (details: ${ERRLOG_FILE}). Investigate the current spec of this tool, classify the failure, and append a proposed fix to ${qfile} using your write tool. Do NOT modify app code.`);
  } catch (_) {}
}

function piAgentFromArgs(args) {
  const s = JSON.stringify(args || {});
  for (const [comp, agent] of Object.entries(COMPANY_AGENT)) {
    if (s.includes(comp)) return agent || 'claude-code';
  }
  // pi-subagents の委任先（役割名/タスク文）からも判定
  const ROLE_WORDS = { media: 'justin', design: 'risa', school: 'marble', localai: 'biglama', influencer: 'coco', grunt: 'biglama' };
  const low = s.toLowerCase();
  for (const [w, agent] of Object.entries(ROLE_WORDS)) if (low.includes(w)) return agent;
  return null;
}

async function piFinalizeTurn() {
  if (!piTurnOpen) {
    // v13: 空ターン検知→即時切り替え（再試行なし・ユーザー通知）
    if (piAwaitingAnswer && piFallbackN < 2) {
      const wasRunning = pi.running;
      await pi.fallback(1500);
      if (pi.running !== wasRunning) return; // 切り替え成功→return
      bus.push({ source: 'pi', type: 'warn', text: `🔄 complete silence detected → switched to ${pi.model}` });
      liveComment('Model switched due to complete silence', 'warn');
      broadcast('pi:event', {
        kind: 'turn_start', text: piLastPrompt.slice(0, 30), model: pi.model,
        sandbox: 'global sandbox · Vault AGENTS.md',
      });
      pi.prompt(piLastPrompt);
    }
    return;
  }
  piAwaitingAnswer = false;
  piTurnOpen = false;
  const touched = [...piTouched];
  piTouched = new Set();
  const completedAnswer = piAnswerText;
  if (piAnswerText.trim()) { // 最終回答をログに恒久記録＋読み上げ（ライブ中は文単位TTSの残りだけ流す＝二重読み上げ防止）
    bus.push({ source: 'pi', agent: null, type: 'say', text: `Pi reply: ${piAnswerText.replace(/\s+/g, ' ').trim().slice(0, 220)}` });
    ttsFlushRemainder(piAnswerText);
    piAnswerText = '';
  }
  const stats = await pi.turnStats().catch(() => null);
  const turn = stats && stats.turn;
  const durMs = piTurnT0 ? Date.now() - piTurnT0 : 0; // ターン所要時間の実測（tok/s算出用）
  piTurnT0 = 0;
  broadcast('pi:stats', { turn, total: stats && stats.total, touched, ms: durMs });
  liveComment(C.turnDone(turn && turn.input, turn && turn.output, durMs, pi.model), 'ok');
  bus.push({
    source: 'pi', agent: null, type: 'tokens',
    text: turn ? `Pi turn measured: in ${turn.input} · out ${turn.output} tok (${pi.model.split('/').pop()})` : 'Pi turn complete',
    tokens: turn || undefined, touched,
  });
  // v12 Swarm: 議論を経たターンが成功(toolエラー0)なら成功パターンをKBへ自動保存
  try { taskCache.turnDone({ ok: turnToolErrors === 0, tokens: turn }); } catch (_) {}
  // D1: モデルやプロセスが切り替わっても続きから再開できる短い状態を残す。
  // D2: Makerの完了後だけ、別ターンのCheckerへ読み取り専用の検収を渡す。
  const completedTask = piCurrentTask;
  if (completedTask) {
    const state = governance.makeState(completedTask, {
      answer: completedAnswer, model: pi.model, touched, turn, toolErrors: turnToolErrors,
    });
    router.saveTaskState(state);
    bus.push({ source: 'system', type: 'info', text: `🧠 D1 state saved: ${state.taskId} · next: ${state.nextAction}` });
    if (completedTask.kind === 'maker' && pi.running) {
      const checker = governance.startTask(completedTask.ownerText, 'checker');
      piCurrentTask = checker;
      const checkerState = { ...state, taskId: checker.id };
      setTimeout(() => {
        if (pi.running && !pi.isStreaming) piSendPrompt(governance.makeCheckerPrompt(checkerState), { raw: true, kind: 'checker', task: checker });
      }, 1000);
      bus.push({ source: 'system', type: 'info', text: `🔎 D2 Checker queued for ${state.taskId} (read-only verification)` });
    } else {
      piCurrentTask = null;
    }
  }
  // コンテキスト肥大の自動検知（Token Efficiency）: 入力25k tok/turn超で新セッションを提案
  if (turn && turn.input > 25000) {
    bus.push({ source: 'pi', type: 'info', text: `⚠ context bloat: input ${turn.input} tok/turn (>25k) — restart π for a fresh session` });
    liveComment(C.bloat(turn.input), 'warn');
  }
  // Auto-Heal調査の委任はターンの切れ目でだけ送る（実行中ターンを乗っ取らない・上限2回/セッション）
  if (healPending.length && healSent < 2 && pi.running) {
    const p = healPending.shift();
    healSent++;
    setTimeout(() => { if (pi.running && !pi.isStreaming) piSendPrompt(p, { raw: true }); }, 4000);
  }
}

pi.on('event', (evt) => {
  if (evt.type === 'message_update') {
    piTurnOpen = true;
    const d = evt.assistantMessageEvent;
    if (d && d.type === 'text_delta' && d.delta) {
      piDeltaBuf += d.delta;
      piAnswerText += d.delta;
      clearTimeout(speechFallbackTimer);
      // The stateful gate handles internal tags split across deltas and only
      // releases complete owner-visible sentences. This starts natural speech
      // while the model continues producing the remainder of its answer.
      for (const sentence of speechFilter.push(d.delta)) {
        const agent = /claude/i.test(pi.model) ? 'claude' : /gemini/i.test(pi.model) ? 'gemini'
          : /glm|zai/i.test(pi.model) ? 'glm' : /codex/i.test(pi.model) ? 'codex' : 'pi';
        ttsEnqueue(sentence, { agent });
      }
      if (!piDeltaTimer) {
        piDeltaTimer = setTimeout(() => {
          broadcast('pi:event', { kind: 'delta', text: piDeltaBuf });
          piDeltaBuf = '';
          piDeltaTimer = null;
        }, 150);
      }
    }
  } else if (evt.type === 'tool_execution_start') {
    piTurnOpen = true;
    const agent = piAgentFromArgs(evt.args);
    if (agent) piTouched.add(agent);
    const args = JSON.stringify(evt.args || {}).slice(0, 800); // ダッシュボードのJSON折り畳み表示用に800字
    toolT0.set(evt.toolName, Date.now());
    lastToolArgs.set(evt.toolName, args);
    bus.push({ source: 'pi', agent, type: 'task', text: `pi:${evt.toolName} ${args}` });
    liveComment(C.toolStart(agent, evt.toolName));
  } else if (evt.type === 'tool_execution_end') {
    const ms = toolT0.has(evt.toolName) ? Date.now() - toolT0.get(evt.toolName) : null; // 往復レイテンシ実測
    toolT0.delete(evt.toolName);
    let out = '';
    try { // ツール結果の先頭だけダッシュボードへ（RPCイベントのフィールド名差異に耐える）
      const raw = evt.result ?? evt.output ?? evt.content ?? null;
      if (raw != null) out = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 600);
    } catch (_) {}
    broadcast('pi:event', { kind: 'tool_end', toolName: evt.toolName, isError: !!evt.isError, ms, out });
    liveComment(C.toolEnd(evt.toolName, ms, !!evt.isError), evt.isError ? 'warn' : 'ok');
    if (evt.isError) { turnToolErrors++; recordToolError(evt.toolName, ms, lastToolArgs.get(evt.toolName)); }
  }
  clearTimeout(piIdleTimer);
  // 正式なターン終了は agent_end のみ（turn_end はツール実行ごとに途中で発火する・実測）。
  // 静止タイマーは巨大ファイル生成中の長い無音で誤発火するため保険（120秒）に格下げ
  if (evt.type === 'agent_end') { piFinalizeTurn(); return; }
  piIdleTimer = setTimeout(piFinalizeTurn, 120000);
});
pi.on('stderr', (d) => { // 沈黙診断用: piの標準エラーを構造化ログへ（quota/認証エラーの一次証跡）
  try {
    fs.mkdirSync(ERRLOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(ERRLOG_DIR, 'pi-stderr.log'), `[${new Date().toISOString()}] ${String(d).slice(0, 500)}\n`);
  } catch (_) {}
  // v13: stderr内の429/quota、または廃止・未提供モデルを検知→即デグレード
  const fell = pi.detectErrorAndFallback(String(d));
  if (fell) {
    bus.push({ source: 'pi', type: 'warn', text: `⚠ provider failure detected → degradation in progress (${pi.model})` });
    liveComment(C.fallback(pi.model), 'warn');
    broadcast('pi:event', { kind: 'degrade', model: pi.model, reason: d.slice(0, 120), ts: Date.now() });
    // 実際の降格は下の degrade イベントに一本化する。二重実行は2ティア飛ばしの原因になる。
  }
});
pi.on('status', (s) => {
  broadcast('pi:event', { kind: 'status', ...s });
  if (!s.running) { clearTimeout(piIdleTimer); piFinalizeTurn(); } // プロセス消滅時は途中でも確定しUIを閉じる
});

// v13: degradeイベントを受信→バックグラウンドで降格再起動（ターンの妨げにならない）
pi.on('degrade', async (s) => {
  broadcast('pi:event', { kind: 'degrade_loop', model: s.model, reason: s.reason });
  const ok = await pi.fallback(2500);
  if (ok) bus.push({ source: 'pi', type: 'info', text: `🔄 degraded to ${pi.model} — chain position ${pi.modelIdx}/${pi.chainList.length - 1}` });
});

ipcMain.handle('pi:toggle', () => {
  if (pi.running) { pi.stop(); return { running: false }; }
  const ok = pi.start();
  if (ok) bus.push({ source: 'pi', type: 'info', text: `Pi RPC session up (${pi.model} · Vault root · grunt = local ¥0)` });
  return { running: ok };
});
let turnToolErrors = 0; // Swarm成功判定用（このターンのtoolエラー数）
function piDispatch(text, opts = {}) { // 実送信（分類済みプロンプト）
  if (!pi.running) pi.start();
  piAnswerText = '';
  ttsReset(opts.requestedAt || Date.now());
  const ownerText = String(text);
  const kind = opts.kind || 'maker';
  const substantive = !opts.raw && governance.isSubstantiveTask(ownerText);
  piCurrentTask = substantive || kind === 'checker' ? (opts.task || governance.startTask(ownerText, kind)) : null;
  const isContinuation = !opts.raw && /(?:続き|継続|再開|resume|continue)/i.test(ownerText);
  const continuity = isContinuation ? governance.makeResumeContext(router.loadTaskState()) : '';
  const prompt = substantive ? governance.makeMakerPrompt(continuity + ownerText, piCurrentTask.id) : continuity + ownerText;
  piLastPrompt = prompt;
  piAwaitingAnswer = true;
  piFallbackN = 0;
  piTurnT0 = Date.now();
  turnToolErrors = 0;
  // パイプライン起点の実情報（sandbox→モデル→プロンプト）をフローカードへ
  broadcast('pi:event', {
    kind: 'turn_start', text: ownerText.slice(0, 30), model: pi.model,
    sandbox: 'global sandbox · Vault AGENTS.md',
  });
  liveComment(C.turnStart(pi.model));
  bus.push({ source: 'pi', type: 'log', text: `Prompt → Pi: ${ownerText.slice(0, 120)}` });
  // v12堅牢化: quota死は「イベントゼロの完全沈黙」でも起きる（実測）。
  // 既存の120sアイドルタイマーは初イベント後にしか装填されないため、送信時点で先に装填し
  // 完全沈黙でも piFinalizeTurn → fallback降格再送 が必ず作動するようにする
  clearTimeout(piIdleTimer);
  piIdleTimer = setTimeout(piFinalizeTurn, opts.voice ? 30000 : 90000);
  pi.prompt(prompt);
  if (opts.voice) {
    // A silent provider gets one fast serial failover; no duplicate paid race.
    speechFallbackTimer = setTimeout(async () => {
      if (speechFirstQueued || piAnswerText.trim()) return;
      const switched = await pi.fallback(1200).catch(() => false);
      if (switched && pi.running) {
        bus.push({ source: 'pi', type: 'warn', text: `Voice SLA: silent route switched to ${pi.model}` });
        broadcast('voice:sla', { state: 'route-fallback', elapsedMs: Date.now() - speechRequestAt, model: pi.model });
        pi.prompt(prompt);
      }
    }, 10000);
    const audioCfg = settingsStore?.get().audio || { systemFallbackAtMs: 22000, firstSpeechDeadlineMs: 30000 };
    const promptLanguage = detectSpeechLanguage(ownerText, 'English');
    speechRescueTimer = setTimeout(() => {
      if (speechFirstPlayed) return;
      const status = promptLanguage === 'Japanese'
        ? 'まだ処理中です。結果が準備でき次第、続けてお伝えします。'
        : "I'm still processing that. I'll continue with the result as soon as it is ready.";
      queueSpeech(status, { track: 'owner', agent: 'codex', requestedAt: speechRequestAt,
        utteranceId: speechUtterance, countsAsAnswer: false });
      broadcast('voice:sla', { state: 'spoken-progress-fallback', elapsedMs: Date.now() - speechRequestAt,
        engine: 'system-neural' });
    }, audioCfg.systemFallbackAtMs);
    speechDeadlineTimer = setTimeout(() => {
      if (!speechFirstPlayed) {
        bus.push({ source: 'system', type: 'warn', text: 'Voice SLA missed: no owner-visible answer was available within 30 seconds' });
        broadcast('voice:sla', { state: 'missed', elapsedMs: Date.now() - speechRequestAt, model: pi.model });
      }
    }, audioCfg.firstSpeechDeadlineMs);
  }
}
// v12: 送信前にタスク分類（direct/cache/swarm）。raw=true は分類スキップ（内部指示・音声会話）
function piSendPrompt(text, opts = {}) {
  if (opts.raw) { piDispatch(String(text), opts); return; }
  if (daemonClient?.connected) {
    const mode = settingsStore?.get().routing.executionMode || 'plan';
    daemonClient.turn(String(text), { mode, sessionId: daemonState?.activeSessionId || '' }).then((result) => {
      daemonState = { ...(daemonState || {}), activeSessionId: result.sessionId };
      if (result.run) bus.push({ source: 'system', type: 'info', text: `Daemon run ${result.run.id} · ${result.run.assignments.length} on-demand models · ${result.run.status}` });
      else if (result.draft) bus.push({ source: 'pi', type: 'result', text: `Local idea draft saved · ${result.draft.title}` });
      if (result.reply) speak(result.reply);
    }).catch((error) => {
      bus.push({ source: 'system', type: 'warn', text: `Daemon route unavailable: ${error.message} · using in-app fallback` });
      fastDispatch(String(text));
    });
    return;
  }
  const prompt = String(text);
  fastDispatch(prompt);
  // Qwen remains available for raw internal planning/cache work and never delays this answer.
}
// 通常のGUI対話は高速経路、内部計画・検収・修復はraw=trueでPi/Qwenを継続利用する。
let fastBusy = false;
async function fastDispatch(text) {
  const ownerText = String(text || '').trim();
  if (!ownerText) return;
  if (fastBusy) { bus.push({ source: 'system', type: 'warn', text: 'Fast route busy — request queued to local Pi.' }); piDispatch(ownerText); return; }
  fastBusy = true;
  const t0 = Date.now(); let answer = '';
  broadcast('pi:event', { kind: 'turn_start', text: ownerText.slice(0, 30), model: 'fast-router', sandbox: 'global sandbox · Vault AGENTS.md' });
  try {
    const result = await facilitator.facilitate(ownerText, {
      onStart: (provider) => broadcast('pi:event', { kind: 'route', provider, priority: fastRouter.PRIORITY.indexOf(provider) + 1 }),
      onDelta: (delta) => { answer += String(delta); broadcast('pi:event', { kind: 'delta', text: String(delta) }); },
    });
    answer = result.promptSpecText || (result.questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n') || answer;
    bus.push({ source: 'pi', type: result.status === 'ready' ? 'result' : 'say', text: `${result.provider} facilitator: ${answer.slice(0, 700)}` });
    broadcast('pi:stats', { turn: { input: 0, output: 0 }, total: null, touched: [], ms: result.latencyMs, provider: result.provider });
    broadcast('pi:event', { kind: 'agent_end', provider: result.provider, latencyMs: result.latencyMs,
      status: result.status, planHash: result.planHash, cached: !!result.cached });
    if (result.status === 'ready' && coordinator) {
      const run = coordinator.submit({ prompt: ownerText, promptSpec: result.promptSpec, planHash: result.planHash,
        mode: settingsStore?.get().routing.executionMode || 'plan' });
      bus.push({ source: 'system', type: 'info', text: `Run ${run.id} ${run.status.toLowerCase()} · ${run.assignments.length} specialists` });
    }
    if (answer) speak(answer);
  } catch (err) {
    bus.push({ source: 'pi', type: 'warn', text: `Fast route unavailable: ${String(err.message).slice(0, 180)} — local Pi fallback` });
    broadcast('pi:event', { kind: 'degrade', model: 'fast-router', reason: String(err.message).slice(0, 140) });
    piDispatch(ownerText);
  } finally { fastBusy = false; }
  bus.push({ source: 'system', type: 'info', text: `Fast route completed in ${Date.now() - t0}ms` });
}
taskCache.init({
  kbPath: path.join(PATHS.knowledgeRoot, 'task_knowledge_base.json'),
  // Enables the semantic second chance on a cache miss. Without an embedding model on
  // the machine the store reports itself unavailable and routing is unchanged.
  knowledgeRoot: PATHS.knowledgeRoot,
  model: 'qwen3.5:35b-a3b',
  knowledge,
  C,
  emit: { liveComment: (t, s) => liveComment(t, s), broadcast: (ch, p) => broadcast(ch, p) },
});
ipcMain.on('pi:prompt', (_e, text) => piSendPrompt(text));
ipcMain.handle('conversation:turn', async (_e, text, options = {}) => {
  if (!daemonClient?.connected) throw new Error('BigKiji daemon is unavailable');
  const result = await daemonClient.turn(String(text), { ...options, sessionId: options.sessionId || daemonState?.activeSessionId || '' });
  daemonState = { ...(daemonState || {}), activeSessionId: result.sessionId }; return result;
});

// Approved parallel execution lanes. Planning is stored locally first; paid
// lanes cannot be started until an explicit owner approval arrives from UI.
ipcMain.handle('task:list', async () => daemonClient?.connected ? (await daemonClient.state()).tasks : taskRunner.snapshot());
ipcMain.handle('task:plan', (_e, spec) => taskRunner.plan(spec));
ipcMain.handle('task:prepare', (_e, spec) => taskRunner.prepare(spec));
ipcMain.handle('task:approve', (_e, value) => {
  const task = typeof value === 'string' ? { id: value } : value;
  return taskRunner.approve(String(task.id), { disclosureHash: task.disclosureHash });
});
ipcMain.handle('task:retry', (_e, id) => taskRunner.retry(String(id)));
ipcMain.handle('task:abort', (_e, id) => taskRunner.abort(String(id)));
ipcMain.handle('run:list', async () => daemonClient?.connected ? (await daemonClient.state()).runs : (coordinator?.snapshot() || []));
ipcMain.handle('run:approve', (_e, value) => {
  const run = typeof value === 'string' ? { id: value } : value;
  const expected = { revision: run.revision, planHash: run.planHash, disclosureHash: run.disclosureHash, idempotencyKey: run.idempotencyKey };
  return daemonClient?.connected ? daemonClient.approve(run) : coordinator.approve(String(run.id), expected);
});
ipcMain.handle('run:abort', (_e, id) => daemonClient?.connected ? daemonClient.abort(String(id)) : coordinator.abort(String(id)));
ipcMain.handle('session:list', async () => daemonClient?.connected ? (await daemonClient.sessions()).sessions : []);
ipcMain.handle('session:get', async (_e, id) => daemonClient?.connected ? daemonClient.session(String(id)) : null);
ipcMain.handle('idea:list', async () => daemonClient?.connected ? (await daemonClient.ideas()).ideas : []);
ipcMain.handle('idea:get', async (_e, id) => daemonClient?.connected ? daemonClient.idea(String(id)) : null);
ipcMain.handle('idea:enhance', async (_e, idea) => daemonClient.enhanceIdea(String(idea.id), String(idea.draftHash)));
ipcMain.handle('idea:enhance-approve', async (_e, spec) => daemonClient.approveIdeaEnhancement(spec));
ipcMain.handle('idea:plan', async (_e, idea) => daemonClient.planIdea(String(idea.id), String(idea.draftHash)));
ipcMain.handle('idea:promote', async (_e, idea) => daemonClient.promoteIdea(String(idea.id), String(idea.draftHash)));
ipcMain.handle('idea:archive', async (_e, idea) => daemonClient.archiveIdea(String(idea.id), String(idea.draftHash)));
ipcMain.handle('remote:access', async (_e, request = false) => {
  const options = typeof request === 'object' && request ? request : { ensure: !!request, action: request ? 'pair' : 'status' };
  if (!remoteAccess) return { state: 'unavailable', ready: false };
  try { return await remoteAccess.status(options); }
  catch (error) {
    return { state: 'error', ready: false, requirement: 'BigKiji Core is unavailable.', detail: String(error.message || error) };
  }
});
ipcMain.handle('open:external', (_e, url) => {
  const value = String(url || ''); if (!/^https?:\/\//i.test(value)) throw new Error('Only HTTP(S) links can be opened');
  return shell.openExternal(value);
});
ipcMain.handle('knowledge:state', () => knowledge.loadState());
ipcMain.handle('fleet:snapshot', () => piFleet.snapshot());
ipcMain.handle('model:status:snapshot', () => fleetMetrics.snapshot());
ipcMain.handle('relationship:snapshot', () => relationshipService.snapshot());
ipcMain.handle('fast-router:status', async () => ({ priority: fastRouter.PRIORITY, available: await fastRouter.detect() }));
// タスク完了レポート（2026-08-02オーナー指示）: Core消滅前にレンダラーが report:build を呼ぶ。
// 取得経路は既存ハンドラと同じ（daemon接続時はdaemon state、非接続時はin-appストア）。
const reportBuilder = new TaskReportBuilder({
  listRuns: async () => daemonClient?.connected ? (await daemonClient.state()).runs : (coordinator?.snapshot() || []),
  listTasks: async () => daemonClient?.connected ? (await daemonClient.state()).tasks : taskRunner.snapshot(),
  getModelSnapshot: async () => daemonState?.models || fleetMetrics.snapshot(),
  getIdeas: async () => daemonClient?.connected ? (await daemonClient.ideas()).ideas : [],
  getPreviewStatus: () => previewServer?.snapshot() || { running: false },
  captureWindow: async () => {
    if (!mainWin || mainWin.isDestroyed()) return null;
    const image = await mainWin.webContents.capturePage();
    return image.isEmpty() ? null : image.toPNG();
  },
  recordingsRoots: [PATHS.recordingsRoot, path.join(APP_ROOT, 'recordings')],
  reportsRoot: PATHS.reportsRoot,
});
ipcMain.handle('report:build', async (_e, detail) => {
  const report = await reportBuilder.build(detail || {});
  // tray通知はバス経由の1行（trayの実イベントフィードにそのまま載る・控えめトーン）
  bus.push({ source: 'system', type: 'result', text: `📄→(=^･ω･^=) 完了レポートあり · ${path.basename(report.mdPath)}` });
  return report;
});
ipcMain.handle('preview:status', () => previewServer?.snapshot() || ({ running: false }));
ipcMain.handle('preview:start', () => previewServer?.start() || ({ running: false }));
ipcMain.handle('preview:stop', () => { previewServer?.close(); const state = previewServer?.snapshot() || ({ running: false }); broadcast('preview:status', state); return state; });
// ---- first-run setup wizard ------------------------------------------------
// Own window, deliberately opaque: no transparent/vibrancy, so it may style itself
// freely without the backdrop-filter-vs-vibrancy conflict the main window has.
let setupWin = null;
function createSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); return setupWin; }
  setupWin = new BrowserWindow({
    width: 780, height: 600, resizable: false, show: false, backgroundColor: '#101215',
    titleBarStyle: 'hiddenInset', title: 'BigKiji Universe — Setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  setupWin.loadFile(path.join(UI_ROOT, 'setup.html'));
  setupWin.once('ready-to-show', () => setupWin.show());
  setupWin.on('closed', () => { setupWin = null; });
  return setupWin;
}

function setupScan() {
  const { planMigration } = require('./migration-plan');
  const layout = require('./data-root').dataLayout(PATHS.dataRoot);
  const state = planMigration({ layout, userData: PATHS.userData, includeModels: false });
  const all = planMigration({ layout, userData: PATHS.userData, includeModels: true });
  return { state, all };
}

ipcMain.handle('setup:state', () => {
  const { defaultDataRoot, findVaultCandidates, dataLayout } = require('./data-root');
  const { findPendingManifest } = require('./data-migrator');
  const { state, all } = setupScan();
  // A migration writes its manifest before it moves a byte, precisely so a crash
  // mid-move can be finished or undone. Nothing ever looked for one, so that manifest
  // was written for a reader that did not exist and an interrupted move stayed
  // half-done in silence.
  const pending = findPendingManifest(dataLayout(PATHS.dataRoot));
  return {
    kind: SETUP_STATUS.kind, version: APP_VERSION,
    defaultRoot: defaultDataRoot(), vault: PATHS.vaultRoot,
    vaultCandidates: findVaultCandidates(),
    stateBytes: state.totalBytes, modelsBytes: all.groups.models,
    found: state.entries.map((entry) => ({ label: entry.id, bytes: entry.bytes, files: entry.files })),
    interrupted: pending ? { status: pending.manifest.status, startedAt: pending.manifest.startedAt || '',
      dataRoot: pending.manifest.dataRoot || '', manifestPath: pending.manifestPath,
      entries: (pending.manifest.entries || []).map((entry) => ({ id: entry.id, state: entry.state || 'pending' })) } : null,
  };
});
// Undo an interrupted move. Rollback is the safe direction: it puts back what was
// moved and leaves what was not, so it is correct whether the crash happened at the
// first entry or the last.
ipcMain.handle('setup:rollback', async () => {
  const { dataLayout } = require('./data-root');
  const { findPendingManifest, rollbackMigration } = require('./data-migrator');
  const pending = findPendingManifest(dataLayout(PATHS.dataRoot));
  if (!pending) return { rolledBack: false, reason: 'No interrupted migration was found.' };
  await stopDaemonForMigration();
  const result = await rollbackMigration(pending);
  return { rolledBack: true, reverted: result.reverted, status: result.manifest.status };
});

ipcMain.handle('setup:plan', (_event, choice = {}) => {
  const { dataLayout } = require('./data-root');
  const { planMigration } = require('./migration-plan');
  const { preflight } = require('./data-migrator');
  const layout = dataLayout(path.resolve(choice.dataRoot || PATHS.dataRoot));
  const plan = planMigration({ layout, userData: PATHS.userData, includeModels: !!choice.includeModels });
  return { ...plan, preflight: preflight({ plan, layout, vaultRoot: PATHS.vaultRoot }) };
});

ipcMain.handle('setup:choose-folder', async (_event, kind) => {
  const result = await require('electron').dialog.showOpenDialog(setupWin || undefined, {
    title: kind === 'vault' ? 'Choose your Obsidian vault' : 'Choose where BigKiji keeps its data',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? '' : result.filePaths[0];
});

// Quiesce the daemon before anything moves underneath it. macOS has no mandatory
// locks, so open handles do not block a rename — the real hazard is a write landing
// in the old location after the move.
async function stopDaemonForMigration() {
  try { daemonClient?.disconnect?.(); } catch (_) {}
  try {
    await fetch(`http://127.0.0.1:8777/api/shutdown`, { method: 'POST',
      headers: { authorization: `Bearer ${remoteAccess?.token?.() || ''}` } });
  } catch (_) {}
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const alive = await fetch('http://127.0.0.1:8777/health').then((r) => r.ok).catch(() => false);
    if (!alive) return true;
    if (attempt === 11) {
      try { process.kill(Number(fs.readFileSync(PATHS.daemonPidFile, 'utf8').trim()), 'SIGTERM'); } catch (_) {}
    }
  }
  return false;
}

ipcMain.handle('setup:apply', async (_event, choice = {}) => {
  const dataRootMod = require('./data-root');
  const { planMigration, referenceOverrides } = require('./migration-plan');
  const { preflight, executeMigration, rollbackMigration } = require('./data-migrator');
  const dataRoot = path.resolve(choice.dataRoot || PATHS.dataRoot);
  const reference = choice.mode === 'reference';
  const layout = dataRootMod.dataLayout(dataRoot);
  const send = (update) => { if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:progress', update); };
  try {
    if (reference) {
      dataRootMod.writePointer(PATHS.userData, { dataRoot, mode: 'reference',
        overrides: referenceOverrides({ layout, userData: PATHS.userData }), migratedAt: new Date().toISOString() });
    } else {
      const plan = planMigration({ layout, userData: PATHS.userData, includeModels: !!choice.includeModels });
      const guard = preflight({ plan, layout, vaultRoot: PATHS.vaultRoot });
      if (!guard.ok) return { ok: false, error: guard.errors.join(' ') };
      await stopDaemonForMigration();
      dataRootMod.ensureLayout(layout);
      const run = await executeMigration({ plan, layout, userData: PATHS.userData,
        startedAt: new Date().toISOString(), settingsBefore: settingsStore?.get()?.paths || {}, onProgress: send });
      if (!run.ok) {
        const undo = await rollbackMigration(run);
        return { ok: false, error: 'Migration failed.', rolledBack: undo.reverted.length > 0 };
      }
      // Pointer and settings are written last: until this line a crash simply leaves
      // the app reading the old locations, which is a safe place to fail.
      dataRootMod.writePointer(PATHS.userData, { dataRoot, mode: 'own', migratedAt: new Date().toISOString() });
    }
    if (choice.vault) settingsStore?.update({ paths: { vaultRoot: choice.vault } });
    dataRootMod.writeSetupState(PATHS.userData, { choice: reference ? 'reference' : 'move', dataRoot, appVersion: APP_VERSION });
    return { ok: true, dataRoot, moved: !reference };
  } catch (err) {
    return { ok: false, error: String(err && err.message).slice(0, 300) };
  }
});

ipcMain.handle('setup:skip', () => {
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  bus.push({ source: 'system', type: 'log', text: 'Setup postponed — BigKiji is using its default data folder. Re-open it from Settings.' });
  return { ok: true };
});

ipcMain.handle('setup:finish', () => { app.relaunch(); app.exit(0); });

// ---- local tool connections ------------------------------------------------
// BigKiji never bundles, copies or installs a tool: it detects what the owner already has,
// lets them point at anything it missed, and remembers only the path — the gigabytes stay
// where they are. Detection is synchronous and cheap so opening Settings is instant;
// health probes are separate, bounded and never throw, so a dead port cannot stall the UI.
const TOOL_PROBE_TIMEOUT_MS = 2000; // a cold CLI answers `--version` in ~750ms here
ipcMain.handle('tools:detect', () => {
  const registry = require('../domain/pi-agent/tool-registry');
  return registry.detectAll({ saved: settingsStore?.get()?.paths || {} });
});
ipcMain.handle('tools:probe', async (_event, id) => {
  const registry = require('../domain/pi-agent/tool-registry');
  const row = registry.detectAll({ saved: settingsStore?.get()?.paths || {} }).find((tool) => tool.id === String(id));
  if (!row) return { id: String(id), status: 'missing', checked: false, detail: 'Unknown tool' };
  // A tool with no health check is re-detected, never probed: merging an unchecked probe
  // result would overwrite a status detection had already established.
  if (!row.probe) return row;
  return { ...row, ...(await registry.probe(row, { timeoutMs: TOOL_PROBE_TIMEOUT_MS })) };
});
ipcMain.handle('tools:probe-all', () => {
  const registry = require('../domain/pi-agent/tool-registry');
  return registry.detectAndProbeAll({ saved: settingsStore?.get()?.paths || {}, timeoutMs: TOOL_PROBE_TIMEOUT_MS });
});
ipcMain.handle('tools:choose', async (_event, id) => {
  const registry = require('../domain/pi-agent/tool-registry');
  const tool = registry.findTool(id);
  if (!tool || tool.kind === 'http') return '';
  const directory = tool.kind === 'directory';
  const result = await require('electron').dialog.showOpenDialog(mainWin || undefined, {
    title: `Locate ${tool.label}`,
    message: `BigKiji only remembers where ${tool.label} is. Nothing is copied, moved or installed.`,
    properties: [directory ? 'openDirectory' : 'openFile'],
  });
  return result.canceled ? '' : result.filePaths[0];
});

// Which folders BigKiji may read and edit. The owner's default picture is that
// ~/Documents is the working surface and each business is a folder inside it — so the
// candidates come from there. They are proposed, never auto-registered: a directory
// silently becoming readable because it happened to be in the right place is how an
// app ends up indexing somebody's tax returns.
const workspaces = new WorkspaceRegistry({ userData: PATHS.userData });
function workspaceState() {
  return {
    roots: workspaces.list(),
    candidates: candidateWorkspaces({ roots: [path.join(os.homedir(), 'Documents'), os.homedir()] })
      .filter((item) => !workspaces.list().some((root) => root.path === item.path)).slice(0, 24),
    defaultExclude: [...WORKSPACE_DEFAULT_EXCLUDE],
    documentsRoot: path.join(os.homedir(), 'Documents'),
  };
}
function publishWorkspaces() {
  const state = workspaceState();
  broadcast('workspace:changed', state);
  // Registering a folder is what makes it appear in the map and stay watched, so both
  // have to follow the list rather than wait for the next launch.
  startVaultWatch();
  scanVaultFiles().catch((error) => bus.push({ source: 'system', type: 'degrade', text: `Workspace scan failed: ${error.message}` }));
  return state;
}
// The read path the registry exists to gate. Registering a folder is what makes a file
// in it reachable from the renderer; an excluded subfolder and a sensitive file are not
// reachable even inside a registered root.
const { isSensitivePath } = require('../domain/pi-core/security/security-policy');
function resolveWorkspaceFile(target) {
  const value = String(target || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value) return '';
  const registered = workspaces.list().length > 0;
  for (const root of scanRoots()) {
    const stripped = root.prefix && value.startsWith(root.prefix) ? value.slice(root.prefix.length) : value;
    const absolute = path.resolve(root.path, stripped);
    if (!absolute.startsWith(path.resolve(root.path) + path.sep)) continue;
    if (registered && !workspaces.allows(absolute)) continue;
    if (isSensitivePath(absolute)) continue;
    if (!fs.existsSync(absolute)) continue;
    return absolute;
  }
  return '';
}
ipcMain.handle('workspace:state', () => workspaceState());
ipcMain.handle('workspace:register', (_event, spec = {}) => {
  workspaces.register(String(spec.path || ''), { label: spec.label || '', exclude: Array.isArray(spec.exclude) ? spec.exclude : null });
  return publishWorkspaces();
});
ipcMain.handle('workspace:remove', (_event, id) => { workspaces.remove(String(id || '')); return publishWorkspaces(); });
ipcMain.handle('workspace:update', (_event, id, patch = {}) => { workspaces.update(String(id || ''), patch); return publishWorkspaces(); });
ipcMain.handle('workspace:choose', async () => {
  const result = await require('electron').dialog.showOpenDialog(mainWin || undefined, {
    title: 'Add a folder BigKiji may work in',
    message: 'BigKiji reads and edits inside the folders you add here, and nowhere else.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return workspaceState();
  workspaces.register(result.filePaths[0]);
  return publishWorkspaces();
});

ipcMain.handle('settings:get', () => settingsStore?.get());
ipcMain.handle('settings:update', (_event, patch) => {
  const before = settingsStore.get(); const next = settingsStore.update(patch || {});
  if (daemonClient?.connected && JSON.stringify(before.conversation) !== JSON.stringify(next.conversation)) {
    daemonClient.configureConversation(next.conversation).catch((error) => bus.push({ source:'system', type:'warn', text:`Conversation settings sync failed: ${error.message}` }));
  }
  if (ttsService && (before.audio.ttsEndpoint !== next.audio.ttsEndpoint || before.audio.ttsModel !== next.audio.ttsModel)) {
    ttsService.stop();
  }
  if (previewServer && (before.preview.preferredPort !== next.preview.preferredPort || before.preview.enabled !== next.preview.enabled)) {
    const root = previewServer.root; previewServer.close();
    previewServer = new PreviewServer({ root, preferredPort: next.preview.preferredPort });
    previewServer.on('status', (status) => broadcast('preview:status', status));
    previewServer.on('reload', (status) => broadcast('preview:reload', status));
    previewServer.on('error', (error) => broadcast('preview:error', { message: String(error.message || error) }));
    if (coordinator) coordinator.preview = previewServer;
    if (next.preview.enabled) previewServer.start().catch((error) => broadcast('preview:error', { message: error.message }));
  }
  if (next?.piAgent?.displayName !== before?.piAgent?.displayName) fleetMetrics.setPiAgentName(next?.piAgent?.displayName || '');
  broadcast('settings:changed', next);
  return next;
});
ipcMain.handle('settings:secret', async (_event, id, value) => {
  const provider = String(id); const secret = String(value || '');
  const status = settingsStore.setSecret(provider, secret);
  if (daemonClient?.connected && ['claude', 'codex', 'gemini', 'glm'].includes(provider)) {
    await daemonClient.syncCredentials({ [provider]: secret });
    daemonState = await daemonClient.state();
  }
  // A key the owner just typed has to change what the fleet shows and what Pi can
  // borrow, now — not after a restart. pi-bridge has had refreshChain() for exactly
  // this since V13 and nothing has ever called it, so entering a GLM key left Pi on
  // the tier it had chosen when the key was still missing.
  try { pi?.refreshChain?.(); } catch (_) { /* the key is saved either way */ }
  refreshFleetAvailability?.().catch?.(() => {});
  return status;
});
ipcMain.handle('settings:secret-status', () => settingsStore.secretStatus());
ipcMain.handle('voice:status', () => ttsService?.snapshot() || ({ state: 'offline', ready: false, engine: 'system-neural' }));
ipcMain.handle('voice:preview', async (_event, spec = {}) => {
  const requestedAt = Date.now();
  speechFirstQueued = false; speechAnyQueued = false; speechFirstPlayed = false; speechRequestAt = requestedAt; speechUtterance++;
  queueSpeech(String(spec.text || 'BigKiji Universe is ready.'), { track: 'owner', agent: String(spec.agent || 'codex'), requestedAt, utteranceId: speechUtterance });
  return { queued: true, requestedAt };
});
ipcMain.on('voice:playback-state', (_event, state = {}) => {
  if (state.state === 'playing' && state.track === 'owner') {
    speechFirstPlayed = true;
    clearTimeout(speechRescueTimer);
    clearTimeout(speechDeadlineTimer);
    const ok = Number(state.firstAudioMs) <= (settingsStore?.get().audio.firstSpeechDeadlineMs || 30000);
    broadcast('voice:sla', { state: ok ? 'met' : 'missed', firstAudioMs: Number(state.firstAudioMs), engine: state.engine });
    bus.push({ source: 'system', type: ok ? 'info' : 'warn', text: `Voice first-audio ${Math.round(Number(state.firstAudioMs))}ms · ${state.engine || 'audio'}` });
  }
});
ipcMain.handle('cmux:snapshot', () => cmuxBridge?.snapshot() || ({ connected: false, surfaces: [], error: 'Bridge not ready' }));
ipcMain.handle('cmux:refresh', () => cmuxBridge.refresh());
ipcMain.handle('cmux:select', (_event, surface) => cmuxBridge.select(surface));
ipcMain.handle('cmux:action', (_event, action, payload) => cmuxBridge.action(String(action), payload || {}));
ipcMain.handle('cmux:command', (_event, spec) => cmuxBridge.command(spec || {}));
ipcMain.handle('cmux:open-native', (_event, surface) => cmuxBridge.openNative(surface));
ipcMain.on('cmux:input', (_event, text, surface) => cmuxBridge.send(text, surface).catch((error) => broadcast('cmux:error', { message: error.message })));
ipcMain.on('cmux:key', (_event, key, surface) => cmuxBridge.sendKey(key, surface).catch((error) => broadcast('cmux:error', { message: error.message })));
ipcMain.handle('comfy:status', async () => comfy ? comfy.detect() : ({ state: 'offline', progress: 0, message: 'Media bridge is initializing' }));
ipcMain.handle('comfy:generate', async (_event, spec) => {
  if (!comfy) throw new Error('Media bridge is not ready');
  return comfy.generate(spec || {});
});
ipcMain.handle('comfy:cancel', async (_event, jobId) => comfy ? comfy.cancel(String(jobId || '')) : ({ cancelled: false }));

// PITEST="<プロンプト>" — パイプラインE2E検証: 起動→送信→実写撮影→agent_endで終了。
// フローカード/COMMS/委任発光が実イベントで動くことをスクショ証跡として残す
if (process.env.PITEST) {
  app.whenReady().then(() => {
    const dir = process.env.PITEST_DIR || path.join(os.tmpdir(), 'bigkiji-pitest');
    fs.mkdirSync(dir, { recursive: true });
    setTimeout(() => createMainWindow(), 1500);
    setTimeout(() => piSendPrompt(process.env.PITEST, { raw: true }), 8000);
    const shot = async (name) => {
      try {
        const img = await mainWin.webContents.capturePage();
        fs.writeFileSync(path.join(dir, name), img.toPNG());
        console.log('PITEST shot', name);
      } catch (e) { console.log('PITEST shot fail', e.message); }
    };
    setTimeout(() => shot('t25.png'), 25000);
    setTimeout(() => shot('t70.png'), 70000);
    // マーカーE2E: PITEST_MARKER の一意トークンが応答に無傷で往復すれば
    // 「プロンプト→モデル→応答」パイプラインに切詰め/欠落が無い証明になる
    let ansBuf = '';
    pi.on('event', (evt) => {
      if (evt.type === 'message_update') {
        const d = evt.assistantMessageEvent;
        if (d && d.type === 'text_delta' && d.delta) ansBuf += d.delta;
      }
      if (evt.type === 'agent_end') {
        if (process.env.PITEST_MARKER) {
          console.log('PITEST MARKER ' + (ansBuf.includes(process.env.PITEST_MARKER) ? 'OK' : 'MISS'));
        }
        setTimeout(async () => { await shot('end.png'); console.log('PITEST DONE'); app.exit(0); }, 6000);
      }
    });
    setTimeout(() => { console.log('PITEST TIMEOUT'); app.exit(1); }, 600000);
  });
}
ipcMain.on('pi:abort', () => { if (daemonClient?.connected) daemonClient.post('/api/abort').catch(() => {}); else pi.abort(); });

// Both of these used to resolve against one hardcoded root. They now resolve through
// the registered workspaces, which is what makes the Settings copy — "adding a folder
// is what grants access" — actually true.
ipcMain.on('reveal', (_e, p) => {
  // One resolver, no absolute shortcut. The shortcut skipped resolveWorkspaceFile, which
  // is the only place isSensitivePath() is applied — allows() checks containment and
  // directory exclusions, so reveal('<registered root>/.env') was honoured.
  const relative = typeof p === 'string' && path.isAbsolute(p)
    ? (scanRoots().map((root) => (p.startsWith(path.resolve(root.path) + path.sep)
      ? `${root.prefix || ''}${path.relative(root.path, p)}` : '')).find(Boolean) || '')
    : String(p || '');
  const file = relative && resolveWorkspaceFile(relative);
  if (file) shell.showItemInFolder(file);
});
ipcMain.handle('file:detail', async (_e, relPath) => {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = resolveWorkspaceFile(rel);
  if (!absolute || VAULT_EXCLUDE.test(absolute)) throw new Error('File is outside every folder BigKiji may read');
  const st = await fs.promises.stat(absolute);
  let promptSummary = 'No prompt context recorded';
  if (/\.(md|json)$/i.test(rel)) {
    try {
      const handle = await fs.promises.open(absolute, 'r');
      const buffer = Buffer.alloc(Math.min(st.size, 8192));
      try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
      const head = buffer.toString('utf8').replace(/\s+/g, ' ').trim();
      if (head) promptSummary = head.slice(0, 180);
    } catch (_) {}
  }
  const company = rel.split('/')[0];
  return { name: path.basename(rel), path: rel, size: st.size, mtimeMs: st.mtimeMs,
    updated: new Date(st.mtimeMs).toISOString(), company,
    agent: COMPANY_AGENT[company] || 'core', promptSummary };
});

ipcMain.on('pty:input', (_e, data) => { if (pty) pty.write(data); });
ipcMain.on('pty:resize', (_e, { cols, rows }) => { if (pty && ptyMode === 'pty') pty.resize(cols, rows); });
ipcMain.on('open-main', () => createMainWindow());
ipcMain.on('open-console', () => createConsoleWindow());
ipcMain.handle('get-info', () => {
  let loops = [];
  try {
    loops = require('fs').readdirSync(path.join(UI_ROOT, 'assets', 'loops'))
      .filter((f) => /\.(mp4|webm)$/i.test(f));
  } catch (_) {}
  return { ptyMode, electron: process.versions.electron, loops, deliverables: latestDeliverables,
    vaultFiles, sandboxTopo: sandboxTopology(), tasks: taskRunner.snapshot(),
    fleet: daemonState?.models || fleetMetrics.snapshot(), modelStatus: daemonState?.models || fleetMetrics.snapshot(), relationships: relationshipService.snapshot(), runs: daemonState?.runs || coordinator?.snapshot() || [],
    sessions: daemonState?.sessions || [], daemon: daemonState ? { connected: true, pid: daemonState.pid, activeSessionId: daemonState.activeSessionId } : { connected: false },
    preview: previewServer?.snapshot() || { running: false }, security: daemonState?.security || { mode: 'strict-direct', status: 'ENFORCED', blocked: 0, manifests: 0, recent: [] },
    buildId: APP_BUILD_ID,
    paths: { appRoot: APP_ROOT, vaultRoot: VAULT, knowledgeRoot: PATHS.knowledgeRoot, graphPath: PATHS.graphPath },
    costPolicy: { planning: ['qwen-local'], paid: ['claude', 'codex', 'gemini', 'glm'], localOperators: ['qwen'], blocked: ['kimi', 'openrouter', 'openai-tts', 'elevenlabs'] },
    ...bus.snapshot() };
});

// ---------- ライフサイクル ----------
app.whenReady().then(async () => {
  settingsStore = new SettingsStore({ userData: app.getPath('userData'), safeStorage });
  fleetMetrics.setPiAgentName(settingsStore.get()?.piAgent?.displayName || '');
  remoteAccess = new TailscaleRemoteAccess({ port: 8777, configFile: PATHS.remoteConfigFile });
  if (!SMOKE) {
    try {
      daemonClient = new DaemonClient({ appRoot: APP_ROOT, workspace: PATHS.vaultRoot, dataRoot: PATHS.dataRoot });
      const daemon = await daemonClient.ensure({ timeoutMs: 8000 });
      await daemonClient.syncCredentials(Object.fromEntries(['claude', 'codex', 'gemini', 'glm']
        .map((provider) => [provider, settingsStore.getSecret(provider)]).filter(([, value]) => value)));
      await daemonClient.configureConversation(settingsStore.get().conversation);
      daemonState = await daemonClient.state();
      const channelMap = { task: 'task:event', tasklog: 'task:log', run: 'run:event', models: 'model:status:update',
        fleet: 'pi:fleet', commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event', stats: 'pi:stats', security: 'security:status',
        conversation: 'conversation:update', idea: 'idea:update', knowledge: 'knowledge:status' };
      daemonClient.on('event', ({ event, data }) => {
        if (event === 'state') { daemonState = data; broadcast('daemon:state', data); return; }
        const channel = channelMap[event]; if (channel) broadcast(channel, data);
        if (event === 'run') daemonState = { ...(daemonState || {}), runs: [...(daemonState?.runs || []).filter((run) => run.id !== data.id), data] };
        if (event === 'security') daemonState = { ...(daemonState || {}), security: data };
        if (event === 'idea' && data.draft) daemonState = { ...(daemonState || {}), ideas: [...(daemonState?.ideas || []).filter((idea) => idea.id !== data.draft.id), data.draft] };
      });
      daemonClient.connect();
      bus.push({ source: 'system', type: 'info', text: `${daemon.started ? 'Started' : 'Attached to'} standalone BigKiji Core Engine · 127.0.0.1:8777` });
      // The daemon is spawned detached and survives app restarts, so an attach can land
      // on a pre-migration process still writing to the old directories. Silent split
      // brain looks like "my sessions disappeared", so surface it loudly.
      const probe = await daemonClient.health(1200);
      if (probe && probe.dataRoot && path.resolve(probe.dataRoot) !== path.resolve(PATHS.dataRoot)) {
        bus.push({ source: 'system', type: 'warn',
          text: `Core Engine is using a different data folder (${probe.dataRoot}) than this app (${PATHS.dataRoot}). Quit BigKiji fully and reopen it.` });
      }
    } catch (error) {
      daemonClient = null;
      bus.push({ source: 'system', type: 'warn', text: `Standalone daemon unavailable: ${error.message} · in-app core remains active` });
    }
  }
  // The wizard must never block startup: BigKiji is a menu-bar resident and stays
  // usable if the owner ignores or closes it.
  if (SETUP_STATUS.needed && !SMOKE && !SNAP) setTimeout(createSetupWindow, 400);

  const previewRoot = path.join(PATHS.vaultRoot, 'Generated', 'BigKijiShooter');
  const previewTemplate = path.join(APP_ROOT, 'fixtures', 'e2e', 'bigkiji-shooter');
  if (!fs.existsSync(path.join(previewRoot, 'index.html')) && fs.existsSync(previewTemplate)) {
    fs.mkdirSync(path.dirname(previewRoot), { recursive: true });
    fs.cpSync(previewTemplate, previewRoot, { recursive: true, errorOnExist: false });
  }
  const previewVendor = path.join(previewRoot, 'vendor');
  const threeBuild = path.join(APP_ROOT, 'node_modules', 'three', 'build');
  if (fs.existsSync(threeBuild)) {
    fs.mkdirSync(previewVendor, { recursive: true });
    for (const name of ['three.module.js', 'three.core.js']) {
      const source = path.join(threeBuild, name); const target = path.join(previewVendor, name);
      if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
    }
  }
  previewServer = new PreviewServer({ root: previewRoot, preferredPort: settingsStore.get().preview.preferredPort });
  previewServer.on('status', (status) => broadcast('preview:status', status));
  previewServer.on('reload', (status) => broadcast('preview:reload', status));
  previewServer.on('error', (error) => broadcast('preview:error', { message: String(error.message || error) }));
  // The same readiness gate the daemon uses. Without it this coordinator defaulted
  // to `() => true` and assigned work to providers that could not start — a second
  // dispatch path with none of the first one's checks. See provider-readiness.js.
  coordinator = new CoreExecutionCoordinator({ taskRunner, settingsProvider: () => settingsStore.get(), preview: previewServer,
    available: (provider) => providerReadiness(provider, { secret: (id) => settingsStore.getSecret(id === 'claude-code' ? 'claude' : id) || '' }).ready });
  coordinator.on('run', (event) => { fleetMetrics.ingestRun(event); piFleet.ingestRun(event); broadcast('run:event', event); });
  // The fleet display asked the front-desk router which providers exist, and that
  // router is deliberately local-only: it returns claude/codex/gemini/glm as false
  // unconditionally, because it must never send owner text to a paid provider
  // before a disclosure manifest. Correct for routing, and a lie as a status
  // display — every paid provider read OFFLINE / "Not available" on screen while
  // GLM and Codex were completing real work. Readiness is the same question the
  // daemon and the coordinator ask.
  refreshFleetAvailability = async () => {
    const rows = providerSurvey({ secret: (id) => settingsStore.getSecret(id === 'claude-code' ? 'claude' : id) || '' });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    fleetMetrics.setAvailability({ claude: byId['claude-code']?.ready, codex: byId.codex?.ready,
      gemini: byId.gemini?.ready, glm: byId.glm?.ready, ollama: await fastRouter.ollamaReady().catch(() => false) });
    for (const row of rows) {
      const id = row.id === 'claude' ? 'claude-code' : row.id;
      fleetMetrics.touch?.(id, { metrics: { apiHealth: row.ready ? `ready · ${row.via}` : row.detail } });
    }
  };
  refreshFleetAvailability().catch(() => {});
  if (settingsStore.get().preview.enabled) previewServer.start()
    .catch((error) => bus.push({ source: 'system', type: 'warn', text: `Preview unavailable: ${error.message}` }));
  if (E2E_FIXTURE) setTimeout(() => {
    try {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(E2E_FIXTURE), 'utf8'));
      const run = coordinator.submit({ prompt: fixture.ownerPrompt, promptSpec: { goal: fixture.ownerPrompt,
        acceptance: fixture.acceptance || [], decisions: fixture.ownerAnswers || [] }, mode: 'auto', cwd: previewRoot });
      bus.push({ source: 'system', type: 'task', text: `E2E fixture dispatched: ${run.id} · ${run.assignments.length} specialists` });
      broadcast('pi:event', { kind: 'turn_start', text: fixture.ownerPrompt, model: 'fixture-json', runId: run.id });
    } catch (error) { bus.push({ source: 'system', type: 'error', text: `E2E fixture failed: ${String(error.message).slice(0, 220)}` }); }
  }, 1800);
  taskRunner.setSecretProvider((provider) => settingsStore.getSecret(provider === 'claude-code' ? 'claude' : provider));
  ttsService = new NaturalTTSService({ appRoot: APP_ROOT, userData: app.getPath('userData'), settingsStore,
    cacheDir: PATHS.ttsCacheRoot, venvPython: PATHS.ttsVenvPython });
  ttsService.on('status', (status) => broadcast('voice:engine-status', status));
  ttsService.on('log', (text) => text && bus.push({ source: 'system', type: 'info', text: `TTS: ${String(text).slice(0, 180)}` }));
  // Local neural TTS is intentionally lazy: first speech wakes it, idle timeout closes it.
  cmuxBridge = new CmuxBridge({ settingsStore, defaultBin: PATHS.cmuxBin });
  cmuxBridge.on('snapshot', (snapshot) => broadcast('cmux:snapshot', snapshot));
  cmuxBridge.start();
  comfy = new ComfyUIMediaBridge({ root: PATHS.comfyRoot || undefined, outputDir: PATHS.generatedMediaRoot });
  comfy.on('event', (event) => broadcast('comfy:event', event));
  if (process.platform === 'darwin' && !SMOKE && !SNAP && !SHOW_MAIN && !SHOW_CONSOLE) app.dock.hide(); // 通常時のみメニューバー常駐
  // Without an application menu, Electron registers none of the native edit roles — so
  // Cmd-C and Cmd-V did not work in any window, and Settings was reachable only from a
  // keydown handler inside a focused renderer. Menu.setApplicationMenu was grep 0 until
  // now; this is the Apple HIG entry point the app was missing rather than a decoration.
  applyApplicationMenu({
    Menu,
    app,
    handlers: {
      openConsole: () => createConsoleWindow(),
      openMain: () => createMainWindow(),
      openSettings: () => { createConsoleWindow(); broadcast('ui:open-settings'); },
    },
  });
  createTray();
  createTrayWindow();
  if (SMOKE || SNAP || SHOW_MAIN) createMainWindow(); // --show-main は再起動後のCanvas確認・直接起動用
  if (SHOW_CONSOLE) { const w = createConsoleWindow(); w.once('ready-to-show', () => app.focus({ steal: true })); }
  spawnShell();
  // Models are intentionally cold. PiAgent/daemon wakes only selected roles after owner approval.
  bus.on('event', (evt) => broadcast('bus:event', evt));
  bus.startSystemPulse(app);
  knowledge.savePhysicalLayout({ version: 5, root: APP_ROOT, domains: {
    core: ['src/core/main.js', 'src/core/preload.js', 'src/core/path-config.js', 'src/core/orchestrator.js', 'src/core/tts-policy.js', 'src/core/natural-tts-service.js', 'src/core/settings-store.js', 'src/core/cmux-bridge.js', 'src/core/relationship-snapshot-service.js', 'src/core/preview-server.js'],
    '3d-canvas': ['src/domain/3d-canvas/components/synapse.js', 'src/domain/3d-canvas/components/roadmap-3d.js', 'src/domain/3d-canvas/components/relationship-field.js', 'src/domain/3d-canvas/shaders/core-accretion-field.js', 'src/domain/3d-canvas/shaders/synapse-spark-shedder.js'],
    terminal: ['src/domain/terminal/bigkiji-cli.js', 'src/domain/terminal/components/multi-terminal-manager.js', 'src/domain/terminal/components/terminal-resizer.js', 'src/domain/terminal/components/cmux-terminal-mirror.js'],
    server: ['src/domain/server/daemon.js', 'src/domain/server/daemon-client.js', 'src/domain/server/session-store.js'],
    cli: ['src/cli/tui/monitor.js', 'src/cli/tui/renderer.js'],
    telemetry: ['src/domain/telemetry/components/right-telemetry-panel.js', 'src/domain/telemetry/components/telemetry-store.js'],
    hud: ['src/domain/hud/model-status-store.js', 'src/domain/hud/components/active-ai-models-fleet.js'],
    'pi-agent': ['src/domain/pi-agent/pi-bridge.js', 'src/domain/pi-agent/task-runner.js', 'src/domain/pi-agent/core-execution-coordinator.js', 'src/domain/pi-agent/model-capability-registry.js', 'src/domain/pi-agent/sandbox-policy.js', 'src/domain/pi-agent/context-pruner.js', 'src/domain/pi-agent/pi-knowledge-orchestrator.js', 'src/domain/pi-agent/components/pi-agents-fleet-box.js'],
    ui: ['src/components/UI/main.html', 'src/components/UI/tray.html', 'src/components/UI/audio-engine.js', 'src/components/UI/settings-modal.js', 'src/components/UI/settings-modal.css', 'src/components/UI/remote/mobile.html'],
    remote: ['src/core/tailscale-remote-access.js'],
  } });
  relationshipService.refresh(true);
  const relationshipTimer = setInterval(() => relationshipService.refresh(false), 300000);
  relationshipTimer.unref();
  // Defer filesystem discovery until after the UI/PTY are responsive.
  setImmediate(async () => {
    seikaDirs = findSeikaDirs();
    scanDeliverables();
    await scanVaultFiles();
    const vfTimer = setInterval(scanVaultFiles, 300000); // 実ファイル地図は5分毎に更新
    vfTimer.unref();
    startVaultWatch();
    const seikaTimer = setInterval(scanDeliverables, 60000); // 成果物の実ファイル監視（60秒毎）
    seikaTimer.unref();
  });
  // 配布ガード: Vault不在の環境でも落ちず、空表示の理由を正直に案内する
  if (!fs.existsSync(VAULT)) {
    bus.push({ source: 'system', type: 'info', text: `Vault not found (${VAULT}) — file galaxy & deliverables will be empty on this machine` });
  }

  // Port 8777 belongs exclusively to the standalone daemon. The Electron app never starts a second listener.
  if (!SMOKE && !daemonClient?.connected) bus.push({ source: 'system', type: 'warn',
    text: 'Mobile and CLI sync are unavailable until the standalone BigKiji Core Engine reconnects.' });

  // ⌥Space = どこからでも会話開始（小窓を開いて入力欄へフォーカス）
  const ok = globalShortcut.register('Alt+Space', () => {
    positionTrayWindow();
    trayWin.show();
    trayWin.focus();
    trayWin.webContents.send('composer:focus');
  });
  if (!ok) console.log('⌥Space registration failed (already used by another app)');

  if (process.env.VOICETEST) {
    setTimeout(() => speak('Voice test OK. Hello, owner. BigKiji Universe is live.'), 1500);
  }
  // TTSTEST=1 — final-only TTS と Thinking 除外、Barge-in切断の検証。
  if (process.env.TTSTEST) {
    setTimeout(() => {
      liveVoice.active = true;
      const fake = '<thinking>never speak this draft</thinking>Final owner report. 作業は完了しました。';
      ttsFlushRemainder(fake);
      setTimeout(() => {
        const seqBefore = ttsSeq;
        ttsKill();
        console.log(`TTSTEST synthesized=${seqBefore} queueAfterKill=${speechQueues.owner.length} busy=${speechBusy.owner}`);
        console.log(`TTSTEST ${seqBefore >= 1 && speechQueues.owner.length === 0 ? 'OK' : 'FAIL'}`);
        quitting = true;
        app.exit(0);
      }, 4200);
    }, 1500);
    setTimeout(() => { console.log('TTSTEST TIMEOUT'); app.exit(1); }, 30000);
  }
  if (SNAP) {
    const fs = require('fs');
    positionTrayWindow();
    trayWin.show();
    // 撮影用の可視化テストイベント（SNAPモード限定・textに明示）
    setTimeout(() => {
      bus.push({ source: 'system', agent: 'claude-code', type: 'task', text: 'SNAP visual test — pulse check' });
      bus.push({ source: 'system', agent: 'codex', type: 'task', text: 'SNAP visual test — interface pulse check' });
    }, 2600);
    setTimeout(() => {
      bus.push({ source: 'system', agent: 'biglama', type: 'task', text: 'SNAP visual test — local planning pulse' });
    }, 4700);
    if (process.env.SNAP_SETTINGS) {
      const page = String(process.env.SNAP_SETTINGS || 'audio').replace(/[^a-z-]/g, '');
      setTimeout(() => mainWin?.webContents.executeJavaScript(`window.BKSettings?.open();document.querySelector('[data-page="${page}"]')?.click()`).catch(() => {}), 3200);
    }
    if (process.env.SNAP_WAKE) {
      setTimeout(() => {
        for (const window of [trayWin, mainWin]) window?.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('bk:wake-core'))").catch(() => {});
      }, 2600);
    }
    setTimeout(async () => {
      try {
        for (const [name, w] of [['tray', trayWin], ['main', mainWin]]) {
          const img = await w.webContents.capturePage();
          fs.writeFileSync(path.join(SNAP, `snap-${name}.png`), img.toPNG());
        }
        console.log('SNAP OK');
      } catch (err) { console.log('SNAP FAIL', err.message); }
      quitting = true;
      app.exit(0);
    }, 5000);
  }

  if (SMOKE) {
    // The windows are created earlier in whenReady; on fast machines their
    // load event can precede this harness. Seed from current WebContents state
    // so the smoke result measures the app, not listener timing.
    // The console window is created here rather than at startup: it is not part of the
    // normal boot, but a window that renders model output and hosts a terminal is
    // exactly the kind of thing that should fail the build when it stops loading.
    createConsoleWindow();
    const state = {
      trayLoaded: !!trayWin && !trayWin.webContents.isLoadingMainFrame(),
      mainLoaded: !!mainWin && !mainWin.webContents.isLoadingMainFrame(),
      consoleLoaded: !!consoleWin && !consoleWin.webContents.isLoadingMainFrame(),
      errors: [],
    };
    trayWin.webContents.once('did-finish-load', () => { state.trayLoaded = true; });
    mainWin.webContents.once('did-finish-load', () => { state.mainLoaded = true; });
    consoleWin.webContents.once('did-finish-load', () => { state.consoleLoaded = true; });
    for (const [name, w] of [['tray', trayWin], ['main', mainWin], ['console', consoleWin]]) {
      w.webContents.on('did-fail-load', (_event, code, description) => state.errors.push(`${name}: load ${code} ${description}`));
      w.webContents.on('console-message', (event) => {
        if (Number(event?.level) >= 3) state.errors.push(`${name}: ${event.message}`);
      });
    }
    setTimeout(() => {
      const ok = !!tray && state.trayLoaded && state.mainLoaded && state.consoleLoaded && ptyMode !== 'none' && state.errors.length === 0;
      console.log(`${ok ? 'SMOKE OK' : 'SMOKE FAIL'} tray=${!!tray} trayWin=${state.trayLoaded} mainWin=${state.mainLoaded} consoleWin=${state.consoleLoaded} pty=${ptyMode} rendererErrors=${state.errors.length}`);
      state.errors.slice(0, 5).forEach((e) => console.log('  RENDER ERR:', e));
      quitting = true;
      app.exit(ok ? 0 : 1);
    }, 4000);
  }
});

app.on('window-all-closed', () => { /* 常駐継続 */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitting = true; bus.stop(); pi.dispose(); taskRunner.shutdown(); daemonClient?.disconnect(); ttsService?.stop(); cmuxBridge?.stop(); previewServer?.close(); relationshipService?.dispose?.(); comfy?.shutdown(); if (pty) try { pty.kill(); } catch (_) {} });
