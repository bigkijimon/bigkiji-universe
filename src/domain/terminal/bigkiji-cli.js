#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DaemonClient } = require('../server/daemon-client');
const { TUIMonitor } = require('../../cli/tui/monitor');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const A = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', mint: '\x1b[38;2;84;211;164m',
  cyan: '\x1b[38;2;94;200;220m', amber: '\x1b[38;2;230;190;96m', violet: '\x1b[38;2;176;146;220m', coral: '\x1b[38;2;225;128;106m' };

class KijiSpinner {
  constructor(output = process.stderr) { this.output = output; this.timer = null; this.index = 0; }
  start() {
    if (!this.output.isTTY) { this.output.write('Starting BigKiji Core Engine...\n'); return; }
    const frames = ['(ฅ•ω•ฅ) .  Starting BigKiji Core Engine...', '(ฅ•ω•ฅ) ｡  Checking port 8777...', '(ฅ>ω<ฅ) 𓍢ִ  Loading session memory...', '(ฅ`-ω-ฅ) 🧶  Paws on vault data...'];
    this.timer = setInterval(() => { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); this.output.write(`${A.mint}${frames[this.index++ % frames.length]}${A.reset}`); }, 120);
  }
  stop(ok = true) { if (this.timer) clearInterval(this.timer); if (this.output.isTTY) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); } this.output.write(`${ok ? A.mint : A.coral}${ok ? '● BigKiji Core Engine attached' : '✗ BigKiji Core Engine failed'}${A.reset}\n`); }
}

function header(state = {}) {
  return `${A.bold}${A.mint}[ 🐱 BigKiji ]${A.reset} ${A.bold}BigKiji Universe v2.0${A.reset}\n` +
    `${A.dim}Pi-Orchestrator · Context Compaction Active · PID ${state.pid || '—'}\n${state.workspace || process.cwd()}${A.reset}\n` +
    `${A.amber}● Claude${A.reset}  ${A.cyan}● Codex${A.reset}  ${A.violet}● GLM${A.reset}  ${A.amber}● Gemini${A.reset}  ${A.mint}● PiAgent / Local Qwen${A.reset}`;
}

async function ensureClient() {
  const client = new DaemonClient({ appRoot: APP_ROOT }); const health = await client.health();
  if (!health?.ok) { const spinner = new KijiSpinner(); spinner.start(); try { await client.ensure(); spinner.stop(true); } catch (error) { spinner.stop(false); throw error; } }
  else { client.connected = true; client.token = client.loadToken(); }
  return client;
}

function launchHud() {
  const candidates = [process.env.BIGKIJI_APP_PATH, path.join(os.homedir(), 'Applications', 'BigKiji Universe.app'),
    path.resolve(APP_ROOT, '..', 'dist', 'mac-arm64', 'BigKiji Universe.app')].filter(Boolean);
  const app = candidates.find((candidate) => fs.existsSync(candidate));
  if (process.platform === 'darwin' && app) { const child = spawn('/usr/bin/open', [app], { detached: true, stdio: 'ignore' }); child.unref(); return { launched: app }; }
  const electron = path.join(APP_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (fs.existsSync(electron)) { const child = spawn(electron, ['.', '--show-main'], { cwd: APP_ROOT, detached: true, stdio: 'ignore' }); child.unref(); return { launched: 'development Electron HUD' }; }
  throw new Error('No BigKiji Universe GUI build was found');
}

async function selectSession(client) {
  const { sessions } = await client.sessions();
  if (!sessions.length) { console.log(`${A.dim}No saved sessions yet.${A.reset}`); return null; }
  if (!process.stdin.isTTY) return sessions[0];
  let index = 0;
  const render = () => {
    process.stdout.write('\x1b[H\x1b[2J'); console.log(`${A.bold}Resume a BigKiji session${A.reset}\n${A.dim}↑/↓ select · Enter resume · Esc cancel${A.reset}\n`);
    sessions.slice(0, 12).forEach((session, i) => console.log(`${i === index ? A.mint + '›' : ' '} ${new Date(session.updatedAt).toLocaleString()}  ${session.status || 'IDLE'}  ${session.promptSummary}${A.reset}`));
  };
  render(); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve) => {
    const key = (buf) => {
      const value = buf.toString();
      if (value === '\x1b[A') index = (index - 1 + sessions.length) % sessions.length;
      else if (value === '\x1b[B') index = (index + 1) % sessions.length;
      else if (value === '\r') return done(sessions[index]);
      else if (value === '\x1b' || value === '\x03') return done(null);
      render();
    };
    const done = (value) => { process.stdin.off('data', key); process.stdin.setRawMode(false); resolve(value); };
    process.stdin.on('data', key);
  });
}

