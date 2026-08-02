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

const registry = new SkillRegistry({ roots: [root] });
const found = registry.scan();
assert.strictEqual(found.length, 4, 'bundles nest their skills one level down and must still be indexed');
assert.ok(found.some((skill) => skill.id === 'n8n-workflow-patterns'));

const top = (text) => (registry.match(text)[0] || {}).id;
// The specific skill must outrank the one that merely names every tool. gpu-mem-switch
// legitimately mentions ComfyUI, LTX and ACE-Step, and without weighting the frontmatter
// above the body it wins every generation query.
assert.strictEqual(top('ComfyUIで画像を生成したい'), 'comfyui-workflow');
assert.strictEqual(top('ACE-Stepで音楽制作をする'), 'music-gen');
assert.strictEqual(top('GPUが競合してOOMする'), 'gpu-mem-switch');
assert.strictEqual(top('n8nのワークフローを直す'), 'n8n-workflow-patterns', 'a skill family must be reachable by its tool name');
assert.deepStrictEqual(registry.match(''), [], 'an empty request matches nothing');
assert.deepStrictEqual(registry.match('completely unrelated request about tax filing'), []);

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

fs.rmSync(root, { recursive: true, force: true });
console.log('skill registry selftest: PASS · CJK bigram matching · frontmatter over body · text-only brief · explicit sandbox');
