#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { DaemonClient } = require('../server/daemon-client');
const { TUIMonitor } = require('../../cli/tui/monitor');
const { CliPreferences } = require('./cli-preferences');
const { themeFor, normalizeMode, transportMode } = require('./cli-theme');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
let activeMode = 'plan'; let A = themeFor(activeMode);
const prefs = new CliPreferences();
function setMode(value, persist = true) { activeMode = normalizeMode(value); A = themeFor(activeMode); if (persist) prefs.update({ mode: activeMode }); return activeMode; }

class KijiSpinner {
  constructor(output = process.stderr) { this.output = output; this.timer = null; this.index = 0; }
  start() {
    if (!this.output.isTTY) { this.output.write('Starting BigKiji Core Engine...\n'); return; }
    const frames = ['(ฅ•ω•ฅ) .  Starting BigKiji Core Engine...', '(ฅ•ω•ฅ) ｡  Checking port 8777...', '(ฅ>ω<ฅ) ･  Loading session memory...', '(ฅ`-ω-ฅ) ･  Paws on vault data...'];
    this.timer = setInterval(() => { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); this.output.write(`${A.accent}${frames[this.index++ % frames.length]}${A.reset}`); }, 120);
  }
  stop(ok = true) { if (this.timer) clearInterval(this.timer); if (this.output.isTTY) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); } this.output.write(`${ok ? A.accent : A.error}${ok ? '[Kiji] BigKiji Core Engine attached' : '[Kiji] BigKiji Core Engine failed'}${A.reset}\n`); }
}

function header(state = {}) {
  return `${A.bold}${A.accent}[ Kiji 7kg ] (=^･ω･^=)${A.reset} ${A.bold}BigKiji Universe v2.0${A.reset}\n` +
    `${A.dim}Pi-Orchestrator · Context Compaction Active · PID ${state.pid || '—'}\n${state.workspace || process.cwd()}${A.reset}\n` +
    `${A.brownLight}● Claude${A.reset}  ${A.accent}● Codex${A.reset}  ${A.warning}● GLM${A.reset}  ${A.orangeBright}● Gemini${A.reset}  ${A.brown}● PiAgent / Local Qwen${A.reset}`;
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
    sessions.slice(0, 12).forEach((session, i) => console.log(`${i === index ? A.accent + '›' : ' '} ${new Date(session.updatedAt).toLocaleString()}  ${session.status || 'IDLE'}  ${session.promptSummary}${A.reset}`));
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
  for (const model of fleet) console.log(` ${model.connected ? A.accent : A.dim}● ${model.displayName.padEnd(18)} ${(model.status || 'IDLE').padEnd(11)} ${model.metrics?.tokensUsed || 0} tok · ${model.metrics?.latencyMs || 0}ms${A.reset}`);
}

