'use strict';
// Local tool connection registry.
//
// BigKiji never bundles, copies or installs a tool. Model weights and virtualenvs run to
// gigabytes; keeping the app light means the tools stay exactly where the owner already
// put them and we only remember where that is. This module answers two questions, and
// keeps them strictly apart:
//
//   1. "Is it on this machine, and where?"   -> detectAll(), SYNCHRONOUS and cheap
//      (existsSync/statSync only, so opening Settings is instant).
//   2. "Is it answering right now?"          -> probe(), ASYNCHRONOUS, always resolves,
//      always bounded by a timeout. A dead port must never hang the settings screen.
//
// The two answers are three states, not one boolean:
//   missing    nothing at the resolved path
//   found      it is installed, but its health was not (or could not be) verified
//   connected  a health check ran and answered
// "found" is the honest answer for an installed-but-not-running tool, and it must not be
// collapsed into "connected". A status is never promoted without evidence: a probe that
// has not run reports "not checked", never "connected".
//
// Pure Node on purpose — no electron import — so the standalone daemon and the CLI can
// load this too.

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { findVaultCandidates } = require('../../core/data-root');

const PROBE_TIMEOUT_MS = 1200;
// A graphify graph has been 676 MB in this workspace before it was pruned. Parsing that
// to colour a status badge is not acceptable, so refuse rather than stall.
const MAX_GRAPH_BYTES = 128 * 1024 * 1024;
// Health documents are small, but Ollama's model inventory is not: truncating before
// JSON.parse turned a healthy runtime into "answered but not as expected".
const MAX_BODY_CHARS = 512 * 1024;

const STATUS = Object.freeze({ CONNECTED: 'connected', FOUND: 'found', MISSING: 'missing' });
// `http` describes a tool that exists only as an endpoint and has no on-disk anchor;
// the settings screen renders an endpoint field for it instead of a file chooser. Every
// tool known today has an anchor, so the shipped table uses the other three.
const KINDS = Object.freeze(['http', 'binary', 'directory', 'file']);

function expandPath(value, home = os.homedir()) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith(`~${path.sep}`)) return path.join(home, raw.slice(2));
  return path.resolve(raw);
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch (_) { return false; }
}
function isDir(target) {
  try { return fs.statSync(target).isDirectory(); } catch (_) { return false; }
}
function sizeOf(target) {
  try { return fs.statSync(target).size; } catch (_) { return 0; }
}
function mb(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }

// A GUI app launched from Finder inherits a minimal PATH — often just /usr/bin:/bin —
// so the conventional install directories are searched as well. These are absolute and
// belong to the real machine, which is why a caller inspecting a fabricated home (the
// selftest) passes an empty list. Both checks are statSync only.
const SYSTEM_BIN_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);

function binDirs(home, systemBinDirs) {
  return [...systemBinDirs,
    path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, 'bin')];
}

function lookupOnPath(names, ctx) {
  const { env, home } = ctx;
  const dirs = [...String(env.PATH || '').split(path.delimiter).filter(Boolean), ...binDirs(home, ctx.systemBinDirs)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return '';
}

// Bounded breadth-first search for a single filename. Used instead of hardcoding one
// person's folder layout: the owner's GPU arbitration script sits several levels inside
// their vault under a localised directory name, and a third party will have neither.
function findShallow(root, filename, { maxDepth = 3, maxDirs = 240 } = {}) {
  if (!isDir(root)) return '';
  let visited = 0;
  let frontier = [[root, 0]];
  while (frontier.length) {
    const next = [];
    for (const [dir, depth] of frontier) {
      if (visited++ > maxDirs) return '';
      const candidate = path.join(dir, filename);
      if (isFile(candidate)) return candidate;
      if (depth >= maxDepth) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        next.push([path.join(dir, entry.name), depth + 1]);
      }
    }
    frontier = next;
  }
  return '';
}

