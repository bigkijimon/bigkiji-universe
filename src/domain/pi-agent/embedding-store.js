'use strict';
// Meaning-based lookup, without adding a dependency or a database.
//
// Everything BigKiji knows about similarity is currently Jaccard over character bigrams.
// That finds "rebuild the CLI footer" from "rebuild the CLI footer", and misses
// "the phase bar is in the wrong place" entirely — the words do not overlap. Embeddings
// close that gap, and the owner's constraint is that they close it with what is already
// on the machine.
//
// So: vectors come from Ollama over plain HTTP (no SDK), and they are stored as a flat
// Float32 file with a JSON sidecar (no SQLite, no vector database). At this corpus size
// — a few thousand files, a few hundred knowledge nodes — an exhaustive dot product is
// microseconds of work, and an approximate index would be machinery bought for a problem
// nobody has yet.
//
// Vectors are normalised on write, so cosine similarity is a dot product on read.
//
// The important behaviour is what happens when there is no embedding model: `ready()`
// says so, `search()` returns null rather than an empty list, and every caller is
// expected to fall back to the bigram path. An empty result and "I cannot answer this"
// are different facts, and conflating them would silently degrade search into nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// bge-m3: MIT, official Ollama, 100+ languages, 8K context, 1024 dimensions (measured
// against the running server 2026-08-02). Chosen because this workspace is Japanese prose
// and English identifiers in the same sentence, which single-language models handle badly.
const DEFAULT_MODEL = process.env.BIGKIJI_EMBEDDING_MODEL || 'bge-m3';
const DEFAULT_ENDPOINT = process.env.BIGKIJI_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
const { DEFAULT_KEEP_ALIVE, normalizeKeepAlive } = require('../pi-core/conversation-engine');

const hashOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalise(values) {
  const vector = Float32Array.from(values, Number);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum);
  if (!length || !Number.isFinite(length)) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
  return vector;
}

class EmbeddingStore {
  constructor({ root, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, fetchImpl = global.fetch,
    timeoutMs = 120000, keepAlive = DEFAULT_KEEP_ALIVE } = {}) {
    if (!root) throw new Error('EmbeddingStore requires a root');
    this.root = path.join(root, 'vectors');
    this.model = model;
    this.endpoint = String(endpoint).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.keepAlive = normalizeKeepAlive(keepAlive);
    this.available = null; // null = not probed yet; the tri-state is deliberate
    this.dims = 0;
    this.cache = new Map();
  }

  // One network call, remembered. A machine with no embedding model must not pay a
  // failing request per search — it should ask once and take the bigram path.
  async ready() {
    if (this.available !== null) return this.available;
    const probe = await this.embed(['bigkiji embedding probe']).catch(() => null);
    this.available = Array.isArray(probe) && probe.length === 1 && probe[0].length > 0;
    if (this.available) this.dims = probe[0].length;
    return this.available;
  }

