#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const util = require('util');
const { spawn } = require('child_process');
const { DaemonClient } = require('../server/daemon-client');
const { TUIMonitor } = require('../../cli/tui/monitor');
const { StickyScreen } = require('../../cli/tui/renderer');
const { buildFooter, footerHeightFor } = require('../../cli/tui/footer');
const { loadingFrames, frameAt } = require('../../cli/tui/loading-frames');
const {
  glyphs, renderAssistantText, renderEvent, renderNote, renderStatus, renderToolCall, renderToolResult,
  renderUserTurn, shortenPath, stringWidth, truncateToWidth,
} = require('../../cli/tui/transcript');
const { CliPreferences } = require('./cli-preferences');
const { themeFor, normalizeMode, transportMode } = require('./cli-theme');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_VERSION = require('../../../package.json').version;
let activeMode = 'plan'; let A = themeFor(activeMode);
const prefs = new CliPreferences();
function setMode(value, persist = true) { activeMode = normalizeMode(value); A = themeFor(activeMode); if (persist) prefs.update({ mode: activeMode }); return activeMode; }

const BOOT_NOTES = ['Starting BigKiji Core Engine...', 'Checking port 8777...', 'Loading session memory...', 'Paws on vault data...'];

// Boot spinner for the daemon handshake. It writes to **stdout** — stderr
// bypassed the sticky DECSTBM region and corrupted the screen — and shares the
// pluggable loading frame set with the REPL footer, so both animate the same cat.
class KijiSpinner {
  constructor(output = process.stdout, frameSet = loadingFrames()) { this.output = output; this.frameSet = frameSet; this.timer = null; this.index = 0; }
  get frames() { return this.frameSet.frames; }
  get frameMs() { return this.frameSet.frameMs; }
  frame(index = this.index) { return frameAt(index, this.frameSet).split('\n').join(' '); }
  start() {
    if (!this.output.isTTY) { this.output.write(`${BOOT_NOTES[0]}\n`); return; }
    this.timer = setInterval(() => {
      const index = this.index++;
      readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0);
      this.output.write(`${A.accent}${this.frame(index)}  ${BOOT_NOTES[index % BOOT_NOTES.length]}${A.reset}`);
    }, this.frameMs);
    this.timer.unref?.();
  }
  stop(ok = true) { if (this.timer) clearInterval(this.timer); if (this.output.isTTY) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); } this.output.write(`${ok ? A.accent : A.error}${ok ? '[Kiji] BigKiji Core Engine attached' : '[Kiji] BigKiji Core Engine failed'}${A.reset}\n`); }
}

/** Terminal width, honest about the fact that a pipe has none. */
function screenWidth(output = process.stdout) { return Math.max(40, Math.min(200, Number(output.columns) || 80)); }

// Three lines, no frame. Mascot and version on the left, daemon facts dim on the
// right, workspace and hints muted underneath. The old banner also drew five
// permanently lit model dots; they were decoration, not state — every dot was
// always on regardless of whether the model was reachable — so they are gone and
// /status carries the real fleet.
function header(state = {}, width = screenWidth()) {
  const mark = glyphs();
  const title = `${A.bold}${A.accent}(=^･ω･^=)${A.reset} ${A.bold}${A.ink}BigKiji Universe v${APP_VERSION}${A.reset}`;
  const facts = `${A.dim}Core 8777 ${mark.note} PID ${state.pid || '—'}${A.reset}`;
  const room = width - stringWidth(title) - stringWidth(facts);
  const line1 = room > 1 ? `${title}${' '.repeat(room)}${facts}` : truncateToWidth(`(=^･ω･^=) BigKiji v${APP_VERSION}`, width);
  const line2 = `${A.muted}${truncateToWidth(`${shortenPath(state.workspace || process.cwd())} ${mark.note} Pi-Orchestrator ${mark.note} context compaction active`, width)}${A.reset}`;
  return `${line1}\n${line2}`;
}

const HINTS = '/help commands · /status fleet · /mode ask|auto-edit|plan · /exit';
function hintLine(width = screenWidth()) { return `${A.dim}${truncateToWidth(HINTS, width)}${A.reset}`; }

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

// /status no longer reprints the whole banner — it is a single gutter headline
// with the fleet folded underneath, and metrics the daemon never measured show
// as '—' instead of a fabricated 0.
function stateText(state, width = screenWidth()) {
  return renderStatus(state, { width, theme: A, mark: glyphs() }).join('\n');
}
function printState(state) { console.log(stateText(state)); }

const RELAY_EVENTS = ['commentary', 'phase', 'tasklog', 'run', 'conversation', 'idea'];