async function repl(client) {
  let mode = setMode(prefs.get().mode, false); let sessionId = ''; const state = await client.state(); console.log(header(state));
  console.log(`${A.dim}Commands: /status /fleet /setting [key value] /mode ask|auto-edit|plan /ideas /idea plan|enhance|send|adopt|archive /run /resume /reload /hud /abort /clear /help /exit${A.reset}`);
  client.on('event', ({ event, data }) => {
    if (!['commentary', 'phase', 'tasklog', 'run', 'conversation', 'idea'].includes(event)) return;
    const text = data.reply || data.draft?.title || data.text || data.phase || data.status || data.action || '';
    process.stdout.write(`\n${A.dim}[${event}]${A.reset} ${text}\nπ> `);
  }); client.connect();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.prompt}π>${A.reset} ` });
  rl.on('line', async (line) => {
    const text = line.trim();
    try {
      if (!text) {}
      else if (['/exit', '/quit'].includes(text)) { rl.close(); return; }
      else if (text === '/status' || text === '/fleet') printState(await client.state());
      else if (text === '/setting' || text === '/settings' || text.startsWith('/setting ') || text.startsWith('/settings ')) {
        const [, key, requested] = text.split(/\s+/); const value = prefs.get();
        if (key) {
          if (key === 'mode') mode = setMode(requested);
          else if (key === 'contrast' && ['standard', 'high'].includes(requested)) prefs.update({ contrast: requested });
          else if (key === 'cat' && ['low', 'periodic'].includes(requested)) prefs.update({ catCommentary: requested });
          else if (key === 'accent' && ['follow', 'fixed-orange'].includes(requested)) prefs.update({ modeAccent: requested });
          else throw new Error('Usage: /setting mode ask|auto-edit|plan | contrast standard|high | cat low|periodic | accent follow|fixed-orange');
          A = themeFor(mode);
        }
        const current = prefs.get(); console.log(`${A.strong}SETTINGS${A.reset}\n  theme: warm-brown\n  mode accent: ${current.modeAccent}\n  contrast: ${current.contrast}\n  cat commentary: ${current.catCommentary}\n  mode: ${mode}`);
      }
      else if (text.startsWith('/mode ')) { const next = text.slice(6).trim(); if (!['ask', 'auto-edit', 'plan', 'auto', 'manual'].includes(next)) throw new Error('mode must be ask, auto-edit, or plan'); mode = setMode(next); console.log(`${A.accent}Mode: ${mode}${A.reset}`); }
      else if (text === '/resume') { const session = await selectSession(client); if (session) { sessionId = session.id; console.log(`Resumed ${session.id}: ${session.promptSummary}`); } }
      else if (text === '/reload') console.log(await client.reload());
      else if (text === '/ideas') {
        const { ideas } = await client.ideas(); ideas.forEach((idea) => console.log(`${A.strong}${idea.id}${A.reset}  ${idea.status.padEnd(9)} ${idea.title}  ${String(idea.draftHash).slice(0,10)}`));
      }
      else if (text.startsWith('/idea ')) {
        const [, action, id, hash, disclosure] = text.split(/\s+/); if (!action || !id) throw new Error('Usage: /idea plan|enhance|send|adopt|archive <id> [hash] [disclosure]');
        const idea = action === 'send' ? null : await client.idea(id); if (action !== 'send' && !idea) throw new Error('Idea not found');
        if (action === 'plan') console.log(await client.planIdea(id, idea.draftHash));
        else if (action === 'enhance') { const planned = await client.enhanceIdea(id, idea.draftHash); const d = planned.task.disclosure;
          console.log(`${A.strong}Gemini disclosure${A.reset} ${d.estimatedTokens} tok · ${d.files.length} files · payload ${d.payloadHash}\nApprove with: /idea send ${planned.task.id} ${idea.draftHash} ${d.disclosureHash}`); }
        else if (action === 'send') console.log(await client.approveIdeaEnhancement({ taskId:id, draftHash:hash, disclosureHash:disclosure }));
        else if (action === 'adopt') console.log(await client.promoteIdea(id, idea.draftHash));
        else if (action === 'archive') console.log(await client.archiveIdea(id, idea.draftHash));
        else throw new Error('Unknown idea action');
      }
      else if (text.startsWith('/run ')) { const result = await client.prompt(text.slice(5), { mode: transportMode(mode), sessionId }); sessionId = result.sessionId; console.log(`${A.accent}Plan ready:${A.reset} ${result.run.id} · ${result.run.status}`); }
      else if (text === '/hud') console.log(launchHud());
      else if (text === '/abort') console.log(await client.post('/api/abort'));
      else if (text === '/clear') process.stdout.write('\x1b[H\x1b[2J');
      else if (text === '/help') console.log('Talk naturally. Ideas stay local as drafts. Use /run for an explicit execution plan; every external model still waits for Owner approval.');
      else { console.log(`${A.accent}[Kiji] (=^･ω･^=) Received in ${mode} mode${A.reset}`); const result = await client.turn(text, { mode: transportMode(mode), sessionId }); sessionId = result.sessionId; console.log(`${A.ink}${result.reply}${A.reset}`);
        if (result.draft) console.log(`${A.strong}Draft:${A.reset} ${result.draft.id} · ${result.draft.title}`);
        if (result.run) console.log(`${A.accent}Plan:${A.reset} ${result.run.id} · ${result.run.status}`); }
    } catch (error) { console.log(`${A.error}✗ ${error.message}${A.reset}`); }
    rl.prompt();
  });
  rl.on('close', () => { client.disconnect(); process.exit(0); }); rl.prompt();
}

async function main(argv = process.argv.slice(2)) {
  const client = await ensureClient(); setMode(prefs.get().mode, false); const args = [...argv]; const autoAt = args.indexOf('--auto'); const auto = autoAt >= 0;
  if (auto) args.splice(autoAt, 1); const command = String(args[0] || '').replace(/^\//, '').toLowerCase();
  if (['monitor', 'tui'].includes(command) || args.includes('--tui')) { const monitor = new TUIMonitor({ client }); client.on('hud-request', () => launchHud()); await monitor.start(); return; }
  if (command === 'hud') { console.log(launchHud()); return; }
  if (command === 'status' || command === 'fleet') { printState(await client.state()); return; }
  if (command === 'reload') { console.log(await client.reload()); return; }
  if (command === 'resume') { const session = await selectSession(client); if (session) console.log(JSON.stringify(await client.session(session.id), null, 2)); return; }
  if (args.length) {
    const result = await client.turn(args.join(' '), { mode: auto ? 'auto' : transportMode(activeMode) }); console.log(`${A.ink}${result.reply}${A.reset}`);
    if (result.draft) console.log(`  draft   ${result.draft.id} · ${result.draft.title}`);
    if (result.run) { console.log(`  run     ${result.run.id} · ${result.run.status}`); console.log(`${A.strong}  Awaiting owner directive. Open “bigkiji monitor” and press a to accept.${A.reset}`); }
    return;
  }
  await repl(client);
}

if (require.main === module) main().catch((error) => { console.error(`${A.error}✗ ${error.message}${A.reset}`); process.exit(1); });

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, APP_ROOT };
