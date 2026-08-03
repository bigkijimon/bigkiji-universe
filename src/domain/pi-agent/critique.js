'use strict';

// What BigKiji says back when an agent hands in its work.
//
// The owner asked for this by name: BigKiji looks at each result and comments, the
// agent reads the comment and answers with what it would do differently, and the
// exchange is shown rather than hidden. Two things would quietly ruin it, and both
// are designed against here.
//
// **A weak model asked "is this good?" answers "yes".** Measured by a Japanese
// practitioner integrating Qwen 3.5 9B into a review loop: asked to compare a
// design document against the code, it returned 問題なし whenever the code was
// syntactically valid, and never once found the divergence. So BigKiji's half of
// this conversation asks no model anything. Every check below is deterministic —
// did it finish, did it stay inside the files the plan named, did it touch
// something dangerous, did it cost what it said it would. Facts, not opinions.
//
// **Said every time, it stops being read in three days.** Same mechanism as the
// approval flood. A result with nothing to say about it collapses to one line, and
// only a finding opens the thread.
//
// The agent's half is the part worth paying a model for, and it is the part that
// pays for itself: `model_performance.json` had zero samples and priors written by
// hand, so nothing could improve the routing. A structured reflection is training
// data for a store that is empty.

const DANGEROUS = [
  { id: 'rm-rf', pattern: /\brm\s+-[a-z]*[rf][a-z]*\s+\//i, note: 'recursive delete from an absolute path' },
  { id: 'force-push', pattern: /git\s+push\s+[^\n]*--force(?!-with-lease)/i, note: 'force push without --force-with-lease' },
  { id: 'history-rewrite', pattern: /git\s+(?:reset\s+--hard|filter-branch|rebase\s+-i)/i, note: 'history rewrite' },
  { id: 'credential-read', pattern: /(?:cat|less|head|tail)\s+[^\n]*(?:\.env|\.ssh\/|credentials?\.json|auth\.json)/i, note: 'reading a credential file' },
  { id: 'curl-pipe-sh', pattern: /curl[^\n|]*\|\s*(?:ba)?sh/i, note: 'piping a download into a shell' },
  { id: 'chmod-777', pattern: /chmod\s+(?:-R\s+)?777/i, note: 'world-writable permissions' },
];

/** Paths the assignment's own plan named, as a Set of basenames. */
function plannedFiles(run = {}) {
  const spec = run.promptSpec || {};
  const text = [spec.goal, ...(spec.steps || []), ...(spec.constraints || []), ...(spec.acceptance || [])].join(' ');
  const found = String(text).match(/[\w./-]+\.[a-z]{1,5}\b/gi) || [];
  return new Set(found.map((item) => item.split('/').pop().toLowerCase()));
}

/** Files the output claims to have touched. */
function touchedFiles(output = '') {
  const found = String(output).match(/[\w./-]+\.[a-z]{1,5}\b/gi) || [];
  return [...new Set(found.map((item) => item.split('/').pop()))];
}

/**
 * BigKiji's comment on one finished assignment. Deterministic — no model is asked.
 * @returns {{runId: string, taskId: string, role: string, provider: string,
 *   findings: Array<{id: string, note: string}>, quiet: boolean, summary: string}}
 */
function reviewResult({ run = {}, assignment = {}, task = {} } = {}) {
  const findings = [];
  const output = String(task.output || '');

  if (task.status !== 'completed') {
    findings.push({ id: 'unfinished', note: `${task.status}${task.failureReason ? ` · ${task.failureReason}` : ''}` });
  }
  for (const rule of DANGEROUS) {
    if (rule.pattern.test(output)) findings.push({ id: rule.id, note: rule.note });
  }
  // Scope: only worth saying when the plan actually named files. A plan that named
  // none cannot be departed from, and inventing a violation is worse than silence.
  const planned = plannedFiles(run);
  if (planned.size && assignment.write) {
    const strayed = touchedFiles(output).filter((file) => !planned.has(file.toLowerCase()));
    if (strayed.length) findings.push({ id: 'out-of-scope', note: `not in the plan: ${strayed.slice(0, 4).join(', ')}` });
  }
  // A write assignment that produced nothing is not a success, whatever it exited.
  if (task.status === 'completed' && assignment.write && !output.trim()) {
    findings.push({ id: 'no-output', note: 'completed without producing anything' });
  }
  // Verification is the owner's standing rule, and the one an agent skips first.
  if (task.status === 'completed' && assignment.write && !/\b(?:test|npm test|passed|PASS|✓)\b/i.test(output)) {
    findings.push({ id: 'unverified', note: 'no sign that anything was run to check it' });
  }

  const quiet = findings.length === 0;
  return {
    runId: run.id || '', taskId: task.id || '', role: assignment.role || '', provider: task.provider || '',
    findings, quiet,
    summary: quiet ? 'nothing to add' : findings.map((item) => item.note).join('; '),
  };
}

// The reflection is asked of the model that did the work, in its own words, and
// answered as data rather than prose — the routing store is the consumer, and prose
// cannot be counted. Kept small on purpose: this runs once per finding, and the
// owner is paying for it.
const REFLECTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    acknowledged: { type: 'boolean' },
    whatWentWrong: { type: 'string' },
    whatToDoDifferently: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['acknowledged', 'whatToDoDifferently'],
});

function reflectionPrompt(review) {
  return [
    'You completed an assignment and BigKiji reviewed the result. These are its findings:',
    ...review.findings.map((item) => `- ${item.id}: ${item.note}`),
    '',
    'Answer as JSON only, with keys: acknowledged (boolean), whatWentWrong (one sentence),',
    'whatToDoDifferently (one concrete change, imperative), confidence (0-1).',
    'Do not restate the findings. Do not apologise. If a finding is wrong, say so in',
    'whatWentWrong and set acknowledged false.',
  ].join('\n');
}

/** Shape a model's reflection into something the routing store can hold. */
function normalizeReflection(value, review) {
  const text = (input, max) => String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const change = text(value?.whatToDoDifferently, 240);
  if (!change) return null; // a reflection with no change in it is not a reflection
  return {
    runId: review.runId, taskId: review.taskId, role: review.role, provider: review.provider,
    acknowledged: value?.acknowledged !== false,
    whatWentWrong: text(value?.whatWentWrong, 240),
    whatToDoDifferently: change,
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0.5)),
    findings: review.findings.map((item) => item.id),
  };
}

module.exports = { reviewResult, reflectionPrompt, normalizeReflection, REFLECTION_SCHEMA, DANGEROUS, plannedFiles, touchedFiles };
