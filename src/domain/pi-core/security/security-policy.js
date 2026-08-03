'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isInside } = require('../../../core/path-config');

const PROVIDER_SECRET = Object.freeze({
  claude: 'ANTHROPIC_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  glm: 'ZAI_API_KEY',
});

// The single file each provider CLI reads to know it is logged in. One path per
// provider, and only the path that authenticates — not the directory around it.
const CREDENTIAL_FILES = Object.freeze({
  // Claude Code is not here on purpose. On macOS its token is in the login keychain,
  // which HOME cannot hide; ~/.claude/.credentials.json is a July file this install
  // no longer uses, and lending it made things worse rather than better — see below.
  codex: ['.codex/auth.json'],
  // Pi is a program, not a model: models.json is where it learns which provider and
  // key to borrow, and settings.json is version and package state. Neither holds a
  // secret here — this machine's models.json refers to ${ZAI_API_KEY} rather than
  // storing the key — but both are required for `pi --model ...` to resolve at all.
  //
  // Measured 2026-08-03: without them the sandbox hid Pi's own configuration from
  // Pi, so every model BigKiji asked for came back `Model "..." not found` and the
  // process exited. The same shape as Claude Code and the login keychain — the
  // sandbox was hiding the store, not the secret.
  glm: ['.pi/agent/models.json', '.pi/agent/settings.json'],
  pi: ['.pi/agent/models.json', '.pi/agent/settings.json'],
});

// Some logins are not a file you can lend — they are a few named fields inside a
// file that also holds things the provider has no business seeing.
//
// On macOS, Claude Code's token lives in the login keychain, which a sandboxed HOME
// does not affect. What HOME hides is ~/.claude.json, and without the account
// binding in it the CLI decides it is a fresh install and answers "Not logged in".
// That file is 62KB here and its `projects` key is every path the owner has ever
// opened together with their prompt history. So the binding is rebuilt from three
// named fields rather than copied: the owner approved lending a login, not a
// history, and named this file and these fields to do it (2026-08-03).
const CREDENTIAL_FIELDS = Object.freeze({
  claude: { '.claude.json': ['userID', 'hasCompletedOnboarding', 'oauthAccount'] },
  'claude-code': { '.claude.json': ['userID', 'hasCompletedOnboarding', 'oauthAccount'] },
});

const SENSITIVE_SEGMENT = /(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.bigkiji|secrets?|credentials?|private[-_]?keys?|auth(?:entication)?)(?:\/|$)/i;
// The leading dot used to defeat this. `~/app/credentials.json` was sensitive and
// `~/.claude/.credentials.json` — the file that logs Claude Code in — was not, and
// neither was `~/.codex/auth.json`. Every reader that asks this question (the
// context pruner, the disclosure manifest, the sandbox policy) was told those two
// were ordinary files. Found 2026-08-03 while lending exactly those files to a task.
//
// `auth` is matched only as a config file, never as source: `src/routes/auth.ts` is
// code the owner may well want a provider to read.
const SENSITIVE_FILE = /(?:^|\/)(?:\.?credentials?(?:\.[^/]*)?|\.?auth\.(?:json|toml|ya?ml)|secrets?(?:\.[^/]*)?|secrets\.enc\.json|remote\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p8|p12|pfx|jks|keystore|kdbx))$/i;

function canonical(value) {
  const absolute = path.resolve(String(value || '.'));
  try { return fs.realpathSync.native(absolute); } catch (_) {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    try { return path.join(fs.realpathSync.native(parent), path.basename(absolute)); } catch (_) { return absolute; }
  }
}

function portable(value) { return String(value || '').replace(/\\/g, '/'); }
function isSensitivePath(value) {
  const normalized = portable(path.resolve(String(value || '.')));
  return SENSITIVE_SEGMENT.test(normalized) || SENSITIVE_FILE.test(normalized);
}