  async embed(inputs) {
    // Whitespace-only input is dropped, not embedded: a model call that can only return
    // a meaningless vector is a wasted second and a row that will match everything.
    const list = (Array.isArray(inputs) ? inputs : [inputs]).map((value) => String(value ?? '')).filter((value) => value.trim());
    if (!list.length) return [];
    if (!this.fetchImpl) throw new Error('EmbeddingStore has no fetch implementation');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/embed`, {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
        // Without an explicit value this inherits OLLAMA_KEEP_ALIVE=-1 from the
        // machine's launchd environment, which is why bge-m3 sat in VRAM forever
        // after a single search.
        body: JSON.stringify({ model: this.model, input: list, keep_alive: this.keepAlive }),
      });
      const body = await response.json();
      if (!response.ok || body?.error) throw new Error(body?.error || `Ollama HTTP ${response.status}`);
      // Newer Ollama answers /api/embed with `embeddings`; the older /api/embeddings
      // route answered with a single `embedding`. Accept both rather than pinning to a
      // server version the owner did not choose.
      const rows = body?.embeddings || (body?.embedding ? [body.embedding] : []);
      if (!rows.length) throw new Error('embedding response carried no vectors');
      return rows.map(normalise);
    } finally { clearTimeout(timer); }
  }

  paths(namespace) {
    const safe = String(namespace).replace(/[^\w.-]/g, '_');
    return { bin: path.join(this.root, `${safe}.bin`), meta: path.join(this.root, `${safe}.json`) };
  }

  load(namespace) {
    if (this.cache.has(namespace)) return this.cache.get(namespace);
    const { bin, meta } = this.paths(namespace);
    let index = { version: 1, model: this.model, dims: 0, items: [] };
    try { index = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch (_) { /* first use */ }
    let vectors = new Float32Array(0);
    try {
      const buffer = fs.readFileSync(bin);
      vectors = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    } catch (_) { /* first use */ }
    // A vector file that disagrees with its sidecar is a torn write. The sidecar is
    // authoritative and is written second, so trailing vectors are simply ignored;
    // missing ones mean the whole namespace is rebuilt rather than half-answered.
    const expected = index.items.length * (index.dims || 0);
    if (index.dims && vectors.length < expected) index = { ...index, items: [], dims: index.dims };
    const state = { index, vectors };
    this.cache.set(namespace, state);
    return state;
  }

  save(namespace, state) {
    const { bin, meta } = this.paths(namespace);
    // Vectors first, sidecar second. A crash between them leaves vectors nobody
    // references, which is wasted disk; the other order would leave references to
    // vectors that do not exist, which is a wrong answer.
    writeAtomic(bin, Buffer.from(state.vectors.buffer, state.vectors.byteOffset, state.vectors.byteLength));
    writeAtomic(meta, Buffer.from(JSON.stringify(state.index, null, 2)));
    this.cache.set(namespace, state);
  }

  // Adds or refreshes entries. Text whose hash is unchanged is not re-embedded — the
  // point of the hash is that re-indexing a workspace costs one stat per file, not one
  // model call per file.
  async upsert(namespace, entries = []) {
    const list = entries.filter((entry) => entry && entry.id && String(entry.text || '').trim());
    if (!list.length) return { added: 0, skipped: 0 };
    if (!(await this.ready())) return { added: 0, skipped: list.length, unavailable: true };

    const state = this.load(namespace);
    const known = new Map(state.index.items.map((item, position) => [item.id, { item, position }]));
    const fresh = list.filter((entry) => known.get(entry.id)?.item.hash !== hashOf(entry.text));
    if (!fresh.length) return { added: 0, skipped: list.length };

    const vectors = await this.embed(fresh.map((entry) => entry.text));
    const dims = vectors[0].length;
    if (state.index.dims && state.index.dims !== dims) {
      // A different model produces incomparable vectors. Rebuilding is the only honest
      // response; mixing them would return confident nonsense.
      state.index = { version: 1, model: this.model, dims, items: [] };
      state.vectors = new Float32Array(0);
      known.clear();
    }

    const items = state.index.items.slice();
    const buffer = new Float32Array(state.vectors.length + fresh.length * dims);
    buffer.set(state.vectors, 0);
    let cursor = state.vectors.length;
    fresh.forEach((entry, i) => {
      const existing = known.get(entry.id);
      const record = { id: entry.id, hash: hashOf(entry.text), label: String(entry.label || entry.id).slice(0, 200) };
      if (existing) { items[existing.position] = { ...record, offset: cursor / dims }; }
      else { items.push({ ...record, offset: cursor / dims }); }
      buffer.set(vectors[i], cursor);
      cursor += dims;
    });

    this.save(namespace, { index: { version: 1, model: this.model, dims, items }, vectors: buffer });
    return { added: fresh.length, skipped: list.length - fresh.length };
  }

  // Returns null — not [] — when embeddings are unavailable, so the caller can tell
  // "nothing matched" from "this machine cannot answer that kind of question".
  async search(namespace, query, { limit = 8, minScore = 0.3 } = {}) {
    if (!(await this.ready())) return null;
    const state = this.load(namespace);
    if (!state.index.items.length) return [];
    const [vector] = await this.embed([query]);
    if (!vector) return [];
    const dims = state.index.dims;
    const scored = state.index.items.map((item) => {
      const at = item.offset * dims;
      let score = 0;
      for (let i = 0; i < dims; i += 1) score += vector[i] * state.vectors[at + i];
      return { id: item.id, label: item.label, score };
    });
    return scored.filter((row) => row.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  snapshot() {
    return { model: this.model, endpoint: this.endpoint, available: this.available, dims: this.dims, root: this.root };
  }
}

module.exports = { EmbeddingStore, normalise, hashOf, DEFAULT_MODEL };
