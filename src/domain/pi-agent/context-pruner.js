'use strict';

const fs = require('fs');
const path = require('path');
const { isInside } = require('../../core/path-config');
const { isSensitivePath } = require('../pi-core/security/security-policy');
const { redactPayload } = require('../pi-core/security/payload-redactor');

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.html', '.css', '.scss', '.py', '.sh', '.yml', '.yaml', '.toml', '.txt']);
const SKIP = /(^|[\\/])(node_modules|\.git|graphify-out|recordings|dist|build|\.obsidian|\.ssh|\.aws|\.azure|\.kube|\.gnupg|secrets?|credentials?)([\\/]|$)|(^|[\\/])\.env($|\.)|\.(?:pem|key|p8|p12|pfx|jks|keystore|kdbx)$/i;

function estimateTokens(text) {
  let ascii = 0; let wide = 0;
  for (const char of String(text || '')) char.codePointAt(0) < 128 ? ascii++ : wide++;
  return Math.ceil(ascii / 4 + wide / 1.5);
}

function termsFor(prompt) {
  return [...new Set(String(prompt || '').match(/[A-Za-z_$][\w$.-]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}/g) || [])]
    .filter((term) => !/^(the|and|for|with|this|that|from|into|する|して|これ|それ)$/i.test(term)).slice(0, 24);
}

class ContextPruner {
  constructor({ graphPath = '', maxFiles = 10, maxChars = 48000, maxTokens = 12000 } = {}) {
    this.graphPath = graphPath; this.maxFiles = maxFiles; this.maxChars = maxChars; this.maxTokens = Math.min(8192 * 4, Math.max(512, maxTokens)); this.cache = new Map();
  }

  read(file) {
    const stat = fs.statSync(file); const key = `${stat.mtimeMs}:${stat.size}`;
    const prior = this.cache.get(file); if (prior?.key === key) return prior.text;
    if (stat.size > 2 * 1024 * 1024) return '';
    const text = fs.readFileSync(file, 'utf8'); this.cache.set(file, { key, text }); return text;
  }

  files(policy) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (out.length >= 1800 || depth > 7 || SKIP.test(dir)) return;
      let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (out.length >= 1800) break;
        if (entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name); if (SKIP.test(file) || isSensitivePath(file)) continue;
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (TEXT_EXT.has(path.extname(file).toLowerCase())) out.push(file);
      }
    };
    for (const root of policy.allowRead) walk(root);
    return [...new Set(out)].filter((file) => policy.allowRead.some((root) => isInside(root, file)));
  }

  graphHints(terms, policy) {
    if (!this.graphPath || !fs.existsSync(this.graphPath)) return new Set();
    try {
      const graph = JSON.parse(fs.readFileSync(this.graphPath, 'utf8')); const hits = new Set();
      for (const node of graph.nodes || []) {
        const hay = `${node.label || ''} ${node.id || ''} ${node.source_file || ''}`.toLowerCase();
        if (!terms.some((term) => hay.includes(term.toLowerCase()))) continue;
        const source = node.source_file || node.file;
        if (!source) continue;
        const absolute = path.isAbsolute(source) ? source : path.resolve(policy.vaultRoot, source);
        if (policy.allowRead.some((root) => isInside(root, absolute))) hits.add(absolute);
      }
      return hits;
    } catch (_) { return new Set(); }
  }

  prepare({ prompt, policy, maxTokens = this.maxTokens }) {
    maxTokens = Math.min(this.maxTokens, Math.max(512, Number(maxTokens) || this.maxTokens));
    const terms = termsFor(prompt); const allFiles = this.files(policy); const hints = this.graphHints(terms, policy);
    let fullContextTokens = estimateTokens(prompt); const scored = [];
    for (const file of allFiles) {
      let text = ''; try { text = this.read(file); } catch (_) { continue; }
      fullContextTokens += estimateTokens(text);
      const relative = path.relative(policy.vaultRoot, file); const lower = `${relative}\n${text.slice(0, 220000)}`.toLowerCase();
      let score = hints.has(file) ? 20 : 0;
      for (const term of terms) if (lower.includes(term.toLowerCase())) score += relative.toLowerCase().includes(term.toLowerCase()) ? 8 : 2;
      if (score) scored.push({ file, relative, text, score });
    }
    scored.sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
    const included = []; let used = 0; let usedTokens = estimateTokens(prompt) + 32;
    for (const item of scored.slice(0, this.maxFiles)) {
      const lines = item.text.split('\n'); const indexes = [];
      lines.forEach((line, index) => { if (terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) indexes.push(index); });
      const ranges = indexes.length ? indexes.slice(0, 4).map((index) => [Math.max(0, index - 24), Math.min(lines.length, index + 25)]) : [[0, Math.min(lines.length, 80)]];
      const slice = ranges.map(([a, b]) => `L${a + 1}-L${b}:\n${lines.slice(a, b).join('\n')}`).join('\n…\n');
      const sliceTokens = estimateTokens(slice) + estimateTokens(item.relative) + 12;
      if (used + slice.length > this.maxChars || usedTokens + sliceTokens > maxTokens) break;
      used += slice.length; usedTokens += sliceTokens; included.push({ path: item.relative, content: slice,
        ranges: ranges.map(([a, b]) => `L${a + 1}-L${b}`) });
    }
    const context = included.map((item) => `\n<file path="${item.path}">\n${item.content}\n</file>`).join('');
    const redacted = redactPayload(`${prompt}\n\n[Sandbox-scoped relevant context only]${context || '\nNo matching local context was required.'}`);
    if (redacted.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_CONTEXT');
    let prunedPrompt = redacted.text;
    if (estimateTokens(prunedPrompt) > maxTokens) {
      const ratio = maxTokens / estimateTokens(prunedPrompt); prunedPrompt = prunedPrompt.slice(0, Math.max(1024, Math.floor(prunedPrompt.length * ratio * 0.96)));
    }
    const prunedContextTokens = estimateTokens(prunedPrompt);
    return { prompt: prunedPrompt, slices: included.map(({ path, ranges }) => ({ path, ranges })), redactions: redacted.findings,
      metrics: { fullContextTokens, prunedContextTokens,
      tokensSaved: Math.max(0, fullContextTokens - prunedContextTokens), measurement: 'estimated',
      includedFiles: included.map((item) => item.path), excludedFiles: Math.max(0, allFiles.length - included.length),
      sandboxPath: policy.sandboxPath, scannedFiles: allFiles.length, contextTokenLimit: maxTokens,
      redactionCount: redacted.redactionCount } };
  }
}

module.exports = { ContextPruner, estimateTokens, termsFor, SKIP };
