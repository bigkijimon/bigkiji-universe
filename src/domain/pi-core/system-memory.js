'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isSensitivePath } = require('./security/security-policy');

const MEMORY_VERSION = 2;
const DEFAULT_FILE = path.join(os.homedir(), '.bigkiji', 'system_memory.json');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.html', '.css', '.yml', '.yaml']);
const OMIT = /(?:^|\/)(?:node_modules|\.git|dist|build|recordings|graphify-out|\.obsidian)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/;
const EVENT_RE = /(?:emit|publish|broadcast|handle|on|addEventListener)\(\s*['"]([^'"]{2,80})['"]/g;
const SECRET_RE = /(?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*['"][^'"]+['"]/ig;

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function walk(root, limit = 5000) {
  const files = [];
  const visit = (directory) => {
    if (files.length >= limit) return;
    let entries = []; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit || entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (OMIT.test(relative) || isSensitivePath(absolute)) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name).toLowerCase())) files.push({ absolute, relative });
    }
  };
  visit(root); return files;
}

function buildSystemMemory({ appRoot, ownerProfile = {} } = {}) {
  const root = path.resolve(appRoot || path.join(__dirname, '..', '..', '..'));
  const files = walk(root); const events = new Set(); const entries = [];
  for (const file of files) {
    let text = ''; let stat; try { text = fs.readFileSync(file.absolute, 'utf8'); stat = fs.statSync(file.absolute); } catch (_) { continue; }
    const safe = text.replace(SECRET_RE, '$1=[REDACTED]'); let match;
    while ((match = EVENT_RE.exec(safe))) events.add(match[1]);
    if (/^#!|require\(['"]electron['"]\)|new (?:DaemonEngine|TaskRunner)|contextBridge\.exposeInMainWorld/.test(safe.slice(0, 1600))) entries.push(file.relative);
    file.digest = hash(`${file.relative}:${stat.size}:${stat.mtimeMs}:${safe.slice(0, 4096)}`).slice(0, 20);
  }
  const structureHash = hash(files.map((file) => `${file.relative}:${file.digest}`).join('\n'));
  return {
    version: MEMORY_VERSION, project: 'bigkiji-universe', generatedAt: new Date().toISOString(), structureHash,
    architecture: { daemon: 'http://127.0.0.1:8777', surfaces: ['CLI', 'cmux TUI', 'Electron', 'Mobile PWA'],
      fleet: ['Claude', 'Codex', 'Gemini', 'GLM', 'PiAgent Engine', 'Local Qwen'], entryPoints: entries.sort(), events: [...events].sort() },
    policies: { paidAllowlist: ['claude', 'codex', 'gemini', 'glm'], activation: 'on-demand', ownerApprovalForMutation: true,
      security: { mode: 'strict-direct', externalBeforeDisclosureApproval: false, modelWebSearch: 'broker-only', childEnvironment: 'minimal', unknownTools: 'deny' },
      localQwen: { defaultContextTokens: 6144, hardContextTokens: 8192, degradedContextTokens: 4096, taskTimeoutMs: 60000 } },
    ownerProfile: { visual: 'quiet floating glass with restrained color', response: 'fast, factual and evidence-backed',
      audio: 'English default, optional low-fatigue telephony filter', ...ownerProfile },
    knownFailurePatterns: ['goal-created-without-dispatch', 'stale-plan-approval', 'stale-disclosure-approval', 'duplicate-port-8777-listener', 'provider-timeout-or-expired-key', 'provider-started-with-inherited-environment'],
    files: files.map(({ relative, digest }) => ({ path: relative, digest })),
  };
}

function writeSystemMemory({ appRoot, file = DEFAULT_FILE, ownerProfile } = {}) {
  const next = buildSystemMemory({ appRoot, ownerProfile }); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prior = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } })();
  if (prior?.structureHash === next.structureHash && prior?.version === next.version) return { ...prior, unchanged: true };
  const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); return next;
}

module.exports = { MEMORY_VERSION, DEFAULT_FILE, buildSystemMemory, writeSystemMemory, walk };
