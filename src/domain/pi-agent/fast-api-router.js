'use strict';

const knowledge = require('./pi-knowledge-orchestrator');
const { GLM_MODELS } = require('./model-router');
// One residency window for every local model BigKiji loads. See conversation-engine.
const { DEFAULT_KEEP_ALIVE: KEEP_ALIVE } = require('../pi-core/conversation-engine');

// Front desk is deliberately local-only. External providers receive no owner
// text until a disclosure manifest has been reviewed and approved.
const PRIORITY = ['ollama'];
const PAID_EXECUTORS = ['claude', 'codex', 'gemini', 'glm'];
const BLOCKED_PAID = ['kimi', 'openrouter', 'openai-tts', 'elevenlabs'];
// 前受付は軽量・高速が要件なのでGLMはflash枠を使う（IDの正本はmodel-router）
const MODELS = { ollama: 'qwen3.5:35b-a3b', glm: GLM_MODELS.flash };
async function ollamaReady(timeoutMs = 850) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal }); return response.ok; }
  catch (_) { return false; } finally { clearTimeout(timer); }
}
// Which providers this front desk may use — not which providers exist.
//
// The paid entries are false on purpose: the front desk is local-only, because no
// owner text may reach a paid provider before a disclosure manifest is approved.
// This was also wired to the fleet display, where the same false meant "offline"
// and put four working providers behind the word "Not available". Anything asking
// "can this provider run" wants provider-readiness.survey(), not this.
async function detect() { return { ollama: await ollamaReady(), glm: false, claude: false, codex: false,
  gemini: false, kimi: false, openrouter: false }; }
function availableOrder(availability) { return PRIORITY.filter((id) => availability[id]); }

function safeJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*|\s*```$/g, '');
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function facilitatorPrompt(ownerText, prior = '') {
  return `You are BigKiji's concise requirements facilitator. Never execute tools or edit files.\n` +
    `Owner request: """${knowledge.cleanText(ownerText, 5000)}"""\n` +
    (prior ? `Previous facilitation context: """${knowledge.cleanText(prior, 2600)}"""\n` : '') +
    (prior ? `The owner has answered the clarification. Do not ask another question; choose safe reasonable defaults and produce a decision-complete Prompt Spec.\n`
      : `If materially important decisions are missing, ask for ALL of them in this one round — never hold one back to ask next turn. Otherwise produce a decision-complete Prompt Spec.\n`
        + `Every question must be answerable by picking, not by writing: give 2-5 concrete, mutually exclusive options. Never ask an open-ended question.\n`) +
    // The spec is read by Claude, Codex, GLM and Gemini, and describes identifiers,
    // paths and libraries that only exist in English. Measured 2026-08-05: a Japanese
    // request already came back as an English spec because this prompt is in English —
    // so this states the rule rather than introducing it, and adds the half that was
    // missing. A translated proper noun is a silent requirement change the owner
    // cannot catch, because the owner reads the request in Japanese and the spec in
    // English; names, paths, numbers and domain terms therefore travel verbatim.
    `Write the Prompt Spec in English, whatever language the owner used.\n` +
    `Ask your questions in the owner's own language.\n` +
    `Never translate names, file paths, identifiers, numbers, or the owner's domain terms — copy them exactly as written.\n` +
    `Return JSON only: {"status":"needs_clarification|ready","questions":[{"ask":"...","options":["...","..."]}],"promptSpec":{"goal":"...","constraints":["..."],"steps":["..."],"acceptance":["..."]}}`;
}
async function runOllama(prompt) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // `think: false` is why this returns a spec instead of nothing.
    //
    // qwen3.5 is a reasoning model and its deliberation is drawn from the same
    // num_predict budget as the answer, so it spent all 700 thinking and returned
    // truncated output — `safeJson` gave null, the loop recorded "ollama returned
    // invalid facilitator JSON", and every request fell through to the deterministic
    // spec. Measured 2026-08-05: 2.6s and a fallback with the flag off, 5.7s and a
    // 945-character decision-complete spec with it on. conversation-engine.js found
    // and fixed exactly this; the fix never reached the second place that needed it.
    body: JSON.stringify({ model: MODELS.ollama, prompt, stream: false, format: 'json', keep_alive: KEEP_ALIVE, think: false,
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 700 } }),
  });
  const body = await response.json(); if (!response.ok || body.error) throw new Error(body.error || `ollama ${response.status}`);
  return String(body.response || '');
}
function fallbackSpec(ownerText) {
  return { status: 'ready', questions: [], promptSpec: {
    goal: knowledge.cleanText(ownerText, 900), constraints: ['Paid execution is limited to Claude, Codex, Gemini and GLM', 'Persist approved state locally'],
    steps: ['Audit relevant code', 'Implement the requested change', 'Run proportional verification'], acceptance: ['Requested behavior works', 'Tests pass', 'No blocked paid provider is invoked'],
  } };
}
/**
 * Questions the owner can answer by picking.
 *
 * The owner asked for this after a six-character request produced three open-ended
 * questions in a row — "どのような形式の映画ですか？" is a form to fill in, not a decision
 * to make, and answering it costs more than the request did. A question with no
 * options is still shown: losing the question entirely would be worse than showing
 * one that has to be typed at.
 */