async function repl(client) {
  let mode = setMode(prefs.get().mode, false); let sessionId = ''; let live = await client.state();
  // Sticky Bottom: 入力(π>)は罫線で挟んだ固定フッタの中・キジトラヘッダは最上部固定・出力は中間のDECSTBM領域を流れる
  const frameSet = loadingFrames();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.prompt}π>${A.reset} ` });
  const sticky = new StickyScreen({ output: process.stdout, footerHeight: footerHeightFor(frameSet) });
  let inputOffset = frameSet.rows + 2; let frameIndex = 0; let turnStartedAt = 0; let comment = ''; let phaseInfo = live.phase; let painted = '';
  const promptRow = () => process.stdout.write(`\x1b[${Math.min(sticky.rows, sticky.footerTop + inputOffset)};1H\x1b[2K`);
  // Readline owns the input row: re-issue the prompt or the line being typed gets
  // eaten, then repair the rows underneath it — readline's refresh emits ESC[0J,
  // which would otherwise erase the bottom rule and the MODE/SHELL/AGENT row.
  const refreshPrompt = () => {
    if (!sticky.active) { rl.prompt(true); return; }
    promptRow(); rl.prompt(true); process.stdout.write(sticky.restoreFooter());
  };
  // Footer-only repaint: never touches the header or the scrolling relay above.
  const paintFooter = (force = false) => {
    if (!sticky.active) return;
    const { lines, inputIndex } = buildFooter({ cols: sticky.cols, mode, state: live, phase: phaseInfo, comment,
      busy: turnStartedAt > 0, elapsedMs: turnStartedAt ? Date.now() - turnStartedAt : null, frameIndex, frameSet });
    inputOffset = inputIndex;
    const signature = lines.join(' ');
    if (!force && signature === painted) return;
    painted = signature;
    sticky.setFooter(lines, { paint: false });
    process.stdout.write('\x1b[?25l'); refreshPrompt(); process.stdout.write('\x1b[?25h');
  };
  const stickyOn = sticky.start({ header: [...header(live, sticky.cols).split('\n'), hintLine(sticky.cols)], onLayout: () => paintFooter(true) });
  const say = (value) => {
    const text = typeof value === 'string' ? value : util.inspect(value, { colors: process.env.NO_COLOR === undefined, depth: 4 });
    if (sticky.active) sticky.print(text); else console.log(text);
  };
  // Transcript width and shared render options: every renderer measures against
  // the live terminal so wrapped lines hang at the content column and nothing
  // is ever allowed to run past the right edge.
  const view = () => ({ width: sticky.active ? sticky.cols : screenWidth(), theme: A, mark: glyphs() });
  const emit = (lines) => { const list = Array.isArray(lines) ? lines : [lines]; if (list.length) say(list.join('\n')); };
  if (!stickyOn) { console.log(header(live)); console.log(hintLine()); }
  // ~120ms ticker: animates the loading cat + elapsed clock, repainting only when the footer actually changed.
  const ticker = setInterval(() => { if (turnStartedAt) frameIndex += 1; paintFooter(); }, frameSet.frameMs); ticker.unref?.();
  // Fleet/agent status is push-first (SSE) with a slow poll as the safety net.
  const statePoll = setInterval(() => { client.state().then((next) => { live = next; paintFooter(); }).catch(() => {}); }, 4000); statePoll.unref?.();
  client.on('event', ({ event, data }) => {
    if (event === 'state') live = { ...live, ...data };
    else if (event === 'models') live = { ...live, models: data };
    else if (event === 'phase') phaseInfo = data;
    else if (event === 'run') phaseInfo = data.status || phaseInfo;
    if (!RELAY_EVENTS.includes(event)) { paintFooter(); return; }
    // The footer's comment slot still shows every event, so the transcript can
    // afford to stay quiet: phase ticks and the daemon echoing back the prompt
    // the owner just typed are dropped by renderEvent rather than printed.
    const text = data.reply || data.draft?.title || data.text || data.phase || data.status || data.action || '';
    if (text) comment = String(text).replace(/\s+/g, ' ').trim();
    const lines = renderEvent(event, data, { ...view(), resultLines: 4 });
    if (lines.length) emit(lines);
    paintFooter(); refreshPrompt();
  }); client.connect();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (sticky.active && text) emit(renderUserTurn(text, view()));
    if (text) { turnStartedAt = Date.now(); frameIndex = 0; paintFooter(true); } // elapsed clock starts the moment the owner hits Enter
    try {
      if (!text) {}
      else if (['/exit', '/quit'].includes(text)) { rl.close(); return; }
      else if (text === '/status' || text === '/fleet') { live = await client.state(); emit(renderStatus(live, view())); }
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
        const current = prefs.get();
        emit([...renderToolCall('Settings', `theme warm-brown · mode ${mode}`, view()),
          ...renderToolResult(`mode accent: ${current.modeAccent}\ncontrast: ${current.contrast}\ncat commentary: ${current.catCommentary}`, { ...view(), maxLines: 6 })]);
      }
      else if (text.startsWith('/mode ')) { const next = text.slice(6).trim(); if (!['ask', 'auto-edit', 'plan', 'auto', 'manual'].includes(next)) throw new Error('mode must be ask, auto-edit, or plan'); mode = setMode(next); emit(renderToolCall('Mode', mode, view())); }
      else if (text === '/resume') { const wasSticky = sticky.active; if (wasSticky) sticky.suspend(); const session = await selectSession(client); if (wasSticky) sticky.resume(); if (session) { sessionId = session.id; emit([...renderToolCall('Resume', session.id, view()), ...renderToolResult(session.promptSummary, { ...view(), maxLines: 2 })]); } }
      else if (text === '/reload') { const result = await client.reload(); emit([...renderToolCall('Reload', `${result.cleared ?? '—'} hooks`, view())]); }
      else if (text === '/ideas') {
        const { ideas } = await client.ideas();
        emit([...renderToolCall('Ideas', `${ideas.length} draft${ideas.length === 1 ? '' : 's'}`, view()),
          ...renderToolResult(ideas.map((idea) => `${idea.id}  ${idea.status.padEnd(9)} ${idea.title}`).join('\n') || 'none', { ...view(), maxLines: 8 })]);
      }
      else if (text.startsWith('/idea ')) {
        const [, action, id, hash, disclosure] = text.split(/\s+/); if (!action || !id) throw new Error('Usage: /idea plan|enhance|send|adopt|archive <id> [hash] [disclosure]');
        const idea = action === 'send' ? null : await client.idea(id); if (action !== 'send' && !idea) throw new Error('Idea not found');
        const ideaResult = (label, payload) => emit([...renderToolCall('Idea', `${action} · ${id}`, view()),
          ...renderToolResult(typeof payload === 'string' ? payload : util.inspect(payload, { depth: 2, colors: false }), { ...view(), maxLines: 5 })]);
        if (action === 'plan') ideaResult(action, await client.planIdea(id, idea.draftHash));
        else if (action === 'enhance') { const planned = await client.enhanceIdea(id, idea.draftHash); const d = planned.task.disclosure;
          ideaResult(action, `${d.estimatedTokens} tok · ${d.files.length} files · payload ${d.payloadHash}\nApprove with: /idea send ${planned.task.id} ${idea.draftHash} ${d.disclosureHash}`); }
        else if (action === 'send') ideaResult(action, await client.approveIdeaEnhancement({ taskId:id, draftHash:hash, disclosureHash:disclosure }));
        else if (action === 'adopt') ideaResult(action, await client.promoteIdea(id, idea.draftHash));
        else if (action === 'archive') ideaResult(action, await client.archiveIdea(id, idea.draftHash));
        else throw new Error('Unknown idea action');
      }
      else if (text.startsWith('/run ')) { const result = await client.prompt(text.slice(5), { mode: transportMode(mode), sessionId }); sessionId = result.sessionId;
        emit(renderEvent('run', result.run, view())); }
      else if (text === '/hud') { const launched = launchHud(); emit(renderToolCall('HUD', launched.launched || 'launched', view())); }
      else if (text === '/abort') { const result = await client.post('/api/abort'); emit(renderToolCall('Abort', result.status || 'sent', view())); }
      else if (text === '/clear') { if (sticky.active) sticky.clear(); else process.stdout.write('\x1b[H\x1b[2J'); }
      else if (text === '/help') emit(renderAssistantText('Talk naturally. Ideas stay local as drafts. Use /run for an explicit execution plan; every external model still waits for Owner approval.', view()));
      else {
        // No "received in plan mode" acknowledgement: the footer's loading cat,
        // elapsed clock and phase bar already say the turn is in flight, and the
        // transcript should hold nothing but the question and the answer.
        const result = await client.turn(text, { mode: transportMode(mode), sessionId }); sessionId = result.sessionId;
        emit(renderAssistantText(result.reply, view()));
        if (result.draft) emit(renderNote(`draft ${result.draft.id} · ${result.draft.title}`, view()));
        if (result.run) emit(renderEvent('run', result.run, view()));
      }
    } catch (error) { emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 3, isError: true })); }
    finally { turnStartedAt = 0; }
    paintFooter(true); refreshPrompt();
  });
  rl.on('close', () => { clearInterval(ticker); clearInterval(statePoll); sticky.stop(); client.disconnect(); process.exit(0); });
  paintFooter(true); refreshPrompt();
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
    const options = { width: screenWidth(), theme: A, mark: glyphs() };
    const result = await client.turn(args.join(' '), { mode: auto ? 'auto' : transportMode(activeMode) });
    console.log(renderAssistantText(result.reply, options).join('\n'));
    if (result.draft) console.log(renderNote(`draft ${result.draft.id} · ${result.draft.title}`, options).join('\n'));
    if (result.run) {
      console.log(renderEvent('run', result.run, options).join('\n'));
      console.log(renderNote('Awaiting owner directive — open “bigkiji monitor” and press a to accept.', options).join('\n'));
    }
    return;
  }
  await repl(client);
}

if (require.main === module) main().catch((error) => { console.error(`${A.error}✗ ${error.message}${A.reset}`); process.exit(1); });

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, APP_ROOT };