function hashPolicy(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class SecurityPolicy {
  constructor({ mode = 'strict-direct', runtimeRoot = path.join(os.tmpdir(), 'bigkiji-secure-runtime') } = {}) {
    this.mode = mode; this.runtimeRoot = canonical(runtimeRoot);
  }

  normalize(policy = {}) {
    const allowRead = [...new Set((policy.allowRead || []).map(canonical))];
    const allowWrite = [...new Set((policy.allowWrite || []).map(canonical))];
    const value = {
      version: 1,
      mode: this.mode,
      valid: policy.valid !== false,
      vaultRoot: canonical(policy.vaultRoot || policy.taskRoot || process.cwd()),
      taskRoot: canonical(policy.taskRoot || policy.vaultRoot || process.cwd()),
      allowRead,
      allowWrite,
      denySensitive: true,
      webSearch: 'broker-only',
      unknownTools: 'deny',
      shellCommands: [
        '^npm (?:test|run (?:test(?::[\\w-]+)?|check(?::[\\w-]+)?|build|lint))(?=\\s|$)',
        '^node --check (?!.+(?:\\.env|credentials|secrets))',
        '^(?:npx )?tsc --noEmit(?=\\s|$)',
        '^git (?:status|diff|log|show)(?=\\s|$)',
        '^rg (?!.*(?:\\.env|credentials|secrets))',
      ],
    };
    value.policyHash = hashPolicy(value);
    return value;
  }

  assertPath(policy, requested, access = 'read') {
    if (!requested) throw new Error('SECURITY_PATH_REQUIRED');
    const target = canonical(path.isAbsolute(requested) ? requested : path.resolve(policy.taskRoot, requested));
    if (isSensitivePath(target)) throw new Error(`SECURITY_SENSITIVE_PATH:${portable(path.relative(policy.vaultRoot, target) || target)}`);
    const roots = access === 'write' ? policy.allowWrite : policy.allowRead;
    if (!roots.some((root) => isInside(root, target))) throw new Error(`SECURITY_PATH_OUTSIDE_${access.toUpperCase()}:${portable(target)}`);
    return target;
  }

  createRuntime(taskId, provider = '') {
    fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const safeId = String(taskId || 'task').replace(/[^a-z0-9._-]/gi, '-').slice(0, 80);
    const root = fs.mkdtempSync(path.join(this.runtimeRoot, `${safeId}-`));
    const home = path.join(root, 'home'); const tmp = path.join(root, 'tmp');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const linked = provider ? this.lendCredentials(provider, home) : [];
    return { root, home, tmp, linked, policyFile: path.join(root, 'security-policy.json') };
  }

  /**
   * Copy in the one file this provider needs to prove who it is, and nothing else.
   *
   * The sandbox gives every task a throwaway HOME so a provider cannot read the
   * owner's ~/.ssh, ~/.aws or anything else it was never asked to see. Claude Code,
   * Codex and Pi all authenticate from a file under HOME, so the sandbox also
   * removed their logins: measured 2026-08-03, Claude Code answered "Not logged in ·
   * Please run /login" and Codex got 401 Unauthorized from its websocket. That is
   * the whole explanation for 27 assignments and zero paid completions — the
   * providers were never broken, they were never authenticated.
   *
   * Each entry below is one path, chosen because the CLI cannot start without it.
   * Nothing is copied that the provider does not need, the copies live and die with
   * the task, and they are written read-only so a model cannot rewrite the owner's
   * credentials through its own sandbox.
   * @returns {string[]} the relative paths that were lent
   */
  lendCredentials(provider, home) {
    const files = CREDENTIAL_FILES[provider] || [];
    const lent = [];
    for (const relative of files) {
      const source = path.join(os.homedir(), relative);
      let stat; try { stat = fs.statSync(source); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      const target = path.join(home, relative);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, target);
        fs.chmodSync(target, 0o400);
        lent.push(relative);
      } catch (_) { /* a login we cannot lend is a provider that reports itself unauthenticated */ }
    }
    for (const [relative, fields] of Object.entries(CREDENTIAL_FIELDS[provider] || {})) {
      const extracted = this.extractFields(path.join(os.homedir(), relative), fields);
      if (!extracted) continue;
      const target = path.join(home, relative);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, JSON.stringify(extracted), { mode: 0o400 });
        lent.push(relative);
      } catch (_) { /* same: an unauthenticated provider beats a widened sandbox */ }
    }
    return lent;
  }

  /**
   * The named fields of a JSON file. Never the file, and never a field not asked for.
   * @returns {object|null}
   */
  extractFields(source, fields) {
    let parsed; try { parsed = JSON.parse(fs.readFileSync(source, 'utf8')); } catch (_) { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    for (const field of fields) if (Object.prototype.hasOwnProperty.call(parsed, field)) out[field] = parsed[field];
    return Object.keys(out).length ? out : null;
  }

  minimalEnv(provider, { runtime, secret = '', extra = {} } = {}) {
    // Finder起動のElectronはGUIのPATH(/usr/bin:/bin:…)しか持たず、pi子プロセスが
    // `env: node: No such file or directory` で死ぬ（~/.bigkiji/logs/pi-stderr.log 実測）。
    // node/piが実在する既知のbinディレクトリを補完する（実在するものだけ）。
    const basePath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    const knownBins = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global', 'bin')]
      .filter((dir) => !basePath.split(':').includes(dir) && fs.existsSync(dir));
    const env = {
      PATH: [basePath, ...knownBins].join(':'),
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
      TERM: process.env.TERM || 'xterm-256color',
      HOME: runtime.home,
      TMPDIR: runtime.tmp,
      XDG_CONFIG_HOME: path.join(runtime.home, '.config'),
      XDG_CACHE_HOME: path.join(runtime.home, '.cache'),
      XDG_DATA_HOME: path.join(runtime.home, '.local', 'share'),
      BIGKIJI_EXECUTOR: provider,
      BIGKIJI_SECURITY_POLICY: runtime.policyFile,
      PI_TELEMETRY: '0',
      NO_COLOR: '1',
      ...extra,
    };
    const secretName = PROVIDER_SECRET[provider];
    if (secret && secretName) env[secretName] = String(secret);
    return env;
  }
}

module.exports = { SecurityPolicy, PROVIDER_SECRET, CREDENTIAL_FILES, CREDENTIAL_FIELDS, SENSITIVE_SEGMENT, SENSITIVE_FILE, isSensitivePath, canonical, hashPolicy };
