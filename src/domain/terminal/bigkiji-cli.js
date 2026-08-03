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
const { StickyScreen, modelPanel } = require('../../cli/tui/renderer');
const { buildFooter, footerHeightFor } = require('../../cli/tui/footer');
const { loadingFrames, frameAt } = require('../../cli/tui/loading-frames');
const {
  glyphs, lower, phrase, renderAssistantText, renderEvent, renderNote, renderStatus, renderToolCall, renderToolResult,
  renderUserTurn, shortenPath, truncateToWidth,
} = require('../../cli/tui/transcript');
const { CliPreferences } = require('./cli-preferences');
const { themeFor, normalizeMode, transportMode } = require('./cli-theme');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_VERSION = require('../../../package.json').version;
let activeMode = 'plan'; let A = themeFor(activeMode);
const prefs = new CliPreferences();
function setMode(value, persist = true) { activeMode = normalizeMode(value); A = themeFor(activeMode); if (persist) prefs.update({ mode: activeMode }); return activeMode; }

const BOOT_NOTES = ['starting bigkiji core engine...', 'checking port 8777...', 'loading session memory...', 'paws on vault data...'];

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
  stop(ok = true) { if (this.timer) clearInterval(this.timer); if (this.output.isTTY) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); } this.output.write(`${ok ? A.accent : A.error}${ok ? '[kiji] bigkiji core engine attached' : '[kiji] bigkiji core engine failed'}${A.reset}\n`); }
}

/** Terminal width, honest about the fact that a pipe has none. */
function screenWidth(output = process.stdout) { return Math.max(40, Math.min(200, Number(output.columns) || 80)); }

// Four lines: the model panel, then the workspace and daemon facts muted
// underneath. The name and version ride the panel's top border rather than
// taking a line of their own, which buys back a row of transcript.
//
// The kaomoji that used to open this banner is gone (owner, 2026-08-03). The
// cat is still here — it is the pixel sprite inside the panel, eight columns
// instead of eleven, and it is the same art the footer animates.
//
// The old banner also drew five permanently lit model dots; they were
// decoration, not state — every dot was on regardless of whether the model was
// reachable — so they are gone and the panel counts what is really connected.
function header(state = {}, width = screenWidth()) {
  const mark = glyphs();
  const panel = modelPanel(state, { width, theme: A, label: ` bigkiji universe v${APP_VERSION} ` });
  const facts = truncateToWidth(
    `${lower(shortenPath(state.workspace || process.cwd()))} ${mark.note} pi-orchestrator ${mark.note} core 8777 ${mark.note} pid ${state.pid || '—'}`, width);
  return [...panel, `${A.muted}${facts}${A.reset}`].join('\n');
}

const HINTS = '/help commands · /status fleet · /approve start waiting run · /gpu off free vram · /mode ask|auto-edit|plan · /exit';
function hintLine(width = screenWidth()) { return `${A.dim}${truncateToWidth(HINTS, width)}${A.reset}`; }

async function ensureClient() {
  const client = new DaemonClient({ appRoot: APP_ROOT }); const health = await client.health();
  if (!health?.ok) { const spinner = new KijiSpinner(); spinner.start(); try { await client.ensure(); spinner.stop(true); } catch (error) { spinner.stop(false); throw error; } }
  else { client.connected = true; client.token = client.loadToken(); client.versionGap(health); }
  // An engine from a different build answers every request and gets every answer
  // subtly wrong. It is still better than no engine, so this warns rather than
  // refuses — but it does not let the mismatch stay invisible the way it did for
  // a whole morning of already-fixed bugs.
  client.on('version-mismatch', ({ ours, theirs }) => {
    console.error(`${A.error}! core engine is v${theirs}, this cli is v${ours} — restart the engine (bigkiji /reload or kill the daemon) before trusting what you see${A.reset}`);
  });
  return client;
}

