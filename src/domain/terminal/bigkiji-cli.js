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
const { buildFooter, footerHeightFor, runningAgents, formatElapsed } = require('../../cli/tui/footer');
const { loadingFrames, frameAt } = require('../../cli/tui/loading-frames');
const {
  DASH, glyphs, lower, phrase, renderAssistantText, renderEvent, renderNote, renderStatus, renderToolCall, renderToolResult,
  renderUserTurn, shortRunId, shortenPath, truncateToWidth,
} = require('../../cli/tui/transcript');
const { CliPreferences, HISTORY_LIMIT } = require('./cli-preferences');
const { redactPayload } = require('../pi-core/security/payload-redactor');
const { themeFor, nextMode, normalizeMode, transportMode } = require('./cli-theme');

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_VERSION = require('../../../package.json').version;
// The one degraded reason that describes the machine rather than the turn, and therefore
// the one that must not outlive the machine being in that state. See `machineNote`.
const FROZEN_TURN_NOTE = 'local model frozen — gpu busy';
let activeMode = 'plan'; let A = themeFor(activeMode);

/**
 * What the footer says about the machine, taken from the machine.
 *
 * `turnNote` is a fact about the last turn and was drawn as a fact about now. Measured on
 * the owner's machine 2026-08-10: the render finished at 12:00 — `/tmp/bigkiji_gpu.lock`
 * gone, every Ollama process back in state S — and at 12:32 the footer still read
 * "local model frozen — gpu busy". The only thing that would have cleared it was typing
 * another turn, which is precisely what an owner does not do while the screen says the
 * model is stopped. It spent thirty-two minutes lying about the single fact that decides
 * whether asking is worth it.
 *
 * The freeze comes from the four-second state poll now, so it reads forwards as well as
 * backwards: the model stopping shows up without having to ask it first. A turn's own
 * degraded reason still shows when the machine is fine and that one turn was not.
 */
function machineNote({ gpu = null, turnNote = '' } = {}) {
  if (gpu?.frozen) {
    return gpu.orphaned
      ? 'local model frozen — nobody holds the gpu'
      : `local model frozen — gpu busy${gpu.holder ? ` (${lower(gpu.holder)})` : ''}`;
  }
  // The machine is fine, so a freeze remembered from an earlier turn is not news about it.
  return turnNote === FROZEN_TURN_NOTE ? '' : turnNote;
}

// What the owner may press when a plan is waiting for them.
//
// `y n t` because that is the shape they asked for, and `t` means what it means in Claude
// Code: do not run it, and say what to change. The digits stay alongside — they were the
// only keys for as long as this prompt has existed and fingers remember them, and taking
// away what someone already types is a second thing to learn rather than a simpler one.
//
// Out here rather than inline so the contract can be asserted without a daemon, a tty or
// a run: what these keys mean is the part that must not drift.
// The letters a question's options are offered under.
//
// The same letters `questionText` prints beside them (fast-api-router), and they have to
// stay the same letters: the owner reads "b) Upclass" on one line and presses b on the
// next. Two lists that drift are a prompt that lies. Five because normalizeQuestions caps
// options at five.
const PICK_LETTERS = Object.freeze(['a', 'b', 'c', 'd', 'e']);

// How many past sessions the resume picker shows at once. Twelve fits a short terminal
// with the header, the two markers and the prompt still on screen.
const SESSION_WINDOW = 12;
// How much of a resumed conversation is replayed. Enough to remember where you were,
// not so much that the thing you resume into is a wall of your own old text.
const RESUME_TURNS = 6;

/** True when every question can be answered by pressing one key. */
function pickable(questions) {
  return Array.isArray(questions) && questions.length > 0
    && questions.every((question) => Array.isArray(question?.options) && question.options.length > 0);
}

/** The answer string a set of presses makes — the format the prompt itself documents. */
function answerFromPicks(picks) {
  return picks.map((letter, index) => `${index + 1}${letter}`).join(' ');
}

// `a` is Claude Code's "Yes, and auto-accept edits", which is the same sentence this
// fleet spells `auto-edit`: approve this plan, and stop stopping. It is the one key
// here that changes what happens after the run it is pressed on, so it says so on
// screen when it is used — see offerApproval.
const APPROVAL_CHOICES = Object.freeze([
  Object.freeze({ id: 'approve', keys: Object.freeze(['y', 'Y', '1']) }),
  Object.freeze({ id: 'auto', keys: Object.freeze(['a', 'A']) }),
  Object.freeze({ id: 'reject', keys: Object.freeze(['n', 'N', '2']) }),
  Object.freeze({ id: 'tell', keys: Object.freeze(['t', 'T']) }),
  Object.freeze({ id: 'later', keys: Object.freeze(['l', 'L', '3']) }),
]);

/**
 * The files this process is actually running, and when they were last written.
 *
 * `require.cache` is the exact answer — not a guess at which modules matter, not a glob
 * over the tree, but the list of files Node loaded into this process. Compared against
 * itself later, it answers one question: is the code I am running still the code on disk?
 *
 * The owner asked three times in one evening why a change they had just approved was not
 * on screen, and the answer each time was that their terminal had been open since before
 * it. Nothing said so. `build-info.json` cannot say so either — it is stamped when a build
 * is made (last on 2026-08-09), so it is blind to every edit since.
 *
 * Measured: 11 files, 32–71µs per sweep. Cheap enough for the four-second poll that
 * already exists.
 */
function loadedSources(cache = require.cache) {
  return Object.keys(cache).filter((file) => file.includes(`${path.sep}src${path.sep}`) && !file.includes('node_modules'));
}

/**
 * True when a typed line is safe to keep in the history file.
 *
 * `redactPayload().blocked` is not the test: it is only true for a private key, so a
 * pasted API token comes back unblocked and would have been written to disk verbatim.
 * The findings are the test. Emails and phone numbers are excluded from the rule rather
 * than from the file — the owner types those on purpose here (LINE, students, the
 * classroom), the session log beside it already holds every turn in full, and dropping
 * them would quietly make ordinary lines unrepeatable.
 */
