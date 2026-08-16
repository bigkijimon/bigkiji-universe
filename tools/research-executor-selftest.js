'use strict';
// The executor is the only thing in the fleet that reaches the public internet, so the
// part worth testing is not that it fetches — it is that it refuses. Every case below
// asserts both the error and that fetch was never called, because a guard that throws
// after the request has already left is not a guard.
//
// No network: fetch is stubbed with a captured DuckDuckGo response, so this runs offline
// and in CI. The live endpoint was measured separately (2026-08-16: 33-38KB and ten
// results with a browser User-Agent, 14KB and zero without).

const assert = require('assert');
const { ResearchBroker } = require('../src/domain/pi-core/security/research-broker');
const { createDisclosureManifest } = require('../src/domain/pi-core/security/disclosure-manifest');
const { ResearchExecutor, unwrapUrl, parseResults } = require('../src/domain/pi-core/security/research-executor');

// Two results in the shape the endpoint actually returns, redirector and all.
const SAMPLE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=aa">First &amp; only</a>
  <a class="result__snippet" href="#">Snippet <b>one</b></a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo&amp;rut=bb">Second</a>
  <a class="result__snippet" href="#">Snippet two</a>
</div>`;

const policy = { vaultRoot: process.cwd(), security: { policyHash: 'selftest-policy-hash' } };
const QUERY = 'how tall is the eiffel tower';

function build() {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => SAMPLE }; };
  const executor = new ResearchExecutor({ fetchImpl });
  const externalTools = new ResearchBroker().prepareAll([{ query: QUERY, tool: 'search' }]);
  const manifest = createDisclosureManifest({ runId: 'selftest', provider: 'claude-code', model: 'm', purpose: 'p', policy, externalTools });
  return { executor, manifest, calls: () => calls };
}

async function refuses(label, run, expected) {
  const { executor, manifest, calls } = build();
  await assert.rejects(() => run(executor, manifest), (error) => {
    assert.strictEqual(error.message, expected, `${label}: expected ${expected}, got ${error.message}`);
    return true;
  });
  assert.strictEqual(calls(), 0, `${label}: refused but still called fetch`);
  console.log(`  ok  ${label} -> ${expected} (no request made)`);
}

(async () => {
  console.log('research-executor selftest');

  await refuses('no manifest', (ex) => ex.run({ query: QUERY }), 'SECURITY_DISCLOSURE_TAMPERED');

  await refuses('query injected into the manifest after sealing', (ex, manifest) => {
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.externalTools.push({ tool: 'search', query: 'exfiltrate', redactions: [] });
    return ex.run({ manifest: tampered, query: 'exfiltrate' });
  }, 'SECURITY_DISCLOSURE_TAMPERED');

  await refuses('intact manifest, undisclosed query', (ex, manifest) =>
    ex.run({ manifest, query: 'something nobody approved' }), 'SECURITY_QUERY_NOT_DISCLOSED');

  await refuses('empty query', (ex, manifest) => ex.run({ manifest, query: '   ' }), 'SECURITY_EMPTY_QUERY');

  // The disclosed query is the only one that gets out.
  const { executor, manifest, calls } = build();
  const result = await executor.run({ manifest, query: QUERY }, { limit: 5 });
  assert.strictEqual(calls(), 1, 'disclosed query should make exactly one request');
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.degraded, false);
  assert.strictEqual(result.results[0].url, 'https://example.com/one', 'redirector must be unwrapped');
  assert.strictEqual(result.results[0].title, 'First & only', 'entities must be decoded');
  assert.strictEqual(result.results[1].url, 'https://example.org/two');
  console.log('  ok  disclosed query -> 2 results, redirector unwrapped');

  // A 200 with nothing in it is the stub page, not an empty web. It must be visible.
  const stub = new ResearchExecutor({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>no results here</html>' }) });
  const empty = await stub.run({ manifest, query: QUERY });
  assert.strictEqual(empty.degraded, true, 'zero results behind a 200 must be reported as degraded');
  console.log('  ok  empty 200 -> degraded:true (not silently "no results")');

  assert.strictEqual(unwrapUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fx&rut=z'), 'https://a.test/x');
  assert.strictEqual(unwrapUrl('not a url'), '', 'a non-URL must not be passed through');
  assert.strictEqual(parseResults('', 5).length, 0);
  console.log('  ok  url unwrapping and empty-body parsing');

  console.log('research-executor selftest: all passed');
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
