'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function createPathConfig({ appRoot, userData = '', env = process.env, saved = {} } = {}) {
  const root = path.resolve(expandHome(env.APP_ROOT) || appRoot || path.join(__dirname, '..', '..'));
  const uiRoot = expandHome(env.UI_ROOT || saved.uiRoot) || path.join(root, 'src', 'components', 'UI');
  const legacyVault = path.join(os.homedir(), 'Documents', 'CEOBigKiji');
  const portableVault = path.join(os.homedir(), 'Documents', 'BigKiji');
  const vaultRoot = firstExisting([
    env.BIGKIJI_VAULT_ROOT,
    saved.vaultRoot,
    legacyVault,
    portableVault,
  ], portableVault);
  const knowledgeRoot = expandHome(env.BIGKIJI_KNOWLEDGE_ROOT || env.KNOWLEDGE_ROOT || saved.knowledgeRoot)
    || path.join(userData || path.join(os.homedir(), '.bigkiji'), 'knowledge');
  const graphPath = expandHome(env.GRAPHIFY_GRAPH_PATH || saved.graphifyGraphPath)
    || path.join(vaultRoot, 'graphify-out', 'graph.json');
  return Object.freeze({
    appRoot: root,
    uiRoot,
    vaultRoot,
    knowledgeRoot,
    graphPath,
    recordingsRoot: path.join(userData || root, 'recordings'),
    comfyRoot: expandHome(env.COMFYUI_ROOT || saved.comfyRoot),
    whisperBin: executablePath(env.WHISPER_BIN || saved.whisperBin, 'whisper-cli'),
    whisperModel: expandHome(env.WHISPER_MODEL || saved.whisperModel)
      || path.join(os.homedir(), '.bigkiji', 'whisper', 'ggml-small.bin'),
    cmuxBin: executablePath(env.CMUX_BIN || saved.cmuxBin, 'cmux'),
    piBin: executablePath(env.PI_BIN || saved.piBin, 'pi'),
  });
}

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { createPathConfig, expandHome, isInside, executableDefault, executablePath };
