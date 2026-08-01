'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, globalShortcut, systemPreferences, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
// v13: dotenv-expandで.env APIキーをprocess.envへ（model-routerが検知する）
const { expand } = require('dotenv-expand');
const dotenv = require('dotenv');
const APP_ROOT = path.resolve(__dirname, '..', '..');
expand(dotenv.config({ path: path.join(APP_ROOT, '.env') }));
const { createPathConfig, isInside } = require('./path-config');
let savedPaths = {};
try { savedPaths = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).paths || {}; } catch (_) {}
const PATHS = createPathConfig({ appRoot: APP_ROOT, userData: app.getPath('userData'), saved: savedPaths });
const UI_ROOT = PATHS.uiRoot;
if (!process.env.BIGKIJI_KNOWLEDGE_ROOT) process.env.BIGKIJI_KNOWLEDGE_ROOT = PATHS.knowledgeRoot;
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
const { DaemonClient } = require('../domain/server/daemon-client');
const { TailscaleRemoteAccess } = require('./tailscale-remote-access');
const facilitator = new fastRouter.FastFacilitatorRouter();
const APP_BUILD_ID = process.env.BIGKIJI_BUILD_ID || 'voice-cmux-local-qwen-v8';

const SMOKE = !!process.env.SMOKE;
const SNAP = process.env.SNAP || ''; // SNAP=<出力dir> で5秒後に両画面をPNG撮影して終了
const SHOW_MAIN = process.argv.includes('--show-main') || process.env.BIGKIJI_SHOW_MAIN === '1';
const E2E_FIXTURE = process.env.BIGKIJI_E2E_FIXTURE || '';
const bus = new Orchestrator();
const taskRunner = new TaskRunner({ cwd: PATHS.vaultRoot, vaultRoot: PATHS.vaultRoot, graphPath: PATHS.graphPath, maxParallel: 5 });
const fleetMetrics = new ModelStatusStore({ knowledge });
const relationshipService = new RelationshipSnapshotService({
  graphPath: PATHS.graphPath,
});

let tray = null;
let trayWin = null;
let mainWin = null;
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

