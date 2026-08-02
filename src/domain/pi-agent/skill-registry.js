'use strict';
// Indexes the owner's accumulated skills so PiAgent routes work through them instead
// of rediscovering the same lessons every run.
//
// Why this exists: a sub-agent spent 428 seconds driving ComfyUI into unusable output
// while `~/.claude/skills/comfyui-workflow/SKILL.md` already recorded the required
// approach, and a music task was about to be run against ACE-Step's bundled CLI, whose
// default endpoint is a CLOUD api — directly against the owner's local-only rule, and
// silent because the cloud health check answers "OK". Those files are the owner's own
// hard-won instructions; not reading them is the expensive mistake.
//
// The registry is read-only. It never executes a skill and never widens the sandbox:
// matched guidance is injected into the plan as text, so the security boundary is
// unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Order matters: the first root wins on an id collision. The app ships English
// versions of the owner's skills because BigKiji's system language is English, and
// falls back to the Japanese originals for anything not yet translated.
const APP_SKILLS = path.resolve(__dirname, '..', '..', '..', 'skills');
const HOME = os.homedir();
const DEFAULT_ROOTS = [
  APP_SKILLS,
  path.join(HOME, '.claude', 'skills'),           // the owner's own, hand-written
  path.join(HOME, '.claude', 'plugins', 'cache'), // installed plugins (figma, vercel, sonarqube, ...)
  path.join(HOME, 'Documents', 'CEOBigKiji'),     // per-project skills inside the vault
  ...toolRepoSkillRoots(),                        // tool repos that ship their own (ACE-Step, LTX-2, ...)
];

