'use strict';

// Sticky footer for the `bigkiji` REPL. Pure rendering — no I/O, no timers —
// so it can be unit rendered and diffed before being painted.
//
//   <loading icon>  <status>  <comment>            <elapsed>  <tokens>
//   PHASE VECTOR  ●1 PREFLIGHT  ○2 EXECUTE  ○3 VERIFY    ━━━━━───── 58%
//   ──────────────────────────────────────────────────────────────────
//   π> <text input>                       <- readline owns this row (null)
//   ──────────────────────────────────────────────────────────────────
//   MODE: plan    SHELL: zsh(1234)    AGENT: codex ●running
//
// Honesty rules baked in here: a metric we do not really have renders as '—'
// (never 0, never a guess). Elapsed time is measured from the moment the owner
// pressed Enter; tokens are summed from the fleet the daemon actually reports;
// the shell is derived from $SHELL + this process pid, or '—' when unknown.

const path = require('path');
const { stripAnsi, themeFor } = require('../../domain/terminal/cli-theme');
const { bar, clip, phaseChip, phaseName, progressOf } = require('./renderer');
const { LOADING_TEXT, frameRows, loadingFrames } = require('./loading-frames');

const DASH = '—';
const MARGIN = '  ';
const ROWS_BELOW_ART = 5; // phase vector, rule, input, rule, status
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
  if (!model) return { text: DASH, colored: `${C.muted}${DASH}${C.reset}` };
  const status = String(model.status || 'IDLE').toUpperCase();
  const word = STATUS_WORD[status] || status.toLowerCase();
  const tone = busy ? C.accent : status === 'ERROR' ? C.error : C.muted;
  return { text: `${model.id} ●${word}`, colored: `${C.ink}${model.id}${C.reset} ${tone}●${word}${C.reset}` };
}

// Join a left and a right segment inside `width` columns, measuring plain text.
function spread(left, right, width, leftPlain = plain(left), rightPlain = plain(right)) {
  const room = width - leftPlain.length - rightPlain.length;
  if (room < 1) return { text: clip(`${leftPlain} ${rightPlain}`, width), width: Math.min(width, leftPlain.length + rightPlain.length + 1) };
  return { text: `${left}${' '.repeat(room)}${right}`, width };
}

/**
 * Build every footer row. The input row is returned as `null` so the caller can
 * leave readline's own line untouched while repainting the rest.
 * @returns {{lines: (string|null)[], inputIndex: number, height: number}}
 */
function buildFooter(options = {}) {
  const { cols = 80, mode = 'plan', state = {}, phase = state?.phase, comment = '', elapsedMs = null,
    status = '', busy = false, frameIndex = 0, frameSet = loadingFrames() } = options;
  const C = themeFor(mode);
  const width = Math.max(46, Math.min(Math.trunc(Number(cols) || 80), 220));
  const inner = Math.max(30, width - MARGIN.length * 2);
  const art = frameRows(frameIndex, frameSet);
  const lines = [];

  // Rows 1..n-1 — extra art rows for multi-row frame sets (bobbing cat).
  for (const extra of art.slice(0, -1)) lines.push(`${MARGIN}${C.brownLight}${extra}${C.reset}`);

  // Row n — icon · status · comment ............ elapsed · tokens
  const icon = art[art.length - 1];
  const statusText = clip(busy ? LOADING_TEXT : (status || phaseName(phase)), 18);
  const tokens = tokenTotals(state);
  const rightPlain = `${formatElapsed(elapsedMs)}  ${formatTokens(tokens.used)} tok`;
  const right = `${C.muted}${rightPlain}${C.reset}`;
  const headPlain = `${icon}  ${statusText}`;
  const room = inner - headPlain.length - rightPlain.length - 4;
  const note = room > 6 ? clip(String(comment || '').trim() || DASH, room) : '';
  const leftPlain = note ? `${headPlain}  ${note}` : headPlain;
  const left = `${C.brownLight}${icon}${C.reset}  ${busy ? C.accent : C.strong}${statusText}${C.reset}${note ? `  ${C.muted}${note}${C.reset}` : ''}`;
  lines.push(MARGIN + spread(left, right, inner, leftPlain, rightPlain).text);

  // Row n+1 — PHASE VECTOR + real progress meter
  const percent = progressOf(state, phase);
  const chips = `${phaseChip('PREFLIGHT', phase, 1, C)}  ${phaseChip('EXECUTE', phase, 2, C)}  ${phaseChip('VERIFY', phase, 3, C)}`;
  const vectorLeft = `${C.bold}${C.ink}PHASE VECTOR${C.reset}  ${chips}`;
  const vectorLeftPlain = `PHASE VECTOR  ${plain(chips)}`;
  const meterPlain = `${bar(percent, METER_WIDTH)} ${String(percent).padStart(3)}%`;
  const meter = `${C.accent}${bar(percent, METER_WIDTH)}${C.reset} ${C.strong}${String(percent).padStart(3)}%${C.reset}`;
  lines.push(MARGIN + spread(vectorLeft, meter, inner, vectorLeftPlain, meterPlain).text);

  // Rows n+2 / n+4 — the rules that frame the input line
  const rule = `${MARGIN}${C.border}${'─'.repeat(inner)}${C.reset}`;
  lines.push(rule);
  lines.push(null); // readline draws the π> input row itself
  lines.push(rule);

  // Row n+5 — mode · shell · agent
  const agent = agentLabel(state, C);
  const statusRow = `${C.muted}MODE:${C.reset} ${C.strong}${mode}${C.reset}    ${C.muted}SHELL:${C.reset} ${C.ink}${shellLabel()}${C.reset}    ${C.muted}AGENT:${C.reset} ${agent.colored}`;
  const statusRowPlain = `MODE: ${mode}    SHELL: ${shellLabel()}    AGENT: ${agent.text}`;
  lines.push(MARGIN + (statusRowPlain.length > inner ? clip(statusRowPlain, inner) : statusRow));

  return { lines, inputIndex: art.length + 2, height: art.length + ROWS_BELOW_ART };
}

function footerHeightFor(frameSet = loadingFrames()) { return Math.max(1, Number(frameSet?.rows) || 1) + ROWS_BELOW_ART; }

module.exports = { buildFooter, footerHeightFor, formatElapsed, formatTokens, tokenTotals, shellLabel, agentLabel, ROWS_BELOW_ART };