function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).map((entry) => {
    const ask = knowledge.cleanText(typeof entry === 'string' ? entry : (entry?.ask || entry?.question || ''), 240);
    if (!ask) return null;
    const raw = Array.isArray(entry?.options) ? entry.options : [];
    const options = [...new Set(raw.map((o) => knowledge.cleanText(String(o), 80)).filter(Boolean))].slice(0, 5);
    return { ask, options };
  }).filter(Boolean);
}
/** Numbered questions, lettered options, and the one answer that is always available. */
function questionText(questions) {
  return questions.map((q, i) => {
    const head = `${i + 1}. ${q.ask}`;
    if (!q.options.length) return head;
    const options = q.options.map((option, j) => `   ${String.fromCharCode(97 + j)}) ${option}`);
    return [head, ...options].join('\n');
  }).join('\n') + (questions.length ? '\n\n答えは「1a 2c 3b」のように並べても、言葉で書いても、「おまかせ」でも通ります。' : '');
}

function specText(spec) {
  const p = spec.promptSpec || {};
  // fallbackSpec always fills these with arrays; a model answering the same schema
  // does not. `"constraints": "none"` is a reasonable thing for a small model to
  // emit and used to throw here, which the caller swallowed into a bare
  // "Fast route unavailable" — the actual cause never reached anyone.
  const join = (value, sep) => (Array.isArray(value) ? value : [value].filter(Boolean).map(String)).join(sep);
  return [`Goal: ${p.goal || ''}`, `Constraints: ${join(p.constraints, '; ')}`, `Steps: ${join(p.steps, ' -> ')}`, `Acceptance: ${join(p.acceptance, '; ')}`].join('\n');
}

