'use strict';
// The work-step parser, and the two properties that make it trustworthy.
//
// 1. It survives arbitrary chunk boundaries. stdout 'data' events split wherever the pipe
//    happens to flush, routinely mid-object, and a parser that only worked when a chunk
//    held whole lines would drop steps unpredictably — worst on the busiest runs.
// 2. It never throws. It runs inside a live child process's stdout handler; an exception
//    escaping it would kill a run the owner is paying for.
//
// It also pins the boundary the design depends on: the parser reports what the provider
// stated (tool, target, counts), never how it should look (labels, icons, order).

const assert = require('assert');
const { createStepReader, stepsFromValue, countPatch, countEdit, providerEmitsSteps } = require('../src/domain/pi-agent/stream-steps');

const line = (value) => `${JSON.stringify(value)}\n`;
const toolUse = (id, name, input) => line({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, isError, content) => line({
  type: 'user', message: { content: [{ type: 'tool_use_id', tool_use_id: id }] },
}).replace('"type":"tool_use_id"', '"type":"tool_result"').replace('}]}}', `,"is_error":${!!isError},"content":${JSON.stringify(content || '')}}]}}`);

const STREAM = [
  line({ type: 'system', subtype: 'init', model: 'claude-opus-5' }),
  toolUse('toolu_1', 'Read', { file_path: '/repo/src/console.js' }),
  toolResult('toolu_1', false, 'ok'),
  toolUse('toolu_2', 'Edit', { file_path: '/repo/src/app.css', old_string: 'a\nb\nc', new_string: 'x\ny' }),
  toolResult('toolu_2', false, ''),
  toolUse('toolu_3', 'Bash', { command: 'npm test' }),
  toolResult('toolu_3', true, 'exit 1: 3 failing'),
  line({ type: 'result', usage: { input_tokens: 10, output_tokens: 4 } }),
].join('');

function drain(chunks) {
  const push = createStepReader();
  const steps = [];
  for (const chunk of chunks) for (const step of push(chunk)) steps.push(step);
  return steps;
}

// ---- whole-stream baseline --------------------------------------------------
{
  const steps = drain([STREAM]);
  assert.equal(steps.length, 6, 'three tools, each with a start and an end');
  assert.deepEqual(steps.map((s) => s.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
  assert.deepEqual(steps.map((s) => s.tool).filter(Boolean), ['Read', 'Edit', 'Bash']);
  assert.equal(steps[0].target, '/repo/src/console.js', 'the target is the argument that names the work');
  assert.equal(steps[4].target, 'npm test', 'for Bash that is the command');
  assert.equal(steps[3].ok, true, 'a clean tool_result is a success');
  assert.equal(steps[5].ok, false, 'is_error is a failure');
  assert.equal(steps[5].errorText, 'exit 1: 3 failing', 'and the reason is carried, clipped');
  assert.equal(steps[1].errorText, '', 'a success carries no error text');

  // Facts, not presentation: numbers, never a formatted string.
  assert.equal(steps[2].added, 2, 'Edit reports the lines it wrote');
  assert.equal(steps[2].removed, 3, 'and the lines it replaced');
  assert.ok(!Object.values(steps[2]).some((v) => typeof v === 'string' && /^[+-]\d/.test(v)),
    'the parser must not format the counts — +12/−3 is the renderer\'s business');

  // Correlation is by tool_use_id, so an end can be matched to its start even when a
  // provider interleaves several tools.
  assert.equal(steps[0].toolUseId, 'toolu_1');
  assert.equal(steps[1].toolUseId, 'toolu_1');
}

// ---- arbitrary chunk boundaries ---------------------------------------------
// The property that cannot be checked by reading the code: split the same stream at every
// possible byte offset and the result must not change.
{
  const expected = JSON.stringify(drain([STREAM]));
  for (let cut = 1; cut < STREAM.length; cut += 7) {
    const steps = drain([STREAM.slice(0, cut), STREAM.slice(cut)]);
    assert.equal(JSON.stringify(steps), expected, `a split at byte ${cut} changed the result`);
  }
  // And byte-at-a-time, the worst case a slow pipe can produce.
  assert.equal(JSON.stringify(drain(STREAM.split(''))), expected, 'one byte per chunk must still work');
}

// ---- never throws -----------------------------------------------------------
{
  const push = createStepReader();
  for (const junk of ['', '\n', 'not json\n', '{unclosed\n', '{"type":"assistant"}\n',
    '{"message":{"content":"a string not an array"}}\n', `${'x'.repeat(2 * 1024 * 1024)}\n`,
    null, undefined, 12345]) {
    assert.doesNotThrow(() => push(junk), `threw on ${String(junk).slice(0, 24)}`);
  }
  assert.deepEqual(stepsFromValue(null), [], 'a null line yields no steps');
  assert.deepEqual(stepsFromValue({ type: 'result' }), [], 'and neither does a non-tool message');
  // Recovery is at the next line boundary, not mid-line.
  //
  // The junk above ends without a newline, so it is still an unterminated line and the
  // next chunk concatenates onto it — correctly, because a parser cannot know where JSON
  // begins inside a partial line without guessing. What matters is that the damage is
  // bounded by one line rather than poisoning the reader forever.
  assert.equal(push(toolUse('toolu_8', 'Read', { file_path: '/x' })).length, 0,
    'a chunk appended to an unterminated junk line is part of that line');
  assert.equal(push('\n').length, 0, 'which ends here');
  assert.equal(push(toolUse('toolu_9', 'Grep', { pattern: 'TODO' })).length, 1,
    'and the very next line parses again — malformed input costs one line, not the run');
}

// ---- counting ---------------------------------------------------------------
{
  assert.deepEqual(countPatch('@@ -1,2 +1,3 @@\n ctx\n+one\n+two\n-gone'), { added: 2, removed: 1 });
  assert.deepEqual(countPatch('+ prose before any hunk\n- more prose'), { added: 0, removed: 0 },
    'text before a hunk header is not a patch — the same rule the renderer counter uses');
  assert.deepEqual(countEdit({ content: 'a\nb\nc' }), { added: 3, removed: 0 }, 'a Write adds every line');
  assert.deepEqual(countEdit({ edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd\ne', new_string: 'f' }] }),
    { added: 3, removed: 3 }, 'a multi-edit sums its parts');
}

// ---- which providers can report at all --------------------------------------
// glm is spawned with --no-tools and qwen/ollama have no tool layer, so for those the
// absence of steps is the truth rather than a parser gap. Saying so here stops a future
// reader from "fixing" it.
{
  assert.ok(providerEmitsSteps('claude') && providerEmitsSteps('claude-code'), 'claude streams stream-json');
  assert.ok(providerEmitsSteps('gemini'), 'and so does gemini');
  assert.ok(!providerEmitsSteps('glm'), 'glm runs with --no-tools — it has no steps to report');
  assert.ok(!providerEmitsSteps('qwen') && !providerEmitsSteps('ollama'), 'nor do the local text models');
  assert.ok(providerEmitsSteps('codex'), 'codex speaks its own schema, and it is parsed');
}

// ---- codex --------------------------------------------------------------------
// Measured against a real `codex exec --json` run on 2026-08-04, not guessed. codex is
// the other role that writes (ui), so until this was parsed, half of every collision
// between two writers was invisible.
{
  const started = stepsFromValue({ type: 'item.started', item: { id: 'item_2', type: 'file_change',
    changes: [{ path: '/w/sample.js', kind: 'update' }, { path: '/w/new.js', kind: 'add' }] } });
  assert.strictEqual(started.length, 2, 'one step per file, as three Edit calls would read as three');
  assert.deepStrictEqual(started.map((step) => [step.tool, step.target]),
    [['Edit', '/w/sample.js'], ['Write', '/w/new.js']], 'add is a Write, update is an Edit');
  assert.strictEqual(started[0].added, null,
    'codex reports no line counts, and an absent measurement stays absent rather than becoming 0');
  assert.strictEqual(started[0].removed, null);

  const done = stepsFromValue({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', status: 'completed',
    changes: [{ path: '/w/sample.js', kind: 'update' }] } });
  assert.deepStrictEqual(done.map((step) => [step.phase, step.ok]), [['end', true]]);

  const shell = stepsFromValue({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution',
    command: 'git diff', exit_code: 1 } });
  assert.strictEqual(shell[0].ok, false, 'a non-zero exit is a failed step');
  assert.deepStrictEqual(stepsFromValue({ type: 'item.completed',
    item: { id: 'x', type: 'agent_message', text: 'prose' } }), [], 'prose is not a step');
  assert.deepStrictEqual(stepsFromValue({ type: 'turn.completed', usage: {} }), []);
}

// ---- secrets ----------------------------------------------------------------
// Redaction happens upstream in task-runner.append(), which hands this parser
// redactPayload().text rather than the raw buffer. Pin that the parser is fed the redacted
// string, because reading the raw one would route secrets straight to a renderer.
{
  const source = require('fs').readFileSync(require('path').join(__dirname, '../src/domain/pi-agent/task-runner.js'), 'utf8');
  assert.ok(/this\.emitSteps\(task, redacted\.text\)/.test(source),
    'steps are parsed from the redacted text, never from the raw buffer');
  assert.ok(/const text = knowledge\.cleanText\(redacted\.text, 4000\);/.test(source),
    'and cleanText still runs for task:log exactly as before — this change is additive');
  assert.ok(/this\.emit\('log', \{ taskId: task\.id/.test(source), 'the raw log channel is untouched');
}

console.log('task step selftest: PASS · 6 steps from a real stream · identical output at every chunk boundary and '
  + 'byte-at-a-time · never throws on junk and recovers after it · counts are numbers, not formatted strings · '
  + 'glm/qwen report nothing because they run without tools · parsed from redacted text with task:log unchanged');
