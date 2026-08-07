'use strict';

// What BigKiji actually did, written in English, where another AI tool can read it.
//
// The owner's ask (2026-08-07): keep the prompt that was given, keep what came out, and
// keep the gap between the two, so the prompts BigKiji generates can be improved from
// evidence instead of memory. An external coding agent — Claude Code or Codex started
// separately in this repo — is the intended reader.
//
// Why this is not in ~/BigKijiUniverse/knowledge/ where the rest of the memory lives:
// a pi agent could not read it there.
//
// There are two boundaries and they disagree, which is the part that is easy to get
// wrong. Measured 2026-08-07:
//
//   SandboxPolicyResolver (this app)  taskRoot is prepended to allowRead, and the
//                                     daemon's cwd is /Users/yuma — so it permits
//                                     BigKijiUniverse. Checking only this layer would
//                                     have said the data folder was fine.
//   pi-sandbox (OS-enforced)          ~/.pi/agent/sandbox.json denies "/Users" wholesale
//                                     and its allowRead holes are ".", the BIGKIJI repo,
//                                     ~/.config, ~/.local, ~/.cache, ~/Library.
//                                     BigKijiUniverse matches none of them.
//
// The stricter layer wins, so the ledger would have been written and never once opened.
// The repo is granted by BOTH (pi-sandbox names .../CompanyApp/BIGKIJI in allowRead and
// allowWrite; app/.pi/sandbox.json names ./docs in both). Hence docs/v3/, and no new
// hole in the boundary — the data folder also holds task_state.json and, next door,
// state/remote.json, which is a token the policy classifies as sensitive.
//
// This module must never break a run. The daemon is long-lived; a throw here would take
// the run down with it. Everything is wrapped, nothing is awaited by the caller, and the
// translation gives up after a timeout and falls back to the原文.
//
// What it does NOT do: it does not edit prompts. It records. Proposals go to
// docs/v3/prompt-improvements.md for a human or an external agent to act on.

const fs = require('fs');
const path = require('path');
const http = require('http');

const knowledge = require('./pi-knowledge-orchestrator');

const DOCS = path.resolve(__dirname, '..', '..', '..', 'docs', 'v3');
const MD_PATH = path.join(DOCS, 'run-ledger.md');
const JSONL_PATH = path.join(DOCS, 'run-ledger.jsonl');

// One entry is roughly ten lines. 200 keeps the file inside what a coding agent will
// actually read in one go; older entries stay in the jsonl.
const MAX_ENTRIES = 200;
const PROMPT_QUOTE_CHARS = 400;

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const TRANSLATE_MODEL = process.env.BIGKIJI_LEDGER_MODEL || 'qwen3.5:35b-a3b';
const TRANSLATE_TIMEOUT_MS = 20000;

const HEADER = `# Run ledger — what BigKiji actually did, in English

Read this when you are asked to improve the prompts BigKiji generates.

Each entry is one run: the prompt exactly as it was given, what actually shipped, the
**gap** between the two, what broke, how it was fixed, and what that implies for the
next prompt.

**Why the gap line matters.** A run is marked COMPLETED when every assignment finishes.
That is not the same as delivering what was asked — a run can cleanly produce the wrong
thing. \`quality.checks\` only asks "did the assignments complete" and "was there an
independent read-only checker". Nobody checks the order against the goods. That is what
the Gap line is for.

**How to use it.** Group the "Prompt lesson" lines, find the ones that repeat, and
propose a change to the role instructions in
\`src/domain/pi-agent/core-execution-coordinator.js\` (ROLE_BLUEPRINT) or to the front
desk prompt. Put proposals in \`docs/v3/prompt-improvements.md\`. **Do not edit
ROLE_BLUEPRINT without the owner** — those five roles and their providers were each
decided for a reason recorded in the comments there.

\`bigkiji ledger --gaps\` aggregates the repeats for you.

Newest first. Full machine-readable detail, one JSON object per line, same folder:
\`run-ledger.jsonl\` (gitignored — it is on disk, it is just not worth a diff).

---
`;

/* ── small helpers ─────────────────────────────────────────────────────── */

const clean = (value, max = 600) => {
  try {
    return knowledge.cleanText(String(value == null ? '' : value), max);
  } catch (_) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }
};