class FastFacilitatorRouter {
  constructor() { this.pending = null; }
  async facilitate(ownerText, { onStart, onDelta } = {}) {
    const started = Date.now(); const text = knowledge.cleanText(ownerText, 5000);
    const cached = knowledge.findPlan(text);
    // A cache entry is only usable if it kept the fields, not just the prose.
    //
    // This branch returned `promptSpecText` and no `promptSpec` at all, so a caller
    // that needs goal/constraints/steps/acceptance got nothing and fell back to
    // whatever it had — which made a cache *hit* produce a worse spec than a miss.
    // Measured 2026-08-05: the second identical request came back in 2 ms as
    // `provider: local-cache` carrying no structured spec. Entries written before
    // this simply read as misses and are replaced the next time one is written.
    if (cached?.spec) {
      const result = { status: 'ready', cached: true, provider: 'local-cache', promptSpec: cached.spec,
        promptSpecText: cached.plan, planHash: cached.planHash, questions: [] };
      onStart?.('local-cache'); onDelta?.(result.promptSpecText); return { ...result, latencyMs: Date.now() - started };
    }
    const combined = this.pending ? `${this.pending.ownerText}\nOwner answers: ${text}` : text;
    const prior = this.pending ? JSON.stringify(this.pending.questions) : '';
    const availability = await detect(); const candidates = availableOrder(availability);
    let parsed = null; let provider = 'deterministic-local'; let lastError = null; let modelWrote = false;
    for (const candidate of candidates) {
      onStart?.(candidate);
      try {
        const request = facilitatorPrompt(combined, prior);
        const raw = await runOllama(request);
        parsed = safeJson(raw); if (!parsed) throw new Error(`${candidate} returned invalid facilitator JSON`);
        provider = candidate; modelWrote = true; break;
      } catch (err) { lastError = err; }
    }
    if (!parsed) parsed = fallbackSpec(combined);
    const questions = normalizeQuestions(parsed.questions);
    if (parsed.status === 'needs_clarification' && questions.length && !this.pending) {
      this.pending = { ownerText: combined, questions, provider, at: new Date().toISOString() };
      const message = questionText(questions); onDelta?.(message);
      return { status: 'needs_clarification', provider, questions, latencyMs: Date.now() - started, availability };
    }
    if (parsed.status === 'needs_clarification') { parsed = fallbackSpec(combined); modelWrote = false; }
    this.pending = null;
    const final = parsed.promptSpec ? parsed : fallbackSpec(combined);
    if (!parsed.promptSpec) modelWrote = false;
    const textSpec = specText(final); const task = knowledge.createTask(combined, 'facilitated');
    // Only a spec a model actually wrote is worth keeping.
    //
    // `fallbackSpec` is three generic steps and a goal that is the owner's line
    // verbatim — the deliberately empty answer for when nothing local responds. It
    // used to be stored anyway, so one unreachable moment became the permanent
    // answer to that request: every later ask returned it from cache in 2 ms, and
    // `provider: local-cache` gave no hint that no model had ever seen it. Measured
    // 2026-08-05, on the first live turn through this path.
    const stored = modelWrote ? knowledge.rememberPlan(task, textSpec, final.promptSpec?.steps || [], final.promptSpec) : null;
    onDelta?.(textSpec);
    return { status: 'ready', provider, promptSpec: final.promptSpec, promptSpecText: textSpec, planHash: stored?.planHash || null,
      remembered: !!stored, latencyMs: Date.now() - started, availability,
      fallbackReason: lastError ? knowledge.cleanText(lastError.message, 160) : null };
  }
  /**
   * Stage two, for questions this router did not ask.
   *
   * A plan can carry `⚠ unanswered` because the conversation model asked, not the
   * facilitator — and until now the owner had no way to answer it from anywhere:
   * the CLI offered approve, reject and later, none of which is an answer, so an
   * approved plan simply went back to asking. The pair is handed in here instead of
   * remembered, and the rest is the same second stage `facilitate()` runs when it
   * asked the questions itself: no further question, one decision-complete spec.
   */
  async answer(ownerText, questions, answerText, hooks = {}) {
    const asked = normalizeQuestions(questions);
    if (!asked.length) throw new Error('There is no question to answer');
    const said = knowledge.cleanText(String(answerText || ''), 5000);
    if (!said) throw new Error('An answer is required');
    this.pending = { ownerText: knowledge.cleanText(String(ownerText || ''), 5000), questions: asked, provider: 'owner', at: new Date().toISOString() };
    try { return await this.facilitate(said, hooks); }
    catch (error) { this.pending = null; throw error; }
  }
  reset() { this.pending = null; }
}

module.exports = { normalizeQuestions, questionText, PRIORITY, PAID_EXECUTORS, BLOCKED_PAID, MODELS, detect, ollamaReady, availableOrder, FastFacilitatorRouter, fallbackSpec, facilitatorPrompt, specText };
