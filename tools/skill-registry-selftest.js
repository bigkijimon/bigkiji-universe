'use strict';
// The registry decides which of the owner's accumulated skills reach a specialist.
// Getting it wrong is not cosmetic: the reason it exists is that a sub-agent burned
// 428s of GPU on an approach a skill file had already ruled out, and a music task was
// one step from a cloud endpoint a skill file warns is the misleading default.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SkillRegistry, parseFrontmatter, extractTerms } = require('../src/domain/pi-agent/skill-registry');

// ---- frontmatter ------------------------------------------------------------
const meta = parseFrontmatter(['---', 'name: demo-skill', 'description: "Quoted value"',
  'disable-model-invocation: true', 'allowed-tools: Bash(curl *)', '---', '# body'].join('\n'));
assert.strictEqual(meta.name, 'demo-skill');
assert.strictEqual(meta.description, 'Quoted value', 'surrounding quotes must be stripped');
assert.strictEqual(meta['disable-model-invocation'], 'true');

// ---- tokenisation -----------------------------------------------------------
// Japanese has no spaces. Splitting on whitespace yields one 40-character token per
// sentence and nothing ever matches, which is exactly the bug this guards against.
const terms = extractTerms('ローカル音楽生成（ACE-Step 1.5）。Trigger: 音楽制作, BGM', 'music-gen');
assert.ok(terms.words.includes('ace-step'), 'hyphenated product names stay whole');
assert.ok(terms.words.includes('bgm'));
assert.ok(!terms.words.includes('trigger'), 'frontmatter scaffolding must not be indexed');
assert.ok(terms.grams.includes('音楽'), 'CJK must be indexed as character bigrams');
assert.ok(terms.grams.includes('制作'));
assert.ok(terms.grams.every((gram) => gram.length === 2), 'grams are exactly two characters');
assert.ok(terms.words.includes('ローカル'), 'a katakana run is one word, not a pile of bigrams');
assert.ok(terms.triggerGrams.includes('音楽'), 'the Trigger list states intent and is tracked apart from prose');
assert.ok(!terms.triggerGrams.includes('楽生'), 'a bigram found only in the description is not a trigger');

// Hiragana is grammar. Indexing it produced 「が足」「足り」「りな」 as if they were terms, and
// because they are rare across the corpus, rarity-weighting then treated them as
// distinctive: "GPUのメモリが足りない" ranked an English-quiz skill first, on inflection alone.
const grammar = extractTerms('「ゲームらしさが足りない」「演出を足したい」ときに使う。ライフやスコアを追加する', 'english-game');
for (const noise of ['が足', '足り', 'りな', 'ない', 'を足', 'した']) {
  assert.ok(!grammar.grams.includes(noise), `${noise} is inflection, not a term`);
}
assert.ok(grammar.words.includes('ライフ') && grammar.words.includes('スコア'), 'katakana content survives');
assert.ok(grammar.grams.includes('演出') && grammar.grams.includes('追加'), 'kanji compounds survive');

