'use strict';

// Can the local model actually write files, or only be asked to?
//
// `LOCAL_TOOLS_WRITE` ('read,grep,find,ls,edit,write') has existed in task-runner.js for
// as long as the local role has, and `_pick` already falls through to qwen when no paid
// provider can start — so local write work is reachable today, as a floor. The open
// question is whether it should be reachable by *preference*, to keep mechanical work off
// the paid providers (the owner's standing rule: 翻訳/要約/分類/整形/一括処理 goes local).
//
// The only record on this machine says no: 16 samples, 0 successes, 2 failures for qwen.
// That is suggestive and it is not proof — the samples may predate fixes, and "failure"
// there covers dispatch problems as well as bad output. Building a routing change on it
// would be guessing, so this measures instead.
//
// Three mechanical tasks, the kind the owner would actually hand over: translate a file,
// reformat a list, and extract matching lines into a new file. Each is graded on what
// ended up on disk, never on what the model said it did.
//
// Run: node tools/local-write-probe.js            (both tiers)
//      node tools/local-write-probe.js --model qwen3.5:latest
//
// NOT part of `npm test`: it needs a free GPU and it costs a minute. It refuses to run
// while gpu-signal.sh holds the card, because starting an inference during a render is
// the exact contention the whole arbitration exists to prevent.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGpuLock, ollamaFrozen } = require('../src/domain/pi-agent/gpu-lock');

const TOOLS = 'read,grep,find,ls,edit,write';
const TIMEOUT_MS = 180000;

const TASKS = [
  {
    id: 'translate',
    why: 'the owner hands over translation constantly; today it costs a leader dispatch',
    files: { 'note.md': '# Lesson 3\n\n- Greet the student\n- Review last week\n- Practice the past tense\n' },
    prompt: 'Read note.md and write a Japanese translation of it to note.ja.md. Keep the markdown structure. Do not change note.md.',
    grade: (dir) => {
      const out = path.join(dir, 'note.ja.md');
      if (!fs.existsSync(out)) return 'note.ja.md was never created';
      const text = fs.readFileSync(out, 'utf8');
      if (!/[ぁ-んァ-ン一-龥]/.test(text)) return 'the new file has no Japanese in it';
      if (!/^#/m.test(text)) return 'the markdown heading did not survive';
      if (fs.readFileSync(path.join(dir, 'note.md'), 'utf8') !== TASKS[0].files['note.md']) return 'it modified the source file';
      return '';
    },
  },
  {
    id: 'reformat',
    why: 'turning a list into a table is the shape of most 整形 requests',
    files: { 'roster.txt': 'ken,12,tuesday\nmomo,9,friday\nrin,14,tuesday\n' },
    prompt: 'Read roster.txt and rewrite it as a markdown table with the headers name, age, day. Overwrite roster.txt itself.',
    grade: (dir) => {
      const text = fs.readFileSync(path.join(dir, 'roster.txt'), 'utf8');
      if (!/\|/.test(text)) return 'roster.txt is not a table';
      if (!/name/i.test(text) || !/age/i.test(text) || !/day/i.test(text)) return 'the headers are missing';
      for (const name of ['ken', 'momo', 'rin']) if (!text.includes(name)) return `${name} was dropped`;
      return '';
    },
  },
  {
    id: 'extract',
    why: 'bulk extraction is the third thing the owner names as mechanical',
    files: { 'log.txt': 'ok start\nERROR disk full\nok step 2\nERROR timeout\nok done\n' },
    prompt: 'Read log.txt, and write every line containing ERROR to errors.txt, one per line. Do not change log.txt.',
    grade: (dir) => {
      const out = path.join(dir, 'errors.txt');
      if (!fs.existsSync(out)) return 'errors.txt was never created';
      const lines = fs.readFileSync(out, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length !== 2) return `expected 2 lines, got ${lines.length}`;
      if (!lines.every((l) => l.includes('ERROR'))) return 'a line without ERROR got in';
      if (!lines.some((l) => l.includes('disk full')) || !lines.some((l) => l.includes('timeout'))) return 'the wrong lines were extracted';
      return '';
    },
  },
];

function run(model, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bku-write-${task.id}-`));
  for (const [name, body] of Object.entries(task.files)) fs.writeFileSync(path.join(dir, name), body);
  const args = ['--print', '--model', `ollama/${model}`, '--no-context-files', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--tools', TOOLS, task.prompt];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(process.env.PI_BIN || 'pi', args,
      { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        let problem = '';
        try { problem = task.grade(dir); } catch (err) { problem = `grading threw: ${err.message}`; }
        // A spawn failure and bad output are different answers and must not be merged:
        // one says "this cannot run here", the other says "this ran and got it wrong".
        const failedToRun = !!error && !/timed out/i.test(String(error.message));
        resolve({ model, task: task.id, ms, ok: !problem, problem,
          ran: !failedToRun, error: error ? String(stderr || error.message).trim().slice(0, 120) : '',
          dir });
      });
    // The lesson from every other place this repository spawns pi: an open stdin makes it
    // wait out the whole timeout offering a login nobody can answer.
    try { child?.stdin?.end(); } catch (_) {}
  });
}

(async () => {
  const wanted = process.argv.includes('--model')
    ? [process.argv[process.argv.indexOf('--model') + 1]]
    : ['qwen3.5:latest', 'qwen3.5:35b-a3b'];

  const lock = readGpuLock();
  if (lock.held || ollamaFrozen()?.frozen === true) {
    console.error(`the GPU is held by "${lock.holder || 'a generation job'}"${lock.since ? ` since ${lock.since}` : ''} and Ollama is stopped.`);
    console.error('this probe needs the card free — running an inference during a render is the contention gpu-signal.sh exists to prevent.');
    process.exit(2);
  }

  console.log(`local write probe — can the local model edit files, or only be asked to?\n`);
  const results = [];
  for (const model of wanted) {
    console.log(`## ${model}`);
    for (const task of TASKS) {
      const row = await run(model, task);
      results.push(row);
      const verdict = row.ok ? 'ok  ' : row.ran ? 'WRONG' : 'FAIL';
      console.log(`   ${verdict} ${row.task.padEnd(10)} ${String(Math.round(row.ms / 100) / 10).padStart(6)}s  ${row.problem || row.error || ''}`);
      if (!row.ok) console.log(`        ↳ ${row.why || task.why}`);
    }
    const mine = results.filter((r) => r.model === model);
    const good = mine.filter((r) => r.ok).length;
    const total = mine.reduce((sum, r) => sum + r.ms, 0);
    console.log(`   ${good}/${mine.length} correct, ${Math.round(total / 1000)}s total\n`);
  }

  for (const row of results) fs.rmSync(row.dir, { recursive: true, force: true });

  const best = wanted.map((model) => {
    const mine = results.filter((r) => r.model === model);
    return { model, good: mine.filter((r) => r.ok).length, of: mine.length };
  });
  console.log('verdict, for the routing decision this exists to inform:');
  for (const b of best) console.log(`   ${b.model.padEnd(20)} ${b.good}/${b.of}`);
  console.log('\n3/3 means mechanical work can be routed here. Anything less means a local-first');
  console.log('policy would fail and retry on a paid provider, which spends MORE than it saves.');
})().catch((error) => { console.error(error); process.exit(1); });
