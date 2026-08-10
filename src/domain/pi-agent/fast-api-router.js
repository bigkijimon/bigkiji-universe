'use strict';

const knowledge = require('./pi-knowledge-orchestrator');
const { GLM_MODELS } = require('./model-router');
const { readGpuLock, ollamaFrozen } = require('./gpu-lock');
const { escapeReady, runEscape, escapeModel, ESCAPE_ORDER, ESCAPE_TIMEOUT_MS } = require('./cloud-escape');
// One residency window for every local model BigKiji loads. See conversation-engine.
const { DEFAULT_KEEP_ALIVE: KEEP_ALIVE } = require('../pi-core/conversation-engine');

// Local first, always. The rest are reachable only while the GPU is held by someone else
// and only when the owner has turned the escape on — see `cloudFallback` below.
// Then the owner's escape chain in their order (2026-08-10). GLM is last and kept
// rather than dropped: the key is one settings entry away, and a chain that silently
// omits a provider is worse than one that tries it and says why it failed.
const PRIORITY = ['ollama', 'claude', 'codex', 'glm'];
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
//
// One narrow exception, added 2026-08-09 at the owner's request and off by default.
//
// This machine serialises GPU work: `gpu-signal.sh` SIGSTOPs Ollama for the duration of
// a render, and the watchdog refuses to thaw while the lock exists. So while the owner
// generates a video, the front desk has nothing to think with and every request falls
// through to `fallbackSpec` — three generic steps and the owner's own line as the goal.
// The owner's words: 「ComfyUIなどが動いているときに全然ローカルAIが使えなかったら困ります」.
//
// `cloudFallback: 'gpu-busy'` lets exactly one provider through for exactly that window.
// It is still not "the front desk may use paid providers": nothing is reachable while the
// GPU is free, the text is redacted before it leaves, and the provider is named in the
// result so the owner can see which words went where. See `runGlm`.
// `gpuHeld`, `localReady` and `glmReady` exist so a caller — in practice a test — can
// state the machine instead of probing it. All three default to measuring. Without them
// every assertion about this function would depend on what the owner's GPU happened to be
// doing, which this repository has now been bitten by three times.
async function detect({ cloudFallback = 'off', gpuHeld = null, localReady = null, glmReady = null,
  cloudReady = null } = {}) {
  // One `ps` per call at most, and none at all when the caller states the machine.
  let frozen = null;
  const isFrozen = () => { if (frozen === null) frozen = ollamaFrozen()?.frozen === true; return frozen; };
  // A SIGSTOPped server accepts the connection and answers nothing, so the 850 ms probe
  // can only ever time out. Skipping it is 850 ms off the front of the exact turn that is
  // already the slowest one the owner has — the one taken during a render.
  const local = localReady === null ? (isFrozen() ? false : await ollamaReady()) : !!localReady;
  const stopped = gpuHeld === null ? (readGpuLock().held || isFrozen()) : !!gpuHeld;
  // Four conditions, and each one is a different question: did the owner allow this, is
  // the local model unable to answer, is something else holding the card, and is there a
  // key for the thing we are about to spawn.
  const allowed = cloudFallback === 'gpu-busy';
  const window = allowed && !local && stopped;
  // `glmReady` stays for the callers that already state it; `cloudReady` states the whole
  // chain at once. Both default to measuring, because every assertion about this function
  // that depended on what the owner's GPU happened to be doing has cost this repository a
  // debugging session.
  const ready = (provider) => {
    if (provider === 'glm' && glmReady !== null) return !!glmReady;
    if (typeof cloudReady === 'function') return !!cloudReady(provider);
    return escapeReady(provider);
  };
  // Claude, then Codex, then GLM — the owner's order (2026-08-10), and the same order the
  // conversation escape walks. This used to be GLM alone, which on this machine meant the
  // escape was open onto a provider that has never had a key: the front desk fell through
  // to three generic steps for the whole of every render.
  return { ollama: local,
    claude: window && ready('claude'), codex: window && ready('codex'), glm: window && ready('glm'),
    gemini: false, kimi: false, openrouter: false };
}

/**
 * Can a spawned `pi` actually reach zai — not "did the owner switch the escape on".
 *
 * These were the same question until 2026-08-10, when the owner reported that simple
 * questions were very slow and the measurement said this: `~/.pi/agent/auth.json` is `{}`,
 * the daemon's environment has GEMINI_API_KEY and GOOGLE_API_KEY and no ZAI_API_KEY, and
 * no key is saved in settings. GLM has never been reachable on this machine. `detect()`
 * offered it anyway — a setting is a permission, not a credential — so every front-desk
 * turn during a render spawned a provider that could only fail.
 *
 * The reasoning moved to `cloud-escape.escapeReady`, which asks it for every provider in
 * the chain rather than only this one: `readiness()` counts a key saved inside BigKiji as
 * ready, and it would be for anything reading the settings store, but these providers are
 * child processes and a child sees the environment and the login files. This name is kept
 * because it reads better at its two call sites and because the front desk's tests address
 * it directly.
 */
