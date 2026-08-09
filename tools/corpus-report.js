'use strict';

// What the owner actually typed, run through the classifier that decides whether it works.
//
// The corpus existed and nothing read it (measured 2026-08-09: `owner-turns.jsonl` was
// never written and no file referenced CorpusIngest). A writer with no reader is a file,
// not a feature — so this is its first consumer, and it answers the question the corpus is
// best placed to answer: for THIS owner's way of asking, how many requests reach work?
//
// It is offline and read-only. It spends no tokens, starts no run, and never writes to the
// corpus. Run it after changing the lexicon:
//
//   node tools/corpus-report.js            # counts, and the turns the change flipped
//   node tools/corpus-report.js --all      # every CHAT line too, for reading the misses
//
// The comparison baseline is the lexicon as it stood that morning, kept here verbatim so
// the number means something rather than drifting with the thing it measures.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CorpusIngest } = require('../src/domain/pi-core/corpus-ingest');
const { heuristicKind, actionTier, classifyKind } = require('../src/domain/pi-core/conversation-engine');

// 2026-08-09 morning, before the repair. Fourteen words, no normalisation, and a model
// TASK downgraded unconditionally.
const BEFORE = /(?:実装|修正|変更|追加|削除|build|implement|fix|refactor|commit|create|作って|直して|してください|してほしい)/i;
const IDEA_BEFORE = /(?:アイデア|思いつ|どうかな|できたら|将来|考えたい|検討したい|考えている|ならどう|はどうだろう|idea|maybe|what if|could we|構想|案)/i;
const beforeKind = (text) => (BEFORE.test(text) ? 'TASK' : IDEA_BEFORE.test(text) ? 'IDEA' : 'CHAT');

const showAll = process.argv.includes('--all');
const clip = (text, width = 78) => {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
};

(async () => {
  const corpusRoot = process.env.BIGKIJI_CORPUS_ROOT
    || path.join(process.env.BIGKIJI_DATA_ROOT || path.join(os.homedir(), 'BigKijiUniverse'), 'corpus');
  const ingest = new CorpusIngest({ corpusRoot });
  const summary = await ingest.run();
  const lines = fs.readFileSync(ingest.turnsFile, 'utf8').split('\n').filter(Boolean);

  const rows = [];
  for (const line of lines) {
    let row = null;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row?.text) continue;
    rows.push({ ...row, before: beforeKind(row.text), after: heuristicKind(row.text), tier: actionTier(row.text) });
  }

  const count = (predicate) => rows.filter(predicate).length;
  const started = count((r) => r.before === 'TASK');
  const startsNow = count((r) => r.after === 'TASK');
  const gained = rows.filter((r) => r.before !== 'TASK' && r.after === 'TASK');
  const lost = rows.filter((r) => r.before === 'TASK' && r.after !== 'TASK');

  console.log(`owner corpus — ${rows.length} turns from ${summary.scanned} files`);
  console.log(`  by source: ${Object.entries(summary.bySource).map(([id, n]) => `${id} ${n}`).join(' · ') || '(all cached)'}`);
  console.log('');
  console.log(`  before (14-word lexicon)  TASK ${started}  (${((started / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  after  (two tiers + kana) TASK ${startsNow}  (${((startsNow / rows.length) * 100).toFixed(1)}%)`);
  console.log(`    of which strong ${count((r) => r.tier === 'strong')} · soft ${count((r) => r.tier === 'soft')}`);
  console.log(`  turns the change starts that it used to drop: ${gained.length}`);
  console.log(`  turns it no longer starts: ${lost.length}${lost.length ? '  ← a regression, read these' : ''}`);

  if (gained.length) {
    console.log('\n  newly recognised as work:');
    for (const row of gained.slice(0, showAll ? gained.length : 12)) {
      console.log(`    [${row.tier}] ${clip(row.text)}`);
    }
    if (!showAll && gained.length > 12) console.log(`    … +${gained.length - 12} more (--all)`);
  }
  for (const row of lost) console.log(`    LOST ${clip(row.text)}`);

  if (showAll) {
    console.log('\n  still not recognised as work (the remaining misses):');
    for (const row of rows.filter((r) => r.after === 'CHAT')) console.log(`    ${clip(row.text)}`);
  }

  // A model promotion is the other half of the door, and it is not measurable offline —
  // it depends on what the conversation model says at the time. Stated rather than
  // guessed at, so this report is not read as the whole picture.
  console.log(`\n  note: ${rows.length - startsNow} turns still classify as CHAT here. The conversation`);
  console.log('  model may promote any of them to TASK at runtime (classifyKind), and such a');
  console.log('  promotion always waits for one approval. That half cannot be measured offline.');
  console.log(`\n  corpus: ${ingest.turnsFile.replace(os.homedir(), '~')}`);
})().catch((error) => { console.error(error); process.exit(1); });