// Local tool checkouts carry the operational knowledge for the tool itself, and it is
// often more current than the owner's notes about it: the ACE-Step skill in ~/.claude
// still records a path that no longer exists, while the repo's own copy sits next to
// the code. Bounded to one level under ~/Documents so this stays a cheap lookup.
function toolRepoSkillRoots(home = HOME) {
  const roots = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(home, 'Documents'), { withFileTypes: true }); } catch (_) { return roots; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'CEOBigKiji') continue;
    for (const relative of [path.join('.claude', 'skills'), 'skills']) {
      const candidate = path.join(home, 'Documents', entry.name, relative);
      if (fs.existsSync(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

// Paths that must never be indexed as authoritative.
//   _archive / cleanup- : superseded snapshots. Indexing a stale copy of a skill is
//                         worse than having none, because it reads as current.
//   jobs                : scratch space from a previous run
//   upstream            : vendored copies that would shadow their parent skill
const EXCLUDE = /(?:^|[\\/])(?:node_modules|\.git|_archive|cleanup-\d+|jobs|upstream|dist|graphify-out)(?:[\\/]|$)/;
const MAX_DEPTH = 6;
const MAX_DIGEST_CHARS = 1400;

// Frontmatter is a small, fixed YAML subset here: `key: value` lines between --- fences.
// Line-based on purpose — a skill file is not general YAML — but it has to handle the
// two forms real skill files use. A folded (`>`) or literal (`|`) block scalar parsed
// line-by-line yields the literal string ">", which is what a skill's whole description
// became: one term, matching nothing, silently never selected.
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        i += 1; folded.push(lines[i].trim());
      }
      out[kv[1]] = folded.join(value.startsWith('>') ? ' ' : '\n').trim();
      continue;
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

// A skill with no frontmatter at all is still a skill. Falling back to its first
// heading and first paragraph is the difference between indexing one term and
// indexing the document — the file is otherwise present but unreachable.
function describeWithoutFrontmatter(text) {
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const heading = /^#{1,3}\s+(.+)$/m.exec(body);
  const paragraph = body.split(/\r?\n\s*\r?\n/).map((block) => block.trim())
    .find((block) => block && !block.startsWith('#') && !block.startsWith('```'));
  return [heading ? heading[1].trim() : '', (paragraph || '').replace(/\s+/g, ' ').slice(0, 400)]
    .filter(Boolean).join(' — ');
}

// Terms come from the explicit `Trigger:` list when present, plus the description.
//
// Japanese has no spaces, so splitting on whitespace produces one useless 40-character
// token per sentence and nothing ever matches. Without a morphological analyser the
// standard answer is character bigrams: index every adjacent pair of CJK characters and
// test them as substrings. Latin words are indexed whole.
const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
// Frontmatter scaffolding and filler that would otherwise match everything.
const STOPWORDS = new Set(['trigger', 'the', 'and', 'for', 'with', 'use', 'used', 'when', 'this',
  'that', 'from', 'not', 'skill', 'task', 'tasks', 'etc']);

function extractTerms(description = '', name = '') {
  const trigger = /Trigger\s*:\s*(.+)$/im.exec(description);
  const source = `${name} ${trigger ? trigger[1] : ''} ${description}`;
  const words = new Set();
  const grams = new Set();
  for (const word of source.match(/[A-Za-z][A-Za-z0-9.+_-]{2,}/g) || []) {
    const lower = word.toLowerCase();
    if (!STOPWORDS.has(lower)) words.add(lower);
  }
  for (const run of source.match(new RegExp(`${CJK.source}+`, 'g')) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 2 <= run.length; i += 1) grams.add(run.slice(i, i + 2));
  }
  return { words: [...words], grams: [...grams] };
}

// The "traps" sections are where the owner records what actually went wrong. They are
// the highest-value lines in a skill file, so they lead the digest.
function buildDigest(body) {
  const lines = body.split(/\r?\n/);
  const trapStart = lines.findIndex((line) => /^#{1,4}\s*.*(⚠|罠|教訓|trap|pitfall|gotcha)/i.test(line));
  const picked = [];
  if (trapStart >= 0) {
    for (const line of lines.slice(trapStart, trapStart + 40)) {
      if (picked.length && /^#{1,4}\s/.test(line) && picked.length > 1) break;
      if (line.trim()) picked.push(line.trim());
    }
  }
  for (const line of lines) {
    if (picked.join('\n').length > MAX_DIGEST_CHARS) break;
    if (/^[-*]\s|^\d+\.\s/.test(line.trim()) && !picked.includes(line.trim())) picked.push(line.trim());
  }
  return picked.join('\n').slice(0, MAX_DIGEST_CHARS);
}

// Plugins ship several versions side by side (figma 2.2.81 and 2.2.87). Prefer the
// earlier-declared root, then the higher version, then the newer file.
function versionOf(file) {
  const match = /[\\/](\d+)\.(\d+)\.(\d+)[\\/]/.exec(file);
  return match ? Number(match[1]) * 1e6 + Number(match[2]) * 1e3 + Number(match[3]) : -1;
}

function preferSkill(candidate, current) {
  if (candidate.rootIndex !== current.rootIndex) return candidate.rootIndex < current.rootIndex;
  const a = versionOf(candidate.file); const b = versionOf(current.file);
  if (a !== b) return a > b;
  let ma = 0; let mb = 0;
  try { ma = fs.statSync(candidate.file).mtimeMs; } catch (_) {}
  try { mb = fs.statSync(current.file).mtimeMs; } catch (_) {}
  return ma > mb;
}

function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const meta = parseFrontmatter(text);
  const name = meta.name || path.basename(dir);
  const description = meta.description || describeWithoutFrontmatter(text);
  const body = text.slice(text.indexOf('---', 3) + 3);
  return {
    id: name,
    file,
    description,
    allowedTools: meta['allowed-tools'] || '',
    manualOnly: String(meta['disable-model-invocation'] || '') === 'true',
    // Two tiers. The frontmatter description states what a skill IS FOR and is scored
    // heavily; the body merely MENTIONS things and is scored lightly. Without this split
    // gpu-mem-switch wins every generation query, because arbitrating the GPU legitimately
    // requires it to name ComfyUI, LTX and ACE-Step — outranking the skill actually asked for.
    ...extractTerms(description, name),
    ...(() => { const b = extractTerms(body.slice(0, 4000), ''); return { bodyWords: b.words, bodyGrams: b.grams }; })(),
    digest: buildDigest(body),
  };
}

class SkillRegistry {
  constructor({ roots = DEFAULT_ROOTS } = {}) {
    this.roots = roots;
    this.skills = [];
  }

  // Skills are scattered: the owner's own, bundles that nest theirs a level down,
  // installed plugins several levels deep, and per-project ones inside the vault.
  // Walk rather than assume a shape, bounded in depth and filtered by EXCLUDE.
  discover() {
    const found = [];
    for (const root of this.roots) {
      const stack = [[root, 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > MAX_DEPTH || EXCLUDE.test(dir)) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
          found.push({ dir, root });
          continue; // a skill directory owns its subtree
        }
        for (const entry of entries) {
          if (entry.isDirectory()) stack.push([path.join(dir, entry.name), depth + 1]);
        }
      }
    }
    return found;
  }

  scan() {
    const byId = new Map();
    for (const { dir, root } of this.discover()) {
      const skill = readSkill(dir);
      if (!skill) continue;
      skill.origin = root === APP_SKILLS ? 'app'
        : dir.includes(`${path.sep}plugins${path.sep}`) ? 'plugin'
          : root === path.join(HOME, '.claude', 'skills') ? 'owner' : 'project';
      skill.rootIndex = this.roots.indexOf(root);
      const previous = byId.get(skill.id);
      if (!previous || preferSkill(skill, previous)) byId.set(skill.id, skill);
    }
    this.skills = [...byId.values()];
    this.pruneCommonTerms();
    return this.skills;
  }

  // Indexing whole bodies makes generic vocabulary ("生成", "実行", "file") appear in
  // almost every skill, where it adds noise to every score equally. Drop any term that
  // shows up in more than 40% of skills — cheap IDF without a corpus.
  pruneCommonTerms() {
    if (this.skills.length < 4) return;
    const limit = Math.ceil(this.skills.length * 0.4);
    for (const field of ['words', 'grams', 'bodyWords', 'bodyGrams']) {
      const freq = new Map();
      for (const skill of this.skills) {
        for (const term of new Set(skill[field])) freq.set(term, (freq.get(term) || 0) + 1);
      }
      for (const skill of this.skills) skill[field] = skill[field].filter((term) => freq.get(term) <= limit);
    }
  }

  // A whole Latin word is a far stronger signal than one CJK bigram, and bigrams are
  // numerous, so they are scored low and capped. A skill whose own id appears in the
  // request is almost certainly the right one.
  match(text, { limit = 2 } = {}) {
    const raw = String(text || '');
    const haystack = raw.toLowerCase();
    if (!haystack.trim()) return [];
    const scored = this.skills.map((skill) => {
      let score = 0;
      // A distinctive product name ("ace-step", "comfyui") is worth far more than a
      // short common word, and far more than any single bigram.
      for (const word of skill.words) if (haystack.includes(word)) score += word.length >= 4 ? 10 : 4;
      let gramHits = 0;
      for (const gram of skill.grams) if (raw.includes(gram)) gramHits += 1;
      score += Math.min(20, gramHits * 2);
      // Body evidence is corroboration, not purpose: capped low on both sides.
      let bodyScore = 0;
      for (const word of skill.bodyWords || []) if (haystack.includes(word)) bodyScore += 2;
      for (const gram of skill.bodyGrams || []) if (raw.includes(gram)) bodyScore += 0.5;
      score += Math.min(6, bodyScore);
      if (haystack.includes(skill.id.toLowerCase())) score += 16;
      // Skills ship in families ("n8n-agents", "n8n-validation-expert"); naming the tool
      // should reach the family even when the full id is never typed.
      const family = skill.id.toLowerCase().split(/[-_ ]/)[0];
      if (family.length >= 3 && haystack.includes(family)) score += 12;
      return { skill, score: Math.round(score), gramHits };
    }).filter((row) => row.score >= 10);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((row) => ({ ...row.skill, score: row.score }));
  }

  // A compact block for the plan prompt. Text only — this never grants filesystem
  // access, so the sandbox boundary is untouched.
  brief(text, { limit = 2 } = {}) {
    const matched = this.match(text, { limit });
    if (!matched.length) return '';
    const blocks = matched.map((skill) => [
      `### Skill: ${skill.id}`,
      `Reference: ${skill.file}`,
      skill.description ? `Purpose: ${skill.description.replace(/\s+/g, ' ').slice(0, 240)}` : '',
      skill.digest ? `Standing rules and known traps:\n${skill.digest}` : '',
    ].filter(Boolean).join('\n'));
    return ['## Owner skills that apply to this task',
      'These are the owner\'s own accumulated instructions. Follow them before improvising.',
      ...blocks].join('\n\n');
  }

  snapshot() {
    return {
      version: 1,
      scannedAt: new Date().toISOString(),
      roots: this.roots,
      counts: this.skills.reduce((acc, skill) => ({ ...acc, [skill.origin]: (acc[skill.origin] || 0) + 1 }), {}),
      skills: this.skills.map(({ id, file, description, allowedTools, manualOnly, origin, words, grams }) =>
        ({ id, file, origin, description, allowedTools, manualOnly, termCount: words.length + grams.length })),
      note: 'Frontmatter terms state purpose and are weighted heavily; body terms only corroborate.',
    };
  }

  persist(knowledgeRoot) {
    if (!knowledgeRoot) return '';
    const file = path.join(knowledgeRoot, 'skills.json');
    try {
      fs.mkdirSync(knowledgeRoot, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.snapshot(), null, 2));
      return file;
    } catch (_) { return ''; }
  }
}

module.exports = { SkillRegistry, DEFAULT_ROOTS, APP_SKILLS, EXCLUDE, parseFrontmatter,
  describeWithoutFrontmatter, extractTerms, buildDigest, versionOf };
