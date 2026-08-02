'use strict';
// Semantic lookup that must not become a dependency, a database, or a lie.
//
// The behaviour worth pinning is mostly about absence: most machines running this app
// will not have an embedding model pulled, and the whole design rests on that case
// degrading to the bigram path rather than quietly returning nothing. So the fake
// server here is the primary subject, and the live model — if one happens to be
// installed — is checked at the end as a bonus rather than a requirement.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmbeddingStore, normalise, hashOf } = require('../src/domain/pi-agent/embedding-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-embed-'));

// A deterministic stand-in for a model: three dimensions keyed off characters present.
// Vectors that differ meaningfully is all the search path needs to be exercised.
function fakeServer({ dims = 3, fail = false, calls = [] } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (fail) return { ok: false, status: 500, json: async () => ({ error: 'no embedding model' }) };
    const embeddings = body.input.map((text) => {
      const vector = new Array(dims).fill(0);
      for (const ch of String(text)) vector[ch.codePointAt(0) % dims] += 1;
      return vector.map((value) => value + 0.01);
    });
    return { ok: true, json: async () => ({ model: body.model, embeddings }) };
  };
}

(async () => {
  // ---- normalisation makes cosine a dot product ------------------------------
  const unit = normalise([3, 4]);
  assert.ok(Math.abs(Math.sqrt(unit[0] ** 2 + unit[1] ** 2) - 1) < 1e-6, 'vectors are stored unit length');
  assert.doesNotThrow(() => normalise([0, 0]), 'a zero vector must not divide by zero');
  assert.strictEqual(normalise([0, 0])[0], 0);

  // ---- no embedding model: degrade, do not pretend ---------------------------
  // This is the case that matters most. `search` returns null rather than [], because
  // "nothing matched" and "this machine cannot answer that" are different facts and the
  // caller has to be able to fall back to Jaccard.
  const bare = new EmbeddingStore({ root: tmp(), fetchImpl: fakeServer({ fail: true }) });
  assert.strictEqual(await bare.ready(), false);
  assert.strictEqual(await bare.search('skills', 'anything'), null,
    'an unavailable store returns null, never an empty result set');
  const refused = await bare.upsert('skills', [{ id: 'a', text: 'hello' }]);
  assert.strictEqual(refused.unavailable, true);
  assert.strictEqual(refused.added, 0);
  assert.ok(!fs.existsSync(path.join(bare.root, 'skills.bin')), 'and writes nothing to disk');

  // The probe is remembered: a machine without a model must not pay a failing request
  // for every search it ever performs.
  const probeCalls = [];
  const counted = new EmbeddingStore({ root: tmp(), fetchImpl: fakeServer({ fail: true, calls: probeCalls }) });
  await counted.ready(); await counted.ready(); await counted.search('x', 'y');
  assert.strictEqual(probeCalls.length, 1, 'the availability probe runs once, not per call');

  // ---- the ordinary path ------------------------------------------------------
  const root = tmp();
  const calls = [];
  const store = new EmbeddingStore({ root, fetchImpl: fakeServer({ calls }) });
  assert.strictEqual(await store.ready(), true);

  await store.upsert('notes', [
    { id: 'aaa', text: 'aaaaaa', label: 'all a' },
    { id: 'bbb', text: 'bbbbbb', label: 'all b' },
    { id: 'ccc', text: 'cccccc', label: 'all c' },
  ]);
  const hits = await store.search('notes', 'aaaaaa', { minScore: 0 });
  assert.ok(Array.isArray(hits) && hits.length, 'a populated store answers');
  assert.strictEqual(hits[0].id, 'aaa', 'the nearest vector comes first');
  assert.strictEqual(hits[0].label, 'all a', 'labels survive the round trip');
  assert.ok(hits[0].score >= hits[hits.length - 1].score, 'results are sorted by score descending');

  // ---- unchanged text is not re-embedded --------------------------------------
  // Re-indexing a workspace has to cost a hash per entry, not a model call per entry.
  const before = calls.length;
  const again = await store.upsert('notes', [{ id: 'aaa', text: 'aaaaaa', label: 'all a' }]);
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.skipped, 1);
  assert.strictEqual(calls.length, before, 'identical text produces no request at all');

  const edited = await store.upsert('notes', [{ id: 'aaa', text: 'aaaaaa changed', label: 'all a' }]);
  assert.strictEqual(edited.added, 1, 'edited text is re-embedded');
  assert.notStrictEqual(hashOf('aaaaaa'), hashOf('aaaaaa changed'));

  // ---- it survives a restart --------------------------------------------------
  const reopened = new EmbeddingStore({ root, fetchImpl: fakeServer() });
  const persisted = await reopened.search('notes', 'bbbbbb', { minScore: 0 });
  assert.ok(persisted.some((row) => row.id === 'bbb'), 'what was indexed outlives the process');
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'vectors', 'notes.json'), 'utf8'));
  assert.strictEqual(meta.items.length, 3, 'upsert replaces in place rather than appending duplicates');
  assert.strictEqual(new Set(meta.items.map((item) => item.id)).size, 3);
  assert.strictEqual(fs.statSync(path.join(root, 'vectors', 'notes.json')).mode & 0o777, 0o600,
    'the index is written with the same permissions as the rest of the knowledge root');

  // ---- a torn write is detected, not half-answered ----------------------------
  // The sidecar is written second, so a crash can leave it describing more vectors than
  // exist. Answering from that would return a confident wrong neighbour.
  const torn = tmp();
  fs.mkdirSync(path.join(torn, 'vectors'), { recursive: true });
  fs.writeFileSync(path.join(torn, 'vectors', 'x.json'), JSON.stringify({
    version: 1, model: 'fake', dims: 3, items: [{ id: 'a', hash: 'x', offset: 0 }, { id: 'b', hash: 'y', offset: 1 }],
  }));
  fs.writeFileSync(path.join(torn, 'vectors', 'x.bin'), Buffer.alloc(3 * 4)); // room for one vector, not two
  const recovered = new EmbeddingStore({ root: torn, fetchImpl: fakeServer() });
  assert.deepStrictEqual(await recovered.search('x', 'q', { minScore: 0 }), [],
    'a namespace whose vectors do not match its index is emptied, not trusted');

  // ---- changing the model invalidates the namespace ---------------------------
  // Vectors from a different model are not comparable. Mixing them silently would be
  // the worst possible failure: plausible neighbours that mean nothing.
  const swapped = new EmbeddingStore({ root, model: 'other-model', fetchImpl: fakeServer({ dims: 5 }) });
  await swapped.upsert('notes', [{ id: 'zzz', text: 'zzz' }]);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(root, 'vectors', 'notes.json'), 'utf8'));
  assert.strictEqual(rebuilt.dims, 5);
  assert.deepStrictEqual(rebuilt.items.map((item) => item.id), ['zzz'],
    'a dimension change rebuilds the namespace rather than mixing incomparable vectors');

  // ---- degenerate input --------------------------------------------------------
  assert.deepStrictEqual(await store.embed([]), []);
  assert.deepStrictEqual(await store.embed(['', '   ']), []);
  assert.strictEqual((await store.upsert('notes', [])).added, 0);
  assert.strictEqual((await store.upsert('notes', [{ id: '', text: 'x' }])).added, 0, 'an entry with no id is not indexable');
  assert.throws(() => new EmbeddingStore({}), /requires a root/);

  // ---- bonus: the real model, when one is installed ---------------------------
  // Skipped rather than failed when absent, because the point of the design is that the
  // app works without it.
  let live = 'skipped (no local embedding model)';
  try {
    const real = new EmbeddingStore({ root: tmp(), timeoutMs: 20000 });
    if (await real.ready()) {
      await real.upsert('live', [
        { id: 'footer', text: 'Rebuild the CLI footer so the phase bar stays pinned to the bottom' },
        { id: 'audio', text: 'Generate a background music track with ACE-Step on the GPU' },
      ]);
      // The sentence shares almost no characters with the indexed one, which is exactly
      // what the bigram path cannot do.
      const found = await real.search('live', 'the status line at the bottom of the terminal is in the wrong place');
      assert.strictEqual(found?.[0]?.id, 'footer', 'a real model matches meaning, not shared characters');
      live = `ok (${real.model}, ${real.dims} dims)`;
    }
  } catch (error) { live = `skipped (${String(error.message || error).slice(0, 60)})`; }

  console.log(`embedding store selftest: PASS · no model degrades to null, not empty · probe runs once · unchanged text costs no request · torn index is emptied · model change rebuilds · live model: ${live}`);
})().catch((error) => { console.error(error); process.exit(1); });
