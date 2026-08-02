'use strict';
// The only sanctioned way anything reaches the network.
//
// Spawned providers have web tools denied outright (ToolInterceptor + per-provider
// policy files), so a specialist that needs a fact asks for it as a *request* rather
// than making the call. The broker sanitises the query, and what survives is written
// into the disclosure manifest by name, so the owner approves the exact string that
// would leave the machine — not "this task may search the web".

const { sanitizeSearchQuery } = require('./payload-redactor');

class ResearchBroker {
  prepare(query, { tool = 'search' } = {}) {
    const result = sanitizeSearchQuery(query);
    if (result.blocked) throw new Error('SECURITY_RESEARCH_QUERY_BLOCKED');
    return { tool: String(tool || 'search'), query: result.text, redactions: result.findings,
      provider: 'pi-agent-broker', requiresOwnerApproval: true };
  }

  // Batch form for building a manifest. One blocked query blocks the whole task: a
  // request that leaked a secret is not something to silently drop and continue with,
  // because the specialist would then run without the fact it said it needed.
  prepareAll(requests = []) {
    return (Array.isArray(requests) ? requests : [requests])
      .map((item) => (typeof item === 'string' ? { query: item } : item || {}))
      .filter((item) => String(item.query || '').trim())
      .map((item) => this.prepare(item.query, { tool: item.tool }));
  }
}

module.exports = { ResearchBroker };
