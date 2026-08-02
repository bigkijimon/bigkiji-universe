'use strict';
// Generated media has to reach the phone.
//
// Before V2.5 the daemon served a five-file whitelist and had no directory route, so
// everything BigKiji produced stayed on the desktop. Adding a directory route adds the
// three ways a static server gets exploited or simply fails, so each is pinned here.
//
// The data root is redirected before the daemon is required: PATHS is resolved at
// module load, and a test that writes fixtures into the owner's real media directory
// is a test that pollutes their app.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-assets-'));
process.env.BIGKIJI_DATA_ROOT = dataRoot;

const { DaemonEngine, startDaemon } = require('../src/domain/server/daemon');

const media = path.join(dataRoot, 'generated-media');
fs.mkdirSync(media, { recursive: true });
const clip = Buffer.alloc(4096, 7);
fs.writeFileSync(path.join(media, 'render.mp4'), clip);
fs.writeFileSync(path.join(media, 'note.txt'), 'not media');
fs.writeFileSync(path.join(dataRoot, 'secret.json'), '{"token":"must-not-escape"}');

(async () => {
  const engine = new DaemonEngine({ stateRoot: path.join(dataRoot, 'state'), workspace: process.cwd() });
  const listener = startDaemon({ engine, config: { bind: '127.0.0.1', port: 0, token: 'assets-token' } });
  await new Promise((resolve) => listener.server.once('listening', resolve));
  const base = `http://127.0.0.1:${listener.server.address().port}`;
  const auth = { authorization: 'Bearer assets-token' };

  // ---- authentication is not optional for media -------------------------------
  assert.strictEqual((await fetch(`${base}/assets/render.mp4`)).status, 401,
    'generated media is the owner\'s work product, not public files');

  // ---- the happy path ---------------------------------------------------------
  const whole = await fetch(`${base}/assets/render.mp4`, { headers: auth });
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.headers.get('content-type'), 'video/mp4');
  assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await whole.arrayBuffer()).byteLength, clip.length);

  // ---- Range, without which Safari will not play a video at all ---------------
  const ranged = await fetch(`${base}/assets/render.mp4`, { headers: { ...auth, range: 'bytes=100-199' } });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(ranged.headers.get('content-range'), `bytes 100-199/${clip.length}`);
  assert.strictEqual((await ranged.arrayBuffer()).byteLength, 100);
  const tail = await fetch(`${base}/assets/render.mp4`, { headers: { ...auth, range: 'bytes=-64' } });
  assert.strictEqual(tail.status, 206);
  assert.strictEqual(tail.headers.get('content-range'), `bytes ${clip.length - 64}-${clip.length - 1}/${clip.length}`);
  const open = await fetch(`${base}/assets/render.mp4`, { headers: { ...auth, range: 'bytes=4000-' } });
  assert.strictEqual(open.status, 206, 'an open-ended range is what a player actually sends when seeking');
  assert.strictEqual((await open.arrayBuffer()).byteLength, 96);
  const bad = await fetch(`${base}/assets/render.mp4`, { headers: { ...auth, range: 'bytes=99999-100000' } });
  assert.strictEqual(bad.status, 416);
  assert.strictEqual(bad.headers.get('content-range'), `bytes */${clip.length}`);

  // ---- traversal, including the encoded form that a naive check misses --------
  for (const attempt of ['/assets/../secret.json', `/assets/${encodeURIComponent('../secret.json')}`, '/assets/%2e%2e%2fsecret.json']) {
    const response = await fetch(`${base}${attempt}`, { headers: auth });
    assert.notStrictEqual(response.status, 200, `${attempt} must not resolve outside the media root`);
    assert(!(await response.text()).includes('must-not-escape'));
  }

  // ---- an unmapped extension is refused, not guessed at -----------------------
  assert.strictEqual((await fetch(`${base}/assets/note.txt`, { headers: auth })).status, 415);
  assert.strictEqual((await fetch(`${base}/assets/missing.png`, { headers: auth })).status, 404);

  // ---- the index the phone reads to know what exists --------------------------
  const listing = await fetch(`${base}/api/assets`, { headers: auth }).then((response) => response.json());
  assert.deepStrictEqual(listing.items.map((item) => item.name), ['render.mp4'], 'non-media files are not offered');
  assert.strictEqual(listing.items[0].url, '/assets/render.mp4');

  // ---- HEAD, which is how a player probes size before streaming ---------------
  const head = await fetch(`${base}/assets/render.mp4`, { method: 'HEAD', headers: auth });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.get('content-length'), String(clip.length));

  listener.server.close(); engine.shutdown();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  console.log('assets route selftest: PASS · authenticated · Range + 416 + HEAD · traversal refused (raw and encoded) · type from a fixed map');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
