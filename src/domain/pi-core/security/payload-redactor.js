'use strict';

const SECRET_PATTERNS = Object.freeze([
  { type: 'private-key', critical: true, re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { type: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { type: 'aws-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'authorization', re: /\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{12,}/gi },
  { type: 'named-secret', re: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*(["']?)[^\s,;"'}]{8,}\2/gi },
  { type: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: 'phone', re: /(?<![\w.])(?:\+?\d[\d ()-]{8,}\d)(?![\w.])/g },
]);

function redactPayload(value, { blockCritical = true } = {}) {
  let text = String(value || ''); const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    let count = 0;
    text = text.replace(pattern.re, () => { count++; return `<REDACTED:${pattern.type}>`; });
    if (count) findings.push({ type: pattern.type, count, critical: !!pattern.critical });
  }
  const blocked = blockCritical && findings.some((item) => item.critical);
  return { text, findings, blocked, redactionCount: findings.reduce((sum, item) => sum + item.count, 0) };
}

function sanitizeSearchQuery(value) {
  let query = String(value || '').replace(/```[\s\S]*?```/g, ' ').replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"']+[\\/])+[^\s"']*/g, '<PATH>');
  const codeSignals = (query.match(/[{};]|=>|\b(?:const|let|function|class|import|require)\b/g) || []).length;
  const result = redactPayload(query, { blockCritical: true });
  query = result.text.replace(/\s+/g, ' ').trim().slice(0, 320);
  return { ...result, text: query, blocked: result.blocked || codeSignals > 4 || !query || query.includes('<PATH>') };
}

module.exports = { SECRET_PATTERNS, redactPayload, sanitizeSearchQuery };
