'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileHash(file) { return sha(fs.readFileSync(file)); }

function createDisclosureManifest({ runId = '', provider, purpose, policy, slices = [], redactions = [], estimatedTokens = 0 }) {
  const files = slices.map((item) => {
    const absolute = path.resolve(policy.vaultRoot, item.path);
    return { path: item.path.replace(/\\/g, '/'), ranges: item.ranges || [], sha256: fileHash(absolute) };
  });
  const base = { version: 1, runId, provider, purpose: String(purpose || '').slice(0, 240), files,
    redactions: redactions.map(({ type, count }) => ({ type, count })), externalTools: [],
    estimatedTokens: Number(estimatedTokens || 0), policyHash: policy.security.policyHash };
  return { ...base, disclosureHash: sha(JSON.stringify(base)) };
}

function verifyDisclosureManifest(manifest, policy) {
  if (!manifest || manifest.policyHash !== policy.security.policyHash) return false;
  try {
    return manifest.files.every((item) => fileHash(path.resolve(policy.vaultRoot, item.path)) === item.sha256);
  } catch (_) { return false; }
}

function aggregateDisclosureHash(manifests) {
  return sha(JSON.stringify((manifests || []).map((item) => item.disclosureHash).sort()));
}

module.exports = { createDisclosureManifest, verifyDisclosureManifest, aggregateDisclosureHash, sha };
