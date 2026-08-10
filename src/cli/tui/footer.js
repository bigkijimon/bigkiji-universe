'use strict';

// Sticky footer for the `bigkiji` REPL. Pure rendering — no I/O, no timers —
// so it can be unit rendered and diffed before being painted.
//
//   <loading icon>  <status>  <comment>            <elapsed>  <tokens>
//   ──────────────────────────────────────────────────────────────────
//   π> <text input>                       <- readline owns this row (null)
//   ──────────────────────────────────────────────────────────────────
//   mode: plan    shell: zsh(1234)    agent: codex ●running
//
// Every label above is lowercase because the owner asked for it (2026-08-03).
// The values the daemon publishes are untouched: only what reaches the screen
// is folded, via `phrase()` / `lower()` from ./transcript.
//
// Honesty rules baked in here: a metric we do not really have renders as '—'
// (never 0, never a guess). Elapsed time is measured from the moment the owner
// pressed Enter; tokens are summed from the fleet the daemon actually reports;
// the shell is derived from $SHELL + this process pid, or '—' when unknown.

const path = require('path');
const { stripAnsi, themeFor } = require('../../domain/terminal/cli-theme');
const { bar, clip, phaseName } = require('./renderer');
const { providerColor } = require('../../domain/terminal/cli-theme');
const { lower, phrase, stringWidth } = require('./transcript');
const { LOADING_TEXT, frameRows, loadingFrames } = require('./loading-frames');

const DASH = '—';
const MARGIN = '  ';
const ROWS_BELOW_ART = 4; // rule, input, rule, status — the phase vector moved into the model panel
const METER_WIDTH = 10;
const plain = (value) => stripAnsi(value);

const BUSY_STATUS = new Set(['EXECUTING', 'THINKING', 'PRUNING', 'RUNNING', 'DISPATCHING', 'VERIFYING', 'REPAIRING']);
const STATUS_WORD = Object.freeze({ EXECUTING: 'running', THINKING: 'thinking', PRUNING: 'pruning', DISPATCHING: 'dispatching',
  VERIFYING: 'verifying', REPAIRING: 'repairing', ERROR: 'error', OFFLINE: 'offline', IDLE: 'idle' });

