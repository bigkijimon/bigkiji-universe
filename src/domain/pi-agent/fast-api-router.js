'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const knowledge = require('./pi-knowledge-orchestrator');

// Front desk only. Heavy paid execution remains in TaskRunner (Claude Code/GLM).
const PRIORITY = ['ollama', 'glm'];
const PAID_EXECUTORS = ['claude', 'codex', 'gemini', 'glm'];
const BLOCKED_PAID = ['kimi', 'openrouter', 'openai-tts', 'elevenlabs'];
const MODELS = { ollama: 'qwen3.5:35b-a3b', glm: 'glm-4.7-flash' };
const PLACEHOLDER = /^REPLACE_WITH|^YOUR_|^$/i;

function usableKey(value) { return typeof value === 'string' && value.length > 8 && !PLACEHOLDER.test(value); }
function glmConfig() {
  if (usableKey(process.env.ZAI_API_KEY)) return { key: process.env.ZAI_API_KEY, baseUrl: 'https://api.z.ai/api/paas/v4' };
  try {
    const file = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8'));
    const provider = file.providers?.zai;
    if (provider && usableKey(provider.apiKey)) return { key: provider.apiKey, baseUrl: provider.baseUrl };
  } catch (_) {}
  return null;
}
async function ollamaReady(timeoutMs = 850) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal }); return response.ok; }
  catch (_) { return false; } finally { clearTimeout(timer); }
}
async function detect() { return { ollama: await ollamaReady(), glm: !!glmConfig(), claude: true, codex: true,
  gemini: usableKey(process.env.GEMINI_API_KEY), kimi: false, openrouter: false }; }
function availableOrder(availability) { return PRIORITY.filter((id) => availability[id]); }

function safeJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*|\s*```$/g, '');
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function facilitatorPrompt(ownerText, prior = '') {
  return `You are BigKiji's concise requirements facilitator. Never execute tools or edit files.\n` +
    `Owner request: """${knowledge.cleanText(ownerText, 5000)}"""\n` +
    (prior ? `Previous facilitation context: """${knowledge.cleanText(prior, 2600)}"""\n` : '') +
    `If a materially important decision is missing, ask 1-3 short questions. Otherwise produce a decision-complete Prompt Spec.\n` +
    `Return JSON only: {"status":"needs_clarification|ready","questions":["..."],"promptSpec":{"goal":"...","constraints":["..."],"steps":["..."],"acceptance":["..."]}}`;
}
async function runOllama(prompt) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELS.ollama, prompt, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0.1, num_predict: 700 } }),
  });
  const body = await response.json(); if (!response.ok || body.error) throw new Error(body.error || `ollama ${response.status}`);
  return String(body.response || '');
}
async function runGlm(prompt) {
  const conf = glmConfig(); if (!conf) throw new Error('GLM is not configured');
  const response = await fetch(`${conf.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({ model: MODELS.glm, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.1 }),
  });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || `glm ${response.status}`);
  return String(body.choices?.[0]?.message?.content || '');
}
function fallbackSpec(ownerText) {
  return { status: 'ready', questions: [], promptSpec: {
    goal: knowledge.cleanText(ownerText, 900), constraints: ['Paid execution is limited to Claude, Codex, Gemini and GLM', 'Persist approved state locally'],
    steps: ['Audit relevant code', 'Implement the requested change', 'Run proportional verification'], acceptance: ['Requested behavior works', 'Tests pass', 'No blocked paid provider is invoked'],
  } };
}
function specText(spec) {
  const p = spec.promptSpec || {};
  return [`Goal: ${p.goal || ''}`, `Constraints: ${(p.constraints || []).join('; ')}`, `Steps: ${(p.steps || []).join(' -> ')}`, `Acceptance: ${(p.acceptance || []).join('; ')}`].join('\n');
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
        const raw = candidate === 'ollama' ? await runOllama(facilitatorPrompt(combined, prior)) : await runGlm(facilitatorPrompt(combined, prior));
        parsed = safeJson(raw); if (!parsed) throw new Error(`${candidate} returned invalid facilitator JSON`);
        provider = candidate; break;
      } catch (err) { lastError = err; }
    }
    if (!parsed) parsed = fallbackSpec(combined);
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3).map((q) => knowledge.cleanText(q, 240)) : [];
    if (parsed.status === 'needs_clarification' && questions.length) {
      this.pending = { ownerText: combined, questions, provider, at: new Date().toISOString() };
      const message = questions.map((q, i) => `${i + 1}. ${q}`).join('\n'); onDelta?.(message);
      return { status: 'needs_clarification', provider, questions, latencyMs: Date.now() - started, availability };
    }
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

module.exports = { PRIORITY, PAID_EXECUTORS, BLOCKED_PAID, MODELS, detect, availableOrder, FastFacilitatorRouter, fallbackSpec };
