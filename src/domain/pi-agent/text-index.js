'use strict';
// One term index for the three callers that each grew their own.
//
// Japanese has no spaces, so splitting on whitespace produces one useless 40-character
// token per sentence and nothing ever matches. Without a morphological analyser the
// standard answer is character bigrams: index every adjacent pair of CJK characters and
// test each one as a substring. Latin words are indexed whole.
//
// That much all three call sites agree on. Everything else they disagree about, and the
// disagreement is load bearing rather than accidental — collapsing it into one "correct"
// tokenizer would silently change retrieval quality in three places at once:
//
//   * task-cache matches a whole prompt against a knowledge base of past prompts, so it
//     wants a bounded, lowercased bag of terms, and it bigrams anything that is not
//     plain a-z0-9 — including a token that mixes scripts ("3d生成" → 3d, d生, 生成).
//     Its output is also persisted: task_knowledge_base.json stores these terms as
//     intent_keywords and hashes them into task_pattern_hash, so any change to the
//     extraction invalidates every pattern already on disk. That is the strongest reason
//     this mode is reproduced character for character rather than tidied up.
//   * skill-registry scores a whole Latin word ten times higher than one bigram, so
//     words and grams live in separate buckets and neither is truncated.
//   * context-pruner uses its terms as substring probes against whole source files. A
//     two-character bigram appears in nearly every Japanese file, so it deliberately
//     keeps each CJK run whole: the term is longer, rarer, and therefore selective.
//     Feeding it bigrams instead would score every candidate file alike and the pruner
//     would pick the model's context essentially at random.
//
// The modes below are therefore the point of this module, not decoration: identical
// code, three declared shapes, each reproducing the implementation it replaces exactly.

// Latin filler that would otherwise match every cached pattern. task-cache's list is the
// widest of the three because it is applied to raw owner prompts rather than to curated
// skill frontmatter.
const CACHE_STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'with', 'at',
  'it', 'this', 'that', 'you', 'i', 'we', 'me', 'my', 'your', 'please', 'from', 'into', 'about',
]);
// Frontmatter scaffolding: "trigger" and "skill" appear in the indexed text of literally
// every skill file, so they carry no signal at all.
const SKILL_STOP = new Set(['trigger', 'the', 'and', 'for', 'with', 'use', 'used', 'when', 'this',
  'that', 'from', 'not', 'skill', 'task', 'tasks', 'etc']);
// The pruner's list is a regexp, not a set, because it is the only one that has to reject
// Japanese function words (する / して / これ / それ) as well as Latin ones — those are
// legitimate two-character CJK runs and would otherwise be its most common terms.
const PRUNE_STOP = /^(the|and|for|with|this|that|from|into|する|して|これ|それ)$/i;

// The CJK ranges differ per mode and are reproduced as they stand. They were written at
// different times and each one is baked into stored data or tuned scores:
//   3040-30FF  hiragana + katakana          (all three)
//   3400-4DBF  CJK unified extension A      (skill and prune only)
//   4DC0-4DFF  Yijing hexagrams             (prune only, via one contiguous sweep)
//   4E00-9FFF  CJK unified ideographs       (all three)
// Widening task-cache to match the others would re-tokenize every prompt and orphan the
// knowledge base, which is a data migration, not a cleanup.
const MODES = Object.freeze({
  // task-cache.keywords(): one flat, lowercased, bounded bag.
  cache: Object.freeze({
    coerce: 'string',
    lowercaseInput: true,
    pattern: /[a-z0-9぀-ヿ一-鿿]+/g,
    expand: 'auto',
    latin: /^[a-z0-9]+$/,
    minLatin: 3,
    stop: CACHE_STOP,
    limit: 40,
  }),
  // context-pruner.termsFor(): whole runs, original case, hard cap at 24 probes.
  prune: Object.freeze({
    coerce: 'blank-on-falsy',
    pattern: /[A-Za-z_$][\w$.-]{2,}|[぀-ヿ㐀-鿿]{2,}/g,
    expand: 'whole',
    stop: PRUNE_STOP,
    limit: 24,
  }),
  // skill-registry.extractTerms(), Latin half. Two passes over the same source rather
  // than one, because the two buckets are scored on completely different scales.
  skillWords: Object.freeze({
    coerce: 'string',
    pattern: /[A-Za-z][A-Za-z0-9.+_-]{2,}|[ァ-ヺー-ヿ]{2,}/g,
    expand: 'whole',
    lowercaseTerm: true,
    stop: SKILL_STOP,
  }),
  // skill-registry.extractTerms(), kanji half. Case is left alone: bigrams are CJK, where
  // lowercasing is a no-op, and the matcher tests them against the raw request.
  //
  // Kanji only, and katakana moved up to skillWords, because hiragana bigrams are
  // grammar: 「が足」「足り」「りな」「ない」 are inflection, they are rare across a skill
  // corpus, and rarity-weighting therefore scored them as distinctive. Measured, that
  // put an English-quiz skill at the top of "GPUのメモリが足りない".
  skillGrams: Object.freeze({
    coerce: 'string',
    pattern: /[㐀-䶿一-鿿]{2,}/g,
    expand: 'bigram',
  }),
});