let remote = null; // v12 リモートサーバ（whenReadyで起動・全broadcastをSSEへ中継）
function broadcast(channel, payload) {
  if (channel === 'pi:stats') fleetMetrics.ingestStats(payload);
  else if (channel === 'bk:swarm') fleetMetrics.ingestSwarm(payload);
  else if (channel === 'voice:live-state') fleetMetrics.ingestVoice(payload);
  else if (channel === 'vault:touch') fleetMetrics.ingestSync({ text: payload?.[0] || 'Vault sync' });
  for (const w of [trayWin, mainWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
  if (remote) remote.publish(channel, payload);
}
taskRunner.on('task', (task) => {
  fleetMetrics.ingestTask(task); broadcast('task:event', task);
  if (['running', 'completed', 'failed', 'awaiting_approval'].includes(String(task.status || ''))) {
    const label = String(task.agent || task.provider || 'Pi agent');
    speakAgent(`${label}. ${String(task.status).replaceAll('_', ' ')}. ${String(task.title || task.prompt || '').slice(0, 90)}`, label);
  }
});
taskRunner.on('log', (log) => broadcast('task:log', log));
fleetMetrics.on('update', (snapshot) => { broadcast('model:status:update', snapshot); broadcast('pi:fleet', snapshot); });
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

async function scanVaultFiles() {
  const out = [];
  const walk = async (dir, depth) => {
    if (out.length > 4200) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (VAULT_EXCLUDE.test(p)) continue;
      if (e.isDirectory()) { if (depth < 4) await walk(p, depth + 1); continue; }
      try {
        const st = await fs.promises.stat(p);
        const rel = p.slice(VAULT.length + 1);
        out.push({ p: rel, c: rel.split('/')[0], t: st.mtimeMs, size: st.size });
      } catch (_) {}
    }
  };
  await walk(VAULT, 0);
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
const touchQueue = new Set();
async function refreshVaultPaths(paths) {
  let changed = false;
  for (const raw of paths) {
    const rel = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || VAULT_EXCLUDE.test(rel) || rel.split('/').some((part) => part.startsWith('.'))) continue;
    const absolute = path.resolve(VAULT, rel);
    if (!absolute.startsWith(path.resolve(VAULT) + path.sep)) continue;
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
function startVaultWatch() {
  try {
    fs.watch(VAULT, { recursive: true }, (_ev, fname) => {
      if (!fname || VAULT_EXCLUDE.test(fname)) return;
      const base = path.basename(fname);
      if (base.startsWith('.') || base.endsWith('.tmp')) return;
      touchQueue.add(String(fname));
    });
  } catch (_) { return; }
  const flush = setInterval(() => {
    if (!touchQueue.size) return;
    const paths = [...touchQueue].slice(0, 6);
    touchQueue.clear();
    broadcast('vault:touch', paths);
    // Incremental metadata refresh avoids a 4,200-file rescan on every edit.
    refreshVaultPaths(paths).catch((error) => bus.push({ source: 'system', type: 'degrade', text: `Vault refresh failed: ${error.message}` }));
    for (const rel of paths.slice(0, 3)) {
      const agent = COMPANY_AGENT[rel.split('/')[0]] ?? null;
      bus.push({ source: 'vault', agent, type: 'fs', text: `✎ ${rel.slice(0, 110)}` });
    }
  }, 900);
  flush.unref();
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

// ---------- Tray ----------
function createTray() {
  tray = new Tray(nativeImage.createEmpty()); // バイナリ資産ゼロ：テキストTray
  tray.setTitle('❖');
  tray.setToolTip('BigKiji Universe OS');
  tray.on('click', toggleTrayWindow);
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
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
  if (text.replace(/[\s.,!?。、…]/g, '').length < 2) return { text: '', lang: r.lang }; // ノイズ/空は送らない
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
function whisperDetect(wav) {
  return new Promise((resolve) => {
    execFile(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '-dl'], { timeout: 30000 }, (_err, stdout, stderr) => {
      const m = (String(stderr) + String(stdout)).match(/detected language:\s*([a-z]{2})/i);
      const lang = m ? m[1].toLowerCase() : 'en';
      resolve(['en', 'ja', 'th'].includes(lang) ? lang : 'en');
    });
  });
}
function whisperTranscribe(wav) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WHISPER_MODEL)) {
      resolve({ error: 'whisper is not set up yet (model download pending)' });
      return;
    }
    whisperDetect(wav).then((lang) => {
      execFile(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '-l', lang, '-np', '-nt'],
        { timeout: 90000 }, (err2, stdout) => {
          if (err2) { resolve({ error: 'whisper failed: ' + err2.message }); return; }
          const text = String(stdout).replace(/\s+/g, ' ').trim();
          if (text) bus.push({ source: 'system', type: 'log', text: `🎙 STT(${lang}): ${text.slice(0, 120)}` });
          resolve({ text, lang });
        });
    });
  });
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
const ERRLOG_DIR = path.join(os.homedir(), '.bigkiji', 'logs');
const HEAL_DIR = path.join(PATHS.knowledgeRoot, 'repair-queue');
const toolFails = {};
const healedTools = new Set();
const healPending = [];
let healSent = 0;
function recordToolError(toolName, ms, argsStr) {
  try {
    fs.mkdirSync(ERRLOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(ERRLOG_DIR, 'tool-errors.jsonl'),
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
      `- Error log: \`~/.bigkiji/logs/tool-errors.jsonl\` (entries for tool=${toolName})`,
      '',
      '## Investigation instructions (Auto-Heal)',
      '1. Check the tool\'s current specification using primary sources (official docs/web search).',
      '2. Classify the failure: 429/quota already handled by degradation, type error, API change, or permission.',
      '3. Append a proposed code diff to this file. **Do not modify application code directly.**',
      '4. Apply only after owner/Claude Code review.',
      '',
      '## Delegation command',
      '```bash',
      `pi -p --session-id bigkiji-heal "Research why the tool '${toolName}' keeps failing (see ~/.bigkiji/logs/tool-errors.jsonl), check current specs via web/docs, and append a proposed fix to ${qfile}. Do NOT modify app code."`,
      '```',
      '',
    ].join('\n'));
    bus.push({ source: 'system', type: 'info', text: `⚕ Auto-Heal: ${toolName} failed 3× → repair task queued: ${path.basename(qfile)}` });
    healPending.push(`[AUTO-HEAL] The tool "${toolName}" failed ${toolFails[toolName]} times (details: ~/.bigkiji/logs/tool-errors.jsonl). Investigate the current spec of this tool, classify the failure, and append a proposed fix to ${qfile} using your write tool. Do NOT modify app code.`);
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
    daemonClient.prompt(String(text), { mode }).then((result) => {
      bus.push({ source: 'system', type: 'info', text: `Daemon run ${result.run.id} · ${result.run.assignments.length} on-demand models · ${result.run.status}` });
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
  model: 'qwen3.5:35b-a3b',
  knowledge,
  C,
  emit: { liveComment: (t, s) => liveComment(t, s), broadcast: (ch, p) => broadcast(ch, p) },
});
ipcMain.on('pi:prompt', (_e, text) => piSendPrompt(text));

// Approved parallel execution lanes. Planning is stored locally first; paid
// lanes cannot be started until an explicit owner approval arrives from UI.
ipcMain.handle('task:list', async () => daemonClient?.connected ? (await daemonClient.state()).tasks : taskRunner.snapshot());
ipcMain.handle('task:plan', (_e, spec) => taskRunner.plan(spec));
ipcMain.handle('task:prepare', (_e, spec) => taskRunner.prepare(spec));
ipcMain.handle('task:approve', (_e, id) => taskRunner.approve(String(id)));
ipcMain.handle('task:retry', (_e, id) => taskRunner.retry(String(id)));
ipcMain.handle('task:abort', (_e, id) => taskRunner.abort(String(id)));
ipcMain.handle('run:list', async () => daemonClient?.connected ? (await daemonClient.state()).runs : (coordinator?.snapshot() || []));
ipcMain.handle('run:approve', (_e, id) => daemonClient?.connected ? daemonClient.approve(String(id)) : coordinator.approve(String(id)));
ipcMain.handle('run:abort', (_e, id) => daemonClient?.connected ? daemonClient.abort(String(id)) : coordinator.abort(String(id)));
ipcMain.handle('session:list', async () => daemonClient?.connected ? (await daemonClient.sessions()).sessions : []);
ipcMain.handle('session:get', async (_e, id) => daemonClient?.connected ? daemonClient.session(String(id)) : null);
ipcMain.handle('remote:access', async (_e, ensure = false) => remoteAccess?.status({ ensure: !!ensure }) || ({ state: 'unavailable', ready: false }));
ipcMain.handle('knowledge:state', () => knowledge.loadState());
ipcMain.handle('fleet:snapshot', () => fleetMetrics.snapshot());
ipcMain.handle('model:status:snapshot', () => fleetMetrics.snapshot());
ipcMain.handle('relationship:snapshot', () => relationshipService.snapshot());
ipcMain.handle('fast-router:status', async () => ({ priority: fastRouter.PRIORITY, available: await fastRouter.detect() }));
ipcMain.handle('preview:status', () => previewServer?.snapshot() || ({ running: false }));
ipcMain.handle('preview:start', () => previewServer?.start() || ({ running: false }));
ipcMain.handle('preview:stop', () => { previewServer?.close(); const state = previewServer?.snapshot() || ({ running: false }); broadcast('preview:status', state); return state; });
ipcMain.handle('settings:get', () => settingsStore?.get());
ipcMain.handle('settings:update', (_event, patch) => {
  const before = settingsStore.get(); const next = settingsStore.update(patch || {});
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
  broadcast('settings:changed', next);
  return next;
});
ipcMain.handle('settings:secret', (_event, id, value) => settingsStore.setSecret(String(id), String(value || '')));
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

ipcMain.on('reveal', (_e, p) => {
  if (typeof p === 'string' && isInside(VAULT, p)) shell.showItemInFolder(p); // Vault内のみ許可
});
ipcMain.handle('file:detail', async (_e, relPath) => {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = path.resolve(VAULT, rel);
  const root = path.resolve(VAULT) + path.sep;
  if (!absolute.startsWith(root) || VAULT_EXCLUDE.test(absolute)) throw new Error('File is outside the BigKiji Vault');
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
    preview: previewServer?.snapshot() || { running: false },
    buildId: APP_BUILD_ID,
    paths: { appRoot: APP_ROOT, vaultRoot: VAULT, knowledgeRoot: PATHS.knowledgeRoot, graphPath: PATHS.graphPath },
    costPolicy: { planning: ['qwen-local'], paid: ['claude', 'codex', 'gemini', 'glm'], localOperators: ['qwen'], blocked: ['kimi', 'openrouter', 'openai-tts', 'elevenlabs'] },
    ...bus.snapshot() };
});