function launchHud() {
  const candidates = [process.env.BIGKIJI_APP_PATH, path.join(os.homedir(), 'Applications', 'BigKiji Universe.app'),
    path.resolve(APP_ROOT, '..', 'dist', 'mac-arm64', 'BigKiji Universe.app')].filter(Boolean);
  const app = candidates.find((candidate) => fs.existsSync(candidate));
  if (process.platform === 'darwin' && app) { const child = spawn('/usr/bin/open', [app], { detached: true, stdio: 'ignore' }); child.unref(); return { launched: app }; }
  const electron = path.join(APP_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (fs.existsSync(electron)) { const child = spawn(electron, ['.', '--show-main'], { cwd: APP_ROOT, detached: true, stdio: 'ignore' }); child.unref(); return { launched: 'development Electron HUD' }; }
  throw new Error('no bigkiji universe gui build was found');
}

async function selectSession(client) {
  const { sessions } = await client.sessions();
  if (!sessions.length) { console.log(`${A.dim}no saved sessions yet.${A.reset}`); return null; }
  if (!process.stdin.isTTY) return sessions[0];
  let index = 0;
  const render = () => {
    process.stdout.write('\x1b[H\x1b[2J'); console.log(`${A.bold}resume a bigkiji session${A.reset}\n${A.dim}↑/↓ select · enter resume · esc cancel${A.reset}\n`);
    sessions.slice(0, 12).forEach((session, i) => console.log(`${i === index ? A.accent + '›' : ' '} ${new Date(session.updatedAt).toLocaleString()}  ${phrase(session.status || 'IDLE')}  ${session.promptSummary}${A.reset}`));
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

const RELAY_EVENTS = ['commentary', 'phase', 'tasklog', 'run', 'conversation', 'idea', 'checkpoint'];

async function repl(client) {
  let mode = setMode(prefs.get().mode, false); let sessionId = ''; let live = await client.state();
  // Sticky Bottom: 入力(π>)は罫線で挟んだ固定フッタの中・キジトラヘッダは最上部固定・出力は中間のDECSTBM領域を流れる
  const frameSet = loadingFrames();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.prompt}>${A.reset} ` });
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
  // The same run reaches the transcript from up to three places — the awaited
  // response, the daemon's `run` event, and the status update that follows — so
  // one submitted plan printed two or three identical blocks in a row. Each
  // distinct state of a run is printed once; a real status change still prints.
  const seenRuns = new Set();
  const emitRun = (run) => {
    if (!run?.id) return;
    const key = `${run.id}:${run.status}:${run.revision ?? ''}:${run.assignments?.length ?? 0}`;
    if (seenRuns.has(key)) return;
    if (seenRuns.size > 200) seenRuns.delete(seenRuns.values().next().value);
    seenRuns.add(key); emit(renderEvent('run', run, view()));
  };
  if (!stickyOn) { console.log(header(live)); console.log(hintLine()); }
  // Animates the loading cat + elapsed clock, repainting only when the footer
  // actually changed. Three deliberate limits, all of them measured problems in
  // other terminal agents rather than hypotheticals:
  //
  //   - it does not run at all without a TTY. Piped into `cat` or a CI log there
  //     is no sticky footer to animate, and a timer firing 15x a second to
  //     discover that is waste.
  //   - frames only advance while a turn is in flight. Pi's own issue #3881
  //     reports a permanent spinner raising CPU in proportion to transcript
  //     size until the fan spins up; an idle cat would buy the same bill.
  //   - the interval is the frame set's own (67ms ≈ 15fps), which is the floor
  //     of the 15–30fps range terminal UIs are expected to stay inside.
  const ticker = stickyOn
    ? setInterval(() => { if (turnStartedAt) frameIndex += 1; paintFooter(); }, frameSet.frameMs)
    : null;
  ticker?.unref?.();
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
    // The footer says what is happening. It used to reach for `data.reply` first,
    // so it re-printed the answer that was already sitting in the transcript two
    // lines above — in Japanese, clipped mid-word, next to an English status word.
    // A status line that repeats the content is one line of screen doing no work.
    const text = data.phase || data.status || data.action || data.draft?.title || data.text || '';
    if (text) comment = String(text).replace(/\s+/g, ' ').trim();
    if (event === 'run') { emitRun(data); paintFooter(); refreshPrompt(); return; }
    const lines = renderEvent(event, data, { ...view(), resultLines: 4 });
    if (lines.length) emit(lines);
    paintFooter(); refreshPrompt();
  }); client.connect();
  const handleTurn = async (text) => {
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
          else throw new Error('usage: /setting mode ask|auto-edit|plan | contrast standard|high | cat low|periodic | accent follow|fixed-orange');
          A = themeFor(mode);
        }
        const current = prefs.get();
        emit([...renderToolCall('settings', `theme warm-brown · mode ${mode}`, view()),
          ...renderToolResult(`mode accent: ${current.modeAccent}\ncontrast: ${current.contrast}\ncat commentary: ${current.catCommentary}`, { ...view(), maxLines: 6 })]);
      }
      else if (text.startsWith('/mode ')) { const next = text.slice(6).trim(); if (!['ask', 'auto-edit', 'plan', 'auto', 'manual'].includes(next)) throw new Error('mode must be ask, auto-edit, or plan'); mode = setMode(next); emit(renderToolCall('mode', mode, view())); }
      else if (text === '/resume') { const wasSticky = sticky.active; if (wasSticky) sticky.suspend(); const session = await selectSession(client); if (wasSticky) sticky.resume(); if (session) { sessionId = session.id; emit([...renderToolCall('resume', lower(session.id), view()), ...renderToolResult(session.promptSummary, { ...view(), maxLines: 2 })]); } }
      else if (text === '/reload') { const result = await client.reload(); emit([...renderToolCall('reload', `${result.cleared ?? '—'} hooks`, view())]); }
      else if (text === '/ideas') {
        const { ideas } = await client.ideas();
        emit([...renderToolCall('ideas', `${ideas.length} draft${ideas.length === 1 ? '' : 's'}`, view()),
          ...renderToolResult(ideas.map((idea) => `${idea.id}  ${idea.status.padEnd(9)} ${idea.title}`).join('\n') || 'none', { ...view(), maxLines: 8 })]);
      }
      else if (text.startsWith('/idea ')) {
        const [, action, id, hash, disclosure] = text.split(/\s+/); if (!action || !id) throw new Error('usage: /idea plan|enhance|send|adopt|archive <id> [hash] [disclosure]');
        const idea = action === 'send' ? null : await client.idea(id); if (action !== 'send' && !idea) throw new Error('idea not found');
        const ideaResult = (label, payload) => emit([...renderToolCall('idea', `${lower(action)} · ${lower(id)}`, view()),
          ...renderToolResult(typeof payload === 'string' ? payload : util.inspect(payload, { depth: 2, colors: false }), { ...view(), maxLines: 5 })]);
        if (action === 'plan') ideaResult(action, await client.planIdea(id, idea.draftHash));
        else if (action === 'enhance') { const planned = await client.enhanceIdea(id, idea.draftHash); const d = planned.task.disclosure;
          ideaResult(action, `${d.estimatedTokens} tok · ${d.files.length} files · payload ${d.payloadHash}\napprove with: /idea send ${planned.task.id} ${idea.draftHash} ${d.disclosureHash}`); }
        else if (action === 'send') ideaResult(action, await client.approveIdeaEnhancement({ taskId:id, draftHash:hash, disclosureHash:disclosure }));
        else if (action === 'adopt') ideaResult(action, await client.promoteIdea(id, idea.draftHash));
        else if (action === 'archive') ideaResult(action, await client.archiveIdea(id, idea.draftHash));
        else throw new Error('unknown idea action');
      }
      else if (text.startsWith('/run ')) { const result = await client.prompt(text.slice(5), { mode: transportMode(mode), sessionId }); sessionId = result.sessionId;
        emitRun(result.run); }
      else if (text === '/hud') { const launched = launchHud(); emit(renderToolCall('hud', lower(launched.launched || 'launched'), view())); }
      // Approving from where the owner already is.
      //
      // Until now the only answer to "a run is waiting" was a note telling the
      // owner to quit and open `bigkiji monitor`, so nothing was ever approved:
      // the daemon had a run sitting in AWAITING_APPROVAL and the phase bar had
      // read `awaiting approval` all day. A conversation that can create work and
      // cannot start it is not a conversation about work.
      //
      // The gate itself is unchanged. The hashes below are the ones the
      // coordinator demands back — a stale revision, plan or disclosure is still
      // refused, which is the whole point of echoing them rather than sending a
      // bare id.
      else if (text === '/approve' || text === '/reject') {
        live = await client.state();
        const run = (live.runs || []).filter((item) => item.status === 'AWAITING_APPROVAL').at(-1);
        if (!run) { emit(renderNote('nothing is waiting for approval', view())); }
        else if (text === '/reject') {
          const result = await client.abort(run.id);
          emit(renderToolCall('reject', `${lower(run.id)} · ${phrase(result.status || 'aborted')}`, view()));
        } else {
          const result = await client.approve({ id: run.id, revision: run.revision, planHash: run.planHash,
            disclosureHash: run.disclosureHash, idempotencyKey: `cli-${run.id}-${run.revision}-${run.disclosureHash}` });
          emit([...renderToolCall('approve', `${lower(run.id)} · ${phrase(result.status || 'started')}`, view()),
            ...renderToolResult(`${run.assignments?.length || 0} assignments released`, { ...view(), maxLines: 2 })]);
        }
      }
      // The owner's card also runs ComfyUI, LTX-2 and ACE-Step. `/gpu off` unloads
      // the local weights now instead of waiting out the 60s idle window, which is
      // the difference between starting a render and waiting a minute to start one.
      else if (text === '/gpu' || text.startsWith('/gpu ')) {
        const action = text.slice(4).trim() || 'off';
        if (action !== 'off') throw new Error('usage: /gpu off');
        const released = await client.post('/api/gpu/release');
        emit(renderToolCall('gpu', released.released ? `released ${lower(released.model)}` : `hold ${lower(released.error || 'failed')}`, view()));
      }
      else if (text === '/abort') { const result = await client.post('/api/abort'); emit(renderToolCall('abort', phrase(result.status || 'sent'), view())); }
      else if (text === '/clear') { if (sticky.active) sticky.clear(); else process.stdout.write('\x1b[H\x1b[2J'); }
      else if (text === '/help') emit(renderAssistantText('talk naturally. ideas stay local as drafts. use /run for an explicit execution plan. when a run is waiting, /approve starts it and /reject drops it; nothing external ever runs without that.', view()));
      else {
        // No "received in plan mode" acknowledgement: the footer's loading cat,
        // elapsed clock and phase bar already say the turn is in flight, and the
        // transcript should hold nothing but the question and the answer.
        const result = await client.turn(text, { mode: transportMode(mode), sessionId }); sessionId = result.sessionId;
        emit(renderAssistantText(result.reply, view()));
        if (result.draft) emit(renderNote(`draft ${result.draft.id} · ${result.draft.title}`, view()));
        if (result.run) emitRun(result.run);
      }
    } catch (error) { emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 3, isError: true })); }
    finally { turnStartedAt = 0; }
    paintFooter(true); refreshPrompt();
  };

  // One paste is one turn.
  //
  // readline emits a 'line' per newline and never waits for the handler, so a
  // nine-line paste fired nine turns inside 31ms: the daemon opened nine
  // sessions, Ollama queued them, eight tripped the 8s stall timeout and every
  // reply came back degraded. Lines are collected and dispatched together, and
  // turns run one at a time.
  //
  // Bracketed paste (ESC[?2004h) gives the exact boundary when the terminal
  // supports it. Node's readline already strips the markers out of the line
  // content, so stdin is only watched for them. Terminals that ignore the
  // request fall through to the quiet period, which is far shorter than a
  // keystroke gap and far longer than the gap between two lines of one paste.
  const PASTE_START = '\x1b[200~'; const PASTE_END = '\x1b[201~';
  const QUIET_MS = 30; const PASTE_MAX_MS = 750;
  let pending = []; let pasting = false; let pastedBatch = false;
  let quietTimer = null; let pasteTimer = null; let chain = Promise.resolve();
  const flush = () => {
    quietTimer = null;
    if (!pending.length) return;
    // A paste that does not end in a newline leaves its last fragment on the
    // input line. Sending now would submit the block without its final line, so
    // the collected lines wait for Enter — which is what the screen shows.
    if (rl.line && (pending.length > 1 || pastedBatch)) return;
    const text = pending.join('\n').trim(); pending = []; pastedBatch = false;
    chain = chain.then(() => handleTurn(text)).catch(() => {});
  };
  const schedule = () => { clearTimeout(quietTimer); quietTimer = setTimeout(flush, QUIET_MS); quietTimer.unref?.(); };
  // readline echoes every line of a paste as it swallows it, and each echoed line
  // scrolls the sticky region: mid-paste the bottom rule and the MODE/SHELL/AGENT
  // row were overwritten by fragments of the pasted text. The echo is silenced for
  // the duration of the paste and the footer is repainted once at the end, so the
  // screen goes straight from the prompt to the finished block.
  // Keep the width honest while muted: readline falls back to Infinity columns
  // without it, and its idea of how many rows the line occupies has to survive
  // the paste for the redraw afterwards to land on the right row.
  const SINK = { write() { return true; }, get columns() { return process.stdout.columns; }, get rows() { return process.stdout.rows; } };
  let muted = false;
  const mute = () => { if (!muted) { muted = true; rl.output = SINK; } };
  const endPaste = () => {
    clearTimeout(pasteTimer); pasteTimer = null; pasting = false;
    if (muted) { muted = false; rl.output = process.stdout; }
    paintFooter(true); schedule();
  };
  const watchPaste = (chunk) => {
    const seq = chunk.toString('latin1'); // the markers are ASCII; latin1 never mangles their bytes
    const start = seq.lastIndexOf(PASTE_START); const end = seq.lastIndexOf(PASTE_END);
    if (start < 0 && end < 0) return;
    mute(); // this listener runs before readline's, so the echo is stopped before it happens
    if (start > end) {
      pasting = true; pastedBatch = true; clearTimeout(quietTimer); quietTimer = null;
      // A marker split across two reads would otherwise hold the buffer forever.
      clearTimeout(pasteTimer); pasteTimer = setTimeout(endPaste, PASTE_MAX_MS); pasteTimer.unref?.();
    } else {
      // The whole paste arrived in one read: stay muted until readline has finished
      // processing this same chunk, which it does synchronously right after us.
      pastedBatch = true; process.nextTick(endPaste);
    }
  };
  if (process.stdin.isTTY) { process.stdout.write('\x1b[?2004h'); process.stdin.prependListener('data', watchPaste); }
  rl.on('line', (line) => { pending.push(line); if (!pasting) schedule(); });
  // readline in terminal mode swallows ^C itself and emits this instead of
  // letting SIGINT reach the process, so without it Ctrl-C out of the REPL
  // closed the interface and exited 0.
  let interrupted = false;
  rl.on('SIGINT', () => { interrupted = true; rl.close(); });
  rl.on('close', () => {
    clearTimeout(quietTimer); clearTimeout(pasteTimer);
    if (process.stdin.isTTY) { process.stdin.off('data', watchPaste); rl.output = process.stdout; process.stdout.write('\x1b[?2004l'); }
    if (ticker) clearInterval(ticker); clearInterval(statePoll); sticky.stop(); client.disconnect();
    process.exit(interrupted ? 130 : 0);
  });
  paintFooter(true); refreshPrompt();
}

// Exit codes, because something else is going to read them. cmux, tmux, a shell
// `&&` chain and CI all treat this as a normal command: 0 for a turn that
// completed, 1 for a failure with the reason on stderr, 130 for Ctrl-C — the
// conventional 128 + SIGINT, so `while bigkiji ...; do` stops when interrupted
// instead of looping forever.
//
// It lives inside main() rather than under `require.main === module`, because
// the shipped command is tools/bigkiji-cli.js requiring this file — so that
// guard is false for every real invocation and the handler was never installed.
function installSignalHandlers() {
  if (installSignalHandlers.done) return;
  installSignalHandlers.done = true;
  process.on('SIGINT', () => process.exit(130));
}

async function main(argv = process.argv.slice(2)) {
  installSignalHandlers();
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
      console.log(renderNote('awaiting your approval — type /approve to start it, or /reject to drop it.', options).join('\n'));
    }
    return;
  }
  await repl(client);
}

if (require.main === module) {
  main().catch((error) => { console.error(`${A.error}✗ ${error.message}${A.reset}`); process.exit(1); });
}

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, installSignalHandlers, APP_ROOT };