// Scoring weights for rankDocs, kept as data so a caller can retune without forking the
// loop. A distinctive product name ("ace-step", "comfyui") is worth far more than a short
// common word and far more than any single bigram, and bigrams are numerous, so they are
// scored low and capped. Body evidence is corroboration rather than purpose, so it is
// capped low on both sides.
const MATCH_WEIGHTS = Object.freeze({
  word: 10, shortWord: 4, wordLength: 4,
  gram: 7, triggerGram: 16, gramTop: 3, gramCap: 22, gramWeightDefault: 0.5,
  bodyWord: 2, bodyGram: 0.5, bodyCap: 6,
  id: 16, family: 12, familyMin: 3,
  threshold: 10, floorRatio: 0.6, limit: 2,
});

const PRUNE_FIELDS = Object.freeze(['words', 'grams', 'bodyWords', 'bodyGrams', 'triggerWords', 'triggerGrams']);

function isStop(stop, term) {
  if (!stop) return false;
  return stop instanceof RegExp ? stop.test(term) : stop.has(term);
}

// The two coercions are not interchangeable. task-cache calls String(text) directly, so
// keywords(null) really does index the word "null"; the pruner writes String(x || '') and
// gets nothing back. Both are relied upon by their callers' null handling, so the mode
// declares which one it wants instead of this function picking a favourite.
function coerce(text, how) {
  return how === 'blank-on-falsy' ? String(text || '') : String(text);
}

// Terms come out in the order they were met, deduplicated, and capped.
//
// The cap is enforced while accumulating rather than by slicing at the end. That is not
// an optimisation: it is what the originals do, and for a set that only ever grows the
// two are the same answer — the first `limit` distinct terms in emission order — so
// stopping early also keeps a 200KB prompt from being fully tokenized for 24 probes.
function extractTerms(text, mode = MODES.cache) {
  const options = typeof mode === 'string' ? MODES[mode] : mode;
  if (!options || !options.pattern) throw new Error(`text-index: unknown mode ${String(mode)}`);
  const { expand = 'whole', latin = null, minLatin = 0, minLength = 0,
    lowercaseTerm = false, stop = null, limit = 0 } = options;

  let source = coerce(text, options.coerce);
  if (options.lowercaseInput) source = source.toLowerCase();

  const out = new Set();
  const full = () => limit > 0 && out.size >= limit;
  // String.prototype.match resets lastIndex on a global regexp before it starts, so the
  // shared pattern on the frozen mode is safe to reuse across calls.
  for (const token of source.match(options.pattern) || []) {
    if (full()) break;
    const term = lowercaseTerm ? token.toLowerCase() : token;
    if (isStop(stop, term)) continue;
    if (expand === 'bigram' || (expand === 'auto' && !latin.test(term))) {
      // A one-character run yields no pair, which is the same as skipping it.
      for (let i = 0; i + 2 <= term.length && !full(); i += 1) out.add(term.slice(i, i + 2));
      continue;
    }
    if (term.length >= (expand === 'auto' ? minLatin : minLength)) out.add(term);
  }
  return [...out];
}

