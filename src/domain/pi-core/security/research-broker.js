'use strict';

const { sanitizeSearchQuery } = require('./payload-redactor');

class ResearchBroker {
  prepare(query) {
    const result = sanitizeSearchQuery(query);
    if (result.blocked) throw new Error('SECURITY_RESEARCH_QUERY_BLOCKED');
    return { query: result.text, redactions: result.findings, provider: 'pi-agent-broker', requiresOwnerApproval: true };
  }
}

module.exports = { ResearchBroker };
