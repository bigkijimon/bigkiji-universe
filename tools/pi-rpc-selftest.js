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
const { PiBridge, answerText } = require('../src/domain/pi-agent/pi-bridge');

let failures = 0;
const ok = (name, body) => { try { body(); console.log(`  ok  ${name}`); } catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); } };

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'pi-bridge.js'), 'utf8');

/** A bridge with a fake child process, so nothing is spawned. */
function harness() {
  const bridge = new PiBridge({ cwd: process.cwd() });
  const written = [];
  bridge.proc = { stdin: { write: (line) => written.push(line) }, kill() {} };
  bridge.ready = true; bridge.queued = []; // a live session; the start-up queue has its own test
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

ok('a key the owner just entered takes effect without a restart', () => {
  // pi-bridge has had refreshChain() since V13 and nothing ever called it, so
  // entering a GLM key left Pi on the tier it had picked when the key was missing —
  // the owner pasted a key, nothing changed, and the only fix was a restart.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('settings:secret'"), main.indexOf("ipcMain.handle('settings:secret-status'"));
  assert.match(handler, /pi\?\.refreshChain\?\.\(\)/, 'Pi re-picks its tier');
  assert.match(handler, /refreshFleetAvailability/, 'and the fleet display re-asks readiness');
  assert.match(handler, /syncCredentials/, 'and the daemon is told, which it already was');
  // refreshChain itself has to be reachable and honest about what it returns.
  const bridge = new PiBridge({ cwd: process.cwd() });
  const chain = bridge.refreshChain();
  assert.ok(Array.isArray(chain) && chain.length, 'it returns the chain it rebuilt');
  assert.ok(chain.every((tier) => tier && tier.id), `every tier is a real model id: ${JSON.stringify(chain)}`);
  assert.ok(chain.some((tier) => tier.need === 'ollama'), 'and the local tier is always in it');
});

ok('a prompt sent before Pi is listening is not lost', () => {
  // Pi installs its packages before it starts reading RPC — measured, `added 6
  // packages ... audited 7 packages in 3s` on stderr — and a prompt written into
  // that window is accepted by the pipe and dropped. That is what "I asked and
  // nothing happened" was. And it cannot be solved by waiting for an event: Pi
  // emits nothing unprompted, so waiting deadlocks.
  const bridge = new PiBridge({ cwd: process.cwd() });
  const written = [];
  bridge.proc = { stdin: { write: (line) => written.push(line) }, kill() {} };
  bridge.ready = false; bridge.queued = [];
  bridge.prompt('first'); bridge.steer('second');
  assert.equal(written.length, 0, 'nothing goes down the pipe before Pi is reading it');
  assert.equal(bridge.queued.length, 2);
  bridge._ingest('{"type":"response"}\n'); // the first answer of any kind proves it is reading
  assert.equal(bridge.ready, true);
  assert.equal(bridge.queued.length, 0, 'and the queue is released, not left behind');
  assert.deepEqual(written.map((line) => JSON.parse(line).message), ['first', 'second'],
    'in the order the owner said them');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'pi-bridge.js'), 'utf8');
  assert.match(source, /get_session_stats/, 'readiness is polled with a question that changes nothing');
  assert.match(source, /_waitForReady/);
});