// A skill's `Trigger:` line is the author stating outright when the skill applies, so it
// is folded into the source a second time — the terms in it end up counted once, but they
// are guaranteed to be present even when the description is long enough to bury them.
function skillTerms(description = '', name = '') {
  const trigger = /Trigger\s*:\s*(.+)$/im.exec(description);
  const stated = `${name} ${trigger ? trigger[1] : ''}`;
  const source = `${stated} ${description}`;
  return {
    words: extractTerms(source, MODES.skillWords),
    grams: extractTerms(source, MODES.skillGrams),
    // Indexed a second time on their own so the matcher can tell a term the author
    // declared as a trigger from one that merely appears in the prose around it.
    triggerWords: extractTerms(stated, MODES.skillWords),
    triggerGrams: extractTerms(stated, MODES.skillGrams),
  };
}

// Intersection over union on two term lists. The `|| 1` guards the empty-empty case,
// where the honest answer is 0 rather than NaN: two prompts with no indexable terms are
// not the same prompt, and a NaN here would compare false against every threshold and
// silently disable the cache.
function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / ((A.size + B.size - inter) || 1);
}

// Cheap IDF without a corpus.
//
// Indexing whole documents makes generic vocabulary ("生成", "実行", "file") appear in
// almost every one, where it adds the same noise to every score and therefore decides
// nothing while still costing a comparison. Anything present in more than `ratio` of the
// documents is dropped. Below `minDocs` the ratio is meaningless — with three documents a
// term in two of them looks common and is probably the whole signal — so it is left alone.
//
// Mutates in place and returns the same array, because the caller's documents are the
// index. Missing fields are skipped rather than throwing, so a caller can prune a subset.
function pruneCommonTerms(docs, { fields = PRUNE_FIELDS, ratio = 0.4, minDocs = 4 } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  if (list.length < minDocs) return list;
  const limit = Math.ceil(list.length * ratio);
  for (const field of fields) {
    const freq = new Map();
    for (const doc of list) {
      for (const term of new Set(doc[field])) freq.set(term, (freq.get(term) || 0) + 1);
    }
    for (const doc of list) {
      if (Array.isArray(doc[field])) doc[field] = doc[field].filter((term) => freq.get(term) <= limit);
    }
  }
  return list;
}

// A Latin term has to land on a word boundary. Plain substring matching put three
// unrelated skills on 「READMEを直してテストも通す」, all of them on the four letters of
// "read" inside README. Japanese has no such boundaries — and no such accidents, since
// its terms here are whole kanji compounds and katakana words — so it stays a substring
// test. Boundaries are checked by hand rather than by \b, which does not fire between a
// Latin letter and a kana character.
const ALNUM = /[a-z0-9]/;
function wordHit(haystack, word) {
  if (!ALNUM.test(word)) return haystack.includes(word);
  for (let at = haystack.indexOf(word); at >= 0; at = haystack.indexOf(word, at + 1)) {
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + word.length] || '';
    if (!ALNUM.test(before) && !ALNUM.test(after)) return true;
  }
  return false;
}

