'use strict';
// Independent proposals before work starts, merged by PiAgent rather than by a model.
//
// The owner's rule: before starting, several capable models discuss the approach and
// produce the best plan; PiAgent consolidates it and refuses to pay twice for work it
// has already deliberated. The same applies before driving a local tool (n8n, ComfyUI,
// Obsidian, Blender, Unreal, Graphify) — those runs are expensive in GPU minutes, and
// the lens that says "the skill file already rules this out" saves the whole run.
//
// Two deliberate choices:
//   * Lenses are independent. Asking one model twice produces two versions of the same
//     idea; asking an architect and a risk reviewer produces a disagreement worth having.
//   * The merge is code, not a model. Consolidation is set arithmetic over steps, so it
//     costs nothing, is deterministic, and cannot hallucinate a step nobody proposed.

const fs = require('fs');
const path = require('path');
const { keywords, jaccard } = require('./task-cache');

// Local first: the free lens always participates, so a deliberation still happens when
// nothing paid is available. Roles map to the capability registry's existing vocabulary.
const LENSES = Object.freeze([
  { id: 'architect', role: 'leader', provider: 'qwen', title: 'Decomposition and dependency order',
    instruction: 'Propose the shortest correct decomposition. State the dependency order and how each step is verified.' },
  { id: 'risk', role: 'debug', provider: 'glm', title: 'Failure modes and prior art',
    instruction: 'Propose the approach that fails least. Name what breaks, what already exists in this repository that should be reused instead of rebuilt, and what must be measured rather than assumed.' },
  { id: 'operator', role: 'ui', provider: 'codex', title: 'Owner-visible outcome',
    instruction: 'Propose the plan that produces the outcome the owner can see and check. Name the observable result of each step.' },
]);

// Runs against these are slow, serialised on one GPU, and easy to get wrong in a way
// that only shows up after the render — so they always get a discussion first.
const LOCAL_TOOLS = /(?:n8n|comfy\s*ui|obsidian|blender|unreal|graphify|ace-?step|ltx|stable\s*diffusion|flux\b)/i;
const SUBSTANTIAL = /(?:実装|構築|作成|設計|移行|再構築|リファクタ|自動化|調査|分析|レポート|implement|build|creat|design|migrat|refactor|automat|research|analy|audit|rebuild|redesign)/i;

function needed(prompt, { lenses = 2 } = {}) {
  const text = String(prompt || '');
  // One lens is not a discussion, it is a delay. Below two, skip it entirely.
  if (lenses < 2) return false;
  if (LOCAL_TOOLS.test(text)) return true;
  return text.length >= 120 && SUBSTANTIAL.test(text);
}

// Providers answer in prose. Steps are whatever they numbered or bulleted; anything
// else is commentary and is dropped rather than guessed at.
//
// Parsing is marker-based rather than line-based on purpose: task output reaches here
// after knowledge.cleanText(), which collapses every run of whitespace — newlines
// included — so a line-oriented parser finds exactly zero steps in real output.
function extractSteps(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const marker = /(?:^|\s)(?:\d{1,2}[.)]|[-*•])\s+/g;
  const cuts = []; let match;
  while ((match = marker.exec(flat)) !== null) cuts.push({ at: match.index, from: match.index + match[0].length });
  const steps = [];
  for (let i = 0; i < cuts.length && steps.length < 12; i += 1) {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : flat.length;
    const step = flat.slice(cuts[i].from, end).replace(/\*\*/g, '').trim().slice(0, 240);
    if (step.length >= 6 && !/^[-=_]{3,}$/.test(step)) steps.push(step);
  }
  return steps;
}

// Set arithmetic, not a model. The first lens supplies the skeleton and each later lens
// contributes only what nobody has said yet — which is the point of asking more than one.
function consolidate(proposals = []) {
  const usable = proposals.filter((item) => item && item.text);
  const steps = []; const contributors = [];
  for (const proposal of usable) {
    const own = extractSteps(proposal.text);
    let added = 0;
    for (const step of own) {
      if (steps.some((existing) => jaccard(keywords(existing), keywords(step)) > 0.4)) continue;
      steps.push(step); added += 1;
      if (steps.length >= 10) break;
    }
    contributors.push({ lens: proposal.lens, provider: proposal.provider, proposed: own.length, contributed: added });
    if (steps.length >= 10) break;
  }
  return { steps, contributors, lenses: usable.length };
}