// Vault detection is generic and already exists — `.obsidian/` is the marker. It is
// reused rather than reimplemented, and no particular vault path is ever assumed.
function vaultRoots(ctx) {
  if (!ctx._vaults) ctx._vaults = findVaultCandidates(ctx.home);
  const explicit = [expandPath(ctx.env.BIGKIJI_VAULT_ROOT, ctx.home), expandPath(ctx.saved.vaultRoot, ctx.home)];
  return [...explicit, ...ctx._vaults].filter(Boolean);
}

function readJsonBody(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ---- the table -------------------------------------------------------------
// `settingKey` is relative to `settings.paths`. Three tools deliberately reuse a key
// that already exists rather than owning a `tools.<id>` entry, because a second key for
// the same thing is a second source of truth that can disagree with the first:
//   comfyui       -> paths.comfyRoot          read by path-config.js and the ComfyUI bridge
//   obsidian      -> paths.vaultRoot          read by path-config.js
//   graphifyGraph -> paths.graphifyGraphPath  read by path-config.js
const TOOLS = Object.freeze([
  {
    id: 'comfyui',
    label: 'ComfyUI',
    kind: 'directory',
    settingKey: 'comfyRoot',
    purpose: 'Local image and 3D asset generation.',
    env: ['COMFYUI_ROOT'],
    candidates: (ctx) => [path.join(ctx.home, 'Documents', 'ComfyUI'), path.join(ctx.home, 'ComfyUI')],
    probe: {
      type: 'http',
      urls: ['http://127.0.0.1:8000/system_stats', 'http://127.0.0.1:8188/system_stats'],
      accept: (body, response, url) => {
        const json = readJsonBody(body);
        if (!json || !json.system) return '';
        return `ComfyUI ${json.system.comfyui_version || 'running'} at ${new URL(url).host}`;
      },
    },
  },
  {
    id: 'acestep',
    label: 'ACE-Step',
    kind: 'directory',
    settingKey: 'tools.acestep',
    purpose: 'Local music and song generation.',
    env: ['ACESTEP_ROOT', 'ACE_STEP_ROOT'],
    // The owner's own skill file still records a path under MusicStudioKakao that no
    // longer exists, so detection deliberately never consults it.
    candidates: (ctx) => [path.join(ctx.home, 'Documents', 'ACE-Step'), path.join(ctx.home, 'ACE-Step')],
    probe: {
      type: 'http',
      urls: ['http://127.0.0.1:8001/'],
      // ACE-Step serves a Gradio UI, not a documented health document. Any HTTP answer
      // proves the server is up; nothing more is claimed than that.
      accept: (body, response, url) => (response.status < 500 ? `Server answering at ${new URL(url).host}` : ''),
    },
  },
  {
    id: 'ltx2',
    label: 'LTX-2',
    kind: 'directory',
    settingKey: 'tools.ltx2',
    purpose: 'Local video generation.',
    env: ['LTX2_ROOT'],
    candidates: (ctx) => [path.join(ctx.home, 'Documents', 'LTX-2'), path.join(ctx.home, 'LTX-2')],
    // Driven as a batch job, not a resident server: there is nothing to health-check,
    // and inventing an endpoint for it would be inventing health.
    probe: null,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'binary',
    settingKey: 'tools.ollama',
    purpose: 'Local model runtime for PiAgent and conversation.',
    env: ['OLLAMA_BIN'],
    binaries: ['ollama'],
    candidates: () => [],
    probe: {
      type: 'http',
      urls: ['http://127.0.0.1:11434/api/tags'],
      accept: (body) => {
        const json = readJsonBody(body);
        if (!json || !Array.isArray(json.models)) return '';
        return `${json.models.length} local model${json.models.length === 1 ? '' : 's'} on 127.0.0.1:11434`;
      },
    },
  },
  {
    id: 'n8n',
    label: 'n8n',
    kind: 'directory',
    settingKey: 'tools.n8n',
    purpose: 'Workflow automation for scheduled operations.',
    env: ['N8N_ROOT'],
    candidates: (ctx) => [path.join(ctx.home, 'Documents', 'n8n'), path.join(ctx.home, '.n8n')],
    probe: {
      type: 'http',
      urls: ['http://127.0.0.1:5678/healthz'],
      accept: (body) => {
        const json = readJsonBody(body);
        return json && json.status === 'ok' ? 'Editor answering on 127.0.0.1:5678' : '';
      },
    },
  },
  {
    id: 'obsidian',
    label: 'Obsidian vault',
    kind: 'directory',
    settingKey: 'vaultRoot',
    purpose: 'The knowledge vault BigKiji reads. Never written to, never moved.',
    env: ['BIGKIJI_VAULT_ROOT'],
    candidates: (ctx) => vaultRoots(ctx),
    // A vault is any directory holding `.obsidian/`. That marker check is the whole
    // verification and it is a cheap statSync, so it runs during detection.
    verify: (target) => (isDir(path.join(target, '.obsidian'))
      ? { status: STATUS.CONNECTED, detail: 'Vault marker .obsidian present — read-only to BigKiji' }
      : { status: STATUS.FOUND, detail: 'Directory exists but holds no .obsidian marker' }),
    probe: null,
  },
  {
    id: 'graphify',
    label: 'Graphify CLI',
    kind: 'binary',
    settingKey: 'tools.graphify',
    purpose: 'Builds and updates the codebase knowledge graph.',
    env: ['GRAPHIFY_BIN'],
    binaries: ['graphify'],
    candidates: () => [],
    probe: { type: 'exec', args: ['--version'] },
  },
  {
    id: 'graphifyGraph',
    label: 'Graphify graph.json',
    kind: 'file',
    settingKey: 'graphifyGraphPath',
    purpose: 'The generated graph BigKiji queries for structure.',
    env: ['GRAPHIFY_GRAPH_PATH'],
    candidates: (ctx) => vaultRoots(ctx).map((root) => path.join(root, 'graphify-out', 'graph.json')),
    // Parsing several megabytes of JSON is far too slow for the settings screen, so
    // detection only stats the file and the async probe does the parse.
    probe: { type: 'graph' },
  },
  {
    id: 'gpuSignal',
    label: 'GPU arbitration script',
    kind: 'binary',
    settingKey: 'tools.gpuSignal',
    purpose: 'Serialises GPU jobs so two generators never collide.',
    optional: true,
    env: ['BIGKIJI_GPU_SIGNAL'],
    candidates: (ctx) => vaultRoots(ctx)
      .map((root) => findShallow(root, 'gpu-signal.sh'))
      .filter(Boolean),
    // Running it would queue or thaw real jobs, so there is no probe: presence on disk
    // is all BigKiji claims to know.
    probe: null,
  },
].map((tool) => Object.freeze({ ...tool, optional: !!tool.optional })));

const TOOL_IDS = Object.freeze(TOOLS.map((tool) => tool.id));
// Ids stored inside `settings.paths.tools`. Anything else in that object is unknown.
const TOOL_PATH_IDS = Object.freeze(TOOLS.filter((tool) => tool.settingKey.startsWith('tools.')).map((tool) => tool.id));
// Ids whose value belongs in an existing dedicated `settings.paths.*` key. A value found
// under `paths.tools.<id>` folds into the dedicated key instead of shadowing it.
const TOOL_SETTING_ALIASES = Object.freeze(Object.fromEntries(
  TOOLS.filter((tool) => !tool.settingKey.startsWith('tools.')).map((tool) => [tool.id, tool.settingKey])));

function findTool(id) { return TOOLS.find((tool) => tool.id === String(id)) || null; }

function savedValue(tool, saved) {
  if (!saved || typeof saved !== 'object') return '';
  if (!tool.settingKey.startsWith('tools.')) return saved[tool.settingKey];
  const bucket = saved.tools;
  return bucket && typeof bucket === 'object' ? bucket[tool.id] : '';
}

// Resolution order: environment override, saved setting, conventional install paths,
// then PATH for binaries. The first two are the owner speaking explicitly, so they are
// honoured even when the target is gone — reporting "missing" for a path someone chose
// is more useful than silently falling back and hiding the mistake.
function resolvePath(tool, ctx) {
  for (const name of tool.env || []) {
    const value = expandPath(ctx.env[name], ctx.home);
    if (value) return { path: value, source: `env ${name}` };
  }
  const saved = expandPath(savedValue(tool, ctx.saved), ctx.home);
  if (saved) return { path: saved, source: 'settings' };
  for (const candidate of tool.candidates(ctx) || []) {
    const value = expandPath(candidate, ctx.home);
    if (value && (isDir(value) || isFile(value))) return { path: value, source: 'detected' };
  }
  if (tool.binaries) {
    const found = lookupOnPath(tool.binaries, ctx);
    if (found) return { path: found, source: 'PATH' };
  }
  return { path: '', source: '' };
}

function detectOne(tool, ctx) {
  const { path: resolved, source } = resolvePath(tool, ctx);
  const base = {
    id: tool.id,
    label: tool.label,
    kind: tool.kind,
    settingKey: tool.settingKey,
    purpose: tool.purpose,
    optional: tool.optional,
    probe: !!tool.probe,
    source,
    checked: false,
  };
  const present = tool.kind === 'directory' ? isDir(resolved) : isFile(resolved);
  if (!resolved || !present) {
    return {
      ...base,
      status: STATUS.MISSING,
      path: resolved,
      detail: resolved
        ? `Configured path does not exist: ${resolved}`
        : (tool.optional ? 'Not present on this machine. This tool is optional.' : 'Not found. Choose it if it is installed elsewhere.'),
    };
  }
  if (tool.verify) {
    const verdict = tool.verify(resolved);
    return { ...base, status: verdict.status, path: resolved, detail: verdict.detail, checked: true };
  }
  const size = tool.kind === 'file' ? sizeOf(resolved) : 0;
  return {
    ...base,
    status: STATUS.FOUND,
    path: resolved,
    detail: tool.probe
      ? `Present${size ? ` · ${mb(size)}` : ''} · health not checked yet`
      : `Present${size ? ` · ${mb(size)}` : ''} · no health check exists for this tool`,
  };
}

// Synchronous by contract. Never awaits, never opens a socket.
//   env            process.env or a fake for tests
//   home           the user's home directory
//   saved          the `settings.paths` object
//   systemBinDirs  absolute directories searched on top of PATH; pass [] to keep a test
//                  entirely inside a fabricated home
function detectAll({ env = process.env, home = os.homedir(), saved = {}, systemBinDirs = SYSTEM_BIN_DIRS } = {}) {
  const ctx = { env: env || {}, home, saved: saved || {}, systemBinDirs: systemBinDirs || [] };
  return TOOLS.map((tool) => detectOne(tool, ctx));
}

// ---- probes ----------------------------------------------------------------
function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
    promise.then((value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    }, () => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(onTimeout());
    });
  });
}