// Scores indexed documents against a request and returns the best few.
//
// Words are tested against the lowercased request and grams against the raw one, which is
// the same string for CJK and avoids lowercasing the request twice per document. An id
// that appears verbatim in the request is nearly conclusive; a family prefix ("n8n" for
// n8n-agents, n8n-validation-expert) reaches the right group when the full id is never
// typed. Note that an empty id substring-matches everything and therefore scores the id
// bonus — preserved from the original, where a document without an id is not a case that
// can occur, and changing it would move real scores.
function rankDocs(text, docs = [], { limit = MATCH_WEIGHTS.limit, weights = null,
  gramWeight = null, categories = null } = {}) {
  const w = weights ? { ...MATCH_WEIGHTS, ...weights } : MATCH_WEIGHTS;
  const raw = String(text || '');
  const haystack = raw.toLowerCase();
  if (!haystack.trim()) return [];
  const list = Array.isArray(docs) ? docs : [];
  const scored = list.map((doc) => {
    let score = 0;
    for (const word of doc.words || []) {
      if (wordHit(haystack, word)) score += word.length >= w.wordLength ? w.word : w.shortWord;
    }
    // A bigram is worth (how strongly the author meant it as a trigger) × (how rare it
    // is), and only the strongest few count. A long Japanese description overlaps a short
    // request on a dozen pieces of filler, and summing all of them let the wordiest
    // document out-score the one the request actually named.
    const triggers = new Set(doc.triggerGrams || []);
    const hits = [];
    for (const gram of doc.grams || []) {
      if (!raw.includes(gram)) continue;
      const rarity = gramWeight ? (gramWeight.get(gram) ?? w.gramWeightDefault) : w.gramWeightDefault;
      hits.push((triggers.has(gram) ? w.triggerGram : w.gram) * rarity);
    }
    const gramHits = hits.length;
    hits.sort((a, b) => b - a);
    score += Math.min(w.gramCap, hits.slice(0, w.gramTop).reduce((sum, value) => sum + value, 0));
    let bodyScore = 0;
    for (const word of doc.bodyWords || []) if (wordHit(haystack, word)) bodyScore += w.bodyWord;
    for (const gram of doc.bodyGrams || []) if (raw.includes(gram)) bodyScore += w.bodyGram;
    score += Math.min(w.bodyCap, bodyScore);
    const id = String(doc.id || '').toLowerCase();
    if (haystack.includes(id)) score += w.id;
    const family = id.split(/[-_ ]/)[0];
    if (family.length >= w.familyMin && haystack.includes(family)) score += w.family;
    return { doc, score: Math.round(score), gramHits };
  }).filter((row) => row.score >= w.threshold);
  scored.sort((a, b) => b.score - a.score);
  // Second place has to be in the same league as first. "Next.jsのページが遅い" scored the
  // Next.js skill at 26 and an auth skill at 14, purely because Auth0's description
  // mentions Next.js in passing — and with two slots, that spent one of them on ~900
  // tokens of unrelated instructions.
  const floor = (scored[0]?.score || 0) * w.floorRatio;
  return onePerCategory(scored.filter((row) => row.score >= floor), list, haystack, categories)
    .slice(0, limit)
    .map((row) => ({ ...row.doc, score: row.score, ...(row.standsFor ? { standsFor: row.standsFor } : {}) }));
}

// One document per category, because an assignment only has room for two of them.
//
// Asking about n8n returned n8n-workflow-patterns, n8n-subworkflows and n8n-self-hosting
// — three members of one family — and both slots went to the same subject. The
// best-scoring member speaks for its category, and where the family has an entry point
// that is what is returned; unless the request named a specific member out loud, in which
// case the owner asked for that one and gets it.
function onePerCategory(scored, docs, haystack = '', categories = null) {
  if (!categories || !categories.length) return scored;
  const categoryOf = (id) => categories.find((category) => category.members.test(String(id).toLowerCase())) || null;
  const byId = new Map(docs.map((doc) => [String(doc.id || '').toLowerCase(), doc]));
  const taken = new Set();
  const out = [];
  for (const row of scored) {
    const category = categoryOf(row.doc.id);
    const key = category ? category.id : row.doc.id;
    if (taken.has(key)) continue;
    taken.add(key);
    const canonical = category && byId.get(category.canonical);
    const named = haystack.includes(String(row.doc.id || '').toLowerCase());
    out.push(canonical && !named && canonical.id !== row.doc.id
      ? { ...row, doc: canonical, standsFor: row.doc.id }
      : row);
  }
  return out;
}

module.exports = { MODES, MATCH_WEIGHTS, PRUNE_FIELDS,
  CACHE_STOP, SKILL_STOP, PRUNE_STOP,
  extractTerms, skillTerms, jaccard, pruneCommonTerms, rankDocs, wordHit };
