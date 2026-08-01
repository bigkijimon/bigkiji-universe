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
    const filesystem = raw.filesystem || {};
    const allowRead = uniqueRoots([taskRoot, ...(filesystem.allowRead || [])])
      .filter((root) => isInside(this.vaultRoot, root) && !isSensitivePath(root));
    const allowWrite = uniqueRoots(filesystem.allowWrite?.length ? filesystem.allowWrite : [taskRoot])
      .filter((root) => isInside(this.vaultRoot, root) && !isSensitivePath(root));
    const declared = raw.models?.allowPaid || raw.providers?.allow || PAID;
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
