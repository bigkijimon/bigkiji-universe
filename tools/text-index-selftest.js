'use strict';
// Proof that text-index.js can replace three live tokenizers without moving anything.
//
// The three were written separately and disagree on purpose: task-cache bigrams mixed
// tokens and caps at 40, skill-registry keeps Latin words and CJK bigrams in separate
// unbounded buckets, and context-pruner keeps whole CJK runs because its terms are
// substring probes against source files. Unifying them by taste would look like a
// cleanup and would quietly change which files reach the model, which cached plan is
// reused, and which skill is injected — none of which fails loudly.
//
// So this file does not test the new module against expectations. It requires the three
// originals and asserts byte-identical output on the same inputs, including the ranges
// where they differ from each other. Everything else here is secondary.

const assert = require('assert');

const { keywords, jaccard: originalJaccard } = require('../src/domain/pi-agent/task-cache');
const { extractTerms: originalSkillTerms, SkillRegistry } = require('../src/domain/pi-agent/skill-registry');
const { termsFor } = require('../src/domain/pi-agent/context-pruner');
const index = require('../src/domain/pi-agent/text-index');

const clone = (value) => JSON.parse(JSON.stringify(value));
// assert() evaluates its message eagerly, and half the corpus is deliberately not
// JSON-representable, so this has to survive undefined as readily as a 200KB string.
const show = (value) => String(JSON.stringify(value) ?? value).slice(0, 220);

// ---- the corpus ---------------------------------------------------------------
// Hand-picked first: each entry is a shape one of the three call sites actually meets,
// and several exist only to pin down where the three deliberately diverge.
const SAMPLES = [
  '',
  ' ',
  '\n\n\t',
  'hello world',
  'Fix the login bug in src/core/main.js before the release',
  'camelCaseName snake_case_name kebab-case-name $dollarVar _under path/to/file.js',
  'a ab abc abcd 1 12 123 1234',
  'THE AND FOR WITH THIS THAT FROM INTO',
  'the and for with this that from into する して これ それ',
  'ACE-Step v1.5 と ComfyUI を GPU 信号機で直列に回す',
  'ひらがなカタカナ漢字混在のテキストを分割する',
  'これをして、それをする。日本語には空白がない',
  '予約システムの生徒名簿をUPCLASSから移行する',
  '3d生成とAI動画のワークフロー',           // mixed-script token: task-cache bigrams across the seam
  'π',
  '㐀㐁㐂',                                 // extension A: separator for task-cache, indexed by the other two
  '䷀䷁䷂',                                 // Yijing hexagrams: only context-pruner's contiguous sweep covers these
  'ヿヿ ぁ あ',
  '🚀 emoji 🎌 と 絵文字 😀 の 混在',
  'Trigger: 音楽制作, ACE-Step, BGM\nGenerate music locally with ACE-Step 1.5.',
  'Trigger : n8n, workflow, ノード\nUse when building an n8n workflow through the MCP server.',
  '同じ同じ同じ同じ',                        // repeated bigrams: dedupe order has to survive
  'file.js file.js file.js other.js',
  'ver1.2.3+build-7_final',
  '   leading and trailing   ',
  'A　B　C',                        // ideographic space is a separator everywhere
  'ｶﾀｶﾅ半角',                              // halfwidth katakana is outside every range
  'Ω Δ é ü ñ',                             // non-ASCII Latin/Greek: matched by none of the patterns
  null,
  undefined,
  0,
  false,
  123.45,
  {},
  ['配列', 'array'],
];

// A seeded generator, because a randomised equivalence test that cannot be replayed is
// not evidence. Same seed, same 400 strings, every run.
let seed = 20260803;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i));

const ALPHABETS = [
  range(0x3041, 0x3096),                   // hiragana
  range(0x30a1, 0x30fa).concat('ー', 'ヿ'), // katakana, including the range edge
  '一二三本日生成実行漢字語彙移行検証構築英語教室予約講師'.split(''),
  range(0x3400, 0x3410),                   // CJK extension A
  range(0x4dc0, 0x4dc5),                   // Yijing hexagrams
  'abcdefghijklmnopqrstuvwxyz'.split(''),
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  '0123456789'.split(''),
  ' \n\t'.split(''),
  '.-_$/+#(),:;!?"\'`~@%&*[]{}<>|\\='.split(''),
  ['🚀', '🎌', '😀', '👩‍💻', '　', '…', '—', '、', '。'],
];

const randomText = () => {
  const length = Math.floor(random() * 120);
  let out = '';
  for (let i = 0; i < length; i += 1) out += pick(pick(ALPHABETS));
  return out;
};
for (let i = 0; i < 400; i += 1) SAMPLES.push(randomText());

