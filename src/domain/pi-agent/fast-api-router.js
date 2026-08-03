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
      : `If a materially important decision is missing, ask 1-3 short questions. Otherwise produce a decision-complete Prompt Spec.\n`) +
    `Return JSON only: {"status":"needs_clarification|ready","questions":["..."],"promptSpec":{"goal":"...","constraints":["..."],"steps":["..."],"acceptance":["..."]}}`;
}
async function runOllama(prompt) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELS.ollama, prompt, stream: false, format: 'json', keep_alive: KEEP_ALIVE, options: { temperature: 0.1, num_predict: 700 } }),
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
    if (cached) {
      const result = { status: 'ready', cached: true, provider: 'local-cache', promptSpecText: cached.plan, planHash: cached.planHash, questions: [] };
      onStart?.('local-cache'); onDelta?.(result.promptSpecText); return { ...result, latencyMs: Date.now() - started };
    }
    const combined = this.pending ? `${this.pending.ownerText}\nOwner answers: ${text}` : text;
    const prior = this.pending ? JSON.stringify(this.pending.questions) : '';
    const availability = await detect(); const candidates = availableOrder(availability);
    let parsed = null; let provider = 'deterministic-local'; let lastError = null;
    for (const candidate of candidates) {
      onStart?.(candidate);
      try {
        const request = facilitatorPrompt(combined, prior);
        const raw = await runOllama(request);
        parsed = safeJson(raw); if (!parsed) throw new Error(`${candidate} returned invalid facilitator JSON`);
        provider = candidate; break;
      } catch (err) { lastError = err; }
    }
    if (!parsed) parsed = fallbackSpec(combined);
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3).map((q) => knowledge.cleanText(q, 240)) : [];
    if (parsed.status === 'needs_clarification' && questions.length && !this.pending) {
      this.pending = { ownerText: combined, questions, provider, at: new Date().toISOString() };
      const message = questions.map((q, i) => `${i + 1}. ${q}`).join('\n'); onDelta?.(message);
      return { status: 'needs_clarification', provider, questions, latencyMs: Date.now() - started, availability };
    }
    if (parsed.status === 'needs_clarification') parsed = fallbackSpec(combined);
    this.pending = null;
    const final = parsed.promptSpec ? parsed : fallbackSpec(combined);
    const textSpec = specText(final); const task = knowledge.createTask(combined, 'facilitated');
    const stored = knowledge.rememberPlan(task, textSpec, final.promptSpec?.steps || []);
    onDelta?.(textSpec);
    return { status: 'ready', provider, promptSpec: final.promptSpec, promptSpecText: textSpec, planHash: stored.planHash,
      latencyMs: Date.now() - started, availability, fallbackReason: lastError ? knowledge.cleanText(lastError.message, 160) : null };
  }
  reset() { this.pending = null; }
}

module.exports = { PRIORITY, PAID_EXECUTORS, BLOCKED_PAID, MODELS, detect, availableOrder, FastFacilitatorRouter, fallbackSpec, facilitatorPrompt, specText };
