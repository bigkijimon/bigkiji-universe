'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside } = require('../../core/path-config');
const { SecurityPolicy, isSensitivePath, canonical } = require('../pi-core/security/security-policy');

const PAID = Object.freeze(['claude', 'claude-code', 'codex', 'gemini', 'glm']);

function expand(value) {
  const text = String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(text);
}

// The allowed roots and the path being checked against them must be canonicalised by
// the *same* function, or the comparison is between two spellings of one place.
//
// This used to call fs.realpathSync while SecurityPolicy.assertPath called
// fs.realpathSync.native. On macOS and Linux they agree, so nothing showed. On
// Windows the JS implementation leaves 8.3 short names alone and the native one
// expands them, so a root recorded as
//   C:\Users\RUNNER~1\AppData\Local\Temp\...\project
// was compared against a target resolved to
//   C:\Users\runneradmin\AppData\Local\Temp\...\project
// and every read of a file inside the sandbox was refused as
// SECURITY_PATH_OUTSIDE_READ. It fails closed, so it was never a hole — but the app
// could not read its own working directory on Windows (measured in CI, 2026-08-05).
function existingRealPath(value) {
  return canonical(expand(value));
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
  /**
   * @param {{vaultRoot?: string, vaultRoots?: string[], paidAllowlist?: string[], security?: SecurityPolicy}} deps
   *
   * The Vault is a list, because the owner's is in two places and one of them is the
   * canon. Their departments live under ~/Documents; ~/BigKijiUniverse — 正典.md, the
   * skill index, the failure memory — is a sibling of Documents, not a child.
   *
   * Measured 2026-08-10: with a single vaultRoot of ~/Documents, `resolve()` returned
   * School with its two Admin reads and silently dropped all three BigKijiUniverse
   * entries out of every department's own `.pi/sandbox.json`, because the filters below
   * discard anything outside the boundary. Every agent would have lost the canon and its
   * record of what has already gone wrong, and nothing would have said so.
   *
   * `vaultRoot` (singular) still works and means a list of one. Every caller in the
   * repository passes it that way.
   */
  constructor({ vaultRoot, vaultRoots, paidAllowlist = PAID, security = new SecurityPolicy() } = {}) {
    this.setVaultRoots(vaultRoots, vaultRoot);
    this.paidAllowlist = new Set(paidAllowlist);
    this.security = security;
  }

  /**
   * Point the boundary at a different Vault, after construction.
   *
   * The owner switching project has to move this: `resolve()` refuses anything outside
   * `vaultRoots`, so a resolver still holding the previous project answers `valid: false`
   * for every path in the new one. Mutating `vaultRoots` from outside would skip the
   * realpath normalisation and leave `vaultRoot` pointing at the old first entry — two
   * fields that must never disagree, which is why this is a method and not a plain field.
   */
  setVaultRoots(vaultRoots, vaultRoot) {
    const declared = (Array.isArray(vaultRoots) && vaultRoots.length ? vaultRoots : [vaultRoot || process.cwd()])
      .filter((value) => typeof value === 'string' && value.trim());
    this.vaultRoots = uniqueRoots(declared);
    // The first one is the Vault for anything that still asks for a single answer —
    // `resolve()`'s default cwd, and the `vaultRoot` reported on the policy.
    this.vaultRoot = this.vaultRoots[0];
    return this.vaultRoots;
  }

  /** The registered root that contains this path, or '' when none does. */
  rootFor(target) {
    return this.vaultRoots.find((root) => isInside(root, target)) || '';
  }

  resolve(cwd = this.vaultRoot) {
    const taskRoot = existingRealPath(cwd);
    const boundary = this.rootFor(taskRoot);
    if (!boundary) {
      return { valid: false, localOnly: true, error: 'Task cwd is outside the configured Vault', sandboxPath: null,
        allowRead: [], allowWrite: [], providers: [] };
    }
    // Walked up to the root that actually contains this task, not to whichever one
    // happens to be first: a task in ~/BigKijiUniverse must not stop climbing at
    // ~/Documents, and vice versa.
    const sandboxPath = findSandbox(taskRoot, boundary);
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
    // A relative entry means "this folder", measured from the file it is written in.
    //
    // It used to mean the *process's* current directory, because `expand()` calls
    // `path.resolve` with no base. So `"allowWrite": ["."]` in School's own sandbox
    // granted the BigKiji repo — whichever directory the daemon happened to be started
    // from — and never School. Nothing failed; the grant simply landed somewhere else.
    // ~/.pi/sandbox.json already carries a hand-written warning about this
    // (「パスは必ず絶対パス」), which is a workaround for a trap rather than a rule anyone
    // should have to know.
    //
    // pi-sandbox, the OS-enforced layer, reads `.` as the project directory, and
    // tools/sandbox-reachability-audit.js already models it that way. Both readers of a
    // file named `.pi/sandbox.json` now agree about what a dot is.
    // findSandbox accepts both `<dir>/.pi/sandbox.json` and `<dir>/sandbox.json`, so the
    // folder the file describes is one or two levels up depending on which it found.
    const holder = sandboxPath ? path.dirname(sandboxPath) : '';
    const base = holder ? (path.basename(holder) === '.pi' ? path.dirname(holder) : holder) : taskRoot;
    const here = (value) => {
      const text = String(value || '').replace(/^~(?=$|[\\/])/, os.homedir());
      return path.isAbsolute(text) ? text : path.resolve(base, text);
    };
    // Inside ANY registered root, not inside the first one. This is the filter that was
    // eating the canon — see the constructor.
    const allowRead = uniqueRoots([taskRoot, ...(list(filesystem.allowRead) || []).map(here)])
      .filter((root) => this.rootFor(root) && !isSensitivePath(root));
    const allowWrite = uniqueRoots((list(filesystem.allowWrite) || [taskRoot]).map(here))
      .filter((root) => this.rootFor(root) && !isSensitivePath(root));
    const declared = list(raw.models?.allowPaid) || list(raw.providers?.allow) || PAID;
    const providers = [...new Set(declared.map(String))].filter((provider) => this.paidAllowlist.has(provider));
    const resolved = { valid: true, localOnly: false, sandboxPath, allowRead, allowWrite, providers,
      // `vaultRoot` is the root this task is actually inside — the one the disclosure
      // manifest and the run brief should name. `vaultRoots` is the whole list, for
      // anything reporting the configuration rather than this run.
      source: sandboxPath ? 'sandbox' : 'safe-default', vaultRoot: boundary, vaultRoots: [...this.vaultRoots], taskRoot };
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