function formatElapsed(ms) {
  if (ms === null || ms === undefined || ms === '') return DASH;
  const value = Number(ms); if (!Number.isFinite(value) || value < 0) return DASH;
  const total = Math.floor(value / 1000);
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return DASH; // no fabricated metrics
  if (count < 1000) return String(Math.round(count));
  if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// Session totals are per-model today, so sum the fleet the daemon reports.
function tokenTotals(state = {}) {
  const fleet = state?.models?.models || [];
  const totals = state?.models?.totals || {};
  const sum = (key) => fleet.reduce((acc, model) => acc + (Number(model?.metrics?.[key]) || 0), 0);
  if (fleet.length) return { used: sum('tokensUsed'), saved: sum('tokensSaved') };
  return { used: Number(totals.tokensUsed) || 0, saved: Number(totals.tokensSaved) || 0 };
}

function shellLabel(env = process.env, pid = process.pid) {
  const shell = String(env?.SHELL || '').trim();
  if (!shell) return DASH; // the CLI owns no PTY: never invent a shell session
  return `${path.basename(shell)}(${pid})`;
}

function agentLabel(state = {}, C = themeFor('plan')) {
  const fleet = state?.models?.models || [];
  const busy = fleet.find((model) => BUSY_STATUS.has(String(model?.status || '').toUpperCase()));
  const model = busy || fleet.find((item) => item?.connected);
  // Nobody running is not nobody there.
  //
  // `connected` means "has a task running right now", so on an idle machine this row
  // read `agent: —` with six providers authenticated and the conversation model loaded
  // — measured 2026-08-04. A dash is what we print for a metric we never took, and we
  // took this one: the model answering the owner's sentences is in the daemon's
  // conversation snapshot. It is named, and marked idle, because both are true.
  if (!model) {
    const chatting = lower(state?.conversation?.model || '');
    if (!chatting) return { text: DASH, colored: `${C.muted}${DASH}${C.reset}` };
    return { text: `${chatting} ●idle`, colored: `${C.ink}${chatting}${C.reset} ${C.muted}●idle${C.reset}` };
  }
  const status = String(model.status || 'IDLE').toUpperCase();
  const word = STATUS_WORD[status] || phrase(status);
  const tone = busy ? C.accent : status === 'ERROR' ? C.error : C.muted;
  const id = lower(model.id);
  return { text: `${id} ●${word}`, colored: `${C.ink}${id}${C.reset} ${tone}●${word}${C.reset}` };
}

// Join a left and a right segment inside `width` columns, measuring *display*
// width rather than String#length — the comment slot regularly carries Japanese,
// where a character costs two columns and length would overflow the row.
function spread(left, right, width, leftPlain = plain(left), rightPlain = plain(right)) {
  const room = width - stringWidth(leftPlain) - stringWidth(rightPlain);
  if (room < 1) return { text: clip(`${leftPlain} ${rightPlain}`, width), width: Math.min(width, stringWidth(leftPlain) + stringWidth(rightPlain) + 1) };
  return { text: `${left}${' '.repeat(room)}${right}`, width };
}

/**
 * Build every footer row. The input row is returned as `null` so the caller can
 * leave readline's own line untouched while repainting the rest.
 * @returns {{lines: (string|null)[], inputIndex: number, height: number}}
 */
function buildFooter(options = {}) {
  const { cols = 80, mode = 'plan', state = {}, phase = state?.phase, comment = '', elapsedMs = null,
    status = '', busy = false, frameIndex = 0, frameSet = loadingFrames(),
    degraded = false, degradedNote = '', awaitingAnswer = false } = options;
  const C = themeFor(mode);
  const width = Math.max(46, Math.min(Math.trunc(Number(cols) || 80), 220));
  const inner = Math.max(30, width - MARGIN.length * 2);
  const art = frameRows(frameIndex, frameSet);
  const lines = [];

  // Rows 1..n-1 — extra art rows for multi-row frame sets (bobbing cat).
  for (const extra of art.slice(0, -1)) lines.push(`${MARGIN}${C.brownLight}${extra}${C.reset}`);

  // Row n — icon · status · comment ............ elapsed · tokens
  // `icon` may itself carry ANSI when a coloured (pixel) frame set is selected,
  // so every measurement below goes through stringWidth, never String#length.
  const icon = art[art.length - 1];
  // `phrase` here, not `lower`: AWAITING_APPROVAL is a protocol value the daemon
  // publishes, and on screen it should read as two words rather than one token.
  // "asking" — the state with no work in it, which used to look exactly like idle.
  //
  // When the front desk needs a decision it holds the run back and asks, and the phase
  // word stayed on whatever the last run had been. So the owner read the question,
  // answered it in a new sentence an hour later — outside the window — and the answer
  // was taken as a fresh remark. Nothing on screen said the machine was holding.
  const statusText = clip(busy ? LOADING_TEXT : (awaitingAnswer ? 'asking' : phrase(status || phaseName(phase))), 18);
  const tokens = tokenTotals(state);
  const rightPlain = `${formatElapsed(elapsedMs)}  ${formatTokens(tokens.used)} tok`;
  const right = `${C.muted}${rightPlain}${C.reset}`;
  const headPlain = `${plain(icon)}  ${statusText}`;
  const room = inner - stringWidth(headPlain) - stringWidth(rightPlain) - 4;
  // The comment slot is for something the status word does not already say.
  //
  // The daemon publishes the same value down two channels — `run.status` sets the phase
  // and the relay writes it into `comment` — so a waiting run printed
  // `awaiting approval  awaiting approval` and spent the widest slot on the row saying
  // the same thing twice (measured 2026-08-04). If it echoes the status, it is dropped
  // and the room goes back to the elapsed clock.
  //
  // One exception outranks the comment: an answer the model never served.
  //
  // `degraded` has been on every conversation turn the daemon publishes since the
  // engine could fall back, and no surface in this CLI drew it — so nine template
  // replies in a row looked exactly like nine real ones, and the owner concluded the
  // thing was stupid rather than absent (2026-08-09, Ollama SIGSTOPped by gpu-signal.sh
  // for a render). It takes the comment slot because the comment describes work that,
  // in this state, is not happening.
  const said = String(comment || '').trim();
  const echoes = said && phrase(said).toLowerCase() === phrase(statusText).toLowerCase();
  const warn = degraded ? clip(String(degradedNote || 'local model unavailable').trim(), Math.max(6, room))
    : (awaitingAnswer && !busy ? clip('answer to start', Math.max(6, room)) : '');
  const note = room > 6 ? (warn || clip(echoes ? DASH : (said || DASH), room)) : '';
  const leftPlain = note ? `${headPlain}  ${note}` : headPlain;
  const noteColour = warn ? C.warning : C.muted;
  const left = `${C.brownLight}${icon}${C.reset}  ${busy ? C.accent : C.strong}${statusText}${C.reset}${note ? `  ${noteColour}${note}${C.reset}` : ''}`;
  lines.push(MARGIN + spread(left, right, inner, leftPlain, rightPlain).text);

  // The phase vector used to be here, and it is in the model panel now.
  //
  // The owner asked for it twice (2026-08-10): the gauge was on the bottom row of the
  // screen while the panel answering the other half of the same question — which model,
  // which directory, how much of the fleet is up — was on the top. One question, two
  // edges of the terminal. renderer.modelPanel draws both rows inside the frame from the
  // same phaseChips/bar/progressOf this row used, so nothing new is rendered and the
  // footer gives a row back to the transcript.

  // The running block — what is being built, then a gauge per specialist.
  //
  // Fixed, not scrolled away: the owner asked to be able to see who is working without
  // hunting for it in the transcript, and every AI gets its own colour so the row is
  // readable at a glance rather than by reading. A specialist with no published step
  // count gets no bar — `—` is not 0, and a gauge invented to fill the space would be
  // the same lie as a progress percentage for an unstarted run.
  const agents = runningAgents(state, AGENT_LIMIT);
  if (agents.length) {
    const goal = agents.find((agent) => agent.goal)?.goal || '';
    if (goal) lines.push(`${MARGIN}${C.dim}${clip(goal, inner)}${C.reset}`);
    else lines.push(`${MARGIN}${C.dim}${clip('working', inner)}${C.reset}`);
    const roleWidth = Math.min(10, Math.max(...agents.map((agent) => agent.role.length)));
    for (const agent of agents) {
      const tint = providerColor(agent.provider);
      const known = Number.isFinite(agent.done) && Number.isFinite(agent.total) && agent.total > 0;
      const percent = known ? Math.max(0, Math.min(100, Math.round((agent.done / agent.total) * 100))) : 0;
      const gauge = known ? `${C.accent}${bar(percent, METER_WIDTH)}${C.reset} ${C.strong}${agent.done}/${agent.total}${C.reset}`
        : `${C.dim}${'─'.repeat(METER_WIDTH)} ${DASH}${C.reset}`;
      const gaugePlain = known ? `${bar(percent, METER_WIDTH)} ${agent.done}/${agent.total}` : `${'─'.repeat(METER_WIDTH)} ${DASH}`;
      const head = `${clip(lower(agent.role), roleWidth).padEnd(roleWidth)}  ${lower(agent.provider)}`;
      const room = inner - stringWidth(head) - stringWidth(gaugePlain) - 4;
      const note = room > 6 ? clip(agent.title, room) : '';
      const leftPlain = note ? `${head}  ${note}` : head;
      const left = `${tint}${clip(lower(agent.role), roleWidth).padEnd(roleWidth)}${C.reset}  ${tint}${lower(agent.provider)}${C.reset}`
        + (note ? `  ${C.muted}${note}${C.reset}` : '');
      lines.push(MARGIN + spread(left, gauge, inner, leftPlain, gaugePlain).text);
    }
  }

  // Rows n+2 / n+4 — the rules that frame the input line
  const rule = `${MARGIN}${C.border}${'─'.repeat(inner)}${C.reset}`;
  lines.push(rule);
  lines.push(null); // readline draws the π> input row itself
  lines.push(rule);

  // Row n+5 — mode · shell · agent · work
  //
  // The owner asked for the current state of the work on this row. It is appended
  // rather than given a row of its own: this footer already costs six rows of a
  // terminal, and the transcript is what the owner is actually reading. When there
  // is no run in flight the segment is absent entirely — an idle machine reporting
  // its idleness every 67ms is the kind of chrome that stops being read.
  // Segments are dropped whole, in order of what is worth least here, and only the
  // last resort clips. This row used to go straight from "everything" to
  // `clip(everything)`, which on a 63 column pane printed
  // `mode: plan  shell: zsh(48460)  agent: pi-agent-core ●i…` — the agent's *state*,
  // the only changing value on the row, truncated to one letter and an ellipsis,
  // while `shell:` kept all seventeen of its columns. Dropping a segment says "not
  // shown"; clipping a value says something false about it.
  //
  // Order, least valuable first: `shell` (this process's own pid, constant for its
  // whole life), then `mode` (already visible in the prompt colour). `work` is the
  // last thing to go and `agent` rides with it.
  //
  // `work` used to be first out, on the reasoning that the phase row above repeated
  // it. The phase row does not repeat it — it carries the three chips and the meter,
  // and neither of those says how many runs are waiting for the owner. Measured
  // 2026-08-04: `work: 2 awaiting /approve` vanished below 75 columns, so in the
  // owner's split pane the single actionable fact on the screen was the first thing
  // dropped, and two runs sat waiting for eleven hours. The row that says what to do
  // next outranks the row that says which shell you are in.
  const agent = agentLabel(state, C);
  const work = workSegment(state);
  // The mode gets the violet the rest of this palette did not have. Claude Code puts
  // its mode in violet for the same reason: it is the one value on the row that
  // changes what the next Enter will DO, and it read as ordinary text.
  // `⇧⇥` rides with the value, not in a help row. The REPL bound shift+tab on
  // 2026-08-10 and had never advertised it anywhere the owner types; a hint that lives
  // two screens away from the thing it changes is a hint nobody reads. Two columns is
  // what it costs, and it drops out of the row at the same width the mode itself does.
  const modeSeg = { plain: `mode: ${lower(mode)} ⇧⇥`,
    colored: `${C.muted}mode:${C.reset} ${C.violet}${C.bold}${lower(mode)}${C.reset} ${C.dim}⇧⇥${C.reset}` };
  const shellSeg = { plain: `shell: ${lower(shellLabel())}`, colored: `${C.muted}shell:${C.reset} ${C.dim}${lower(shellLabel())}${C.reset}` };
  const agentSeg = { plain: `agent: ${agent.text}`, colored: `${C.muted}agent:${C.reset} ${agent.colored}` };
  const workSeg = work ? { plain: `work: ${work}`, colored: `${C.muted}work:${C.reset} ${C.info}${work}${C.reset}` } : null;
  const candidates = workSeg
    ? [
      [modeSeg, shellSeg, agentSeg, workSeg],
      [modeSeg, agentSeg, workSeg],
      [agentSeg, workSeg],
      [workSeg],
    ]
    : [
      [modeSeg, shellSeg, agentSeg],
      [modeSeg, agentSeg],
      [agentSeg],
    ];
  const join = (segments, key) => segments.filter(Boolean).map((segment) => segment[key]).join('    ');
  const chosen = candidates.find((segments) => stringWidth(join(segments, 'plain')) <= inner);
  lines.push(MARGIN + (chosen ? join(chosen, 'colored') : clip(join([workSeg || agentSeg], 'plain'), inner)));

  // art rows, then the status row, then the rule — so the input is one past the rule.
  // This was `art.length + 2` while the phase vector sat between the status row and the
  // rule; leaving it there after the vector moved would have put readline's prompt one
  // row below where the footer actually leaves the gap.
  return { lines, inputIndex: art.length + 1, height: art.length + ROWS_BELOW_ART };
}

/**
 * What the fleet is doing, in one clause, or '' when it is doing nothing.
 *
 * Counts only what is really running. A number that includes work waiting for the
 * owner would report the machine as busy while it waits on the owner — which is the
 * opposite of the truth and the reason the phase bar read 92% for an unstarted run.
 * @returns {string}
 */
function workSegment(state = {}) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const active = runs.filter((run) => ['EXECUTING', 'DISPATCHING', 'REPAIRING', 'VERIFYING'].includes(String(run.status || '').toUpperCase()));
  const waiting = runs.filter((run) => String(run.status || '').toUpperCase() === 'AWAITING_APPROVAL').length;
  if (!active.length) return waiting ? `${waiting} awaiting /approve` : '';
  const run = active[0];
  const assignments = Array.isArray(run.assignments) ? run.assignments : [];
  const done = assignments.filter((item) => String(item.status || '').toLowerCase() === 'completed').length;
  const started = run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : 0;
  const minutes = started > 0 ? `${Math.floor(started / 60000)}m` : '';
  const budget = run.deadlineAt ? Math.round((new Date(run.deadlineAt).getTime() - Date.now()) / 60000) : null;
  const left = budget === null ? '' : (budget >= 0 ? `${budget}m left` : `${Math.abs(budget)}m over`);
  return [assignments.length ? `${done}/${assignments.length}` : '', minutes, left].filter(Boolean).join(' · ');
}