// A long document too: the pruner is handed whole prompts and the cache is handed whole
// owner instructions, and both cap their output, so the cap has to be reached the same
// way on input far larger than any hand-written sample.
const LONG = Array.from({ length: 4000 }, (_, i) => `段落${i} paragraph_${i} 実装と検証 unique${i}word`).join(' ');
SAMPLES.push(LONG);

// ---- 1. task-cache.keywords ----------------------------------------------------
for (const sample of SAMPLES) {
  assert.deepStrictEqual(index.extractTerms(sample, 'cache'), keywords(sample),
    `cache mode diverged from task-cache.keywords on ${show(sample)}`);
}

// ---- 2. context-pruner.termsFor ------------------------------------------------
for (const sample of SAMPLES) {
  assert.deepStrictEqual(index.extractTerms(sample, 'prune'), termsFor(sample),
    `prune mode diverged from context-pruner.termsFor on ${show(sample)}`);
}

// ---- 3. skill-registry.extractTerms --------------------------------------------
// Called with a description and a name, so the name is varied against the same bodies —
// the `Trigger:` line is pulled out of the description only, and folding the name in is
// what makes a short id reachable.
const NAMES = ['', 'music-gen', 'n8n-agents', 'ACE-Step', '音楽制作', 'a', undefined, null];
for (const sample of SAMPLES) {
  for (const name of NAMES) {
    assert.deepStrictEqual(index.skillTerms(sample, name), originalSkillTerms(sample, name),
      `skillTerms diverged from skill-registry.extractTerms on ${show(sample)} / ${show(name)}`);
  }
}
assert.deepStrictEqual(index.skillTerms(), originalSkillTerms(), 'both default to empty description and name');

// ---- 4. the divergences the three are entitled to keep --------------------------
// If a later refactor "tidies" the CJK ranges or turns the pruner into a bigram indexer,
// the assertions above still pass while retrieval quality changes. These pin the shape.
assert.deepStrictEqual(keywords('㐀㐁㐂'), [], 'task-cache does not cover extension A at all');
assert.deepStrictEqual(termsFor('㐀㐁㐂'), ['㐀㐁㐂'], 'the pruner keeps the whole run, not its bigrams');
assert.deepStrictEqual(originalSkillTerms('㐀㐁㐂').grams, ['㐀㐁', '㐁㐂'], 'the registry bigrams it');
assert.deepStrictEqual(termsFor('䷀䷁'), ['䷀䷁'], 'only the pruner sweeps 4DC0-4DFF');
assert.deepStrictEqual(originalSkillTerms('䷀䷁').grams, [], 'the registry stops at 4DBF');
assert.deepStrictEqual(index.extractTerms('䷀䷁', 'prune'), ['䷀䷁']);
assert.deepStrictEqual(index.skillTerms('䷀䷁').grams, []);
// A token that mixes scripts is bigrammed across the seam by task-cache and split into
// two independent buckets by the registry.
assert.deepStrictEqual(keywords('3d生成'), ['3d', 'd生', '生成']);
assert.deepStrictEqual(index.extractTerms('3d生成', 'cache'), ['3d', 'd生', '生成']);
assert.deepStrictEqual(index.skillTerms('3d生成').grams, ['生成'], 'the registry never crosses the seam');
// Whole CJK runs are what make the pruner's substring probes selective.
assert.deepStrictEqual(termsFor('予約システムの移行'), ['予約システムの移行']);
assert.deepStrictEqual(index.extractTerms('予約システムの移行', 'prune'), ['予約システムの移行']);

// ---- 5. identifiers, code paths and stopwords -----------------------------------
assert.deepStrictEqual(index.extractTerms('path/to/file.js', 'prune'), termsFor('path/to/file.js'));
assert.deepStrictEqual(termsFor('path/to/file.js'), ['path', 'file.js'], '"to" is under the three-character floor');
assert.deepStrictEqual(index.extractTerms('camelCase snake_case', 'prune'), ['camelCase', 'snake_case']);
assert.deepStrictEqual(index.extractTerms('camelCase snake_case', 'cache'), keywords('camelCase snake_case'));
assert.deepStrictEqual(index.extractTerms('camelCase snake_case', 'cache'), ['camelcase', 'snake', 'case'],
  'the cache lowercases first and treats the underscore as a separator');
assert.deepStrictEqual(index.skillTerms('camelCase snake_case').words, ['camelcase', 'snake_case'],
  'the registry keeps the underscore inside the word');
