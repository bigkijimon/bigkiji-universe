#!/usr/bin/env node
'use strict';
// What is actually running, versus what you think is running.
//
// Every symptom below cost the owner real time on 2026-08-05, and every one of them was
// invisible from inside the app:
//
//   "変更が反映されていないのはなんでですか？"  the packaged app was 18 commits old
//   the CLI kept using fixed code that was not loaded   the daemon predated the fix
//   `5/11 tools` read as a fault                        it was correct: 5 answering, 11 known
//   the facilitator silently produced nothing           it pointed at a model, unverified
//   the ComfyUI tutorial could never have worked        0.25.0 installed, 0.30.0+ required
//
// Read-only by construction: statSync, one git rev-parse, and HTTP GETs against
// localhost. It starts nothing, writes nothing, and fixes nothing — a doctor that
// repairs while measuring cannot be trusted about what it measured.
//
// Numbers over verdicts. `—` means "not measured" and is never printed as 0.
//
// Run: npm run doctor

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(ROOT, '..', 'dist', 'mac-arm64', 'BigKiji Universe.app', 'Contents', 'Resources', 'app');
const DASH = '—';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
// A response body is text, not a path. readJson() was handed one on its first run and
// reported "0 models · configured but NOT installed" against an Ollama holding eleven —
// the doctor's own first finding was about the doctor.
function parse(text) {
  try { return JSON.parse(String(text || '')); } catch (_) { return null; }
}
function sh(cmd, args) {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return ''; }
}
async function get(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 200000) };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

const rows = [];
/** @param {string} name @param {string} value @param {string} note @param {boolean|null} ok */
function say(name, value, note = '', ok = null) { rows.push({ name, value, note, ok }); }

async function main() {
  // 1. The build the owner is looking at, against the code that exists.
  const head = sh('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = sh('git', ['status', '--porcelain']).length > 0;
  const bundle = readJson(path.join(DIST, 'src', 'core', 'build-info.json'));
  if (!bundle) {
    say('packaged app', DASH, 'no build in dist/mac-arm64 — nothing to compare', null);
  } else {
    const behind = bundle.commit && head ? sh('git', ['rev-list', '--count', `${bundle.commit}..HEAD`]) : '';
    const count = Number(behind || 0);
    say('packaged app', bundle.buildId,
      count ? `${count} commit${count === 1 ? '' : 's'} behind HEAD (${head}) — rebuild: npm run dist:local`
        : `matches HEAD (${head})`, count === 0);
  }
  say('working tree', dirty ? 'uncommitted changes' : 'clean',
    dirty ? 'a build from a dirty tree is not its commit' : '', !dirty);

  // 2. The daemon the CLI is talking to. A daemon started before a fix does not have it.
  const pids = sh('pgrep', ['-f', 'server/daemon.js']).split('\n').filter(Boolean);
  if (!pids.length) {
    say('daemon', 'not running', 'starts with the app or the CLI', null);
  } else {
    const started = sh('ps', ['-o', 'lstart=', '-p', pids[0]]);
    const health = await get('http://127.0.0.1:8777/health');
    say('daemon', `pid ${pids[0]}`,
      `${started || 'start time unknown'}${health ? ' · answering on 8777' : ' · NOT answering on 8777'}`,
      !!health);
    say('daemon code', DASH,
      'a daemon started before a change does not have it — restart it after any fix to src/domain', null);
  }

  // 3. Tools: known, present, and actually answering are three different numbers.
  const { detectAndProbeAll } = require('../src/domain/pi-agent/tool-registry');
  // Ask data-root where settings live instead of spelling the directory again. The
  // hardcoded copy here still said "bigkiji-universe" after the 2.5 rename, so doctor
  // was grading a file the app had stopped writing four days earlier.
  const settings = readJson(path.join(require('../src/core/data-root').defaultUserData(), 'settings.json'));
  const tools = await detectAndProbeAll({ saved: settings?.paths || {} });
  const connected = tools.filter((tool) => tool.status === 'connected');
  const missing = tools.filter((tool) => tool.status === 'missing');
  say('tools', `${connected.length}/${tools.length} answering`,
    `${tools.length - missing.length} present on disk${missing.length ? ` · missing: ${missing.map((tool) => tool.label).join(', ')}` : ''}`,
    missing.length === 0);

  // 4. The model the front desk points at, against the models that exist. A spec writer
  //    aimed at a model that is not installed fails into a deterministic stub, silently.
  const { MODELS } = require('../src/domain/pi-agent/fast-api-router');
  const tags = await get('http://127.0.0.1:11434/api/tags');
  if (!tags) {
    say('ollama', 'not answering', 'the front desk and the conversation both fall back without it', false);
  } else {
    const installed = (parse(tags.body)?.models || []).map((model) => model.name);
    const wanted = [MODELS.ollama, process.env.BIGKIJI_CONVERSATION_MODEL || 'qwen3.5:latest'];
    const absent = wanted.filter((name) => !installed.includes(name));
    say('ollama', `${installed.length} models`,
      absent.length ? `configured but NOT installed: ${absent.join(', ')}` : `front desk: ${MODELS.ollama}`,
      absent.length === 0);
  }

  // 5. ComfyUI's version against what the newest workflow needs. Following a tutorial
  //    written for 0.30 on 0.25 fails in ways that look like a broken model.
  const stats = await get('http://127.0.0.1:8000/system_stats') || await get('http://127.0.0.1:8188/system_stats');
  if (!stats) {
    say('comfyui', 'not running', 'version unknown until it is started', null);
  } else {
    const version = parse(stats.body)?.system?.comfyui_version || 'unknown';
    const device = parse(stats.body)?.devices?.[0]?.name || 'unknown';
    const major = Number(String(version).split('.')[1] || 0);
    say('comfyui', version, `device ${device}${major < 30 ? ' · MiniMax H3 needs 0.30.0+' : ''}`, major >= 30);
  }

  // 6. The walls hit most often. A repeat here is work the memory should already be
  //    preventing — if it is climbing, the remedy is not working.
  const { FailureMemory } = require('../src/domain/pi-agent/failure-memory');
  const knowledge = require('../src/domain/pi-agent/pi-knowledge-orchestrator');
  const top = new FailureMemory({ root: knowledge.ROOT }).top(3);
  say('failures remembered', top.length ? `${top.length} kind${top.length === 1 ? '' : 's'}` : 'none yet',
    top.map((item) => `${item.signature} ×${item.occurrences}${item.resolved ? ' (fixed)' : ' (unresolved)'}`).join(' · '), null);

  const width = Math.max(...rows.map((row) => row.name.length));
  const mark = (ok) => (ok === null ? ' ' : ok ? '✓' : '!');
  console.log('');
  for (const row of rows) console.log(` ${mark(row.ok)} ${row.name.padEnd(width)}  ${row.value}${row.note ? `  ${DASH} ${row.note}` : ''}`);
  const bad = rows.filter((row) => row.ok === false);
  console.log(`\n ${bad.length ? `${bad.length} thing${bad.length === 1 ? '' : 's'} to look at` : 'nothing measured looks wrong'}\n`);
  // Never a non-zero exit. This is a report, not a gate: failing a build because
  // ComfyUI happens to be closed would make the doctor something people skip.
}

main().catch((error) => { console.error(`doctor: ${error.message}`); });