/**
 * The specialists working right now, in the order they were assigned.
 *
 * Read from the live state rather than tracked separately: the daemon already
 * publishes every assignment of every run, and a second copy would be a second thing
 * to fall out of date. Diagnoses are included — a run that is working out why it broke
 * is working, and hiding that is how "is it stuck?" gets asked.
 *
 * @returns {Array<{role:string, provider:string, title:string, done:number, total:number, goal:string}>}
 */
function runningAgents(state = {}, limit = 3) {
  const runs = (Array.isArray(state?.runs) ? state.runs : [])
    .filter((run) => !['COMPLETED', 'FAILED', 'EXPIRED', 'SECURITY_BLOCKED'].includes(run?.status));
  const out = [];
  for (const run of runs) {
    const goal = String(run?.promptSpec?.goal || run?.promptPreview || '').replace(/\s+/g, ' ').trim();
    for (const item of (Array.isArray(run.assignments) ? run.assignments : [])) {
      if (!['running', 'queued', 'awaiting_approval'].includes(String(item.status || ''))) continue;
      out.push({ role: String(item.role || item.kind || '?'), provider: String(item.provider || ''),
        title: String(item.title || '').replace(/\s+/g, ' ').trim(), goal,
        // Steps finished over steps planned. Absent is absent: a gauge drawn from a
        // total nobody published would be a number invented to fill a bar.
        done: Number(item.stepsDone ?? NaN), total: Number(item.stepsTotal ?? NaN),
        status: String(item.status || '') });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const AGENT_LIMIT = 3;
/**
 * @param {object} frameSet
 * @param {number} agents how many agent rows the block will draw
 */
function footerHeightFor(frameSet = loadingFrames(), agents = 0) {
  const count = Math.max(0, Math.min(AGENT_LIMIT, Math.trunc(Number(agents) || 0)));
  // One row of context above the gauges — the owner asked for the work, then the bars —
  // and nothing at all when nothing is running, because an idle machine drawing an
  // empty panel every 67ms is chrome that stops being read.
  return Math.max(1, Number(frameSet?.rows) || 1) + ROWS_BELOW_ART + (count ? count + 1 : 0);
}

module.exports = { buildFooter, footerHeightFor, runningAgents, AGENT_LIMIT, workSegment, formatElapsed, formatTokens, tokenTotals, shellLabel, agentLabel, ROWS_BELOW_ART };
