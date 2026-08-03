'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside } = require('../../core/path-config');
const { SecurityPolicy, isSensitivePath } = require('../pi-core/security/security-policy');

const PAID = Object.freeze(['claude', 'claude-code', 'codex', 'gemini', 'glm']);

function expand(value) {
  const text = String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(text);
}

function existingRealPath(value) {
  const absolute = expand(value);
  try { return fs.realpathSync(absolute); } catch (_) { return absolute; }
}

function findSandbox(cwd, vaultRoot) {
  let current = path.resolve(cwd);
  const boundary = path.resolve(vaultRoot || current);
  while (isInside(boundary, current)) {
    const candidates = [path.join(current, '.pi', 'sandbox.json'), path.join(current, 'sandbox.json')];
    const direct = candidates.find((candidate) => fs.existsSync(candidate));
    if (direct) return direct;
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function uniqueRoots(values) {
  return [...new Set((values || []).filter(Boolean).map(existingRealPath))];
}

class SandboxPolicyResolver {
  constructor({ vaultRoot, paidAllowlist = PAID, security = new SecurityPolicy() } = {}) {
    this.vaultRoot = existingRealPath(vaultRoot || process.cwd());
    this.paidAllowlist = new Set(paidAllowlist);
    this.security = security;
  }

  resolve(cwd = this.vaultRoot) {
    const taskRoot = existingRealPath(cwd);
    if (!isInside(this.vaultRoot, taskRoot)) {
      return { valid: false, localOnly: true, error: 'Task cwd is outside the configured Vault', sandboxPath: null,
        allowRead: [], allowWrite: [], providers: [] };
    }
    const sandboxPath = findSandbox(taskRoot, this.vaultRoot);
    let raw = {};
    if (sandboxPath) {
      try { raw = JSON.parse(fs.readFileSync(sandboxPath, 'utf8')); }
      catch (error) {
        return { valid: false, localOnly: true, error: `Invalid sandbox JSON: ${error.message}`, sandboxPath,
          allowRead: [], allowWrite: [], providers: [] };
      }
    }
    // Hand-edited config, so every field is whatever the owner typed. A scalar where
    // a list belongs used to throw out of the DaemonEngine constructor, which is not
    // inside a try — the daemon then failed to start at all, and because it is spawned
    // with stdio ignored, the only symptom anywhere was "did not become ready on port
    // 8777". A malformed sandbox must degrade to the safe default, not to silence.
    // A single value where a list belongs means one entry, not none.
    //
    // `{"models": {"allowPaid": "claude"}}` is someone narrowing the allowlist to
    // one provider. Reading it as "not an array, therefore absent" would fall
    // through to PAID and hand them all four — the exact opposite of what they
    // wrote. So: a non-empty string is a one-element list, and only a genuinely
    // absent field falls back to the default.
    const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim())
      : (typeof value === 'string' && value.trim() ? [value] : null));
    if (!raw || typeof raw !== 'object') raw = {};
    const filesystem = (raw.filesystem && typeof raw.filesystem === 'object') ? raw.filesystem : {};
    const allowRead = uniqueRoots([taskRoot, ...(list(filesystem.allowRead) || [])])
      .filter((root) => isInside(this.vaultRoot, root) && !isSensitivePath(root));
    const allowWrite = uniqueRoots(list(filesystem.allowWrite) || [taskRoot])
      .filter((root) => isInside(this.vaultRoot, root) && !isSensitivePath(root));
    const declared = list(raw.models?.allowPaid) || list(raw.providers?.allow) || PAID;
    const providers = [...new Set(declared.map(String))].filter((provider) => this.paidAllowlist.has(provider));
    const resolved = { valid: true, localOnly: false, sandboxPath, allowRead, allowWrite, providers,
      source: sandboxPath ? 'sandbox' : 'safe-default', vaultRoot: this.vaultRoot, taskRoot };
    resolved.security = this.security.normalize(resolved);
    return resolved;
  }

  assertProvider(policy, provider) {
    const normalized = provider === 'claude-code' ? 'claude-code' : String(provider);
    const allowed = policy.providers.includes(normalized)
      || (normalized === 'claude-code' && policy.providers.includes('claude'));
    if (!policy.valid || policy.localOnly || !allowed) throw new Error(`Provider blocked by sandbox policy: ${provider}`);
    return true;
  }
}

module.exports = { SandboxPolicyResolver, PAID, findSandbox, expand };