function brief(plan) {
  if (!plan?.steps?.length) return '';
  const credit = (plan.contributors || []).map((item) => `${item.lens}/${item.provider}`).join(' + ');
  return [
    `DELIBERATED PLAN — ${plan.steps.length} steps, merged by PiAgent from ${plan.lenses} independent proposals${credit ? ` (${credit})` : ''}.`,
    ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
    'Follow this plan. It was proposed independently and merged; re-plan only if it clearly misfits, and say why.',
  ].join('\n');
}

// PiAgent's memory of what it has already thought through. Similar work reuses the
// merged plan instead of paying for the same discussion again — which is the owner's
// "deduplicate similar work" rule, applied before any money is spent rather than after.
class DeliberationMemory {
  constructor({ root, file = '', threshold = 0.5, limit = 120 } = {}) {
    this.file = file || path.join(root || '.', 'deliberation_memory.json');
    this.threshold = threshold; this.limit = limit;
  }

  read() {
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(value.plans) ? value : { version: 1, plans: [] }; }
    catch (_) { return { version: 1, plans: [] }; }
  }

  write(memory) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...memory, plans: memory.plans.slice(-this.limit) }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (_) {}
  }

  /**
   * The closest plan that has not proved itself wrong.
   *
   * This used to return the closest plan, full stop. Nothing recorded what happened
   * to a run afterwards, so a plan that led straight to a failure was recalled with
   * the same confidence as one that shipped — for as long as the file survived. A
   * memory that cannot be disappointed is not learning; it is a cache.
   */
  lookup(prompt) {
    const terms = keywords(prompt); let best = null; let score = 0;
    for (const plan of this.read().plans) {
      // More failures than successes means this shape of plan has been tried and did
      // not work. Recalling it would repeat the mistake with extra confidence.
      const { ok = 0, failed = 0 } = plan.outcomes || {};
      if (failed > ok) continue;
      const value = jaccard(terms, plan.terms || []);
      if (value > score) { score = value; best = plan; }
    }
    if (!best || score < this.threshold) return null;
    const { ok = 0, failed = 0 } = best.outcomes || {};
    return { steps: best.steps, contributors: best.contributors || [], lenses: best.lenses || 0,
      source: 'memory', similarity: Number(score.toFixed(2)), recalledFrom: best.summary,
      // Untried is not the same as proven. A caller that wants to weigh a recalled
      // plan can see which it is instead of inferring confidence from its existence.
      outcomes: { ok, failed }, proven: ok > 0 };
  }

  /**
   * What actually happened to the run that used this plan.
   *
   * Called once per finished run. Matching is by the same similarity the lookup used,
   * so an outcome lands on the entry that was (or would have been) recalled — there is
   * no id to thread through the coordinator, and adding one would mean every existing
   * memory file starts again from nothing.
   */
  record(prompt, { ok = false, runId = '', reason = '' } = {}) {
    const memory = this.read();
    const terms = keywords(prompt);
    let best = null; let score = 0;
    for (const plan of memory.plans) {
      const value = jaccard(terms, plan.terms || []);
      if (value > score) { score = value; best = plan; }
    }
    if (!best || score < this.threshold) return null;
    best.outcomes = best.outcomes || { ok: 0, failed: 0 };
    best.outcomes[ok ? 'ok' : 'failed'] += 1;
    best.lastOutcome = { ok: !!ok, runId: String(runId).slice(0, 60),
      reason: String(reason || '').replace(/\s+/g, ' ').slice(0, 160), at: new Date().toISOString() };
    this.write(memory);
    return best.outcomes;
  }

  store(prompt, plan) {
    if (!plan?.steps?.length) return null;
    const memory = this.read();
    const terms = keywords(prompt);
    if (memory.plans.some((item) => jaccard(terms, item.terms || []) >= this.threshold)) return null;
    const entry = { summary: String(prompt).replace(/\s+/g, ' ').slice(0, 120), terms, steps: plan.steps,
      contributors: plan.contributors || [], lenses: plan.lenses || 0,
      // Nothing has been learned from this plan yet, and that is a fact worth storing
      // rather than a zero to infer later.
      outcomes: { ok: 0, failed: 0 }, createdAt: new Date().toISOString() };
    memory.plans.push(entry); this.write(memory);
    return entry;
  }
}

module.exports = { LENSES, LOCAL_TOOLS, DeliberationMemory, needed, extractSteps, consolidate, brief };