ok('the answer can actually be found in the event', () => {
  // Shapes measured against pi 0.83. `evt.text` — what a caller would reasonably
  // try — is empty in every one of them.
  assert.equal(answerText({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PI ' } }), 'PI ');
  assert.equal(answerText({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'PI OK' } }), 'PI OK');
  assert.equal(answerText({ type: 'message_update', assistantMessageEvent: { type: 'text_start', partial: {} } }), '',
    'a start carries no new text — counting it would double the first token');
  assert.equal(answerText({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PI OK' }] } }), 'PI OK');
  assert.equal(answerText({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } }), '',
    'the owner\'s own words are not the answer');
  assert.equal(answerText({ type: 'agent_end' }), '');
  assert.equal(answerText({}), '');
});

ok('only the finished message reaches the transcript', () => {
  const { renderEvent } = require('../src/cli/tui/transcript');
  const done = renderEvent('pi', { type: 'message_end', message: { role: 'assistant', model: 'qwen2.5:0.5b', content: [{ type: 'text', text: 'PI OK' }] } }, { width: 78 })
    .join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(done, /pi\(answered · qwen2\.5:0\.5b\)/);
  assert.match(done, /PI OK/);
  // The deltas are what the footer's cat already reports; printing a partial answer
  // four times is the duplication the run block used to have.
  assert.equal(renderEvent('pi', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PI' } }, { width: 78 }).length, 0);
  for (const noise of ['turn_start', 'message_start', 'agent_settled', 'agent_start']) {
    assert.equal(renderEvent('pi', { type: noise }, { width: 78 }).length, 0, `${noise} is machinery, not conversation`);
  }
  assert.match(renderEvent('pi', { kind: 'degraded', model: 'ollama/qwen3.5:35b-a3b' }, { width: 78 }).join('').replace(/\x1b\[[0-9;]*m/g, ''),
    /fell back to/, 'a demotion is something the owner should see');
});

ok('the daemon hosts one session and cannot execute through it', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  assert.match(daemon, /if \(this\.piSession\) return this\.piSession;/, 'one session, so the GUI and the CLI cannot disagree');
  assert.match(daemon, /url\.pathname === '\/api\/pi\/prompt'/);
  assert.match(daemon, /redactPayload\(String\(text \|\| ''\)\.trim\(\)\)/, 'the owner\'s text is inspected before it leaves');
  // Toolless by construction — the approval gate stays the only door to work.
  const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'pi-agent', 'pi-bridge.js'), 'utf8');
  assert.match(bridgeSource, /'--no-tools'/);
  const piBlock = daemon.slice(daemon.indexOf('  pi() {'), daemon.indexOf('  piPrompt('));
  for (const term of ['approve', 'planHash', 'disclosureHash', '_seal']) {
    assert.ok(!new RegExp(`\\b${term}\\b`).test(piBlock), `the Pi session must not reach ${term}`);
  }
  assert.match(daemon, /this\.piSession\?\.dispose\(\)/, 'and it is a child process — it has to be cleaned up');
});

ok('npm narrating its own work is not an error', () => {
  // Pi installs its packages on every start. Nine lines of npm progress, funding
  // notices and an upgrade advert reached the transcript as red error blocks before
  // the answer did — the owner asked Pi a question and got a changelog.
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'server', 'daemon.js'), 'utf8');
  const pattern = new RegExp(daemon.match(/const PI_STDERR_NOISE = \/(.*)\/i;/)[1], 'i');
  for (const line of ['added 6 packages, and audited 7 packages in 3s', '1 package is looking for funding',
    'run `npm fund` for details', 'found 0 vulnerabilities', 'npm notice',
    'npm notice New major version of npm available! 11.17.0 -> 12.0.2', 'up to date, audited 11 packages in 1s']) {
    assert.ok(pattern.test(line), `progress, not failure: ${line}`);
  }
  // And a real failure still has to get through — that is the whole point of not
  // simply silencing stderr.
  for (const line of ['Error: Model "ollama/x" not found.', 'EACCES: permission denied',
    'TypeError: cannot read properties of undefined', 'found 3 vulnerabilities (2 high)']) {
    assert.ok(!pattern.test(line), `must not be swallowed: ${line}`);
  }
  assert.match(daemon, /if \(!PI_STDERR_NOISE\.test\(line\)\)/);
});

if (failures) { console.error(`pi rpc selftest: ${failures} FAILED`); process.exit(1); }
console.log('pi rpc selftest: PASS · multibyte survives a chunk split · LF-terminated · steer/follow-up/set_model/abort · extensions off (CVE-2026-54325) · garbage is skipped');
