'use strict';

// Standby at zero.
//
// Measured before this: `ollama ps` read `UNTIL Forever` for both loaded models,
// 5.6GB of qwen3.5 and 664MB of bge-m3, on the machine that also runs ComfyUI,
// LTX-2 and ACE-Step on the same card. Two separate causes: the conversation
// engine sent `keep_alive: -1`, and everything else sent nothing at all — and
// this machine has OLLAMA_KEEP_ALIVE=-1 in its launchd environment, so omitting
// the field inherits forever.
//
// Sixty seconds is the owner's decision: a back-and-forth conversation never
// waits for a reload because every turn restarts the window, and one minute after
// the owner stops the card is free.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ConversationEngine, normalizeKeepAlive, DEFAULT_KEEP_ALIVE } = require('../src/domain/pi-core/conversation-engine');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

(async () => {
  assert.equal(DEFAULT_KEEP_ALIVE, '60s', 'the owner chose sixty seconds, then full release');

  // A value that means "forever" must never survive normalisation, whichever way
  // it is spelled: that is the setting this whole phase exists to remove.
  assert.equal(normalizeKeepAlive(-1), '60s');
  assert.equal(normalizeKeepAlive(undefined), '60s');
  assert.equal(normalizeKeepAlive('forever'), '60s');
  assert.equal(normalizeKeepAlive('nonsense'), '60s');
  assert.equal(normalizeKeepAlive(0), 0, 'zero is a real request: unload now');
  assert.equal(normalizeKeepAlive('0'), 0);
  assert.equal(normalizeKeepAlive(120), '120s');
  assert.equal(normalizeKeepAlive('5m'), '5m', 'an explicit Ollama duration is honoured');

  // --- what actually goes on the wire ---------------------------------------
  const sent = [];
  const stub = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ response: JSON.stringify({ kind: 'CHAT', reply: 'ok' }) }) };
  };
  const engine = new ConversationEngine({ fetchImpl: stub, maxContextTokens: 4096 });
  assert.equal(engine.keepAlive, '60s');
  await engine.turn({ text: 'hello', sessionId: 's1' });
  assert.equal(sent[0].body.keep_alive, '60s', 'every generate call carries the window, or it inherits forever');
  assert.equal(engine.snapshot().keepAlive, '60s', 'and the snapshot reports what is really sent, not a literal');

  // `/gpu off` has to unload rather than shorten: a render starting now cannot
  // wait out an idle window.
  sent.length = 0;
  const released = await engine.release();
  assert.equal(released.released, true);
  assert.equal(sent[0].body.keep_alive, 0, 'release means keep_alive 0, which is Ollama for unload');
  assert.equal(sent[0].body.prompt, '', 'and an empty prompt, so nothing is generated on the way out');

  // A release that fails must say so rather than claim the card is free.
  const dead = new ConversationEngine({ fetchImpl: async () => { throw new Error('connection refused'); } });
  const failure = await dead.release();
  assert.equal(failure.released, false);
  assert.match(failure.error, /connection refused/);

  // A configured window survives; a configured "forever" does not.
  const configured = new ConversationEngine({ fetchImpl: stub, keepAlive: '2m' });
  assert.equal(configured.keepAlive, '2m');
  assert.equal(new ConversationEngine({ fetchImpl: stub, keepAlive: -1 }).keepAlive, '60s',
    'the value this phase removes cannot be put back through the config door');

  // --- no caller may hold the card indefinitely -----------------------------
  const callers = ['src/domain/server/daemon.js', 'src/domain/pi-agent/fast-api-router.js',
    'src/domain/pi-agent/task-cache.js', 'src/domain/pi-agent/embedding-store.js',
    'src/domain/pi-agent/model-router.js', 'src/domain/pi-core/conversation-engine.js'];
  for (const file of callers) {
    const source = read(file);
    assert.ok(!/keep_alive:\s*-1/.test(source), `${file} must not pin a model in VRAM forever`);
    assert.ok(!/keepAlive:\s*-1/.test(source), `${file} must not warm a model forever either`);
    assert.ok(!/keep_alive:\s*'30m'/.test(source), `${file} must not hold a 21GB model for half an hour`);
  }
  // Omitting the field is the same bug wearing a different hat on this machine.
  const embed = read('src/domain/pi-agent/embedding-store.js');
  assert.match(embed, /input: list, keep_alive: this\.keepAlive/,
    'the embedding call has to be explicit, or OLLAMA_KEEP_ALIVE=-1 keeps bge-m3 resident forever');
  const daemon = read('src/domain/server/daemon.js');
  assert.match(daemon, /warmModel\(model, \{ keepAlive: this\.conversation\.keepAlive/,
    'the warmup must ask for the same window the turn will, or it re-pins what the turn released');
  assert.match(daemon, /url\.pathname === '\/api\/gpu\/release'/, 'the owner needs a way to free the card now');
  assert.match(daemon, /this\.warmedModel = null;[\s\S]{0,200}this\.conversation\.release\(\)/,
    'releasing must clear the warm marker, or the next turn assumes weights that are gone');
  // A default of -1 is the same bug as a literal -1: warmModel is called from more
  // than one surface, and the one that omits the option gets forever.
  const { warmModel } = require('../src/domain/pi-agent/model-router');
  const warmed = [];
  await warmModel('ollama/probe', { fetchImpl: async (url, init) => { warmed.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; } });
  assert.equal(warmed[0].keep_alive, '60s', 'warmModel must default to the shared window, not to forever');

  const cli = read('src/domain/terminal/bigkiji-cli.js');
  assert.match(cli, /\/api\/gpu\/release/, 'and a command to reach it from where the owner already is');
  assert.match(cli, /\/gpu off/, 'which has to be discoverable in the hint line');

  console.log('gpu residency selftest: PASS · 60s window on every local call · no forever, no 30m · /gpu off unloads · release failure reported honestly');
})().catch((error) => { console.error(error); process.exit(1); });
