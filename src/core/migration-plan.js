'use strict';
// The whitelist of things BigKiji Universe may relocate into its own data root,
// plus a PURE planner (stat only, zero side effects) that the setup wizard renders.
//
// Deliberately a whitelist and not "move ~/.bigkiji": that directory also holds the
// owner's unrelated shell automation (coco_autopilot.sh, gpu_filler.sh, ollama-*.sh,
// services_healthcheck.sh, setup-grunt.sh, qwen3.5-grunt.Modelfile). Those are not
// ours to move, so the directory itself survives a migration untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');

// group: 'state'  — small, always offered, default ON
// group: 'models' — large local model blobs, default OFF (see the venv warning below)
// copyOnly       — merge a copy and leave the original in place, because another tool
//                  may still read it and we have not proven otherwise
function entryTable({ layout, home = os.homedir(), userData }) {
  const legacy = path.join(home, '.bigkiji');
  const piKnowledge = path.join(home, '.pi', 'agent', 'knowledge', 'bigkiji-universe');
  return [
    { id: 'system-memory', group: 'state', kind: 'file', mode: 0o600, src: path.join(legacy, 'system_memory.json'), dst: layout.systemMemoryFile },
    { id: 'remote-config', group: 'state', kind: 'file', mode: 0o600, src: path.join(legacy, 'remote.json'), dst: layout.remoteConfigFile },
    { id: 'mobile-devices', group: 'state', kind: 'file', mode: 0o600, src: path.join(legacy, 'mobile-devices.json'), dst: layout.mobileDevicesFile },
    { id: 'cli-config', group: 'state', kind: 'file', src: path.join(legacy, 'config.json'), dst: layout.cliConfigFile },
    { id: 'sessions', group: 'state', kind: 'dir', src: path.join(legacy, 'sessions'), dst: layout.sessionsRoot },
    { id: 'ideas', group: 'state', kind: 'dir', src: path.join(legacy, 'ideas'), dst: layout.ideasRoot },
    { id: 'logs', group: 'state', kind: 'dir', src: path.join(legacy, 'logs'), dst: layout.logsRoot },
    { id: 'reports', group: 'state', kind: 'dir', src: path.join(legacy, 'reports'), dst: layout.reportsRoot },
    { id: 'knowledge-userdata', group: 'state', kind: 'dir', src: path.join(userData, 'knowledge'), dst: layout.knowledgeRoot },
    // The `pi` CLI owns ~/.pi/agent/. We created the bigkiji-universe subdirectory, but
    // until it is proven that pi never reads it, merge a copy and keep the original.
    { id: 'knowledge-pi', group: 'state', kind: 'dir', copyOnly: true, src: piKnowledge, dst: layout.knowledgeRoot,
      note: 'Merged as a copy; the original is left in place because ~/.pi belongs to the pi CLI.' },
    { id: 'recordings', group: 'state', kind: 'dir', src: path.join(userData, 'recordings'), dst: layout.recordingsRoot },
    { id: 'generated-media', group: 'state', kind: 'dir', src: path.join(userData, 'generated-media'), dst: layout.generatedMediaRoot },
    { id: 'tts-cache', group: 'state', kind: 'dir', src: path.join(userData, 'tts-cache'), dst: layout.ttsCacheRoot },
    { id: 'whisper-model', group: 'models', kind: 'dir', src: path.join(legacy, 'whisper'), dst: path.join(layout.modelsRoot, 'whisper') },
    // A Python venv bakes absolute paths into pyvenv.cfg, the bin/python symlinks and
    // every console-script shebang. Moving it breaks TTS silently, so it is offered
    // last, off by default, and the wizard must surface this warning verbatim.
    { id: 'tts-venv', group: 'models', kind: 'dir', src: path.join(legacy, 'tts'), dst: path.join(layout.modelsRoot, 'tts'),
      warning: 'A Python virtualenv stores absolute paths. Moving it will break text-to-speech until the venv is re-created at the new location.' },
  ];
}

function measure(target) {
  let stat = null;
  try { stat = fs.lstatSync(target); } catch (_) { return { exists: false, bytes: 0, files: 0 }; }
  if (!stat.isDirectory()) return { exists: true, bytes: stat.size, files: 1 };
  let bytes = 0; let files = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(child); continue; }
      files += 1;
      try { bytes += fs.lstatSync(child).size; } catch (_) {}
    }
  }
  return { exists: true, bytes, files };
}

function deviceOf(target) {
  let probe = path.resolve(target);
  for (let depth = 0; depth < 64; depth += 1) {
    try { return fs.statSync(probe).dev; } catch (_) {}
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return null;
}

// Pure. Stats the filesystem, mutates nothing. This is what the wizard renders and
// what executeMigration() consumes, so the preview and the run can never disagree.
function planMigration({ layout, home = os.homedir(), userData, includeModels = false } = {}) {
  const entries = [];
  for (const entry of entryTable({ layout, home, userData })) {
    if (entry.group === 'models' && !includeModels) continue;
    const size = measure(entry.src);
    if (!size.exists || (size.files === 0 && size.bytes === 0 && entry.kind === 'dir')) continue;
    if (path.resolve(entry.src) === path.resolve(entry.dst)) continue;
    entries.push({
      ...entry,
      bytes: size.bytes,
      files: size.files,
      sameVolume: deviceOf(entry.src) !== null && deviceOf(entry.src) === deviceOf(path.dirname(entry.dst)),
      conflict: fs.existsSync(entry.dst),
      strategy: 'pending',
      state: 'pending',
    });
  }
  entries.sort((a, b) => a.bytes - b.bytes); // cheap failures surface first
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const totalFiles = entries.reduce((sum, entry) => sum + entry.files, 0);
  return {
    entries,
    totalBytes,
    totalFiles,
    crossVolume: entries.some((entry) => !entry.sameVolume),
    groups: {
      state: entries.filter((entry) => entry.group === 'state').reduce((sum, entry) => sum + entry.bytes, 0),
      models: entries.filter((entry) => entry.group === 'models').reduce((sum, entry) => sum + entry.bytes, 0),
    },
  };
}

// Reference mode: nothing moves. Record the legacy absolute path per root so
// dataLayout() keeps resolving to where the data already is.
function referenceOverrides({ layout, home = os.homedir(), userData } = {}) {
  const byId = {
    sessions: 'sessionsRoot', ideas: 'ideasRoot', logs: 'logsRoot', reports: 'reportsRoot',
    'knowledge-userdata': 'knowledgeRoot', recordings: 'recordingsRoot',
    'generated-media': 'generatedMediaRoot', 'tts-cache': 'ttsCacheRoot',
  };
  const overrides = {};
  for (const entry of entryTable({ layout, home, userData })) {
    const key = byId[entry.id];
    if (key && !overrides[key] && fs.existsSync(entry.src)) overrides[key] = entry.src;
  }
  // The individual state files all live in one directory; point stateRoot at it whole.
  const legacyState = path.join(home, '.bigkiji');
  if (fs.existsSync(path.join(legacyState, 'system_memory.json'))) overrides.stateRoot = legacyState;
  // The legacy CLI preferences file is config.json, not cli-config.json.
  if (fs.existsSync(path.join(legacyState, 'config.json'))) overrides.cliConfigFile = path.join(legacyState, 'config.json');
  return overrides;
}

module.exports = { entryTable, planMigration, referenceOverrides, measure, deviceOf };