function keepInHistory(line, redact = redactPayload) {
  const { findings } = redact(String(line || ''));
  return !findings.some((finding) => finding.type !== 'email' && finding.type !== 'phone');
}

/** True when any file this process loaded has been written since it loaded it. */
function sourcesChanged(seen) {
  for (const [file, at] of seen) {
    try { if (fs.statSync(file).mtimeMs > at) return true; } catch (_) { /* deleted counts as unchanged */ }
  }
  return false;
}

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

/**
 * The reading width for prose, clamped at both ends.
 *
 * 40 because narrower than that nothing wraps sensibly; 200 because a sentence measured
 * across a full-screen terminal is a line the eye cannot return from — the reason every
 * newspaper sets narrow columns on a wide page. This ceiling has been here since the CLI
 * was written and it only ever applied to `process.stdout.columns`; the sticky screen
 * hands the transcript `sticky.cols` straight from the terminal, so on a wide window
 * English ran the entire width while the header and footer stayed inside their borders.
 */
function clampWidth(columns) { return Math.max(40, Math.min(200, Number(columns) || 80)); }

/** Terminal width, honest about the fact that a pipe has none. */
function screenWidth(output = process.stdout) { return clampWidth(output.columns); }

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
function header(state = {}, width = screenWidth(), frame = 0, phase = state?.phase) {
  const mark = glyphs();
  // The workspace moved inside the panel — it is the third row now, beside the cat's
  // nose — so repeating it here would be the same fact twice in four rows.
  //
  // `phase` is passed explicitly rather than left to `state.phase`: the REPL tracks the
  // live phase in its own variable, updated from the SSE stream between the slow state
  // polls, and reading it off the last polled snapshot would leave the gauge up to four
  // seconds behind the chips it sits under.
  const panel = modelPanel({ workspace: process.cwd(), ...state },
    { width, theme: A, label: ` bigkiji universe v${APP_VERSION} `, frame, phase });
  const facts = truncateToWidth(`pi-orchestrator ${mark.note} core 8777 ${mark.note} pid ${state.pid || '—'}`, width);
  return [...panel, `${A.dim}${facts}${A.reset}`].join('\n');
}

/**
 * Every command this REPL answers to, in one table.
 *
 * There were two lists and they had drifted: the hint row advertised eight commands and
 * the dispatcher below answered to nineteen, so `/resume`, `/ideas`, `/run`, `/clear`,
 * `/abort`, `/reload` and `/hud` existed and were announced nowhere. Measured on the
 * owner's own session file, 2026-08-11 10:55: they typed `/reaume`, which no list would
 * have caught, and it went to a model as a conversation turn — eight seconds and a
 * generation to be told "did you mean /resume?".
 *
 * The hint row, `/help`, tab completion and the did-you-mean all read this table now.
 * Two lists that drift are a prompt that lies, which is the same argument PICK_LETTERS
 * makes about the letters beside a question.
 *
 * `pinned` is the subset the header advertises — the row is one line wide and the
 * whole table is not.
 */
const COMMANDS = Object.freeze([
  { name: '/help', hint: 'commands', pinned: true },
  { name: '/status', hint: 'fleet', alias: ['/fleet'], pinned: true },
  { name: '/runs', hint: 'what is waiting', pinned: true },
  { name: '/approve', hint: 'start it', pinned: true },
  { name: '/reject', hint: 'drop it' },
  { name: '/answer', hint: 'reply to a question', pinned: true },
  { name: '/run', hint: 'an explicit execution plan' },
  { name: '/pi', hint: 'talk to pi', pinned: true },
  { name: '/ideas', hint: 'local drafts' },
  { name: '/idea', hint: 'plan · enhance · send · adopt · archive' },
  { name: '/resume', hint: 'a past session' },
  { name: '/mode', hint: 'ask · plan · auto-edit · demo' },
  { name: '/setting', hint: 'contrast · cat · accent', alias: ['/settings'] },
  { name: '/gpu', hint: 'free vram — /gpu off', pinned: true },
  { name: '/abort', hint: 'stop the work' },
  { name: '/clear', hint: 'clear the screen' },
  { name: '/reload', hint: 'reload the engine' },
  { name: '/hud', hint: 'open the window' },
  { name: '/exit', hint: '', alias: ['/quit'], pinned: true },
]);
const COMMAND_NAMES = Object.freeze(COMMANDS.flatMap((entry) => [entry.name, ...(entry.alias || [])]));

/** Levenshtein distance, capped by nothing — the strings here are one word long. */
function editDistance(a, b) {
  const rows = a.length + 1; const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[cols - 1];
}

/**
 * The command a typo was reaching for, or '' when the line is not a command at all.
 *
 * Deliberately narrow. An absolute path is the thing most likely to open a line with a
 * slash — `/Users/yuma/…` — so anything with a second slash, a capital, or a space
 * inside the first word is prose and is left alone. Being wrong here means eating a
 * sentence the owner meant to send.
 *
 * @returns {{typed: string, meant: string}|null}
 */