const iso = (value) => {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/** POST to a local ollama and return the response text, or '' on any failure. */
function askLocal(prompt, { timeoutMs = TRANSLATE_TIMEOUT_MS, jsonMode = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    let body;
    try {
      body = JSON.stringify({
        model: TRANSLATE_MODEL,
        prompt,
        stream: false,
        // Without this, qwen3.5/3.6 spend the whole num_predict budget on `thinking`
        // and return an empty `response`. Measured 2026-08-05: the same prompt goes
        // from eval_count 229 (and an empty answer) to 14 with a clean one. `format`
        // only starts working once thinking is off.
        think: false,
        ...(jsonMode ? { format: 'json' } : {}),
        options: { temperature: 0, num_ctx: 8192, num_predict: 800 },
      });
    } catch (_) { return done(''); }

    let url;
    try { url = new URL('/api/generate', OLLAMA); } catch (_) { return done(''); }

    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { done(String(JSON.parse(raw).response || '')); } catch (_) { done(''); }
      });
    });

    req.on('error', () => done(''));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} done(''); });
    try { req.write(body); req.end(); } catch (_) { done(''); }
  });
}

/**
 * Translate to English. Proper nouns, paths, numbers, ids and commands stay as they are —
 * a translated file path is worse than an untranslated sentence.
 * Returns { text, translated }. Never throws.
 */
async function toEnglish(text) {
  const source = clean(text, 1200);
  if (!source) return { text: '', translated: true };
  // Latin-only text is already English enough; do not spend a model call on it.
  if (!/[^\x00-\x7F]/.test(source)) return { text: source, translated: true };

  const answer = await askLocal(
    'Translate the instruction below into plain English. Reply as JSON only: {"en":"..."}\n' +
    'Rules: keep file paths, commands, identifiers, model names, URLs and all numbers ' +
    'exactly as they appear — do not translate or reformat them. Do not add anything ' +
    'that is not in the original. Do not summarise; translate.\n\n' +
    `Instruction:\n${source}`,
  );

  try {
    const parsed = JSON.parse(answer);
    const en = clean(parsed.en, 1200);
    if (en) return { text: en, translated: true };
  } catch (_) { /* fall through */ }
  return { text: source, translated: false };
}

/* ── what actually shipped ─────────────────────────────────────────────── */

function deliveries(run) {
  const rows = (run.report && Array.isArray(run.report.rows)) ? run.report.rows : [];
  if (rows.length) {
    return rows.map((row) => ({
      role: row.role || '?',
      provider: row.provider || '?',
      model: row.model || '',
      status: row.status || '?',
      wrote: Boolean(row.wrote),
      changed: Array.isArray(row.changed) ? row.changed : [],
      headline: clean(row.headline, 200),
      error: clean(row.error, 200),
    }));
  }
  // No report (aborted, expired). Fall back to the assignments so the entry is still
  // worth reading rather than empty.
  return (run.assignments || []).filter((a) => a.kind !== 'diagnosis').map((a) => ({
    role: a.role || '?', provider: a.provider || '?', model: a.model || '',
    status: a.status || '?', wrote: Boolean(a.write), changed: [],
    headline: '', error: clean(a.error, 200),
  }));
}

function changedFileCount(rows) {
  const all = new Set();
  for (const row of rows) for (const f of row.changed) all.add(String(f));
  return all.size;
}

/**
 * The one gap we can settle without a model: a countable request that did not arrive.
 *
 * Counting is exactly what a language model is worst at and a regex is best at, so the
 * quantity check is done here and the model is never asked to count anything. It only
 * fires when the request names a number AND something was actually written — otherwise
 * there is nothing to compare and saying "nothing was delivered" would be a lie about a
 * run whose diff simply was not captured.
 */
function quantityGap(promptText, rows) {
  const text = String(promptText || '');
  const files = changedFileCount(rows);
  if (!files) return null;

  const asked = [];
  const re = /(\d+)\s*(?:個|本|枚|件|つ|ユニット|units?|files?|images?|scenes?|shots?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n > 1 && n <= 500) asked.push({ n, phrase: m[0].trim() });
  }
  if (!asked.length) return null;

  const biggest = asked.reduce((a, b) => (b.n > a.n ? b : a));
  if (files >= biggest.n) return null;
  return `The prompt asks for **${biggest.phrase}**; the run changed **${files} file(s)**. ` +
    'That is not proof of a shortfall on its own — one file can hold many units — but ' +
    'nothing in the run checked the count, so it went unverified.';
}

/**
 * Ask the local model what the request asked for that the outcome does not evidence.
 * Grounded: it only sees the request and the outcome, it is told to cite, and any
 * finding that cites nothing from the record is dropped here rather than printed.
 */