function printState(state) {
  const fleet = state.models?.models || []; console.log(header(state));
  console.log(`\n${A.bold}Phase${A.reset} ${state.phase || 'IDLE'}  ${A.bold}Sessions${A.reset} ${(state.sessions || []).length}  ${A.bold}Runs${A.reset} ${(state.runs || []).length}  ${A.bold}Files${A.reset} ${state.inventory?.files?.length || 0}${state.inventory?.truncated ? '+' : ''}`);
  for (const model of fleet) console.log(` ${model.connected ? A.mint : A.dim}● ${model.displayName.padEnd(18)} ${(model.status || 'IDLE').padEnd(11)} ${model.metrics?.tokensUsed || 0} tok · ${model.metrics?.latencyMs || 0}ms${A.reset}`);
}

async function repl(client) {
  let mode = 'plan'; let sessionId = ''; const state = await client.state(); console.log(header(state));
  console.log(`${A.dim}Commands: /status /fleet /mode plan|auto /resume /reload /hud /abort /clear /help /exit${A.reset}`);
  client.on('event', ({ event, data }) => {
    if (!['commentary', 'phase', 'tasklog', 'run'].includes(event)) return;
    const text = data.text || data.phase || data.status || ''; process.stdout.write(`\n${A.dim}[${event}]${A.reset} ${text}\nπ> `);
  }); client.connect();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.violet}π>${A.reset} ` });
  rl.on('line', async (line) => {
    const text = line.trim();
    try {
      if (!text) {}
      else if (['/exit', '/quit'].includes(text)) { rl.close(); return; }
      else if (text === '/status' || text === '/fleet') printState(await client.state());
      else if (text.startsWith('/mode ')) { const next = text.slice(6).trim(); if (!['plan', 'auto', 'manual'].includes(next)) throw new Error('mode must be plan, auto, or manual'); mode = next === 'manual' ? 'plan' : next; console.log(`Mode: ${mode}`); }
      else if (text === '/resume') { const session = await selectSession(client); if (session) { sessionId = session.id; console.log(`Resumed ${session.id}: ${session.promptSummary}`); } }
      else if (text === '/reload') console.log(await client.reload());
      else if (text === '/hud') console.log(launchHud());
      else if (text === '/abort') console.log(await client.post('/api/abort'));
      else if (text === '/clear') process.stdout.write('\x1b[H\x1b[2J');
      else if (text === '/help') console.log('Send a brief, review the generated model assignments, then accept from HUD/TUI or run /mode auto before sending.');
      else { const result = await client.prompt(text, { mode, sessionId }); sessionId = result.sessionId; console.log(`${A.mint}Plan ready:${A.reset} ${result.run.id} · ${result.run.assignments.map((item) => item.provider).join(', ')} · ${result.run.status}`); }
    } catch (error) { console.log(`${A.coral}✗ ${error.message}${A.reset}`); }
    rl.prompt();
  });
  rl.on('close', () => { client.disconnect(); process.exit(0); }); rl.prompt();
}

async function main(argv = process.argv.slice(2)) {
  const client = await ensureClient(); const args = [...argv]; const autoAt = args.indexOf('--auto'); const auto = autoAt >= 0;
  if (auto) args.splice(autoAt, 1); const command = String(args[0] || '').replace(/^\//, '').toLowerCase();
  if (['monitor', 'tui'].includes(command) || args.includes('--tui')) { const monitor = new TUIMonitor({ client }); client.on('hud-request', () => launchHud()); await monitor.start(); return; }
  if (command === 'hud') { console.log(launchHud()); return; }
  if (command === 'status' || command === 'fleet') { printState(await client.state()); return; }
  if (command === 'reload') { console.log(await client.reload()); return; }
  if (command === 'resume') { const session = await selectSession(client); if (session) console.log(JSON.stringify(await client.session(session.id), null, 2)); return; }
  if (args.length) {
    const result = await client.prompt(args.join(' '), { mode: auto ? 'auto' : 'plan' });
    console.log(`${A.mint}● ${result.run.status}${A.reset} ${result.run.id}`);
    console.log(`  session ${result.sessionId}\n  models  ${result.run.assignments.map((item) => item.provider).join(' · ')}`);
    if (!auto) console.log(`${A.amber}  Awaiting owner directive. Open “bigkiji monitor” and press a to accept.${A.reset}`);
    return;
  }
  await repl(client);
}

if (require.main === module) main().catch((error) => { console.error(`${A.coral}✗ ${error.message}${A.reset}`); process.exit(1); });

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, APP_ROOT };
