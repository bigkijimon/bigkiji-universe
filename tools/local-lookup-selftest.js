'use strict';

// Looking at something should not cost a dispatch, an approval and two invented questions.
//
// 2026-08-10. The owner typed 「データ見せてください」 and got back:
//
//   1. どのデータを表示しますか？  a) ユーザーリスト  b) 売上レポート  c) システムログ
//   2. 表示形式はどちらですか？    a) テーブル  b) チャート  c) JSON
//
// None of those six options exists in this system. The front desk is told to ask about
// every materially important decision that is missing, and a 6.6B model handed a
// four-word request decides everything is missing and makes the choices up. Their report:
// 「まだすぐにだしてくれません。質問が多いです。」
//
// Two rules come out of it, and both are pinned here.
//
//   Questions cost what being wrong costs. Sorting a list the wrong way costs one more
//   turn. Deleting the wrong folder costs the folder. The front desk asked the same
//   number either way, so an inspection now takes safe defaults instead.
//
//   And an inspection is answered locally, for free, with read tools only — listing what
//   is on disk should not start codex and then wait for an approval.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-lookup-'));
process.env.BIGKIJI_KNOWLEDGE_ROOT = path.join(root, 'knowledge');

const { isInspection } = require('../src/domain/pi-core/conversation-engine');
const { localLookup, lookupPrompt, READ_TOOLS } = require('../src/domain/pi-core/local-lookup');
const { DaemonEngine } = require('../src/domain/server/daemon');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };
const okAsync = async (name, body) => { try { await body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

/** A pi that answers, and records exactly how it was called. */
const piThatAnswers = (answer = 'ファイルは3本あります。') => {
  const calls = [];
  const spawn = (bin, args, opts, done) => {
    calls.push({ bin, args, opts });
    done(null, answer, '');
    return { stdin: { end() { calls.at(-1).stdinClosed = true; } } };
  };
  return { spawn, calls };
};

(async () => {
  // ---------------------------------------------------------------------------
  // Which requests only look
  // ---------------------------------------------------------------------------

  ok('the last verb decides, because that is the one that governs', () => {
    // A flat "any write word disqualifies it" test called all four of these changes.
    // バックアップ・設定・整理 are nouns as readily as verbs.
    for (const looking of ['データ見せてください', 'BKUのスキル一覧を出して', '残ってるタスクを教えて',
      '設定を見せてください', 'バックアップある？', 'ログを調べておいて', 'show me the skills',
      'please check the rate limit']) {
      assert.equal(isInspection(looking), true, `${looking} only looks`);
    }
    for (const changing of ['ログを調べて直して', 'READMEのタイポを修正して', 'ファイルを整理してください',
      'バックアップを取っておいて', 'セットアップして', 'list the files and delete the old ones',
      'fix the readme typo']) {
      assert.equal(isInspection(changing), false, `${changing} changes something`);
    }
  });

  // ---------------------------------------------------------------------------
  // What leaves the machine, and what it is allowed to touch
  // ---------------------------------------------------------------------------

  await okAsync('it reads and cannot write, by pi’s allowlist rather than by asking nicely', async () => {
    const pi = piThatAnswers();
    const out = await localLookup('スキル一覧を見せて', { cwd: root, spawn: pi.spawn, frozen: false });
    assert.equal(out.ok, true);
    const { args } = pi.calls[0];
    assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === READ_TOOLS,
      `the allowlist is the enforcement, not a sentence in the prompt: ${args.join(' ')}`);
    assert.ok(!READ_TOOLS.includes('edit') && !READ_TOOLS.includes('write'),
      'and it must not contain a tool that changes anything');
    assert.ok(args.some((a) => String(a).startsWith('ollama/')), 'local model, so no paid provider is started');
    for (const flag of ['--print', '--no-context-files', '--no-session', '--no-skills']) {
      assert.ok(args.includes(flag), `${flag} keeps this to one prompt that is not retained`);
    }
  });

  await okAsync('the tool that asks questions is excluded, which is why this hangs otherwise', async () => {
    // pi ships `ask_question`. In --print mode nobody can answer it, so the model asks,
    // pi waits on stdin, and the process sits there until the timeout. Measured
    // 2026-08-10: 100s, empty stdout, empty stderr — while building the fix for a
    // complaint that reads 「質問が多いです」. With it excluded: 15.6s and an answer.
    const pi = piThatAnswers();
    await localLookup('version を教えて', { cwd: root, spawn: pi.spawn, frozen: false });
    const { args } = pi.calls[0];
    const excluded = args[args.indexOf('--exclude-tools') + 1] || '';
    assert.ok(excluded.includes('ask_question'), `ask_question must be excluded: ${args.join(' ')}`);
    assert.equal(pi.calls[0].stdinClosed, true, 'and stdin is closed, so nothing else can wait on it');
  });

  await okAsync('a stopped local model is refused rather than waited on', async () => {
    const pi = piThatAnswers();
    const out = await localLookup('見せて', { cwd: root, spawn: pi.spawn, frozen: true });
    assert.equal(out.ok, false);
    assert.equal(pi.calls.length, 0, 'a SIGSTOPped Ollama accepts the connection and never answers — do not ask it');
    assert.match(out.reason, /stopped/);
  });

  ok('the prompt tells it to look, and forbids the answer it would otherwise give', () => {
    const prompt = lookupPrompt('スキルの一覧', 'runs: 0');
    assert.match(prompt, /Look first/, 'answering from memory is the failure this replaces');
    assert.match(prompt, /does not exist, say exactly that/, 'and "there is none" has to be a sayable answer');
    assert.match(prompt, /Never invent a filename, a count, or a category/,
      'six invented options is what started this');
    assert.match(prompt, /runs: 0/, 'the real numbers travel with it');
  });

  // ---------------------------------------------------------------------------
  // The turn the owner sees
  // ---------------------------------------------------------------------------

  const stubTurn = (kind = 'TASK') => ({ model: 'stub-qwen',
    turn: async ({ text }) => ({ kind, reply: 'わかりました。', title: 'stub', summary: text, ideas: [],
      requirements: [], decisions: [], openQuestions: [], todos: [], turnId: `turn-${text.slice(0, 6)}`,
      provider: 'local-qwen', latencyMs: 1, degraded: false, promotedByModel: false }) });

  const askingFacilitator = () => ({
    async facilitate() { return { status: 'needs_clarification', provider: 'stub',
      questions: [{ ask: 'どのデータを表示しますか？', options: ['ユーザーリスト', '売上レポート'] }] }; },
    async answer() { return { status: 'ready', provider: 'stub', promptSpec: { goal: 'g', steps: ['s'] } }; },
    reset() {},
  });

  await okAsync('a look-at-it request is answered, not planned and not queued for approval', async () => {
    // The lookup is injected, so this tests the daemon's routing rather than pi and does
    // not depend on what the owner's GPU is doing.
    const answered = 'corpus/owner-turns.jsonl に 365 行あります。';
    const engine = new DaemonEngine({ stateRoot: path.join(root, 'look'), workspace: process.cwd(),
      conversationEngine: stubTurn(), facilitator: askingFacilitator(),
      lookup: async () => ({ ok: true, text: answered, reason: '', ms: 12 }) });
    engine.runner.approve = () => ({ ok: true, stubbed: true });
    const out = await engine.turn('データ見せてください', { mode: 'auto' });
    assert.equal(out.provider, 'local-lookup', `answered locally, not planned: provider=${out.provider}`);
    assert.equal(out.reply, answered);
    assert.equal(out.run, null, 'no run — listing what is on disk is not a dispatch');
    assert.equal(out.requiresApproval, false, 'and nothing to approve');
    assert.deepEqual(out.questions, [], 'and the two invented questions are gone');
    engine.shutdown();
  });

  await okAsync('a change is still planned, and still waits', async () => {
    const engine = new DaemonEngine({ stateRoot: path.join(root, 'change'), workspace: process.cwd(),
      conversationEngine: stubTurn(), facilitator: { async facilitate(text) { return { status: 'ready',
        provider: 'stub', planHash: 'h', promptSpec: { goal: text, steps: ['do it'] } }; },
      async answer() { return { status: 'ready', provider: 'stub', promptSpec: { goal: 'g', steps: ['s'] } }; }, reset() {} } });
    engine.runner.approve = () => ({ ok: true, stubbed: true });
    const out = await engine.turn('ファイルを整理してください', { mode: 'auto' });
    assert.notEqual(out.provider, 'local-lookup', 'a change does not get the read-only shortcut');
    assert.ok(out.run, 'it is planned');
    try { for (const run of engine.coordinator.snapshot()) engine.coordinator.forgetRun(engine.coordinator.runs.get(run.id) || run); } catch (_) {}
    engine.shutdown();
  });

  await okAsync('a lookup that cannot run falls through instead of eating the request', async () => {
    const engine = new DaemonEngine({ stateRoot: path.join(root, 'fallback'), workspace: process.cwd(),
      conversationEngine: stubTurn(), facilitator: { async facilitate(text) { return { status: 'ready',
        provider: 'stub', planHash: 'h', promptSpec: { goal: text, steps: ['do it'] } }; },
      async answer() { return { status: 'ready', provider: 'stub', promptSpec: { goal: 'g', steps: ['s'] } }; }, reset() {} },
      lookup: async () => ({ ok: false, text: '', reason: 'pi not installed', ms: 3 }) });
    engine.runner.approve = () => ({ ok: true, stubbed: true });
    const out = await engine.turn('スキル一覧を見せて', { mode: 'auto' });
    assert.notEqual(out.provider, 'local-lookup');
    assert.ok(out.run, 'the request still becomes something — a broken shortcut is not how a request disappears');
    try { for (const run of engine.coordinator.snapshot()) engine.coordinator.forgetRun(engine.coordinator.runs.get(run.id) || run); } catch (_) {}
    engine.shutdown();
  });

  if (failures) { console.error(`local lookup selftest: ${failures} FAILED`); process.exit(1); }
  console.log('local lookup selftest: PASS · the last verb decides whether a request only looks · read tools only, '
    + 'enforced by the allowlist · ask_question excluded and stdin closed, or it hangs · a stopped model is refused, not waited on · '
    + 'a look-at-it request is answered with no run and no approval · a change is still planned · a failed lookup falls through');
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exit(1); });
