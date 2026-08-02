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

const SENSITIVE_SEGMENT = /(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.bigkiji|secrets?|credentials?|private[-_]?keys?|auth(?:entication)?)(?:\/|$)/i;
const SENSITIVE_FILE = /(?:^|\/)(?:credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|secrets\.enc\.json|remote\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p8|p12|pfx|jks|keystore|kdbx))$/i;

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

  createRuntime(taskId) {
    fs.mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const safeId = String(taskId || 'task').replace(/[^a-z0-9._-]/gi, '-').slice(0, 80);
    const root = fs.mkdtempSync(path.join(this.runtimeRoot, `${safeId}-`));
    const home = path.join(root, 'home'); const tmp = path.join(root, 'tmp');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    return { root, home, tmp, policyFile: path.join(root, 'security-policy.json') };
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

module.exports = { SecurityPolicy, PROVIDER_SECRET, SENSITIVE_SEGMENT, SENSITIVE_FILE, isSensitivePath, canonical, hashPolicy };