async function findGap(promptEnglish, rows, run) {
  const outcome = rows.map((r) =>
    `- ${r.role}/${r.provider}: ${r.status}` +
    (r.changed.length ? `, changed ${r.changed.length} file(s): ${r.changed.slice(0, 8).join(', ')}` : ', no files recorded') +
    (r.headline ? ` — "${r.headline}"` : '')).join('\n');

  if (!rows.length) return { text: '(cannot tell from this run record — no assignments were recorded)', evidenced: false };
  if (!changedFileCount(rows)) {
    return {
      text: '(cannot tell from this run record — no file changes were captured, so there is nothing to compare the request against)',
      evidenced: false,
    };
  }

  const answer = await askLocal(
    'You are checking whether a piece of work matches the request. Reply as JSON only: ' +
    '{"gap":"...","evidence":"...","certain":true|false}\n' +
    'Which parts of the REQUEST are not evidenced in the OUTCOME? Quote the file names, ' +
    'counts or headlines from the OUTCOME that you based this on, in "evidence". ' +
    'If the outcome does look like the request, set "gap" to "none". ' +
    'If the record is too thin to tell, set "certain" to false and say so in "gap". ' +
    'Do not invent anything that is not in the OUTCOME.\n\n' +
    `REQUEST:\n${promptEnglish}\n\nOUTCOME:\n${outcome}\n` +
    `Run status: ${run.status}. Repair cycles: ${run.repairCycle || 0}.`,
  );

  try {
    const parsed = JSON.parse(answer);
    const gap = clean(parsed.gap, 500);
    const evidence = clean(parsed.evidence, 300);
    if (!gap || /^none$/i.test(gap)) return { text: '(none — the outcome matches the request as far as this record shows)', evidenced: true };
    // A finding that points at nothing in the record is a guess. Drop it.
    const grounded = evidence && rows.some((r) =>
      r.changed.some((f) => evidence.includes(String(f).split('/').pop())) ||
      (r.headline && evidence.includes(r.headline.slice(0, 24))) ||
      evidence.includes(r.role));
    if (!grounded) return { text: '(cannot tell from this run record — the check produced no evidence to stand on)', evidenced: false };
    return { text: `${gap} _(evidence: ${evidence})_`, evidenced: parsed.certain !== false };
  } catch (_) {
    return { text: '(cannot tell from this run record — the local check did not answer)', evidenced: false };
  }
}

/* ── the lesson ────────────────────────────────────────────────────────── */

function promptLesson({ gap, quantity, diagnoses, acceptance, files }) {
  if (quantity) {
    return 'A countable request needs a countable acceptance line. → when the prompt names ' +
      'a quantity, restate it in `acceptance` so the quality gate can fail on it.';
  }
  if (gap && gap.evidenced && !gap.text.startsWith('(none')) {
    return `The request and the result diverged where the prompt left room. → ${gap.text.split('_(evidence')[0].trim()}`;
  }
  if (diagnoses.length) {
    const d = diagnoses[0];
    return `${d.cause} → say this in the prompt up front: ${d.fix}`;
  }
  // "We could not tell" is not "it was fine". Saying "delivered as asked" here would be
  // asserting something this record does not establish — the first version did exactly
  // that and it read as a clean bill of health for runs nobody had checked.
  if (!files) {
    return 'This run recorded no file changes, so nothing here can say whether the ' +
      'request was met. → the gap check is blind without a captured diff.';
  }
  if (!acceptance) {
    return 'No acceptance criteria were given, so the run could only check that the ' +
      'assignments finished. → give one line of "done means…" with every request.';
  }
  return '(no lesson — delivered as asked)';
}

/**
 * Should this entry go in the markdown a person or an agent reads?
 *
 * The jsonl keeps everything. The markdown is a reading surface, and `npm test` alone
 * adds three identical fixture runs to it — left unchecked those bury the runs that
 * carry a lesson. A run with no diff, no diagnosis and no gap teaches nothing, so it
 * stays in the jsonl where the aggregate can still count it.
 */
function worthReading(entry) {
  if (entry.status !== 'COMPLETED') return true;
  if (entry.repair_cycles) return true;
  if (entry.diagnoses.length) return true;
  if (entry.files_changed) return true;
  return false;
}

/* ── writing ───────────────────────────────────────────────────────────── */

function renderEntry(e) {
  const L = [];
  L.push(`## ${e.run_id} · ${e.finished_at} · ${e.status}` +
    (e.repair_cycles ? ` · ${e.repair_cycles} repair cycle(s)` : ''));
  L.push('');
  L.push('**Prompt as given (verbatim):**');
  L.push(...String(e.prompt_original || '(empty)').split('\n').slice(0, 12).map((l) => `> ${l}`));
  if ((e.prompt_original || '').length > PROMPT_QUOTE_CHARS) L.push('> …(truncated — full text in run-ledger.jsonl)');
  L.push('');
  if (e.prompt_english && e.prompt_english !== e.prompt_original) {
    L.push(`**Prompt (en):** ${e.prompt_english}${e.translated ? '' : '  `[not translated]`'}`);
  }
  L.push(`**Acceptance as given:** ${e.acceptance || '(none given)'}`);
  L.push(`**Issued to:** ${e.issued_to || '(none)'}`);
  L.push('');
  L.push(`**Delivered:** ${e.delivered || '(nothing recorded)'}`);
  L.push('');
  L.push(`**Gap (asked vs delivered):** ${e.gap}`);
  if (e.broke) { L.push(''); L.push(`**What broke:** ${e.broke}`); }
  if (e.fixed) { L.push(`**How it was fixed:** ${e.fixed}`); }
  L.push('');
  L.push(`**Prompt lesson:** ${e.prompt_lesson}`);
  L.push('');
  return L.join('\n');
}