// ---- matching, against a controlled corpus ----------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-skills-'));
const write = (id, description, body) => {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n${body}\n`);
};
write('comfyui-workflow', 'ポート8000のローカルComfyUIをAPI制御して画像を生成する',
  '## ⚠️ 罠\n- 単発KSamplerは禁止\n- GPU信号機で必ず調停する\n');
write('music-gen', 'ローカル音楽生成（ACE-Step）。Trigger: 音楽制作, BGM',
  '## ⚠️ 罠と教訓\n- 同梱CLIの既定はクラウドAPIを向いている\n');
write('gpu-mem-switch', '統合メモリでOllamaとComfyUI/LTX/ACE-Stepの競合を調停する',
  '- ComfyUI ACE-Step LTX 画像生成 動画生成 音楽生成 すべてGPUを食う\n');
// A bundle directory with no SKILL.md of its own, holding its skills one level down.
// Real bundles name their members as a family (n8n-agents, n8n-validation-expert, ...),
// which is what makes the tool name alone reach them.
fs.mkdirSync(path.join(root, 'bundle', 'skills', 'n8n-workflow-patterns'), { recursive: true });
fs.writeFileSync(path.join(root, 'bundle', 'skills', 'n8n-workflow-patterns', 'SKILL.md'),
  '---\nname: n8n-workflow-patterns\ndescription: n8n workflow repair helper\n---\nbody\n');
write('using-n8n-mcp-skills', 'Entry point for any n8n task; routes to the right specialist', 'body');
write('n8n-code-python', 'Write Python inside an n8n Code node', 'body');
write('doc-reader', 'Read a document and summarise what it says', 'body');
write('product-design', 'UI/UX design and conversion. Trigger: デザイン, UI, 画面設計, ボタン', 'body');
write('web-design-guidelines', 'Review UI code against web interface guidelines', 'body');

const registry = new SkillRegistry({ roots: [root] });
const found = registry.scan();
assert.strictEqual(found.length, 9, 'bundles nest their skills one level down and must still be indexed');
assert.ok(found.some((skill) => skill.id === 'n8n-workflow-patterns'));

const top = (text) => (registry.match(text)[0] || {}).id;
// The specific skill must outrank the one that merely names every tool. gpu-mem-switch
// legitimately mentions ComfyUI, LTX and ACE-Step, and without weighting the frontmatter
// above the body it wins every generation query.
assert.strictEqual(top('ComfyUIで画像を生成したい'), 'comfyui-workflow');
assert.strictEqual(top('ACE-Stepで音楽制作をする'), 'music-gen');
assert.strictEqual(top('GPUが競合してOOMする'), 'gpu-mem-switch');
assert.deepStrictEqual(registry.match(''), [], 'an empty request matches nothing');
assert.deepStrictEqual(registry.match('completely unrelated request about tax filing'), []);

// ---- one skill per category (owner instruction) -----------------------------
// An assignment carries two skills. Before this, "n8nのワークフローを直す" returned
// n8n-workflow-patterns, n8n-subworkflows and n8n-self-hosting — three members of one
// family — and both slots went to the same subject. A family answers through its entry
// point, and the second slot stays free for something genuinely different.
const n8n = registry.match('n8nのワークフローを直す', { limit: 3 });
assert.strictEqual(n8n.length, 1, `one skill per category: ${n8n.map((skill) => skill.id).join(', ')}`);
assert.strictEqual(n8n[0].id, 'using-n8n-mcp-skills', 'a skill family answers through its entry point');
assert.match(n8n[0].standsFor, /^n8n-/, 'and it says which member it stood in for');
// Naming a member out loud is a request for that member, not for the family's front door.
assert.strictEqual(top('n8n-code-python で書きたい'), 'n8n-code-python');

// The owner's example: 「ボタンのデザイン修正はUIデザインのスキルなので他にある大きなものと1本に」.
const design = registry.match('ボタンのデザインを直したい', { limit: 3 });
assert.strictEqual(design.length, 1, `UI design answers once: ${design.map((skill) => skill.id).join(', ')}`);
assert.strictEqual(design[0].id, 'product-design',
  'the owner\'s standing rule sends every UI task through product-design');

// ---- Latin terms must land on a word boundary -------------------------------
// "read" inside README put three unrelated skills on 「READMEを直してテストも通す」.
assert.deepStrictEqual(registry.match('READMEを直してテストも通す'), [],
  'a term found only inside a longer word is not a match');
assert.strictEqual(top('read the design doc'), 'doc-reader', 'a real word still matches');

// ---- the brief is text, and carries the traps -------------------------------
const brief = registry.brief('ACE-Stepで音楽制作をする');
assert.match(brief, /music-gen/);
assert.match(brief, /クラウドAPI/, 'the warning that matters most must survive into the brief');
assert.ok(!/allowRead|allowWrite|--add-dir/.test(brief),
  'the brief injects guidance only; it must never look like a filesystem grant');

// ---- the shipped sandbox policy ---------------------------------------------
// Before V2.5 this file did not exist and the resolver fell through to a default that
// granted write access to the whole app plus every paid provider.
const sandbox = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.pi', 'sandbox.json'), 'utf8'));
assert.ok(Array.isArray(sandbox.filesystem.allowWrite) && sandbox.filesystem.allowWrite.length > 0);
assert.ok(!sandbox.filesystem.allowWrite.includes('.'),
  'the app root must not be writable wholesale — that was the accidental default');
assert.ok(!sandbox.filesystem.allowWrite.some((entry) => /node_modules|dist|\.env/.test(entry)));
assert.ok(Array.isArray(sandbox.models.allowPaid));
assert.ok(sandbox.skills.roots.includes('./skills'), 'app-shipped English skills must be declared first');

// ---- the two frontmatter shapes that made a skill silently unreachable -------
// Both were found in real skill files. A skill that indexes one term is not "weakly
// matched", it is invisible — and it looks exactly like a skill that simply never fits.
const { describeWithoutFrontmatter } = require('../src/domain/pi-agent/skill-registry');
const folded = parseFrontmatter(['---', 'name: phaser-gamedev', 'description: >',
  '  Build 2D browser games with Phaser 3.', '  Use for arcade physics and tilemaps.', 'license: MIT', '---'].join('\n'));
assert.strictEqual(folded.description, 'Build 2D browser games with Phaser 3. Use for arcade physics and tilemaps.',
  'a folded scalar parsed line-by-line yields the literal ">" as the whole description');
assert.strictEqual(folded.license, 'MIT', 'the key after a folded block must still parse');
assert.strictEqual(parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---').description, 'line one\nline two');
assert.strictEqual(parseFrontmatter('---\ndescription: plain value\n---').description, 'plain value');
assert.strictEqual(describeWithoutFrontmatter('# AI Influencer\n\nKeep one face consistent across shots with PuLID.\n'),
  'AI Influencer — Keep one face consistent across shots with PuLID.',
  'a skill with no frontmatter is still a skill');

fs.rmSync(root, { recursive: true, force: true });
console.log('skill registry selftest: PASS · CJK bigram matching · frontmatter over body · folded/literal scalars · no-frontmatter fallback · text-only brief · explicit sandbox');
