'use strict';
// Turning a provider's stream-json into the steps the owner watches.
//
// WHY THIS EXISTS AT ALL — the alternative was tried and cannot work.
//
// The obvious place to do this is the renderer, off the task:log channel, touching no
// backend. That is impossible here, and measurably so. task-runner.js:append() passes
// every stdout chunk through knowledge.cleanText() before emitting it, and cleanText is
//
//     .replace(/\s+/g, ' ').trim().slice(0, max)
//
// (pi-knowledge-orchestrator.js). Newlines are gone by the time anything leaves the main
// process, so JSONL framing is destroyed and a 4000-character cap truncates what is left.
// Two features already depend on splitting that text by '\n' and neither has ever worked:
// console's countDiff() reports 0/0, and captureUsage() cannot JSON.parse a line that now
// holds several concatenated objects. So the parse happens here, against the raw buffer,
// before any of that.
//
// WHAT THIS IS ALLOWED TO REPORT
//
// Only what the provider stated as fact: the tool it invoked, the argument identifying
// the target, whether it succeeded, and how many lines a patch added or removed. Labels,
// icons, colours, ordering and grouping are the renderer's business — this module emits
// `added: 12`, never the string '+12'.
//
// FAILURE POLICY
//
// Never throw. This runs inside the stdout handler of a live child process; an exception
// escaping here would take down a run the owner is paying for. Unknown shapes, malformed
// JSON and oversized lines all yield zero steps rather than an error.

const MAX_LINE = 1024 * 1024; // a single JSONL line larger than this is not a tool event
const MAX_TEXT = 600;

// The tools the coordinator actually grants (task-runner.js adapter(): --allowed-tools
// Read,Edit,Write,Bash,Grep,Glob). Anything else a provider reports is passed through
// under its own name rather than dropped — a tool we did not expect is information.
const TARGET_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'command', 'pattern', 'query', 'url'];

function clip(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

// Count a unified diff the provider is about to apply. Same rule as the renderer's
// counter: a bare '+' is prose far more often than a patch, so nothing counts until a
// hunk header has been seen.
function countPatch(patch) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of String(patch || '').split('\n')) {
    if (/^@@ /.test(line)) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (/^(\+\+\+ |--- )/.test(line)) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

// Edit and Write state their change directly rather than as a patch, so the line counts
// come from the strings themselves. old_string absent (a Write) means every line is new.
function countEdit(input) {
  const lines = (value) => (value ? String(value).split('\n').length : 0);
  if (typeof input?.new_string === 'string' || typeof input?.old_string === 'string') {
    return { added: lines(input.new_string), removed: lines(input.old_string) };
  }
  if (typeof input?.content === 'string') return { added: lines(input.content), removed: 0 };
  if (Array.isArray(input?.edits)) {
    return input.edits.reduce((acc, edit) => {
      const one = countEdit(edit);
      return { added: acc.added + one.added, removed: acc.removed + one.removed };
    }, { added: 0, removed: 0 });
  }
  return { added: 0, removed: 0 };
}

function targetOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of TARGET_KEYS) {
    if (typeof input[key] === 'string' && input[key]) return clip(input[key]);
  }
  return '';
}

// content is either a string, or an array of blocks, depending on provider and message.
// One codex item, in the same shape the claude reader produces.
function codexSteps(value) {
  const item = value.item || {};
  const id = String(item.id || '');
  const phase = value.type === 'item.started' ? 'start' : 'end';
  const kind = String(item.type || '');

  if (kind === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    // One step per file, so a change to three files reads as three, exactly as the
    // claude reader would report three Edit calls.
    return changes.map((change, index) => (phase === 'start'
      ? { phase, toolUseId: `${id}#${index}`, tool: toolForKind(change?.kind), target: String(change?.path || ''), added: null, removed: null }
      : { phase, toolUseId: `${id}#${index}`, ok: item.status !== 'failed', errorText: '' }));
  }
  if (kind === 'command_execution') {
    return [phase === 'start'
      ? { phase, toolUseId: id, tool: 'Bash', target: clip(String(item.command || '')), added: null, removed: null }
      : { phase, toolUseId: id, ok: item.exit_code === 0 || item.status === 'completed', errorText: item.exit_code ? `exit ${item.exit_code}` : '' }];
  }
  return [];
}