function writeMarkdown(entry) {
  fs.mkdirSync(DOCS, { recursive: true });
  let body = '';
  if (fs.existsSync(MD_PATH)) {
    const existing = fs.readFileSync(MD_PATH, 'utf8');
    const marker = existing.indexOf('\n---\n');
    body = marker >= 0 ? existing.slice(marker + 5) : existing;
  }
  // Newest first, so a reader who opens the file sees the latest run without scrolling.
  const entries = (HEADER + '\n' + renderEntry(entry) + '\n' + body)
    .split(/(?=^## run-)/m);
  const head = entries.shift() || '';
  fs.writeFileSync(MD_PATH, head + entries.slice(0, MAX_ENTRIES).join(''));
}

function writeJsonl(entry) {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.appendFileSync(JSONL_PATH, JSON.stringify(entry) + '\n');
}

/* ── entry point ───────────────────────────────────────────────────────── */

class RunLedger {
  /**
   * Record one finished run. Fire and forget — the caller must not await this, and a
   * failure in here must never reach the run.
   */
  record(run) {
    if (!run || !run.id) return;
    Promise.resolve()
      .then(() => this._record(run))
      .catch(() => { /* a ledger that breaks a run is worse than no ledger */ });
  }

  async _record(run) {
    const spec = run.promptSpec || {};
    // redactPayload ran at submission; cleanText again on the way out so the file is
    // safe to read even if a later caller skips the daemon route.
    const original = clean(run.prompt || spec.goal || '', 4000);
    const { text: english, translated } = await toEnglish(spec.goal || original);

    const rows = deliveries(run);
    const quantity = quantityGap(original, rows);
    const gap = quantity
      ? { text: quantity, evidenced: true }
      : await findGap(english || original, rows, run);

    const diagnoses = (run.assignments || [])
      .filter((a) => a.diagnosis && a.kind !== 'diagnosis')
      .map((a) => ({ role: a.role, cause: clean(a.diagnosis.cause, 300), fix: clean(a.diagnosis.fix, 300) }));

    const acceptance = (Array.isArray(spec.acceptance) ? spec.acceptance : [])
      .map((a) => clean(a, 200)).filter(Boolean).join(' · ');

    const failed = rows.filter((r) => r.status !== 'completed');
    const entry = {
      run_id: run.id,
      finished_at: iso(run.finishedAt),
      status: run.status || 'UNKNOWN',
      mode: run.mode || '',
      repair_cycles: run.repairCycle || 0,
      prompt_original: original,
      prompt_english: english,
      translated,
      prompt_spec: {
        goal: clean(spec.goal, 1000),
        constraints: (spec.constraints || []).map((c) => clean(c, 200)),
        steps: (spec.steps || []).map((s) => clean(s, 200)),
        acceptance: (spec.acceptance || []).map((a) => clean(a, 200)),
      },
      acceptance,
      issued_to: rows.map((r) => `${r.role}/${r.provider}${r.model ? `:${r.model}` : ''}`).join(' · '),
      delivered: rows.map((r) =>
        `${r.role} ${r.status}${r.changed.length ? ` (${r.changed.length} file(s))` : ''}` +
        (r.headline ? ` — ${r.headline}` : '')).join(' · '),
      files_changed: changedFileCount(rows),
      rows,
      gap: gap.text,
      gap_evidenced: gap.evidenced,
      broke: failed.map((r) => `${r.role} — ${r.error || r.status}`).join(' · '),
      fixed: diagnoses.map((d) => d.fix).filter(Boolean).join(' · '),
      diagnoses,
      checks: ((run.quality && run.quality.checks) || []).map((c) => ({ id: c.id, pass: !!c.pass })),
      prompt_lesson: promptLesson({ gap, quantity, diagnoses, acceptance, files: changedFileCount(rows) }),
    };

    writeJsonl(entry);
    if (worthReading(entry)) writeMarkdown(entry);
  }
}

module.exports = { RunLedger, MD_PATH, JSONL_PATH };
