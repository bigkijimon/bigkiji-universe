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
const { buildFooter, footerHeightFor, runningAgents } = require('../../cli/tui/footer');
const { loadingFrames, frameAt } = require('../../cli/tui/loading-frames');
const {
  glyphs, lower, phrase, renderAssistantText, renderEvent, renderNote, renderStatus, renderToolCall, renderToolResult,
  renderUserTurn, shortRunId, shortenPath, truncateToWidth,
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
function header(state = {}, width = screenWidth(), frame = 0) {
  const mark = glyphs();
  // The workspace moved inside the panel — it is the third row now, beside the cat's
  // nose — so repeating it here would be the same fact twice in four rows.
  const panel = modelPanel({ workspace: process.cwd(), ...state },
    { width, theme: A, label: ` bigkiji universe v${APP_VERSION} `, frame });
  const facts = truncateToWidth(`pi-orchestrator ${mark.note} core 8777 ${mark.note} pid ${state.pid || '—'}`, width);
  return [...panel, `${A.dim}${facts}${A.reset}`].join('\n');
}

// The commands, as pairs, so the command itself can carry the accent and its
// description can stay quiet. It was one dim string in which `/approve` and the words
// "start waiting run" were the same colour, so the row read as a sentence rather than
// as a list of things you can type.
const HINTS = Object.freeze([
  ['/help', 'commands'], ['/status', 'fleet'], ['/runs', 'what is waiting'], ['/approve', 'start it'],
  ['/answer', 'reply to a question'], ['/pi', 'talk to pi'], ['/gpu off', 'free vram'], ['/exit', ''],
]);

// Wrapped at the separator, never mid-token.
//
// This was `truncateToWidth(HINTS, width)` — a single line, cut. In the owner's 63
// column pane it did not even cut: the header is built once at startup and never
// rebuilt (fixed in repl(), below), so a line measured for a wide terminal was still
// on screen after the pane got narrower, and the terminal wrapped it itself — mid
// token, at `· /` / `pi talk to pi`. Both halves of that are fixed: the header is a
// function of the live width now, and this packs whole pairs into whole lines.
function hintLines(width = screenWidth()) {
  const room = Math.max(20, width);
  const lines = []; let current = ''; let plainWidth = 0;
  for (const [command, detail] of HINTS) {
    const text = detail ? `${command} ${detail}` : command;
    const painted = `${A.accent}${command}${A.reset}${detail ? ` ${A.muted}${detail}${A.reset}` : ''}`;
    const separator = current ? '  ' : '';
    if (plainWidth + separator.length + text.length > room && current) {
      lines.push(`${current}${A.reset}`); current = painted; plainWidth = text.length;
      continue;
    }
    current += `${A.dim}${separator}${A.reset}${painted}`; plainWidth += separator.length + text.length;
  }
  if (current) lines.push(`${current}${A.reset}`);
  return lines;
}

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

// `step` is on this list because it was the missing half of "is it working or not".
//
// The daemon has published one of these per tool call since the stream parser was
// written — Read, Edit, Bash, Grep, with targets and line counts — and this list did
// not carry it, so every one was dropped at daemon-client's door. Measured 2026-08-04:
// the GUI window had a live work timeline and the terminal had nothing, which is why
// the only way to find out whether a delegated agent was doing anything was to ask,
// and asking got a fabricated answer.
const RELAY_EVENTS = ['commentary', 'phase', 'tasklog', 'step', 'run', 'conversation', 'idea', 'checkpoint', 'review', 'reflection', 'pi', 'report'];

/** Replace a run in the live list, or append it. Keeps the footer honest between polls. */
function mergeRun(runs, run) {
  const list = Array.isArray(runs) ? runs : [];
  if (!run?.id) return list;
  return [...list.filter((item) => item.id !== run.id), run];
}

async function repl(client) {
  let mode = setMode(prefs.get().mode, false); let sessionId = ''; let live = await client.state();
  // Sticky Bottom: 入力(π>)は罫線で挟んだ固定フッタの中・キジトラヘッダは最上部固定・出力は中間のDECSTBM領域を流れる
  const frameSet = loadingFrames();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.prompt}>${A.reset} ` });
  const sticky = new StickyScreen({ output: process.stdout, footerHeight: footerHeightFor(frameSet) });
  let inputOffset = frameSet.rows + 2; let frameIndex = 0; let turnStartedAt = 0; let comment = ''; let phaseInfo = live.phase; let painted = '';
  let abortedTurn = false; // one abort per turn; the second Ctrl-C leaves
  let turnAbort = null; // lets Ctrl-C stop waiting on the answer, not just ask the daemon to stop
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
    // The running block grows and shrinks with the work, so the reserved height has to
    // follow it. Without this the extra rows would be drawn over the transcript and the
    // input line would sit somewhere other than where readline believes it is.
    // setFooterHeight() is a no-op when the number has not changed.
    sticky.setFooterHeight(footerHeightFor(frameSet, runningAgents(live).length));
    const { lines, inputIndex } = buildFooter({ cols: sticky.cols, mode, state: live, phase: phaseInfo, comment,
      busy: turnStartedAt > 0, elapsedMs: turnStartedAt ? Date.now() - turnStartedAt : null, frameIndex, frameSet });
    inputOffset = inputIndex;
    const signature = lines.join(' ');
    if (!force && signature === painted) return;
    painted = signature;
    sticky.setFooter(lines, { paint: false });
    process.stdout.write('\x1b[?25l'); refreshPrompt(); process.stdout.write('\x1b[?25h');
  };
  // A function, not an array: StickyScreen re-evaluates it on every layout, so a
  // resize re-renders the panel and the hints at the new width instead of repainting
  // lines measured for the old one.
  const stickyOn = sticky.start({ header: (cols) => [...header(live, cols, frameIndex).split('\n'), ...hintLines(cols)], onLayout: () => paintFooter(true) });
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
  const waitingRuns = () => (Array.isArray(live.runs) ? live.runs : []).filter((item) => item.status === 'AWAITING_APPROVAL');
  /**
   * The waiting run the owner meant. No argument is the newest; an argument matches a
   * full id or a prefix of one, the way `git show` takes a short SHA.
   *
   * `.at(-1)` used to be the only reachable run, full stop. Measured 2026-08-04: two
   * runs were waiting and the older one — eleven hours old — could not be approved or
   * rejected from the CLI by any sequence of keystrokes, because nothing addressed it
   * and nothing listed it.
   */
  const findWaiting = (wanted) => {
    const runs = waitingRuns();
    if (!wanted) return runs.at(-1) || null;
    const needle = String(wanted).toLowerCase();
    return runs.find((item) => String(item.id).toLowerCase() === needle)
      || runs.find((item) => String(item.id).toLowerCase().startsWith(needle)) || null;
  };
  // The gate itself is unchanged. The hashes below are the ones the coordinator demands
  // back — a stale revision, plan or disclosure is still refused, which is the whole
  // point of echoing them rather than sending a bare id.
  const approveRun = async (run) => {
    const result = await client.approve({ id: run.id, revision: run.revision, planHash: run.planHash,
      disclosureHash: run.disclosureHash, idempotencyKey: `cli-${run.id}-${run.revision}-${run.disclosureHash}` });
    emit([...renderToolCall('approve', `${shortRunId(run.id)} ${glyphs().note} ${phrase(result.status || 'started')}`, view()),
      ...renderToolResult(`${run.assignments?.length || 0} assignments released`, { ...view(), maxLines: 2 })]);
    return result;
  };
  const rejectRun = async (run) => {
    const result = await client.abort(run.id);
    emit(renderToolCall('reject', `${shortRunId(run.id)} ${glyphs().note} ${phrase(result.status || 'aborted')}`, view()));
    return result;
  };

  /**
   * One keystroke, read straight off the tty, with readline stood down for the duration.
   *
   * Numbers rather than arrows on purpose: a moving selection has to redraw itself, and
   * redrawing inside the DECSTBM scroll region means either scrolling the transcript or
   * addressing rows this function does not own. A single key needs neither, so the
   * sticky layout cannot be corrupted by the thing that is supposed to make approving
   * easier. Esc and Ctrl-C both mean "later" — never "yes".
   * @returns {Promise<string>} the chosen id, or '' for later
   */
  const askKey = (choices) => new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(''); return; }
    const wasRaw = process.stdin.isRaw;
    rl.pause();
    if (!wasRaw) process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (value) => {
      process.stdin.off('data', onKey);
      if (!wasRaw) process.stdin.setRawMode(false);
      rl.resume(); refreshPrompt();
      resolve(value);
    };
    const onKey = (buffer) => {
      const key = buffer.toString();
      if (key === '\x1b' || key === '\x03' || key === '\r' || key === '\n') return finish('');
      const hit = choices.find((choice) => choice.keys.includes(key));
      if (hit) finish(hit.id);
    };
    process.stdin.on('data', onKey);
  });

  let deciding = false;
  /**
   * Say that a run is waiting, and offer to start it right here.
   *
   * The REPL never said this sentence. `main()` printed "awaiting your approval — type
   * /approve to start it" on the one-shot path and the interactive path printed nothing
   * at all, so the only trace of a waiting run was a footer segment that disappears
   * below 75 columns. Two runs waited eleven hours behind that silence.
   */
  const offerApproval = (run) => {
    const id = shortRunId(run.id);
    // `ask` puts the question on screen and takes one key. `plan` states it and gets out
    // of the way, for the owner who wants to read the disclosure first and type the
    // command deliberately — that is the whole difference between the two modes, and
    // both of them still wait. `auto-edit` never arrives here at all, because a writing
    // run in that mode is released by the coordinator without a gate.
    //
    // Not while they are typing: the prompt reads raw keys, so grabbing the keyboard
    // mid-sentence would eat the line. A half-written line falls back to the note.
    const interactive = mode === 'ask' && process.stdin.isTTY && !deciding && !rl.line;
    emit(renderNote(interactive
      ? `waiting for you.  1 approve  ${glyphs().note}  2 reject  ${glyphs().note}  3 later  (esc = later)`
      : `waiting for you — /approve ${id} to start it, /reject to drop it, /runs to see them all`, view()));
    if (!interactive) return;
    deciding = true;
    askKey([{ id: 'approve', keys: ['1', 'y', 'Y'] }, { id: 'reject', keys: ['2', 'n', 'N'] }, { id: 'later', keys: ['3'] }])
      .then(async (choice) => {
        if (choice === 'approve') await approveRun(run);
        else if (choice === 'reject') await rejectRun(run);
        else emit(renderNote(`left waiting — /approve ${id} when you are ready`, view()));
      })
      .catch((error) => emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 3, isError: true })))
      .finally(() => { deciding = false; paintFooter(true); refreshPrompt(); });
  };

  const emitRun = (run) => {
    if (!run?.id) return;
    const key = `${run.id}:${run.status}:${run.revision ?? ''}:${run.assignments?.length ?? 0}`;
    if (seenRuns.has(key)) return;
    if (seenRuns.size > 200) seenRuns.delete(seenRuns.values().next().value);
    seenRuns.add(key); emit(renderEvent('run', run, view()));
    if (run.status === 'AWAITING_APPROVAL') offerApproval(run);
  };
  if (!stickyOn) { console.log(header(live)); hintLines().forEach((line) => console.log(line)); }
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
    ? setInterval(() => {
      if (!turnStartedAt) { paintFooter(); return; }
      frameIndex += 1;
      // Header first, then the footer: paintFooter() ends by restoring the cursor to
      // readline's input row, and anything written after that would land on it.
      const head = sticky.restoreHeader();
      if (head) process.stdout.write(head);
      paintFooter();
    }, frameSet.frameMs)
    : null;
  ticker?.unref?.();
  // Fleet/agent status is push-first (SSE) with a slow poll as the safety net.
  const statePoll = setInterval(() => { client.state().then((next) => { live = next; paintFooter(); }).catch(() => {}); }, 4000); statePoll.unref?.();
  /**
   * Which delegated agent a step belongs to.
   *
   * The step payload names its provider but not the role it was hired for, and the
   * owner asked to see who is doing what. The run's assignments hold both, keyed by the
   * same taskId, so this is a lookup rather than a guess — and it falls back to the
   * provider rather than inventing a role when the run is not in `live` yet.
   */
  const stepLabel = (step) => {
    for (const run of Array.isArray(live.runs) ? live.runs : []) {
      const found = (run.assignments || []).find((item) => item.taskId === step?.taskId);
      if (found) {
        const who = [lower(found.role || ''), lower(found.agent || '')].filter(Boolean).join(` ${glyphs().note} `);
        if (who) return who;
      }
    }
    return lower(step?.provider || 'agent');
  };
  client.on('event', ({ event, data }) => {
    if (event === 'state') live = { ...live, ...data };
    else if (event === 'models') live = { ...live, models: data };
    else if (event === 'phase') phaseInfo = data;
    else if (event === 'run') {
      phaseInfo = data.status || phaseInfo;
      // Keep the live list current between four-second polls: the footer's waiting
      // count and /approve both read it, and a stale one under-reports what is waiting.
      live = { ...live, runs: mergeRun(live.runs, data) };
    }
    if (!RELAY_EVENTS.includes(event)) { paintFooter(); return; }
    // A step's `phase` is 'start' or 'end' — machinery, not a status. Letting the
    // generic extraction below reach it would put the word "start" in the comment slot
    // where the owner is looking for what is happening.
    if (event === 'step') {
      const lines = renderEvent('step', data, { ...view(), label: stepLabel(data) });
      if (lines.length) emit(lines);
      if (data?.phase === 'start' && data?.tool) {
        comment = `${data.tool}${data.target ? ` ${shortenPath(String(data.target))}` : ''}`.replace(/\s+/g, ' ').trim();
      }
      paintFooter(); refreshPrompt(); return;
    }
    // The footer's comment slot still shows every event, so the transcript can
    // afford to stay quiet: phase ticks and the daemon echoing back the prompt
    // the owner just typed are dropped by renderEvent rather than printed.
    // The footer says what is happening. It reached for `data.reply` first, so it
    // re-printed the answer already sitting in the transcript two lines above; then
    // it reached for `data.text`, which on a conversation event is the owner's own
    // prompt, so it echoed the line they had just typed. Both are already on screen.
    // Free text is only taken from the two channels whose text *is* the status.
    const narrates = event === 'commentary' || event === 'checkpoint';
    const text = data.phase || data.status || data.action || data.draft?.title || (narrates ? data.text : '') || '';
    if (text) comment = String(text).replace(/\s+/g, ' ').trim();
    if (event === 'run') { emitRun(data); paintFooter(); refreshPrompt(); return; }
    const lines = renderEvent(event, data, { ...view(), resultLines: 4 });
    if (lines.length) emit(lines);
    paintFooter(); refreshPrompt();
  }); client.connect();
  const handleTurn = async (text) => {
    if (sticky.active && text) emit(renderUserTurn(text, view()));
    if (text) { turnStartedAt = Date.now(); frameIndex = 0; abortedTurn = false; paintFooter(true); } // elapsed clock starts the moment the owner hits Enter
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
      // What is waiting, in full. There was no way to ask this: /status printed the
      // number of runs and nothing about them, so a run the owner could not address was
      // also a run they could not read.
      else if (text === '/runs') {
        live = await client.state();
        const runs = waitingRuns();
        const shown = runs.slice(-5);
        emit([...renderToolCall('runs', `${runs.length} waiting`, view()),
          ...(runs.length ? shown.flatMap((run) => renderEvent('run', run, view()))
            : renderNote('nothing is waiting for approval', view())),
          ...(runs.length > shown.length ? renderNote(`${glyphs().ellipsis} +${runs.length - shown.length} older`, view()) : [])]);
      }
      else if (text === '/approve' || text === '/reject' || text.startsWith('/approve ') || text.startsWith('/reject ')) {
        live = await client.state();
        const [command, wanted] = text.trim().split(/\s+/);
        const run = findWaiting(wanted);
        if (!run) {
          emit(renderNote(wanted ? `no waiting run matches ${lower(wanted)} — /runs lists them` : 'nothing is waiting for approval', view()));
        } else if (command === '/reject') await rejectRun(run);
        else await approveRun(run);
      }
      // The answer to `⚠ unanswered`.
      //
      // A plan can carry a question the owner has no way to answer: approve, reject
      // and later are not answers, and approving one sent the plan straight back to
      // asking. This hands the reply to the front desk, which rewrites the spec with
      // the decision in it and re-plans — so the specialists get a brief instead of
      // a question. The first word is a run id only when it looks like one; anything
      // else is the answer, addressed to the newest plan that is actually asking.
      else if (text === '/answer' || text.startsWith('/answer ')) {
        live = await client.state();
        const rest = text.slice(7).trim();
        const [first, ...others] = rest.split(/\s+/);
        const addressed = first && /^run-/i.test(first);
        const asking = waitingRuns().filter((item) => (item.promptSpec?.questions || []).length);
        const run = addressed ? findWaiting(first) : asking.at(-1);
        const said = addressed ? others.join(' ') : rest;
        if (!run) {
          emit(renderNote(waitingRuns().length ? 'no waiting plan is asking anything — /approve starts it' : 'nothing is waiting for approval', view()));
        } else if (!(run.promptSpec?.questions || []).length) {
          emit(renderNote(`${lower(shortRunId(run.id))} has no unanswered question — /approve starts it`, view()));
        } else if (!said) {
          emit(renderNote('usage: /answer [run-id] <your answer>', view()));
        } else {
          emit(renderToolCall('answer', `${lower(shortRunId(run.id))} ${glyphs().arrow || '->'} rewriting the plan`, view()));
          turnAbort = new AbortController();
          const result = await client.answerRun(run.id, said, { signal: turnAbort.signal });
          turnAbort = null;
          emit([...renderToolResult(result.spec || 'spec rewritten', { ...view(), indent: 2, maxLines: 10 }),
            ...renderNote(`${lower(shortRunId(result.run?.id || ''))} replaces ${lower(shortRunId(result.answered || ''))} — /approve starts it`, view())]);
          live = await client.state();
        }
      }
      // Step 1 of the owner's own workflow: talk to Pi.
      //
      // Until now there was no way to do that from here — Pi ran only inside the
      // Electron window and the terminal talked to Ollama directly. Same session as
      // the GUI, so the two surfaces cannot disagree about what was said.
      //
      // Toolless by construction: PiBridge spawns with --no-tools and
      // --no-extensions, so this is a second brain to consult, not a second way to
      // execute anything. Work still goes through /run and /approve.
      else if (text === '/pi' || text.startsWith('/pi ')) {
        const rest = text.slice(3).trim();
        const [word, ...others] = rest.split(/\s+/);
        if (!rest || word === 'status') {
          const status = await client.piStatus();
          emit([...renderToolCall('pi', status.running ? `${lower(status.model)} ${glyphs().note} running` : 'stopped', view()),
            ...renderToolResult(`model: ${status.model || '—'}\nchain: ${status.chain?.join(' -> ') || '—'}\nusage: /pi <message> · /pi model <id> · /pi steer <message> · /pi compact · /pi stop`,
              { ...view(), maxLines: 4 })]);
        } else if (word === 'model') {
          const result = await client.piModel(others.join(' '));
          emit(renderToolCall('pi', result.model ? `model ${lower(result.model)}` : 'model unchanged — give an id', view()));
        } else if (word === 'stop') { emit(renderToolCall('pi', phrase((await client.piStop()).running ? 'running' : 'stopped'), view())); }
        else if (word === 'compact') { emit(renderToolCall('pi', (await client.piCompact()).compacted ? 'compacted' : 'not compacted', view())); }
        else {
          const steer = word === 'steer';
          const message = steer ? others.join(' ') : rest;
          if (!message) throw new Error('usage: /pi <message> | /pi steer <message> | /pi model <id> | /pi compact | /pi stop');
          const result = await client.piPrompt(message, { steer });
          if (!result.ok) throw new Error(result.error || 'pi did not start');
          emit(renderToolCall('pi', `${lower(result.model)} ${glyphs().note} ${steer ? 'steering' : 'thinking'}`, view()));
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
      else if (text === '/help') emit(renderAssistantText('talk naturally. ideas stay local as drafts. use /run for an explicit execution plan. read-only work starts on its own and reports each step as it happens; anything that writes waits for you. /runs lists what is waiting, /approve [id] starts it and /reject [id] drops it — an id can be a prefix. when a plan shows an unanswered question, /answer [id] <your answer> rewrites the plan from your reply instead of starting it on a guess. ctrl-c interrupts the work without leaving. /pi consults pi directly — it has no tools and cannot run anything.', view()));
      else {
        // No "received in plan mode" acknowledgement: the footer's loading cat,
        // elapsed clock and phase bar already say the turn is in flight, and the
        // transcript should hold nothing but the question and the answer.
        turnAbort = new AbortController();
        const result = await client.turn(text, { mode: transportMode(mode), sessionId, signal: turnAbort.signal }); sessionId = result.sessionId;
        emit(renderAssistantText(result.reply, view()));
        if (result.draft) emit(renderNote(`draft ${result.draft.id} · ${result.draft.title}`, view()));
        if (result.run) emitRun(result.run);
      }
    } catch (error) {
      // An abort the owner asked for is not an error to report as one. They pressed
      // Ctrl-C; they know.
      if (error?.name !== 'AbortError') emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 3, isError: true }));
    }
    finally { turnStartedAt = 0; turnAbort = null; }
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
  // Ctrl-C stops the work, not the conversation.
  //
  // readline in terminal mode swallows ^C itself and emits this instead of letting
  // SIGINT reach the process, so without a handler Ctrl-C out of the REPL closed the
  // interface and exited 0. It did that during a running turn as well: every other
  // agent CLI reads the interrupt as "stop what you are doing", and this one read it as
  // "throw the session away", which is a bad trade when the thing you want to stop is a
  // twenty-minute run. With a turn in flight the abort goes to the daemon and the REPL
  // stays. Pressed again — or with nothing running — it exits as before.
  let interrupted = false;
  rl.on('SIGINT', () => {
    if (turnStartedAt && !abortedTurn) {
      abortedTurn = true;
      emit(renderNote('interrupting — ctrl-c again to leave bigkiji', view()));
      // Two halves, and both are needed. The abort below tells the coordinator to stop
      // the run; this releases the await the REPL is sitting on, so the next command is
      // not queued behind an answer the owner has already abandoned.
      try { turnAbort?.abort(); } catch (_) {}
      client.post('/api/abort')
        .then((result) => emit(renderToolCall('abort', phrase(result?.status || 'sent'), view())))
        .catch((error) => emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 2, isError: true })))
        .finally(() => { paintFooter(true); refreshPrompt(); });
      return;
    }
    interrupted = true; rl.close();
  });
  rl.on('close', () => {
    clearTimeout(quietTimer); clearTimeout(pasteTimer);
    if (process.stdin.isTTY) { process.stdin.off('data', watchPaste); rl.output = process.stdout; process.stdout.write('\x1b[?2004l'); }
    if (ticker) clearInterval(ticker); clearInterval(statePoll); sticky.stop(); client.disconnect();
    process.exit(interrupted ? 130 : 0);
  });
  // Say what is already waiting, on the way in.
  //
  // offerApproval() only fires on a `run` event, so a run that went to sleep waiting
  // before this session started announced itself nowhere: the transcript opened empty
  // and the sole mention was a footer segment. That is the exact shape of the original
  // failure — two runs waiting eleven hours while the owner asked whether anything was
  // happening — so the first thing the transcript says is what is waiting for them.
  const waitingAtStart = waitingRuns();
  if (waitingAtStart.length) {
    emit([...renderToolCall('runs', `${waitingAtStart.length} waiting for you`, view()),
      ...renderNote(`nothing is running. /runs to read them ${glyphs().note} /approve ${shortRunId(waitingAtStart.at(-1).id)} to start the newest`, view())]);
  }
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

/**
 * `bigkiji check` — what the phone has sent, ready to read.
 *
 * The download step is the whole reason this is a command rather than `ls`: with
 * "Optimize Mac Storage" on, a file the phone uploaded is a zero-byte stub here until
 * something asks iCloud for the bytes. Without this, the answer to "look at what I
 * sent you" is an empty folder.
 */
async function printCheckFolder() {
  const { createPathConfig } = require('../../core/path-config');
  const check = require('../../core/check-folder');
  const dirs = check.ensure(createPathConfig({ appRoot: APP_ROOT }).checkRoot);
  const pulled = await check.materialise(dirs.input);
  if (pulled.requested) {
    console.log(`${A.dim}iCloud から ${pulled.arrived.length}/${pulled.requested} 件を取り寄せました${A.reset}`);
    for (const name of pulled.stillPending) console.log(`${A.warning}まだ届いていません: ${name}${A.reset}`);
  }
  console.log(check.summarise(check.inventory(dirs.input), { now: Date.now() }));
  console.log(`${A.dim}${dirs.root}${A.reset}`);
}

async function main(argv = process.argv.slice(2)) {
  installSignalHandlers();
  // Before the daemon handshake on purpose: looking at what the phone sent is reading
  // a folder, and it has to work when the engine is down or the owner is in a hurry.
  if (String(argv[0] || '').replace(/^\//, '').toLowerCase() === 'check') { await printCheckFolder(); return; }
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
      console.log(renderNote(`awaiting your approval — run \`bigkiji\` and type /approve ${shortRunId(result.run.id)} to start it, or /reject to drop it.`, options).join('\n'));
    }
    return;
  }
  await repl(client);
}

if (require.main === module) {
  main().catch((error) => { console.error(`${A.error}✗ ${error.message}${A.reset}`); process.exit(1); });
}

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, installSignalHandlers, APP_ROOT };
