'use strict';

// Pi is the engine. BigKiji drives it over JSON Lines.
//
// Pi is a program, not a model — it has no brain of its own and borrows one from a
// provider per call. BigKiji talks to it with `pi --mode rpc`, one JSON object per
// LF-terminated line, and everything below is about that pipe being trustworthy.
//
// The bug this file was written for: stdout chunks were decoded one at a time with
// Buffer#toString, so a 3-byte Japanese character split across a read boundary
// became three replacement characters. The line still parsed — U+FFFD is legal
// inside a JSON string — so nothing errored anywhere and the owner simply saw 承
// arrive as ���. Measured at byte 34 of a message_update line.
//
// CVE-2026-54325 is the other reason to have a test here: Pi loads project-local
// extensions without asking, so a crafted repository is arbitrary code execution
// the moment BigKiji starts Pi inside it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { PiBridge } = require('../src/domain/pi-agent/pi-bridge');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'pi-bridge.js'), 'utf8');

/** A bridge with a fake child process, so nothing is spawned. */
function harness() {
  const bridge = new PiBridge({ cwd: process.cwd() });
  const written = [];
  bridge.proc = { stdin: { write: (line) => written.push(line) }, kill() {} };
  bridge.decoder = new StringDecoder('utf8');
  const events = [];
  bridge.on('event', (event) => events.push(event));
  return { bridge, written, events, feed: (buffer) => bridge._ingest(bridge.decoder.write(buffer)) };
}

ok('a multibyte character split across chunks survives', () => {
  const { bridge, events, feed } = harness();
  const line = `${JSON.stringify({ type: 'message_update', text: '承認フローを整理します' })}\n`;
  const buffer = Buffer.from(line, 'utf8');
  const cut = buffer.indexOf(Buffer.from('承', 'utf8')) + 1; // inside the character
  feed(buffer.subarray(0, cut));
  feed(buffer.subarray(cut));
  assert.equal(events.length, 1, 'one line in, one event out');
  assert.equal(events[0].text, '承認フローを整理します', `the owner used to see this as ���: ${events[0].text}`);
  assert.ok(!events[0].text.includes('�'));
  assert.equal(bridge.buf, '', 'and nothing is left stuck in the buffer');
});

ok('the decoder is per-process, not per-chunk', () => {
  assert.match(SOURCE, /this\.decoder = new StringDecoder\('utf8'\)/);
  assert.match(SOURCE, /this\._ingest\(this\.decoder\.write\(d\)\)/,
    'decoding each chunk on its own is exactly the bug');
  assert.ok(!/_ingest\(d\.toString\(\)\)/.test(SOURCE));
  assert.match(SOURCE, /this\.decoder\.end\(\)/, 'a truncated final character is reported, not dropped');
});

ok('a line is a line, and a partial line waits', () => {
  const { bridge, events, feed } = harness();
  feed(Buffer.from('{"type":"a"}\n{"type":"b"}\n{"typ', 'utf8'));
  assert.deepEqual(events.map((event) => event.type), ['a', 'b']);
  assert.equal(bridge.buf, '{"typ', 'the incomplete one is held, not guessed at');
  feed(Buffer.from('e":"c"}\n', 'utf8'));
  assert.deepEqual(events.map((event) => event.type), ['a', 'b', 'c']);
});

ok('the RPC vocabulary is all there', () => {
  const { bridge, written } = harness();
  bridge.isStreaming = false; bridge.prompt('start');
  bridge.steer('correct it');
  bridge.followUp('and then this');
  bridge.setModel('zai/glm-5.2');
  bridge.abort();
  const sent = written.map((line) => JSON.parse(line));
  assert.deepEqual(sent[0], { type: 'prompt', message: 'start' });
  assert.deepEqual(sent[1], { type: 'prompt', message: 'correct it', streamingBehavior: 'steer' },
    'steer lands on the work in flight, after the current tool finishes');
  assert.deepEqual(sent[2], { type: 'prompt', message: 'and then this', streamingBehavior: 'queue' },
    'a follow-up waits for the turn to end rather than interrupting it');
  assert.deepEqual(sent[3], { type: 'set_model', model: 'zai/glm-5.2' },
    'Pi borrows a brain per call — changing it must not need a restart');
  assert.deepEqual(sent[4], { type: 'abort' });
  for (const line of written) assert.ok(line.endsWith('\n') && !line.includes('\r'), `RPC is LF-terminated: ${JSON.stringify(line)}`);
});

ok('mid-stream, a prompt steers instead of starting a second turn', () => {
  const { bridge, written } = harness();
  bridge.isStreaming = true;
  bridge.prompt('actually, stop and do this');
  assert.equal(JSON.parse(written[0]).streamingBehavior, 'steer');
});

ok('setModel refuses to send nothing', () => {
  const { bridge, written } = harness();
  assert.equal(bridge.setModel(''), null);
  assert.equal(bridge.setModel(undefined), null);
  assert.equal(written.length, 0, 'an empty model id would unset the model Pi is using');
});

ok('a request that is never answered resolves rather than hanging', () => {
  const { bridge } = harness();
  const promise = bridge.request('get_session_stats');
  assert.ok(promise instanceof Promise);
  assert.equal(bridge.pending.size, 1);
  // The answer arrives on the same pipe, keyed by id.
  const id = [...bridge.pending.keys()][0];
  bridge._ingest(`${JSON.stringify({ id, data: { inputTokens: 5 } })}\n`);
  assert.equal(bridge.pending.size, 0, 'and the entry is released, not leaked');
  return promise;
});

ok('Pi is started with project-local extensions off', () => {
  // CVE-2026-54325: Pi loads extensions from the project it is started in without
  // asking. BigKiji starts Pi inside whatever folder the owner is working in, so
  // this flag is the difference between a tool and arbitrary code execution.
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session']) {
    assert.match(SOURCE, new RegExp(`'${flag}'`), `${flag} must be passed at spawn`);
  }
  // And it runs in the same sandbox everything else does — not the owner's HOME.
  assert.match(SOURCE, /this\.security\.minimalEnv\(/);
});

ok('garbage on the pipe is skipped, not fatal', () => {
  const { events, feed } = harness();
  feed(Buffer.from('not json\n{"type":"fine"}\n\n   \n', 'utf8'));
  assert.deepEqual(events.map((event) => event.type), ['fine'],
    'one unparseable line must not take the session down with it');
});

if (failures) { console.error(`pi rpc selftest: ${failures} FAILED`); process.exit(1); }
console.log('pi rpc selftest: PASS · multibyte survives a chunk split · LF-terminated · steer/follow-up/set_model/abort · extensions off (CVE-2026-54325) · garbage is skipped');