function unknownCommand(text) {
  const typed = String(text || '').trim().split(/\s+/)[0];
  if (!/^\/[a-z][a-z0-9-]*$/.test(typed)) return null;
  if (COMMAND_NAMES.includes(typed)) return null;
  const ranked = COMMANDS.map((entry) => ({ name: entry.name, distance: editDistance(typed, entry.name) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  return { typed, meant: best && best.distance <= 3 ? best.name : '' };
}

/**
 * Tab completion over the table. readline's contract is `[hits, substring]`, and the
 * substring is the whole first word — so pressing tab on `/ap` replaces it with
 * `/approve`, and pressing it on `/` lists everything.
 */
function completeCommand(line) {
  const text = String(line || '');
  // Past the command word there is nothing here to complete: `/idea plan <id>` takes an
  // id this table has never heard of, and offering command names there would be noise.
  if (!text.startsWith('/') || /\s/.test(text)) return [[], text];
  const hits = COMMANDS.map((entry) => entry.name).filter((name) => name.startsWith(text));
  return [hits.length ? hits : COMMANDS.map((entry) => entry.name), text];
}

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
  for (const { name: command, hint: detail } of COMMANDS.filter((entry) => entry.pinned)) {
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
  // The keys, under the commands they operate on.
  //
  // Every one of these existed before this row did, and none of them was written down
  // anywhere the owner types: shift+tab was advertised in a monitor view they do not
  // use, tab completion and esc are new today, and ctrl-c was documented in the middle
  // of a paragraph of /help. A shortcut nobody can see is a shortcut nobody presses.
  const keys = [['tab', 'complete'], ['⇧⇥', 'mode'], ['esc', 'interrupt'], ['ctrl-c', 'stop']]
    .map(([key, what]) => `${A.violet}${key}${A.reset} ${A.muted}${what}${A.reset}`).join(`${A.dim}  ${A.reset}`);
  lines.push(`${keys}${A.reset}`);
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

/** How long ago, in the same vocabulary the footer uses for elapsed work. */
function agoLabel(value, now = Date.now()) {
  const at = new Date(value || 0).getTime();
  if (!Number.isFinite(at) || at <= 0) return DASH;
  return `${formatElapsed(Math.max(0, now - at))} ago`;
}

/** The rows a session picker shows, newest first, already fitted to the width. */
function sessionRows(sessions, { index = 0, top = 0, window = SESSION_WINDOW, width = 80, now = Date.now() } = {}) {
  const shown = sessions.slice(top, top + window);
  const ago = shown.map((session) => agoLabel(session.updatedAt, now));
  const status = shown.map((session) => phrase(session.status || 'idle'));
  const agoWidth = Math.max(0, ...ago.map((text) => text.length));
  const statusWidth = Math.max(0, ...status.map((text) => text.length));
  return shown.map((session, offset) => {
    const chosen = top + offset === index;
    const head = `${chosen ? '›' : ' '} ${ago[offset].padEnd(agoWidth)}  ${status[offset].padEnd(statusWidth)}  `;
    const summary = String(session.promptSummary || '').replace(/\s+/g, ' ').trim() || '(no first line)';
    return { chosen, session, text: truncateToWidth(`${head}${summary}`, Math.max(20, width - 1)) };
  });
}

/**
 * Pick a past session with the arrow keys.
 *
 * Two things were wrong with this and both of them were invisible until you tried it.
 *
 * readline was never stood down. It is still attached to the same tty in the same raw
 * mode, so ↑ moved this selection *and* pulled the previous input line back into the
 * prompt underneath, and the Enter that chose a session was also the Enter that
 * submitted that line — resuming a session could send a turn nobody typed. `askKey()`
 * pauses readline for exactly this reason and this function never did; the `picking`
 * flag in repl() is the second half, because pausing an interface is not the same as
 * being sure it will not act.
 *
 * And the list showed twelve rows while the cursor walked all 103 sessions on this
 * machine, so pressing ↑ once from the top selected something nobody could see. The
 * window follows the cursor now, and says how many are above and below it.
 *
 * @param {object} client
 * @param {{rl?: object, width?: number}} [options]
 */
async function selectSession(client, { rl = null, width = screenWidth() } = {}) {
  const { sessions } = await client.sessions();
  if (!sessions.length) { console.log(`${A.dim}no saved sessions yet.${A.reset}`); return null; }
  if (!process.stdin.isTTY) return sessions[0];
  const wasRaw = process.stdin.isRaw;
  rl?.pause();
  let index = 0; let top = 0;
  const render = () => {
    // Keep the cursor inside the window, then keep the window inside the list.
    top = Math.min(Math.max(top, index - SESSION_WINDOW + 1), index);
    top = Math.max(0, Math.min(top, Math.max(0, sessions.length - SESSION_WINDOW)));
    const above = top; const below = Math.max(0, sessions.length - top - SESSION_WINDOW);
    process.stdout.write('\x1b[H\x1b[2J');
    console.log(`${A.bold}resume a bigkiji session${A.reset}  ${A.dim}${sessions.length} on record${A.reset}`);
    console.log(`${A.dim}↑/↓ select · enter resume · esc cancel${A.reset}\n`);
    if (above) console.log(`  ${A.dim}${glyphs().ellipsis} ${above} newer${A.reset}`);
    for (const row of sessionRows(sessions, { index, top, width })) {
      console.log(`${row.chosen ? `${A.accent}${row.text}` : row.text}${A.reset}`);
    }
    if (below) console.log(`  ${A.dim}${glyphs().ellipsis} ${below} older${A.reset}`);
  };
  render(); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve) => {
    const key = (buf) => {
      const value = buf.toString();
      if (value === '\x1b[A' || value === 'k') index = (index - 1 + sessions.length) % sessions.length;
      else if (value === '\x1b[B' || value === 'j') index = (index + 1) % sessions.length;
      else if (value === '\r' || value === '\n') return done(sessions[index]);
      else if (value === '\x1b' || value === '\x03' || value === 'q') return done(null);
      render();
    };
    const done = (value) => {
      process.stdin.off('data', key);
      if (!wasRaw) process.stdin.setRawMode(false);
      rl?.resume();
      resolve(value);
    };
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
  // `completer` is tab completion over the command table; `history` is the up arrow
  // surviving a restart, which it never has. readline hands both back on `rl.history`,
  // newest first, and that is what gets written out again on the way to exit.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout,
    prompt: `${A.prompt}>${A.reset} `, completer: completeCommand, history: prefs.history(), historySize: HISTORY_LIMIT });
  const sticky = new StickyScreen({ output: process.stdout, footerHeight: footerHeightFor(frameSet) });
  let inputOffset = frameSet.rows + 2; let frameIndex = 0; let turnStartedAt = 0; let comment = ''; let phaseInfo = live.phase; let painted = '';
  let degradedTurn = false; let degradedWhy = ''; // sticky until a turn the model actually serves
  let awaitingAnswer = false; // the front desk is holding a run until the owner answers
  let staleCode = false; // a file this process is running has changed on disk since it started
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
      busy: turnStartedAt > 0, elapsedMs: turnStartedAt ? Date.now() - turnStartedAt : null, frameIndex, frameSet,
      degraded: degradedTurn, degradedNote: machineNote({ gpu: live?.gpu, turnNote: degradedWhy }), awaitingAnswer, staleCode });
    inputOffset = inputIndex;
    const signature = lines.join(' ');
    if (!force && signature === painted) return;
    painted = signature;
    sticky.setFooter(lines, { paint: false });
    process.stdout.write('\x1b[?25l'); refreshPrompt(); process.stdout.write('\x1b[?25h');
  };
  // The gauge lives in the header now, so a phase change has to repaint the header.
  //
  // The footer is repainted on every tick and after every event; the header was only
  // redrawn while a turn was in flight, because until today the only thing on it that
  // moved was the cat. `restoreHeader()` addresses the header rows absolutely and cannot
  // touch the transcript, and the header's height does not change with the phase — the
  // two gauge rows are always there — so this cannot trigger a re-layout.
  const paintHeader = () => { if (!sticky.active) return; const out = sticky.restoreHeader(); if (out) process.stdout.write(out); };
  // A function, not an array: StickyScreen re-evaluates it on every layout, so a
  // resize re-renders the panel and the hints at the new width instead of repainting
  // lines measured for the old one.
  const stickyOn = sticky.start({ header: (cols) => [...header(live, cols, frameIndex, phaseInfo).split('\n'), ...hintLines(cols)], onLayout: () => paintFooter(true) });
  const say = (value) => {
    const text = typeof value === 'string' ? value : util.inspect(value, { colors: process.env.NO_COLOR === undefined, depth: 4 });
    if (sticky.active) sticky.print(text); else console.log(text);
  };
  // Transcript width and shared render options: every renderer measures against
  // the live terminal so wrapped lines hang at the content column and nothing
  // is ever allowed to run past the right edge.
  // The clamp applies to the transcript only. The header panel and the footer are borders
  // drawn to the edge of the window on purpose — narrowing those would leave a gap on the
  // right of the screen. It is the prose that needs a column.
  const view = () => ({ width: sticky.active ? clampWidth(sticky.cols) : screenWidth(), theme: A, mark: glyphs() });
  const emit = (lines) => { const list = Array.isArray(lines) ? lines : [lines]; if (list.length) say(list.join('\n')); };
  /**
   * The one place the mode changes, because the mode is painted in three.
   *
   * `setMode()` swaps the module-level palette, but the prompt string was baked into
   * createInterface() above and never read it again: `/mode auto-edit` moved the word in
   * the footer and left the `>` wearing the colour of the mode you had just left. The
   * colour is the half you take in without reading, so it was the half that lied — and
   * both `/mode` and `/setting mode` have had that bug for as long as they have existed.
   *
   * restoreHeader() repaints the hint lines in the new accent *without* changing the
   * header's height. Height is the dangerous part: `get top()` is derived from it, and a
   * different top means a full re-layout, which is the path that used to throw the
   * transcript away.
   */
  const applyMode = (next) => {
    const before = mode;
    mode = setMode(next);
    rl.setPrompt(`${A.prompt}>${A.reset} `);
    // `demo` is the only mode whose name does not say what it does: the coordinator
    // skips the approval gate for it and the daemon skips the clarifying questions.
    // Said once, on the way in — a word alone is not a warning.
    if (mode === 'demo' && before !== 'demo') emit(renderNote('demo — 承認も確認もされません', view()));
    const head = sticky.restoreHeader();
    if (head) process.stdout.write(head);
    paintFooter(true);
    return mode;
  };
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
      // The key we just consumed is also on the input line, and it has been all along.
      //
      // `rl.pause()` stops readline reading more; it does not stop it handling the byte
      // that has already arrived, so the same press lands in both places. Measured in a
      // pty 2026-08-11: answering a gate with `n` left `n` sitting at the prompt, which
      // prefixes the next thing typed — and, worse, makes `!rl.line` false, so the NEXT
      // plan that arrives silently falls back to the note instead of offering the keys.
      // One approval by key would quietly disarm the prompt for the rest of the session.
      rl.line = ''; rl.cursor = 0;
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
  // The resume list has the keyboard. Nothing else may read a key or take a line while
  // it does — see selectSession.
  let picking = false;
  // Set by `t` at the approval prompt; consumed by the next line the owner types.
  let pendingTell = null;

  /**
   * The front desk's questions, answered by pressing a letter.
   *
   * They have always arrived with options — `normalizeQuestions` gives every question up
   * to five and `questionText` letters them a) b) c) — and the owner has always had to
   * read them and then type `1a 2c` by hand. The structured questions were already on the
   * turn result, beside the `awaitingAnswer` flag this file did read; nothing had ever
   * looked at them.
   *
   * One question at a time, because one key cannot answer four. What comes back is the
   * same `1a 2c` string the owner would have typed, in the format the prompt itself
   * documents — this assembles an answer, it does not invent a second way to send one.
   *
   * @returns {Promise<string|null>} null when the owner would rather type, or leave it
   */
  const pickAnswers = async (questions) => {
    const letters = PICK_LETTERS;
    const mark = glyphs().note;
    const parts = [];
    for (const [index, question] of questions.entries()) {
      // A question with no options is a request for prose. Offering keys for it would be
      // pretending there is a choice, so the whole set falls back to typing.
      if (!pickable([question])) return null;
      const shown = question.options.slice(0, letters.length);
      emit([...renderNote(`${index + 1}/${questions.length}  ${question.ask}`, view()),
        ...shown.map((option, j) => `   ${A.accent}${letters[j]}${A.reset}  ${A.ink}${option}${A.reset}`),
        ...renderNote(`o ${mark} おまかせ   t ${mark} 打ち込む   (esc = 後で)`, view())]);
      const choices = shown.map((_, j) => ({ id: letters[j], keys: [letters[j], letters[j].toUpperCase()] }));
      choices.push({ id: '__any', keys: ['o', 'O'] }, { id: '__type', keys: ['t', 'T'] });
      const picked = await askKey(choices);
      if (picked === '') return null;          // esc — nothing is sent, the question stays on screen
      if (picked === '__type') return null;    // prose wanted; the question is already printed
      // 「おまかせ」 answers all of them at once, which is what it means and what the
      // prompt already tells the owner they may say. Asking the rest afterwards would be
      // ignoring what they just chose.
      if (picked === '__any') return 'おまかせ';
      parts.push(picked);
    }
    return answerFromPicks(parts);
  };
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
    // Every mode that can arrive here now takes the key.
    //
    // This read `mode === 'ask'`, on the reasoning that `plan` states things and gets
    // out of the way. What that produced, measured on the owner's machine 2026-08-10:
    // eleven runs at AWAITING_APPROVAL, the owner asking why it kept stopping, and a
    // fleet that had been idle for hours behind a prompt that never offered a key —
    // because `plan` is the mode they had chosen and the mode the migration hands
    // everybody. `demo` is the one exclusion: nothing stops to ask in demo, so nothing
    // reaches this function.
    //
    // Not while they are typing: the prompt reads raw keys, so grabbing the keyboard
    // mid-sentence would eat the line. A half-written line falls back to the note.
    const interactive = mode !== 'demo' && process.stdin.isTTY && !deciding && !rl.line;
    const mark = glyphs().note;
    if (!interactive) {
      emit(renderNote(`waiting for you — /approve ${id} to start it, /reject to drop it, /runs to see them all`, view()));
      return;
    }
    // The three doors Claude Code offers, in the owner's language: start it, start it
    // and stop asking, or say what to change. Laid out one per row rather than as a
    // sentence of separators, because this is the moment the screen is asking for a
    // decision and a decision is easier to read as a list than as prose.
    emit([...renderNote('ここから始めますか？', view()),
      `   ${A.accent}y${A.reset}  ${A.ink}はい、この計画で始める${A.reset}`,
      `   ${A.accent}a${A.reset}  ${A.ink}はい、以降は毎回きかない${A.reset} ${A.muted}(auto-edit)${A.reset}`,
      `   ${A.accent}t${A.reset}  ${A.ink}いいえ、直したいことを書く${A.reset}`,
      ...renderNote(`esc = あとで  ${mark}  n = やめる  ${mark}  /approve ${id} でいつでも開始`, view())]);
    deciding = true;
    askKey(APPROVAL_CHOICES)
      .then(async (choice) => {
        if (choice === 'approve') await approveRun(run);
        else if (choice === 'reject') await rejectRun(run);
        // Approve this one, and stop stopping. The mode is the thing that decides
        // whether the next writing run waits, so this changes the mode and says so:
        // a key that quietly widens what the fleet may do unasked is the one kind of
        // shortcut this CLI must not have. What it does not do is release the other
        // plans already waiting — they were submitted under the old mode and are still
        // theirs to approve — and saying that here is cheaper than finding out later.
        else if (choice === 'auto') {
          applyMode('auto-edit');
          emit(renderNote(`auto-edit — これ以降、書き込む計画も止まりません（⇧⇥ で戻せます）${
            waitingRuns().length > 1 ? `。いま待っている他の計画はそのままです` : ''}`, view()));
          await approveRun(run);
        }
        // Nothing runs. The next line the owner types becomes the correction, and the
        // plan is rewritten from it — Claude Code's "No, and tell Claude what to do
        // differently", which is what the owner asked this key to mean.
        //
        // Deliberately NOT `rl.question()`. Calling it from inside an approval would put
        // two owners on the input row while the sticky layout addresses it absolutely;
        // askKey's own comment records why this file does not take that risk. The line
        // handler already exists and already knows how to be interrupted, so the
        // correction is picked up there instead of read here.
        else if (choice === 'tell') {
          pendingTell = { runId: run.id, id };
          emit(renderNote(`not starting it. type what to change and press enter  ${mark}  empty line = leave it waiting`, view()));
        } else emit(renderNote(`left waiting — /approve ${id} when you are ready`, view()));
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
  // What this process loaded, and when. Read once, here, so the comparison later is
  // against the moment this terminal started rather than against anything else.
  const loadedAt = new Map(loadedSources().map((file) => {
    try { return [file, fs.statSync(file).mtimeMs]; } catch (_) { return [file, 0]; }
  }));
  // The header carries fleet counts and the workspace as well as the gauge, so the slow
  // poll repaints it too — otherwise `6/6 ready` would be whatever it was at startup.
  const statePoll = setInterval(() => {
    // Sticky once true: code does not become fresh again, and a warning that flickers is
    // a warning nobody reads.
    if (!staleCode && sourcesChanged(loadedAt)) { staleCode = true; paintFooter(true); }
    client.state().then((next) => { live = next; paintFooter(); paintHeader(); }).catch(() => {});
  }, 4000); statePoll.unref?.();
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
    else if (event === 'phase') { phaseInfo = data; paintHeader(); }
    else if (event === 'run') {
      const before = phaseInfo;
      phaseInfo = data.status || phaseInfo;
      if (phaseInfo !== before) paintHeader();
      // Keep the live list current between four-second polls: the footer's waiting
      // count and /approve both read it, and a stale one under-reports what is waiting.
      live = { ...live, runs: mergeRun(live.runs, data) };
    }
    if (!RELAY_EVENTS.includes(event)) { paintFooter(); return; }
    // A step's `phase` is 'start' or 'end' — machinery, not a status. Letting the
    // generic extraction below reach it would put the word "start" in the comment slot
    // where the owner is looking for what is happening.
    if (event === 'step') {
      // How many lines of the patch this terminal can spare. A step is published while the
      // owner is still typing, so a 40-line diff on a 24-row pane pushes their own prompt
      // off the screen — the cap is a third of the window, and stream-steps has already
      // capped the body itself before it reached the wire.
      const rows = Math.max(12, Number(process.stdout.rows) || 24);
      const lines = renderEvent('step', data, { ...view(), label: stepLabel(data), diffLines: Math.max(4, Math.min(16, Math.floor(rows / 3))) });
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
    // The line after `t` at the approval prompt is a correction, not a new request.
    //
    // Taken here rather than read inside offerApproval, because this is the one place
    // that already owns the input row. A blank line means the owner changed their mind,
    // and the run is left exactly where it was — waiting, not dropped.
    if (pendingTell) {
      const { runId, id } = pendingTell; pendingTell = null;
      if (sticky.active && text) emit(renderUserTurn(text, view()));
      if (!text) { emit(renderNote(`left waiting — /approve ${id} when you are ready`, view())); paintFooter(true); refreshPrompt(); return; }
      turnStartedAt = Date.now(); frameIndex = 0; abortedTurn = false; paintFooter(true);
      try {
        emit(renderToolCall('tell', `${lower(id)} ${glyphs().note} rewriting the plan`, view()));
        const result = await client.answerRun(runId, text);
        emit([...renderToolResult(result.spec || 'plan rewritten', { ...view(), indent: 2, maxLines: 10 }),
          ...renderNote(`${lower(shortRunId(result.run?.id || ''))} replaces ${lower(shortRunId(result.answered || ''))} — it is waiting for you`, view())]);
        live = await client.state();
      } catch (error) {
        emit(renderToolResult(error.message, { ...view(), indent: 0, maxLines: 3, isError: true }));
      } finally { turnStartedAt = 0; paintFooter(true); refreshPrompt(); }
      return;
    }
    if (sticky.active && text) emit(renderUserTurn(text, view()));
    if (text) { turnStartedAt = Date.now(); frameIndex = 0; abortedTurn = false; paintFooter(true); } // elapsed clock starts the moment the owner hits Enter
    // Resolved once, in front of the chain, because the chain below is the list it has
    // to be checked against — every branch of it is a command this is not.
    const mistyped = unknownCommand(text);
    try {
      if (!text) {}
      else if (['/exit', '/quit'].includes(text)) { rl.close(); return; }
      else if (text === '/status' || text === '/fleet') { live = await client.state(); emit(renderStatus(live, view())); }
      else if (text === '/setting' || text === '/settings' || text.startsWith('/setting ') || text.startsWith('/settings ')) {
        const [, key, requested] = text.split(/\s+/); const value = prefs.get();
        if (key) {
          if (key === 'mode') applyMode(requested);
          else if (key === 'contrast' && ['standard', 'high'].includes(requested)) prefs.update({ contrast: requested });
          else if (key === 'cat' && ['low', 'periodic'].includes(requested)) prefs.update({ catCommentary: requested });
          else if (key === 'accent' && ['follow', 'fixed-orange'].includes(requested)) prefs.update({ modeAccent: requested });
          else throw new Error('usage: /setting mode ask|auto-edit|plan|demo | contrast standard|high | cat low|periodic | accent follow|fixed-orange');
        }
        const current = prefs.get();
        emit([...renderToolCall('settings', `theme warm-brown · mode ${mode}`, view()),
          ...renderToolResult(`mode accent: ${current.modeAccent}\ncontrast: ${current.contrast}\ncat commentary: ${current.catCommentary}`, { ...view(), maxLines: 6 })]);
      }
      else if (text.startsWith('/mode ')) { const next = text.slice(6).trim(); if (!['ask', 'auto-edit', 'plan', 'auto', 'manual', 'demo'].includes(next)) throw new Error('mode must be ask, auto-edit, plan, or demo'); applyMode(next); emit(renderToolCall('mode', mode, view())); }
      // Resuming lands you back in the conversation, not just in its id.
      //
      // This printed the session id and its first line and stopped there, which answers
      // "which one did I pick" and not "where was I". The last few turns are already on
      // disk — `client.session()` returns the whole JSONL — so they are replayed into
      // the transcript in the same two renderers a live turn uses.
      else if (text === '/resume') {
        const wasSticky = sticky.active;
        if (wasSticky) sticky.suspend();
        picking = true;
        const session = await selectSession(client, { rl, width: screenWidth() }).finally(() => { picking = false; });
        if (wasSticky) sticky.resume();
        if (session) {
          sessionId = session.id;
          emit(renderToolCall('resume', `${lower(shortRunId(session.id))} ${glyphs().note} ${agoLabel(session.updatedAt)}`, view()));
          const full = await client.session(session.id).catch(() => null);
          const turns = (full?.events || [])
            .filter((event) => event.type === 'conversation' && String(event.text || '').trim())
            .slice(-RESUME_TURNS);
          for (const turn of turns) {
            emit(turn.role === 'owner'
              ? renderUserTurn(turn.text, view())
              : renderAssistantText(turn.text, { ...view(), maxLines: 6 }));
          }
          emit(renderNote(turns.length
            ? `${turns.length} turn${turns.length === 1 ? '' : 's'} back on screen — carry on where you left off`
            : String(session.promptSummary || 'nothing was said in this session'), view()));
        }
      }
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
          // Folded: this is a list of plans, not a reading of each one. The gate prints
          // the whole thing, and `/approve <id>` is one line away.
          ...(runs.length ? shown.flatMap((run) => renderEvent('run', run, { ...view(), plan: 'brief' }))
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
      // /help was one paragraph in which nineteen commands, four keys and the whole
      // approval model were the same run of dim text. The transcript can draw markdown
      // now, so this is a document — and the command list is generated from the table
      // rather than written out again, which is how the two came to disagree.
      else if (text === '/help') {
        emit(renderAssistantText([
          '## commands',
          ...COMMANDS.map((entry) => `- \`${entry.name}\`${entry.hint ? ` — ${entry.hint}` : ''}`),
          '## keys',
          '- `tab` complete a command · `⇧⇥` change mode · `esc` interrupt · `ctrl-c` stop, twice to leave',
          '## how it works',
          'talk naturally. ideas stay local as drafts, and `/run` asks for an explicit execution plan.',
          'read-only work starts on its own and reports each step as it happens; anything that writes waits for you.',
          'at the gate: **y** starts it, **a** starts it and stops asking, **t** rewrites the plan from what you type next.',
          'when a plan shows an unanswered question, `/answer [id] <your answer>` rewrites it from your reply instead of starting it on a guess.',
          '`/pi` consults pi directly — it has no tools and cannot run anything.',
        ].join('\n'), view()));
      }
      // A slash the dispatcher does not know is not a sentence.
      //
      // Measured 2026-08-11 10:55 in the owner's own session: `/reaume` was sent to the
      // conversation model, which spent eight seconds answering "did you mean /resume?".
      // That answer was correct and cost a generation; this one is free and instant.
      else if (mistyped) {
        const { typed, meant } = mistyped;
        emit(renderNote(meant
          ? `${typed} is not a command — did you mean ${meant}?  ${glyphs().note}  tab completes, /help lists them`
          : `${typed} is not a command  ${glyphs().note}  tab completes, /help lists them`, view()));
      }
      else {
        // No "received in plan mode" acknowledgement: the footer's loading cat,
        // elapsed clock and phase bar already say the turn is in flight, and the
        // transcript should hold nothing but the question and the answer.
        turnAbort = new AbortController();
        const result = await client.turn(text, { mode: transportMode(mode), sessionId, signal: turnAbort.signal }); sessionId = result.sessionId;
        // Carry the "this was not the model" flag into the footer.
        //
        // The daemon has published `degraded` on every turn since the engine could fall
        // back, and nothing here read it. On 2026-08-09 gpu-signal.sh had Ollama
        // SIGSTOPped for a render, every reply was a template, and the only difference
        // on screen was one parenthesis at the top of a paragraph — which reads as the
        // model talking, not as the model being absent.
        degradedTurn = !!result.degraded;
        degradedWhy = result.gpuFrozen ? FROZEN_TURN_NOTE : (result.degraded ? 'local model unavailable' : '');
        // The daemon has published `awaitingAnswer` on every turn since the front desk
        // could ask a question, and no surface drew it. The question is in the reply, but
        // once it scrolls, an idle-looking footer is the only thing left — and the daemon
        // is meanwhile treating the next thing typed as the answer.
        awaitingAnswer = !!result.awaitingAnswer;
        emit(renderAssistantText(result.reply, view()));
        if (result.draft) emit(renderNote(`draft ${result.draft.id} · ${result.draft.title}`, view()));
        if (result.run) emitRun(result.run);
        // Offer the letters, having just printed the question.
        //
        // Same rules as the approval prompt, for the same reasons: `ask` mode only —
        // `plan` deliberately states things and gets out of the way — a real tty, nothing
        // else already holding the keyboard, and never while there is a half-typed line.
        //
        // What it produces is submitted the way a typed answer always has been: through
        // `/answer` when a waiting plan is the thing asking, and as an ordinary turn when
        // the front desk is holding one without a run (the daemon takes the next turn as
        // the answer). No new endpoint, no new format.
        const asking = result.questions || [];
        if (asking.length && mode === 'ask' && process.stdin.isTTY && !deciding && !pendingTell && !rl.line) {
          deciding = true;
          const answer = await pickAnswers(asking).catch(() => null).finally(() => { deciding = false; });
          if (answer) {
            const askingRun = result.run?.promptSpec?.questions?.length ? result.run : null;
            chain = chain.then(() => handleTurn(askingRun ? `/answer ${shortRunId(askingRun.id)} ${answer}` : answer));
          }
        }
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
    // Typing while something is running is not ignored and never was — the line goes on
    // the chain and runs when the turn ahead of it finishes. Nothing said so, so it read
    // as a dropped keystroke, which is the same complaint the whole evening has been
    // about: work happening with no sign of it. Claude Code says `queued`; so does this.
    if (text && turnStartedAt) { emit(renderNote('queued — this goes out when the turn ahead of it finishes', view())); refreshPrompt(); }
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
  /**
   * shift+tab cycles the mode — the keystroke every agent CLI has, and the one this
   * REPL never bound.
   *
   * `renderer.js` has printed “shift+tab mode” in the monitor view's hint row for as
   * long as it has existed, and `monitor.js` handled it; the REPL — the surface the
   * owner actually types into — had no keypress listener at all. Measured 2026-08-10:
   * zero `keypress` listeners anywhere in src/. The advertisement shipped without the
   * feature.
   *
   * readline already parses ESC[Z into `{name:'tab', shift:true}` and does not put the
   * escape sequence on the line, so this is a listener and nothing else. Three states
   * must not see it: a paste that happens to contain those bytes (the mode would move
   * because of what the owner copied), `askKey()` holding the tty for an approval, and
   * a non-tty run where readline emits no keypress events at all.
   *
   * The paste guard is `muted`, not `pasting`. `pasting` is only set when the bracketed
   * markers arrive in *different* reads; a paste that lands whole in one chunk — the
   * usual case — takes watchPaste's other branch and leaves it false. Measured in a real
   * pty on 2026-08-10: pasting `hello ESC[Z world` moved the mode from demo to ask, with
   * `pasting` false the entire time. `mute()` is called for both branches before readline
   * sees the chunk, and `endPaste` lifts it on the next tick — after readline has finished
   * processing that same chunk synchronously — so it covers exactly the right window.
   */
  /**
   * Stop the work. The one function, so the two keys that mean it cannot drift apart.
   *
   * Ctrl-C has done this since the REPL learned not to exit on it; esc is Claude Code's
   * key for the same thing and the one the owner's fingers already know. Both of them
   * end up here — this codebase has fixed the same bug in one of two callers four times
   * (see the worktree sweep, the JSON-mode flag, the skills matcher), and an interrupt
   * that works on one key and not the other is that shape exactly.
   *
   * @returns {boolean} true when there was something to interrupt
   */
  const interruptTurn = () => {
    if (!turnStartedAt || abortedTurn) return false;
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
    return true;
  };
  const onModeKey = (_chunk, key) => {
    if (!key) return;
    if (muted || pasting || deciding || picking) return;
    if (key.name === 'tab' && key.shift && !key.ctrl && !key.meta) { applyMode(nextMode(mode)); return; }
    // Esc, the way every other agent CLI reads it: stop the work if there is work, and
    // otherwise clear the line you were half way through.
    //
    // `key.meta` is NOT a disqualifier here, and finding that out cost a pty run: Node
    // reports a bare escape as `{ name: 'escape', meta: true }`, because the escape byte
    // is the meta prefix. A guard of `if (key.ctrl || key.meta) return` at the top of
    // this function — which is what was written first — swallows every press. Measured
    // 2026-08-11 in a real pty: `/re` + esc + `/reaume` submitted `/re/reaume` as a turn.
    //
    // A cursor key cannot reach this: readline parses ESC[A into `{ name: 'up' }`, and
    // `deciding` keeps it away from askKey(), which has always read esc as "later".
    if (key.name === 'escape' && !key.ctrl && !key.shift) {
      if (interruptTurn()) return;
      if (rl.line) { rl.line = ''; rl.cursor = 0; refreshPrompt(); }
    }
  };
  if (process.stdin.isTTY) {
    process.stdout.write('\x1b[?2004h');
    process.stdin.prependListener('data', watchPaste);
    process.stdin.on('keypress', onModeKey);
  }
  // `picking` is the resume list holding the keyboard. rl.pause() asks readline to stop
  // reading; this makes sure that even if a keystroke reaches it anyway, the Enter that
  // chose a session cannot also submit whatever the up arrow left on the input line.
  rl.on('line', (line) => {
    if (picking) return;
    pending.push(line); if (!pasting) schedule();
  });
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
    if (interruptTurn()) return;
    interrupted = true; rl.close();
  });
  rl.on('close', () => {
    clearTimeout(quietTimer); clearTimeout(pasteTimer);
    if (process.stdin.isTTY) { process.stdin.off('data', watchPaste); process.stdin.off('keypress', onModeKey); rl.output = process.stdout; process.stdout.write('\x1b[?2004l'); }
    // The up arrow, kept for next time. readline's own array is newest-first and already
    // free of consecutive duplicates; `keepInHistory` is the same redactor that guards
    // every payload leaving this machine, so a key pasted into the prompt is not written
    // to disk because it happened to be typed here.
    try { prefs.saveHistory(rl.history || [], keepInHistory); } catch (_) { /* history is a convenience, never a reason to fail an exit */ }
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

/**
 * `bigkiji ledger [n]` / `bigkiji ledger --gaps` — what the runs actually did.
 *
 * Reading a file, like `check`: it has to work when the engine is down, because the
 * reason to open the ledger is usually that something went wrong.
 *
 * `--gaps` is the part that matters. One entry tells you about one run; the same gap
 * appearing seven times is what justifies changing a prompt.
 */
async function printLedger(rest = []) {
  const fs = require('fs');
  const { JSONL_PATH, MD_PATH } = require('../pi-agent/run-ledger');

  if (!fs.existsSync(JSONL_PATH)) {
    console.log(`${A.dim}まだ1件も記録がありません（run を1本流すと ${MD_PATH} に出ます）${A.reset}`);
    return;
  }
  const entries = fs.readFileSync(JSONL_PATH, 'utf8').split('\n')
    .filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
  if (!entries.length) { console.log(`${A.dim}記録が読めませんでした${A.reset}`); return; }

  if (rest.includes('--gaps')) {
    // Group by the lesson text — entries that produced the same lesson are the same
    // problem. Exact-match grouping on purpose: it under-groups rather than inventing
    // a category that isn't there.
    const groups = new Map();
    for (const e of entries) {
      const key = String(e.prompt_lesson || '').trim();
      if (!key || key.startsWith('(no lesson')) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`${A.bold}繰り返し起きているズレ（記録 ${entries.length} 件中）${A.reset}\n`);
    if (!ranked.length) { console.log(`${A.dim}まだ繰り返しは出ていません${A.reset}`); return; }
    for (const [lesson, list] of ranked.slice(0, 12)) {
      const mark = list.length >= 3 ? A.warning : A.muted;
      console.log(`${mark}${String(list.length).padStart(3)}回${A.reset}  ${lesson}`);
      console.log(`${A.dim}       直近: ${list.slice(-3).map((e) => e.run_id.slice(0, 16)).join(', ')}${A.reset}`);
    }
    const unclear = entries.filter((e) => e.gap_evidenced === false).length;
    if (unclear) console.log(`\n${A.dim}※ ${unclear} 件は記録が薄くてズレを判定できていません（未分類）${A.reset}`);
    console.log(`\n${A.dim}改善案は docs/v3/prompt-improvements.md へ。ROLE_BLUEPRINT はオーナー承認なしに変えないこと。${A.reset}`);
    return;
  }

  const n = Math.max(1, Number(rest.find((x) => /^\d+$/.test(x)) || 10));
  for (const e of entries.slice(-n).reverse()) {
    const tone = e.status === 'COMPLETED' ? A.success : A.error;
    console.log(`${tone}${e.run_id}${A.reset} ${A.dim}${e.finished_at} · ${e.status}` +
      `${e.repair_cycles ? ` · repair×${e.repair_cycles}` : ''}${A.reset}`);
    console.log(`  ${A.dim}asked   ${A.reset}${String(e.prompt_english || e.prompt_original).slice(0, 150)}`);
    console.log(`  ${A.dim}shipped ${A.reset}${String(e.delivered || '(none)').slice(0, 150)}`);
    console.log(`  ${A.warning}gap     ${A.reset}${String(e.gap).slice(0, 200)}`);
    console.log(`  ${A.info}lesson  ${A.reset}${String(e.prompt_lesson).slice(0, 200)}\n`);
  }
  console.log(`${A.dim}${MD_PATH}${A.reset}`);
}

async function main(argv = process.argv.slice(2)) {
  installSignalHandlers();
  // Before the daemon handshake on purpose: looking at what the phone sent is reading
  // a folder, and it has to work when the engine is down or the owner is in a hurry.
  if (String(argv[0] || '').replace(/^\//, '').toLowerCase() === 'check') { await printCheckFolder(); return; }
  // Same reason as `check`: reading the ledger must not need a live engine — the moment
  // you want it is usually the moment something is wrong.
  if (String(argv[0] || '').replace(/^\//, '').toLowerCase() === 'ledger') { await printLedger(argv.slice(1)); return; }
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

module.exports = { main, ensureClient, launchHud, selectSession, KijiSpinner, installSignalHandlers, machineNote, APPROVAL_CHOICES, PICK_LETTERS, pickable, answerFromPicks, loadedSources, sourcesChanged,
  COMMANDS, COMMAND_NAMES, completeCommand, unknownCommand, editDistance, sessionRows, agoLabel, SESSION_WINDOW, keepInHistory,
  FROZEN_TURN_NOTE, APP_ROOT };