async function httpProbe(spec, timeoutMs) {
  const fetchImpl = global.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, detail: 'No HTTP client available in this runtime' };
  const attempts = await Promise.all(spec.urls.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json,*/*' } });
      const body = (await response.text()).slice(0, MAX_BODY_CHARS);
      const detail = spec.accept(body, response, url);
      return detail ? { ok: true, detail } : { ok: false, detail: `${new URL(url).host} answered ${response.status} but not as expected` };
    } catch (_) {
      return { ok: false, detail: `No answer from ${new URL(url).host}` };
    } finally { clearTimeout(timer); }
  }));
  return attempts.find((attempt) => attempt.ok) || attempts[0] || { ok: false, detail: 'No endpoint configured' };
}

function execProbe(target, spec, timeoutMs) {
  return new Promise((resolve) => {
    execFile(target, spec.args, { timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout, stderr) => {
        const text = String(stdout || stderr || '').trim().split(/\r?\n/)[0] || '';
        if (error && !text) return resolve({ ok: false, detail: `Did not respond to ${spec.args.join(' ')}` });
        resolve({ ok: true, detail: text.slice(0, 120) });
      });
  });
}

async function graphProbe(target) {
  const size = sizeOf(target);
  if (!size) return { ok: false, detail: 'File is empty or unreadable' };
  if (size > MAX_GRAPH_BYTES) return { ok: false, detail: `${mb(size)} is too large to verify — regenerate a pruned graph` };
  let json = null;
  try { json = JSON.parse(await fsp.readFile(target, 'utf8')); } catch (_) { return { ok: false, detail: `${mb(size)} present but does not parse as JSON` }; }
  const nodes = json && Array.isArray(json.nodes) ? json.nodes.length : 0;
  if (!nodes) return { ok: false, detail: `${mb(size)} parsed but holds no nodes` };
  // graphify writes its relations under `links`; `edges` is accepted for older graphs.
  const link = json && (Array.isArray(json.links) ? json.links : json.edges);
  const links = Array.isArray(link) ? link.length : 0;
  return { ok: true, detail: `${nodes.toLocaleString('en-US')} nodes · ${links.toLocaleString('en-US')} links · ${mb(size)}` };
}

// Never throws and never runs longer than `timeoutMs`. `tool` may be an id, a registry
// entry or a detectAll() row; a row carries the resolved path, otherwise pass one in.
async function probe(tool, { timeoutMs = PROBE_TIMEOUT_MS, path: target } = {}) {
  const row = typeof tool === 'string' ? findTool(tool) : (tool || null);
  const id = row ? row.id : String(tool || '');
  const descriptor = (row && row.probe && typeof row.probe === 'object') ? row : findTool(id);
  const spec = descriptor ? descriptor.probe : null;
  const resolved = expandPath(target || (row && row.path) || '');
  const fallbackStatus = resolved && (isDir(resolved) || isFile(resolved)) ? STATUS.FOUND : STATUS.MISSING;
  const startedAt = Date.now();
  const done = (result) => ({
    id,
    ok: !!result.ok,
    checked: result.checked !== false,
    status: result.ok ? STATUS.CONNECTED : fallbackStatus,
    detail: result.detail,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  });
  if (!descriptor) return done({ ok: false, checked: false, detail: 'Unknown tool' });
  if (!spec || !spec.type) return done({ ok: false, checked: false, detail: 'No health check exists for this tool' });
  try {
    const timedOut = () => ({ ok: false, detail: `No answer within ${timeoutMs} ms` });
    if (spec.type === 'http') return done(await withTimeout(httpProbe(spec, timeoutMs), timeoutMs + 150, timedOut));
    if (!resolved) return done({ ok: false, detail: 'Nothing to check — no path is resolved' });
    if (spec.type === 'exec') return done(await withTimeout(execProbe(resolved, spec, timeoutMs), timeoutMs + 150, timedOut));
    if (spec.type === 'graph') return done(await withTimeout(graphProbe(resolved), timeoutMs, timedOut));
    return done({ ok: false, checked: false, detail: `Unsupported probe type ${spec.type}` });
  } catch (error) {
    // Belt and braces: a probe failure is a status, never an exception the UI must catch.
    return done({ ok: false, detail: `Health check failed: ${String(error && error.message || error).slice(0, 120)}` });
  }
}

// Detect, then probe everything that has a probe, in parallel and bounded.
async function detectAndProbeAll({ env, home, saved, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const rows = detectAll({ env, home, saved });
  return Promise.all(rows.map(async (row) => {
    if (!row.probe || row.status === STATUS.MISSING) return row;
    const result = await probe(row, { timeoutMs });
    return { ...row, ...result };
  }));
}

module.exports = {
  TOOLS,
  TOOL_IDS,
  TOOL_PATH_IDS,
  TOOL_SETTING_ALIASES,
  STATUS,
  KINDS,
  PROBE_TIMEOUT_MS,
  detectAll,
  detectAndProbeAll,
  probe,
  findTool,
  expandPath,
  findShallow,
};
