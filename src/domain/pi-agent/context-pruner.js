'use strict';

const { symbolsOf, enclosing, mergeRanges } = require('./symbol-index');
const textIndex = require('./text-index');

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

// Delegates to the shared index. This mode deliberately does NOT build bigrams — it
// keeps runs of CJK characters whole, which is the one thing that made it different
// from the other two implementations and the reason a naive "unification" would have
// broken it. tools/text-index-selftest.js pins the equivalence across 436 inputs.
function termsFor(prompt) { return textIndex.extractTerms(prompt, 'prune'); }

/**
 * For each hit line, the enclosing definition if there is one, else a window.
 *
 * Merged, because two hits in the same function are one slice — sending it twice
 * is the kind of duplication this whole module exists to remove.
 * @returns {Array<[number, number]>}
 */
function symbolRanges(symbols, hits, lineCount) {
  const ranges = hits.map((hit) => {
    const owner = symbols.length ? enclosing(symbols, hit) : null;
    return owner
      ? [Math.max(0, owner.startLine), Math.min(lineCount, owner.endLine + 1)]
      : [Math.max(0, hit - 24), Math.min(lineCount, hit + 25)];
  });
  return mergeRanges(ranges);
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
    // What a caller with no pruner would plausibly have sent: the files that scored
    // as relevant at all. Everything the scan touched and scored zero was never a
    // candidate, and counting it as a saving is how `hello` came to save 5.7M tokens.
    const candidateContextTokens = estimateTokens(prompt)
      + scored.slice(0, this.maxFiles).reduce((sum, item) => sum + estimateTokens(item.text), 0);
    const included = []; let used = 0; let usedTokens = estimateTokens(prompt) + 32;
    for (const item of scored.slice(0, this.maxFiles)) {
      const lines = item.text.split('\n'); const indexes = [];
      lines.forEach((line, index) => { if (terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) indexes.push(index); });
      // Cut at the function, not at a line count.
      //
      // A fixed ±24 lines around a hit is a window that lands wherever it lands: it
      // opens mid-body and closes mid-body, so a model reading it sees a fragment
      // with no signature above it and no closing brace below. symbol-index knows
      // where the enclosing definition starts and ends, and that is both smaller and
      // more useful — a whole function instead of fifty lines through the middle of
      // two. When the file has no symbols the window is what is left, so this is an
      // improvement where it applies and never a regression where it does not.
      const symbols = symbolsOf(item.text, item.relative);
      const ranges = indexes.length
        ? symbolRanges(symbols, indexes.slice(0, 4), lines.length)
        : [[0, Math.min(lines.length, 80)]];
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
      // What pruning actually saved, not what a hypothetical never would have sent.
      //
      // This was `fullContextTokens - prunedContextTokens`, where fullContextTokens
      // is every file in the vault — 1800 of them. Typing `hello` therefore "saved"
      // 5.7 million tokens, because nothing was ever going to send the vault. The
      // saving is the part that was scored as relevant and then left out: real
      // work, honestly measured. `candidateContextTokens` is that denominator.
      tokensSaved: Math.max(0, candidateContextTokens - prunedContextTokens), measurement: 'estimated',
      candidateContextTokens,
      includedFiles: included.map((item) => item.path), excludedFiles: Math.max(0, allFiles.length - included.length),
      sandboxPath: policy.sandboxPath, scannedFiles: allFiles.length, contextTokenLimit: maxTokens,
      redactionCount: redacted.redactionCount } };
  }

  preparePromptOnly({ prompt, policy, maxTokens = this.maxTokens }) {
    maxTokens = Math.min(this.maxTokens, Math.max(512, Number(maxTokens) || this.maxTokens));
    const redacted = redactPayload(String(prompt || ''));
    if (redacted.blocked) throw new Error('SECURITY_CRITICAL_SECRET_IN_CONTEXT');
    let value = redacted.text; const initialTokens = estimateTokens(value);
    if (initialTokens > maxTokens) value = value.slice(0, Math.max(1024, Math.floor(value.length * (maxTokens / initialTokens) * 0.96)));
    const prunedContextTokens = estimateTokens(value);
    return { prompt: value, slices: [], redactions: redacted.findings,
      metrics: { fullContextTokens: initialTokens, prunedContextTokens, tokensSaved: Math.max(0, initialTokens - prunedContextTokens),
        measurement: 'estimated', includedFiles: [], excludedFiles: 0, sandboxPath: policy.sandboxPath,
        scannedFiles: 0, contextTokenLimit: maxTokens, redactionCount: redacted.redactionCount, promptOnly: true } };
  }
}

module.exports = { ContextPruner, estimateTokens, termsFor, SKIP };
