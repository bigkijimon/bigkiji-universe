#!/usr/bin/env node
'use strict';

// R: evidence-only inventory of Pi subagent outcomes. It never changes the Vault.
const fs = require('fs');
const path = require('path');
const { createPathConfig } = require('../src/core/path-config');

const VAULT = createPathConfig({ appRoot: path.join(__dirname, '..') }).vaultRoot;
const SKIP = new Set(['node_modules', '.git', '_archive', 'graphify-out', '.next']);
const rows = [];

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.pi-subagents\/artifacts\/.*_output\.md$/.test(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const status = /Subagent run failed/i.test(text) ? 'failed'
      : /Operation not permitted/i.test(text) ? 'sandbox-denied-as-expected'
        : /acceptance-report/i.test(text) ? 'attested' : 'reported';
    rows.push({ path: path.relative(VAULT, file), status });
  }
}

walk(VAULT);
const summary = rows.reduce((out, row) => {
  out[row.status] = (out[row.status] || 0) + 1;
  return out;
}, {});
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), total: rows.length, summary, rows }, null, 2));
