'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bigkiji', {
  onBusEvent: (cb) => ipcRenderer.on('bus:event', (_e, evt) => cb(evt)),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  ptyInput: (data) => ipcRenderer.send('pty:input', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  openMain: () => ipcRenderer.send('open-main'),
  trayRender: (payload) => ipcRenderer.send('tray:render', payload),
  onDeliverables: (cb) => ipcRenderer.on('vault:deliverables', (_e, items) => cb(items)),
  onVaultFiles: (cb) => ipcRenderer.on('vault:files', (_e, files) => cb(files)),
  onVaultTouch: (cb) => ipcRenderer.on('vault:touch', (_e, paths) => cb(paths)),
  reveal: (p) => ipcRenderer.send('reveal', p),
  onComposerFocus: (cb) => ipcRenderer.on('composer:focus', () => cb()),
  micPermission: () => ipcRenderer.invoke('mic-permission'),
  saveRecording: (buf) => ipcRenderer.invoke('save-recording', buf),
  transcribe: (p) => ipcRenderer.invoke('transcribe', p),
  voiceToggle: () => ipcRenderer.invoke('voice:toggle'),
  getPathForFile: (file) => webUtils.getPathForFile(file), // D&D: Electron32+のFile.path代替
  piToggle: () => ipcRenderer.invoke('pi:toggle'),
  piPrompt: (text) => ipcRenderer.send('pi:prompt', text),
  piAbort: () => ipcRenderer.send('pi:abort'),
  onPiEvent: (cb) => ipcRenderer.on('pi:event', (_e, evt) => cb(evt)),
  onPiStats: (cb) => ipcRenderer.on('pi:stats', (_e, s) => cb(s)),
  getInfo: () => ipcRenderer.invoke('get-info'),
  // v12: LIVE COMMENTARY / Swarm可視化 / フルデュプレックス音声
  onCommentary: (cb) => ipcRenderer.on('bk:commentary', (_e, c) => cb(c)),
  onSwarm: (cb) => ipcRenderer.on('bk:swarm', (_e, s) => cb(s)),
  liveToggle: () => ipcRenderer.invoke('voice:live-toggle'),
  liveUtterance: (buf) => ipcRenderer.invoke('voice:live-utterance', buf),
  voiceInterrupt: () => ipcRenderer.send('voice:interrupt'),
  voiceState: (s) => ipcRenderer.send('voice:state', s),
  onLiveState: (cb) => ipcRenderer.on('voice:live-state', (_e, s) => cb(s)),
  onLiveOwn: (cb) => ipcRenderer.on('voice:live-own', (_e, s) => cb(s)),
  onTtsChunk: (cb) => ipcRenderer.on('voice:tts-chunk', (_e, c) => cb(c)),
});