function glmCredentialled(env = process.env) {
  return escapeReady('glm', env);
}

/**
 * Why this plan is three generic steps, in the owner's language. Only ever called when no
 * model wrote the spec, so it always has something to say.
 *
 * Written for the screen, not for a log — so it names the job holding the card and the one
 * thing the owner could do about it, and it never says "unavailable" without saying what
 * is unavailable. `readGpuLock()` is a file read and `ollamaFrozen()` is memoised for two
 * seconds inside gpu-lock, so this costs nothing on the turn it explains.
 *
 * The distinction below cost a test failure worth keeping: a model that was *there* and
 * produced nothing usable is a different fact from no model at all, and "the cloud escape
 * is off" is not an explanation for anything when the local model answered fine. Reporting
 * both at once is how a true sentence becomes a misleading one.
 */
function draftNote(cloudFallback, availability = {}, { ready = escapeReady } = {}) {
  // "A model was there and produced nothing usable" is a different fact from "no model at
  // all", and it is true of any candidate that was offered — not only the two this
  // function used to name. It listed `ollama || glm` while the escape chain was one
  // provider long; with Claude and Codex in it, a run that reached Claude and came back
  // with unparseable text would have been explained as if nothing had been available.
  if (PRIORITY.some((id) => availability[id])) {
    return '（下書きです：モデルは応答しましたが、整理として使える形になりませんでした）';
  }
  const parts = [];
  const lock = readGpuLock();
  if (ollamaFrozen()?.frozen === true) {
    parts.push(lock.held
      ? `ローカルモデルは停止中です（GPUを「${lock.holder || '生成ジョブ'}」が${lock.since}から使用中）`
      : 'ローカルモデルは停止中です（GPUロックは誰も持っていません）');
  } else {
    parts.push('ローカルモデルが応答しませんでした');
  }
  if (cloudFallback !== 'gpu-busy') parts.push('クラウド退避は off です');
  else {
    // Which door was locked, by name. "The cloud escape is unavailable" tells the owner
    // nothing they can act on; "Claude and Codex are not signed in" tells them the one
    // command that fixes it. `ready` is injectable for the same reason `detect()`'s
    // arguments are: an assertion about this sentence must not depend on whether the
    // machine running the test happens to be signed in.
    const shut = ESCAPE_ORDER.filter((id) => !ready(id));
    if (shut.length === ESCAPE_ORDER.length) parts.push(`クラウド退避先（${shut.join(' / ')}）はどれも未ログイン・鍵未設定です`);
  }
  return `（下書きです：${parts.join('。')}。整理はまだ誰も書いていません）`;
}
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
// How long the front desk waits for a model. Ollama's is a whole-call budget rather than
// a stall deadline because this route is `stream: false` — there is nothing to observe
// until the JSON is complete.
const OLLAMA_TIMEOUT_MS = 30000;
// One timeout for every escape, defined where the escape lives.
const GLM_TIMEOUT_MS = ESCAPE_TIMEOUT_MS;

async function runOllama(prompt) {
  // A deadline, because a SIGSTOPped Ollama accepts the connection and never answers.
  //
  // `ollamaReady()` probes with 850ms in front of this, which is why the hang was never
  // seen — but detection and use are two moments, and a render that starts between them
  // left this `await` with nothing to end it. conversation-engine.js learned this the
  // expensive way (four consecutive turns at exactly 8000ms) and the fix never reached
  // the second place that talks to the same socket.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_TIMEOUT_MS); timer.unref?.();
  try {
    return await callOllama(prompt, ctrl.signal);
  } finally { clearTimeout(timer); }
}

async function callOllama(prompt, signal) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
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

/**
 * The escape hatch: one turn of facilitation off this machine.
 *
 * Reached only through `detect()`, which opens it only while the GPU is held and only
 * when the owner has switched `cloudFallback` on.
 *
 * It was GLM alone, chosen 2026-08-09 over Gemini (whose free quota this machine had
 * already exhausted — the recorded dispatch failure of run-mshw0qbn). Measured 2026-08-10:
 * GLM has never had a key here, so the one door in the escape opened onto a wall and every
 * turn taken during a render fell through to three generic steps. The owner chose Claude
 * then Codex. GLM stays last, because the key is one settings entry away.
 *
 * The flags, the redaction and the closed stdin all live in cloud-escape.js now — one
 * place, so the next provider added cannot get a weaker contract than this one. What
 * leaves the machine is one prompt: no tools, no context files, no session, no repository.
 */