// codex says add / update / delete; the rest of this app speaks Write / Edit.
function toolForKind(kind) {
  if (kind === 'add') return 'Write';
  if (kind === 'delete') return 'Delete';
  return 'Edit';
}

function blocksOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function resultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) {
    return block.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join(' ');
  }
  return '';
}

/**
 * Pull tool events out of one already-parsed JSONL object.
 * Returns [] for everything that is not a tool_use or tool_result.
 */
function stepsFromValue(value) {
  const out = [];
  if (!value || typeof value !== 'object') return out;

  // codex speaks a different schema, measured against `codex exec --json` on 2026-08-04:
  //   {"type":"item.started",  "item":{"id":"item_2","type":"file_change",
  //                                    "changes":[{"path":"…/sample.js","kind":"update"}]}}
  //   {"type":"item.completed","item":{…,"status":"completed"}}
  //   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
  //                                    "command":"…","exit_code":0}}
  // It names the files it changed but reports NO line counts, so added/removed stay
  // absent rather than being filled in with a zero that would read as "changed nothing".
  if (value.type === 'item.started' || value.type === 'item.completed') {
    return codexSteps(value);
  }

  // claude: {type:'assistant', message:{content:[{type:'tool_use',...}]}}
  // Some providers put content at the top level; accept both rather than guessing one.
  const blocks = blocksOf(value.message?.content ?? value.content);

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'tool_use' && block.name) {
      const input = block.input || {};
      const tool = String(block.name);
      let counts = { added: 0, removed: 0 };
      if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') counts = countEdit(input);
      else if (typeof input.patch === 'string') counts = countPatch(input.patch);
      out.push({
        phase: 'start',
        toolUseId: String(block.id || ''),
        tool,
        target: targetOf(input),
        added: counts.added,
        removed: counts.removed,
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const text = resultText(block);
      out.push({
        phase: 'end',
        toolUseId: String(block.tool_use_id || ''),
        ok: block.is_error !== true,
        errorText: block.is_error === true ? clip(text) : '',
      });
    }
  }
  return out;
}

/**
 * A line-buffered reader over raw stdout chunks.
 *
 * stdout 'data' boundaries are arbitrary — a JSON object is routinely split across two
 * chunks, and a chunk routinely holds several objects. The buffer holds the partial tail
 * until its newline arrives, which is the whole reason this cannot be done downstream.
 */
function createStepReader() {
  let buffer = '';

  return function push(chunk) {
    const steps = [];
    try {
      buffer += String(chunk ?? '');
      // A line that never terminates would grow without bound on a provider that streams
      // something other than JSONL. Drop the tail rather than hold it forever.
      if (buffer.length > MAX_LINE) buffer = buffer.slice(-MAX_LINE);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        let value;
        try { value = JSON.parse(trimmed); } catch (_) { continue; }
        for (const step of stepsFromValue(value)) steps.push(step);
      }
    } catch (_) {
      // Never throw into a live child's stdout handler.
      return [];
    }
    return steps;
  };
}

/** Which providers can produce steps at all. */
function providerEmitsSteps(provider) {
  // claude and gemini are spawned with --output-format stream-json; codex speaks its own
  // item.started/item.completed schema, measured on 2026-08-04 and parsed above. glm runs
  // with --no-tools and qwen/ollama have no tool layer, so for those two the absence of
  // steps is the truth, not a gap.
  //
  // codex matters here beyond completeness: it is the other role that WRITES (ui), so
  // until it was parsed, half of every collision between two writers was invisible.
  return provider === 'claude' || provider === 'claude-code' || provider === 'gemini' || provider === 'codex';
}

module.exports = { createStepReader, stepsFromValue, countPatch, countEdit, providerEmitsSteps };
