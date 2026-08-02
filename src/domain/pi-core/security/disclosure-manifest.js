'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileHash(file) { return sha(fs.readFileSync(file)); }

// Every external tool call is brokered, so the manifest states them by name and by the
// exact sanitised query that would leave the machine. It used to be a hardcoded empty
// array, which meant the owner approved "no external calls" no matter what was planned.
function normalizeExternalTools(externalTools) {
  return (externalTools || []).map((item) => ({
    tool: String(item.tool || 'search').slice(0, 60),
    query: String(item.query || '').slice(0, 320),
    redactions: (item.redactions || []).map(({ type, count }) => ({ type, count })),
  })).sort((a, b) => `${a.tool}${a.query}`.localeCompare(`${b.tool}${b.query}`));
}

function createDisclosureManifest({ runId = '', provider, purpose, policy, slices = [], redactions = [], estimatedTokens = 0, payload = '', externalTools = [], model = '' }) {
  const files = slices.map((item) => {
    const absolute = path.resolve(policy.vaultRoot, item.path);
    return { path: item.path.replace(/\\/g, '/'), ranges: item.ranges || [], sha256: fileHash(absolute) };
  });
  // The model is part of what the owner approves. Without it, approving "Opus reads
  // these files" would also authorise a different model reading the same files.
  const base = { version: 2, runId, provider, model: String(model || ''), purpose: String(purpose || '').slice(0, 240), files,
    redactions: redactions.map(({ type, count }) => ({ type, count })), externalTools: normalizeExternalTools(externalTools),
    estimatedTokens: Number(estimatedTokens || 0), payloadHash: sha(String(payload || '')), policyHash: policy.security.policyHash };
  return { ...base, disclosureHash: sha(JSON.stringify(base)) };
}

function verifyDisclosureManifest(manifest, policy, payload = '') {
  if (!manifest || manifest.policyHash !== policy.security.policyHash) return false;
  if (!manifest.payloadHash || manifest.payloadHash !== sha(String(payload || ''))) return false;
  try {
    return manifest.files.every((item) => fileHash(path.resolve(policy.vaultRoot, item.path)) === item.sha256);
  } catch (_) { return false; }
}

function aggregateDisclosureHash(manifests) {
  return sha(JSON.stringify((manifests || []).map((item) => item.disclosureHash).sort()));
}

module.exports = { createDisclosureManifest, verifyDisclosureManifest, aggregateDisclosureHash, normalizeExternalTools, sha };