// ---------- ライフサイクル ----------
app.whenReady().then(async () => {
  settingsStore = new SettingsStore({ userData: app.getPath('userData'), safeStorage });
  remoteAccess = new TailscaleRemoteAccess({ port: 8777 });
  if (!SMOKE) {
    try {
      daemonClient = new DaemonClient({ appRoot: APP_ROOT, workspace: PATHS.vaultRoot });
      const daemon = await daemonClient.ensure({ timeoutMs: 8000 });
      daemonState = await daemonClient.state();
      const channelMap = { task: 'task:event', tasklog: 'task:log', run: 'run:event', models: 'model:status:update',
        fleet: 'pi:fleet', commentary: 'bk:commentary', phase: 'phase:update', session: 'session:update', pi: 'pi:event', stats: 'pi:stats' };
      daemonClient.on('event', ({ event, data }) => {
        if (event === 'state') { daemonState = data; broadcast('daemon:state', data); return; }
        const channel = channelMap[event]; if (channel) broadcast(channel, data);
        if (event === 'run') daemonState = { ...(daemonState || {}), runs: [...(daemonState?.runs || []).filter((run) => run.id !== data.id), data] };
      });
      daemonClient.connect();
      bus.push({ source: 'system', type: 'info', text: `${daemon.started ? 'Started' : 'Attached to'} standalone BigKiji Core Engine · 127.0.0.1:8777` });
    } catch (error) {
      daemonClient = null;
      bus.push({ source: 'system', type: 'warn', text: `Standalone daemon unavailable: ${error.message} · in-app core remains active` });
    }
  }
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
  coordinator = new CoreExecutionCoordinator({ taskRunner, settingsProvider: () => settingsStore.get(), preview: previewServer });
  coordinator.on('run', (event) => { fleetMetrics.ingestRun(event); broadcast('run:event', event); });
  fastRouter.detect().then((availability) => fleetMetrics.setAvailability(availability)).catch(() => {});
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
  ttsService = new NaturalTTSService({ appRoot: APP_ROOT, userData: app.getPath('userData'), settingsStore });
  ttsService.on('status', (status) => broadcast('voice:engine-status', status));
  ttsService.on('log', (text) => text && bus.push({ source: 'system', type: 'info', text: `TTS: ${String(text).slice(0, 180)}` }));
  // Local neural TTS is intentionally lazy: first speech wakes it, idle timeout closes it.
  cmuxBridge = new CmuxBridge({ settingsStore, defaultBin: PATHS.cmuxBin });
  cmuxBridge.on('snapshot', (snapshot) => broadcast('cmux:snapshot', snapshot));
  cmuxBridge.start();
  comfy = new ComfyUIMediaBridge({ root: PATHS.comfyRoot || undefined, outputDir: path.join(app.getPath('userData'), 'generated-media') });
  comfy.on('event', (event) => broadcast('comfy:event', event));
  if (process.platform === 'darwin' && !SMOKE && !SNAP && !SHOW_MAIN) app.dock.hide(); // 通常時のみメニューバー常駐
  createTray();
  createTrayWindow();
  if (SMOKE || SNAP || SHOW_MAIN) createMainWindow(); // --show-main は再起動後のCanvas確認・直接起動用
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

  // v12 リモートサーバ（iPhone PWA / bigkiji CLI の同期エンジン）。SMOKE時は起動しない
  if (!SMOKE && !daemonClient?.connected) {
    try {
      remote = require('./remote-server').start({
        appDir: APP_ROOT,
        piSendPrompt: (text) => piSendPrompt(text),
        piAbort: () => pi.abort(),
        approveRun: (id) => coordinator.approve(id),
        abortRun: (id) => coordinator.abort(id),
        handleUtterance,
        getState: () => ({
          ...bus.snapshot(), piRunning: pi.running, model: pi.model, voiceOn,
          live: liveVoice.active, vaultCount: vaultFiles.length,
          deliverables: latestDeliverables.slice(0, 6).map((d) => ({ name: d.name, company: d.company, ts: d.ts })),
        }),
        log: (t) => bus.push({ source: 'system', type: 'info', text: t }),
      });
    } catch (err) {
      bus.push({ source: 'system', type: 'info', text: `remote server failed: ${String(err.message).slice(0, 120)}` });
    }
  }

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
      setTimeout(() => mainWin?.webContents.executeJavaScript('window.BKSettings?.open()').catch(() => {}), 3200);
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
    const state = {
      trayLoaded: !!trayWin && !trayWin.webContents.isLoadingMainFrame(),
      mainLoaded: !!mainWin && !mainWin.webContents.isLoadingMainFrame(),
      errors: [],
    };
    trayWin.webContents.once('did-finish-load', () => { state.trayLoaded = true; });
    mainWin.webContents.once('did-finish-load', () => { state.mainLoaded = true; });
    for (const [name, w] of [['tray', trayWin], ['main', mainWin]]) {
      w.webContents.on('did-fail-load', (_event, code, description) => state.errors.push(`${name}: load ${code} ${description}`));
      w.webContents.on('console-message', (event) => {
        if (Number(event?.level) >= 3) state.errors.push(`${name}: ${event.message}`);
      });
    }
    setTimeout(() => {
      const ok = !!tray && state.trayLoaded && state.mainLoaded && ptyMode !== 'none' && state.errors.length === 0;
      console.log(`${ok ? 'SMOKE OK' : 'SMOKE FAIL'} tray=${!!tray} trayWin=${state.trayLoaded} mainWin=${state.mainLoaded} pty=${ptyMode} rendererErrors=${state.errors.length}`);
      state.errors.slice(0, 5).forEach((e) => console.log('  RENDER ERR:', e));
      quitting = true;
      app.exit(ok ? 0 : 1);
    }, 4000);
  }
});

app.on('window-all-closed', () => { /* 常駐継続 */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitting = true; bus.stop(); pi.stop(); taskRunner.shutdown(); daemonClient?.disconnect(); ttsService?.stop(); cmuxBridge?.stop(); previewServer?.close(); relationshipService?.dispose?.(); comfy?.shutdown(); if (pty) try { pty.kill(); } catch (_) {} });