assert.deepStrictEqual(index.extractTerms('the and for with this that', 'cache'), [], 'stopwords are dropped');
assert.deepStrictEqual(index.extractTerms('これ それ する して', 'prune'), [],
  'the pruner is the only one that rejects Japanese function words');

// ---- 6. the caps hold, and they are the originals' caps -------------------------
const cacheTerms = index.extractTerms(LONG, 'cache');
assert.strictEqual(cacheTerms.length, 40, 'task-cache stops at 40 terms');
assert.strictEqual(keywords(LONG).length, 40);
const pruneTerms = index.extractTerms(LONG, 'prune');
assert.strictEqual(pruneTerms.length, 24, 'the pruner stops at 24 probes');
assert.strictEqual(termsFor(LONG).length, 24);
assert(index.skillTerms(LONG).words.length > 100, 'the registry deliberately has no cap');
// Capping while accumulating has to be the same answer as capping at the end.
assert.deepStrictEqual(cacheTerms, index.extractTerms(LONG, { ...index.MODES.cache, limit: 0 }).slice(0, 40));
assert.deepStrictEqual(pruneTerms, index.extractTerms(LONG, { ...index.MODES.prune, limit: 0 }).slice(0, 24));
// And the cap is a knob, not a constant baked into the loop.
assert.strictEqual(index.extractTerms(LONG, { ...index.MODES.cache, limit: 7 }).length, 7);
assert.deepStrictEqual(index.extractTerms(LONG, { ...index.MODES.cache, limit: 7 }), cacheTerms.slice(0, 7));
// Reaching the cap must not cost a full tokenization of a large document.
const started = Date.now();
index.extractTerms(LONG, 'prune');
assert(Date.now() - started < 250, 'the early stop is what keeps a large prompt cheap');

// ---- 7. jaccard ------------------------------------------------------------------
for (const [a, b] of [
  [['x'], ['x']], [['x', 'y'], ['y', 'x']], [['x'], ['y']], [[], ['y']], [['x'], []], [[], []],
  [['x', 'x', 'y'], ['y']], [keywords('予約システムの移行を実装する'), keywords('予約システムの移行を検証する')],
]) {
  assert.strictEqual(index.jaccard(a, b), originalJaccard(a, b), `jaccard diverged on ${show([a, b])}`);
}
assert.strictEqual(index.jaccard(['a', 'b'], ['b', 'a']), 1, 'identical sets are 1');
assert.strictEqual(index.jaccard(['a'], ['b']), 0, 'disjoint sets are 0');
assert.strictEqual(index.jaccard([], []), 0, 'empty against empty is 0, not NaN — NaN would disable every threshold');
assert.strictEqual(index.jaccard(['a'], []), 0);
assert.strictEqual(index.jaccard(['a', 'b'], ['b']), 0.5);
assert.strictEqual(index.jaccard(['a', 'a', 'b'], ['b', 'b']), 0.5, 'duplicates in the input are not weight');

// ---- 8. pruneCommonTerms ---------------------------------------------------------
// The registry's copy is a method that mutates this.skills, so equivalence is shown by
// running both over identical clones of the same documents.
const docsOf = () => ([
  { id: 'alpha', words: ['common', 'alpha', 'rare1'], grams: ['生成', '固有'], bodyWords: ['x', 'shared'], bodyGrams: ['実行'] },
  { id: 'beta', words: ['common', 'beta', 'rare2'], grams: ['生成', '独自'], bodyWords: ['y', 'shared'], bodyGrams: ['実行'] },
  { id: 'gamma', words: ['common', 'gamma'], grams: ['生成'], bodyWords: ['z', 'shared'], bodyGrams: ['実行'] },
  { id: 'delta', words: ['delta', 'rare2'], grams: ['固有'], bodyWords: ['w'], bodyGrams: ['検証'] },
  { id: 'epsilon', words: ['epsilon'], grams: ['独自'], bodyWords: ['v'], bodyGrams: ['検証'] },
]);
const registry = new SkillRegistry({ roots: [] });
registry.skills = docsOf();
registry.pruneCommonTerms();
assert.deepStrictEqual(index.pruneCommonTerms(docsOf()), registry.skills,
  'pruneCommonTerms diverged from SkillRegistry.pruneCommonTerms');
