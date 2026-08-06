'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { defaultUserData, resolveDataRoot, dataLayout, findVaultCandidates } = require('./data-root');

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith(`~${path.sep}`) || raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function firstExisting(candidates, fallback) {
  return candidates.map(expandHome).find((candidate) => candidate && fs.existsSync(candidate)) || expandHome(fallback);
}

function executableDefault(name) {
  if (process.platform === 'win32') return `${name}.exe`;
  return name;
}

function executablePath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return executableDefault(fallback);
  if (!raw.includes('/') && !raw.includes('\\')) return raw;
  return expandHome(raw);
}

// The Obsidian vault belongs to the USER, not to the app: it is never migrated and
// never written to by us. Until V2.5 this resolver hardcoded one person's vault path
// as a default, so every fresh install inherited that person's folder layout. Now the
// only automatic source is generic detection — any directory containing `.obsidian/`.
function detectVault(env, saved, home) {
  const explicit = firstExisting([env.BIGKIJI_VAULT_ROOT, saved.vaultRoot], '');
  if (explicit) return explicit;
  const detected = findVaultCandidates(home);
  return detected[0] || path.join(home, 'Documents', 'BigKiji');
}

function createPathConfig({ appRoot, userData = '', dataRoot = '', env = process.env, saved = {}, home = os.homedir() } = {}) {
  const root = path.resolve(expandHome(env.APP_ROOT) || appRoot || path.join(__dirname, '..', '..'));
  const uiRoot = expandHome(env.UI_ROOT || saved.uiRoot) || path.join(root, 'src', 'components', 'UI');
  const resolvedUserData = userData || defaultUserData(process.platform, env, home);
  const resolved = dataRoot
    ? { dataRoot: path.resolve(expandHome(dataRoot)), overrides: {} }
    : resolveDataRoot({ userData: resolvedUserData, env, home });
  const layout = dataLayout(resolved.dataRoot, resolved.overrides || {});

  const vaultRoot = detectVault(env, saved, home);
  const knowledgeRoot = expandHome(env.BIGKIJI_KNOWLEDGE_ROOT || env.KNOWLEDGE_ROOT || saved.knowledgeRoot)
    || layout.knowledgeRoot;
  const graphPath = expandHome(env.GRAPHIFY_GRAPH_PATH || saved.graphifyGraphPath)
    || path.join(vaultRoot, 'graphify-out', 'graph.json');

  // Large local model blobs are opt-in during migration, so resolve them by probing
  // both the new home and the legacy one. This is a file-existence probe, not a
  // personal-path default: it keeps a 465 MB whisper model and a 1.4 GB TTS venv
  // working with zero movement.
  const legacyModels = path.join(home, '.bigkiji');
  const whisperModel = firstExisting([
    env.WHISPER_MODEL, saved.whisperModel,
    path.join(layout.modelsRoot, 'whisper', 'ggml-small.bin'),
    path.join(legacyModels, 'whisper', 'ggml-small.bin'),
  ], path.join(layout.modelsRoot, 'whisper', 'ggml-small.bin'));
  // The folder the owner shares with their phone. iCloud Drive is the only place both
  // ends can reach without a server, so the path is fixed rather than discovered —
  // but `saved` still wins, because a machine signed into a different iCloud account
  // would otherwise write into a folder that never syncs anywhere.
  const checkRoot = expandHome(saved.checkRoot)
    || path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'BigkijiUniverse-Check');

  const venvBin = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const ttsVenvPython = firstExisting([
    path.join(layout.modelsRoot, 'tts', 'venv', ...venvBin),
    path.join(legacyModels, 'tts', 'venv', ...venvBin),
  ], path.join(layout.modelsRoot, 'tts', 'venv', ...venvBin));

  return Object.freeze({
    ...layout, // spread first: the explicit values below must win over the derived ones
    appRoot: root,
    uiRoot,
    userData: resolvedUserData,
    vaultRoot,
    knowledgeRoot,
    graphPath,
    checkRoot,
    dataRootSource: resolved.source || 'explicit',
    dataRootMode: resolved.mode || 'own',
    whisperModel,
    ttsVenvPython,
    comfyRoot: expandHome(env.COMFYUI_ROOT || saved.comfyRoot),
    whisperBin: executablePath(env.WHISPER_BIN || saved.whisperBin, 'whisper-cli'),
    cmuxBin: executablePath(env.CMUX_BIN || saved.cmuxBin, 'cmux'),
    piBin: executablePath(env.PI_BIN || saved.piBin, 'pi'),
  });
}

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { createPathConfig, expandHome, isInside, executableDefault, executablePath, detectVault };