function runGlm(prompt, options = {}) { return runEscape('glm', prompt, { model: MODELS.glm, ...options }); }
function runClaude(prompt, options = {}) { return runEscape('claude', prompt, options); }
function runCodex(prompt, options = {}) { return runEscape('codex', prompt, options); }

// Which function actually runs for a candidate name.
//
// The loop used to call `runOllama` whatever the candidate was. That was invisible while
// `detect()` pinned every non-local provider to false — the list could only ever contain
// 'ollama' — but it meant the first real entry would have been recorded under its own
// name with the local model's answer inside it. A provider label that does not name the
// thing that wrote the text is worse than no label, because the cost record, the routing
// history and the owner all read it.
const RUNNERS = { ollama: runOllama, claude: runClaude, codex: runCodex, glm: runGlm };
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
  /**
   * @param {{cloudFallback?: () => string, runners?: object, detectImpl?: Function}} deps
   *   `cloudFallback` is read per call rather than captured, so switching it in Settings
   *   takes effect on the next request instead of on the next restart.
   */
  constructor({ cloudFallback = () => 'off', runners = RUNNERS, detectImpl = detect } = {}) {
    this.pending = null;
    this.cloudFallback = cloudFallback;
    this.runners = runners;
    this.detectImpl = detectImpl;
  }
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
    let cloudFallback = 'off';
    try { cloudFallback = String(this.cloudFallback?.() || 'off'); } catch (_) {}
    const availability = await this.detectImpl({ cloudFallback });
    const candidates = availableOrder(availability);
    // With no candidate the loop below never runs, so `lastError` stays null and the
    // deterministic spec goes out reading `degraded: false` — a plan nobody wrote,
    // presented exactly like a plan a model thought about. The reason is known here and
    // nowhere downstream, so it is recorded here.
    let parsed = null; let provider = 'deterministic-local'; let modelWrote = false;
    let lastError = candidates.length ? null : new Error('no front-desk model was available');
    for (const candidate of candidates) {
      const run = this.runners[candidate];
      // A candidate with no runner is a list and a table that have drifted apart. Skipping
      // it silently would report the next provider's answer under this one's name.
      if (!run) { lastError = new Error(`no runner for ${candidate}`); continue; }
      onStart?.(candidate);
      try {
        const request = facilitatorPrompt(combined, prior);
        const raw = await run(request);
        parsed = safeJson(raw); if (!parsed) throw new Error(`${candidate} returned invalid facilitator JSON`);
        provider = candidate; modelWrote = true; break;
      } catch (err) { lastError = err; }
    }
    // Which words left the machine, said out loud.
    //
    // The front desk is local by default and the owner is entitled to assume it. When it
    // is not — the GPU was held and the escape was on — that is a fact about their privacy,
    // not an implementation detail, so it travels with the result and the daemon puts it
    // in front of the reply rather than only in a log.
    // Anything that is not the local model is off this machine. This read `=== 'glm'`
    // while GLM was the only escape; with Claude and Codex in the chain, that literal
    // would have let two providers see the owner's words and told them nothing.
    const viaCloud = ESCAPE_ORDER.includes(provider);
    const cloudNote = viaCloud
      ? `（GPUが埋まっていたので、この整理だけ ${escapeModel(provider) || provider}（クラウド）に出しました）`
      : '';
    if (!parsed) parsed = fallbackSpec(combined);
    const questions = normalizeQuestions(parsed.questions);
    if (parsed.status === 'needs_clarification' && questions.length && !this.pending) {
      this.pending = { ownerText: combined, questions, provider, at: new Date().toISOString() };
      const message = cloudNote ? `${cloudNote}\n${questionText(questions)}` : questionText(questions);
      onDelta?.(message);
      return { status: 'needs_clarification', provider, questions, viaCloud, cloudNote,
        latencyMs: Date.now() - started, availability };
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
    // The same argument as `cloudNote`, for the opposite fact: not "which model saw this"
    // but "no model did". Three generic steps under the owner's own sentence is a
    // recognisable thing once you know to look for it, and until now nothing said to look.
    const degradedNote = modelWrote ? '' : draftNote(cloudFallback, availability);
    onDelta?.(cloudNote ? `${cloudNote}\n${textSpec}` : textSpec);
    return { status: 'ready', provider, promptSpec: final.promptSpec, promptSpecText: textSpec, planHash: stored?.planHash || null,
      remembered: !!stored, viaCloud, cloudNote, degradedNote, latencyMs: Date.now() - started, availability,
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

module.exports = { normalizeQuestions, questionText, PRIORITY, PAID_EXECUTORS, BLOCKED_PAID, MODELS, detect, ollamaReady,
  availableOrder, FastFacilitatorRouter, fallbackSpec, facilitatorPrompt, specText, runOllama, runGlm, RUNNERS,
  glmCredentialled, draftNote, OLLAMA_TIMEOUT_MS, GLM_TIMEOUT_MS };