// 5 documents, ratio 0.4 → a term is dropped once it appears in more than 2 of them.
const pruned = index.pruneCommonTerms(docsOf());
assert(!pruned[0].words.includes('common'), '"common" is in 3 of 5 (60%) and has to go');
assert(pruned[0].words.includes('alpha'), 'a term in one document is the whole point of the index');
assert(pruned[1].words.includes('rare2'), '2 of 5 (40%) is at the limit and stays');
assert(!pruned[0].grams.includes('生成'), 'grams are pruned on the same rule');
assert(pruned[0].grams.includes('固有'));
assert(!pruned[0].bodyWords.includes('shared'), 'body fields are pruned too');
assert(!pruned[0].bodyGrams.includes('実行'), '実行 is in 3 of 5 body fields, over the limit of 2');
assert(pruned[3].bodyGrams.includes('検証'), '検証 is in 2 of 5 and survives');
// Below the floor, nothing is pruned: with three documents a term in two of them looks
// common and is usually the signal.
const three = docsOf().slice(0, 3);
assert.deepStrictEqual(index.pruneCommonTerms(three), three);
assert(three[0].words.includes('common'), 'under minDocs the corpus is too small to call anything common');
const smallRegistry = new SkillRegistry({ roots: [] });
smallRegistry.skills = docsOf().slice(0, 3);
smallRegistry.pruneCommonTerms();
assert.deepStrictEqual(index.pruneCommonTerms(docsOf().slice(0, 3)), smallRegistry.skills);
// The ratio is a knob.
const strict = index.pruneCommonTerms(docsOf(), { ratio: 0.1 });
assert(!strict[1].words.includes('rare2'), 'a tighter ratio drops more');
assert.deepStrictEqual(index.pruneCommonTerms([], {}), [], 'no documents is not an error');

// ---- 9. rankDocs ------------------------------------------------------------------
// Same documents, same requests, same order and same scores as SkillRegistry.match.
const scoreDocs = () => ([
  { id: 'music-gen', words: ['music', 'acestep', 'bgm', 'gen'], grams: ['音楽', '楽制', '制作'], bodyWords: ['local'], bodyGrams: ['生成'], digest: 'd1' },
  { id: 'n8n-agents', words: ['n8n', 'workflow', 'agents'], grams: ['自動', '動化'], bodyWords: ['node'], bodyGrams: ['実行'], digest: 'd2' },
  { id: 'comfyui-image-to-3d', words: ['comfyui', 'hunyuan3d', 'glb'], grams: ['画像'], bodyWords: [], bodyGrams: [], digest: 'd3' },
  { id: 'x', words: [], grams: [], bodyWords: [], bodyGrams: [], digest: 'd4' },
]);
const REQUESTS = ['', '   ', 'music-gen で BGM を作る', '音楽制作をしたい', 'n8n workflow を組む',
  'comfyui で画像から3Dを作る', 'まったく無関係な文章', 'MUSIC-GEN AND N8N WORKFLOW', null, undefined,
  ...SAMPLES.slice(0, 60)];
const ranker = new SkillRegistry({ roots: [] });
for (const request of REQUESTS) {
  for (const limit of [1, 2, 4]) {
    ranker.skills = scoreDocs();
    assert.deepStrictEqual(index.rankDocs(request, scoreDocs(), { limit }), ranker.match(request, { limit }),
      `rankDocs diverged from SkillRegistry.match on ${show(request)} (limit ${limit})`);
  }
}
// The weights that decide those scores are data, not literals in the loop.
const top = index.rankDocs('music-gen で BGM を作る', scoreDocs(), { limit: 1 })[0];
assert.strictEqual(top.id, 'music-gen');
assert(top.score >= index.MATCH_WEIGHTS.id, 'a verbatim id is nearly conclusive on its own');
assert.deepStrictEqual(index.rankDocs('music', scoreDocs(), { limit: 4, weights: { threshold: 1000 } }), [],
  'raising the threshold suppresses everything');
assert.strictEqual(index.rankDocs('n8n を使う', scoreDocs(), { limit: 4 })[0].id, 'n8n-agents',
  'the family prefix reaches the group when the full id is never typed');

// ---- 10. nothing here writes anything ---------------------------------------------
// The module is required by three call sites on every prompt; a stray regexp lastIndex or
// a mutated mode would make the second call differ from the first.
for (const sample of SAMPLES.slice(0, 80)) {
  for (const mode of ['cache', 'prune', 'skillWords', 'skillGrams']) {
    assert.deepStrictEqual(index.extractTerms(sample, mode), index.extractTerms(sample, mode),
      `${mode} is not idempotent on ${show(sample)}`);
  }
}
assert.throws(() => index.extractTerms('x', 'nope'), /unknown mode/, 'an unknown mode fails loudly');

console.log(`text index selftest: PASS · ${SAMPLES.length} inputs match task-cache.keywords, `
  + 'context-pruner.termsFor and skill-registry.extractTerms exactly · jaccard, pruneCommonTerms '
  + 'and match reproduced against the live implementations · caps 40/24 and the CJK range '
  + 'differences preserved');
