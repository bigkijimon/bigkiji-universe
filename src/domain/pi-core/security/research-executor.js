'use strict';
// The half of the broker that was missing: the part that actually performs the query.
//
// ResearchBroker sanitises a request and stamps it requiresOwnerApproval, and then
// nothing carried it out. Every spawned provider has web tools denied (ToolInterceptor
// plus the per-provider policy files in task-runner.js), so in practice "broker-only"
// meant "nobody" — a specialist could ask for a fact and never receive one. Verified
// 2026-08-16: no outbound call existed anywhere under pi-agent/ or pi-core/security/;
// the only fetch() targets were 127.0.0.1:11434 (Ollama).
//
// What authorises a call is the disclosure manifest, not a flag.
//
//   A first attempt at this file took `{ ...prepared, approved: true }` — a boolean the
//   caller sets. That makes the gate decorative: any code wanting to skip the owner just
//   sets it. It was removed for that reason. The manifest is the real control, because
//   approve() in task-runner.js refuses any disclosureHash that does not match the sealed
//   one (STALE_DISCLOSURE_HASH), and the sanitised query is *inside* what that hash
//   covers. So a query nobody approved cannot be smuggled in without changing the hash,
//   and changing the hash fails approval.
//
// Constraints this is built to, and why:
//   - No new dependency. package.json is owner-controlled, so this uses Node's built-in
//     fetch and plain regex rather than playwright/cheerio.
//   - No paid provider. Gemini is out on owner instruction (2026-08-16, "課金したくない")
//     and could not have run anyway — its quota is limit:0, a billing plan rather than a
//     key, which ROLE_BLUEPRINT already records.

const { sha, normalizeExternalTools } = require('./disclosure-manifest');

const ENDPOINT = 'https://html.duckduckgo.com/html/';

// The endpoint serves a stub page to default agents (measured: 14KB and zero results,
// against 33-38KB and ten results with this header). This is the same page a person
// gets, but it has to be stated or the executor looks broken for no visible reason.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (/^#/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return whole;
  });
}

function stripTags(fragment) {
  return decodeEntities(String(fragment).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Results are wrapped in a redirector: //duckduckgo.com/l/?uddg=<encoded>&rut=<hash>.
// Without unwrapping, every result URL is identical and useless to the specialist.
function unwrapUrl(href) {
  const raw = decodeEntities(String(href || ''));
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match) { try { return decodeURIComponent(match[1]); } catch (_) { return ''; } }
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function parseResults(body, limit) {
  const anchors = String(body).match(/<a\b[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g) || [];
  const snippets = String(body).match(/<a\b[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) || [];
  const out = [];
  for (let i = 0; i < anchors.length && out.length < limit; i += 1) {
    const href = /href="([^"]*)"/.exec(anchors[i]);
    const url = unwrapUrl(href && href[1]);
    const title = stripTags(anchors[i]);
    if (url && title) out.push({ title, url, snippet: snippets[i] ? stripTags(snippets[i]) : '' });
  }
  return out;
}

// A manifest handed in by a caller is only worth as much as its own integrity: recompute
// the hash over everything except the hash itself and require a match. createDisclosure-
// Manifest() builds `base` and then spreads it, so removing disclosureHash restores the
// exact key order it hashed.
function manifestIsIntact(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.disclosureHash) return false;
  const { disclosureHash, ...base } = manifest;
  return sha(JSON.stringify(base)) === disclosureHash;
}

function isListed(manifest, tool, query) {
  const [wanted] = normalizeExternalTools([{ tool, query }]);
  return (manifest.externalTools || []).some((item) => item.tool === wanted.tool && item.query === wanted.query);
}

class ResearchExecutor {
  constructor({ fetchImpl = null, endpoint = ENDPOINT, timeoutMs = 20000 } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  // `manifest` must be the disclosure the owner approved for this run (task.disclosure,
  // which only carries an approved hash once approve() has accepted it). Both checks
  // refuse rather than warn: a query that ran without being in the approved manifest is
  // exactly the disclosure the owner was asked to sign off on being bypassed.
  async run({ manifest, query, tool = 'search' } = {}, { limit = 8 } = {}) {
    if (!manifestIsIntact(manifest)) throw new Error('SECURITY_DISCLOSURE_TAMPERED');
    if (!String(query || '').trim()) throw new Error('SECURITY_EMPTY_QUERY');
    if (!isListed(manifest, tool, query)) throw new Error('SECURITY_QUERY_NOT_DISCLOSED');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      if (!response || !response.ok) throw new Error(`SEARCH_HTTP_${response ? response.status : 'NO_RESPONSE'}`);
      const results = parseResults(await response.text(), limit);
      // Zero results behind a healthy 200 means the stub page came back, not that the
      // web is empty. Reporting that as "no results" is the silent failure this whole
      // file exists to avoid, so it gets its own flag.
      return { query, results, count: results.length, degraded: results.length === 0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { ResearchExecutor, parseResults, unwrapUrl, stripTags, manifestIsIntact, ENDPOINT, USER_AGENT };
