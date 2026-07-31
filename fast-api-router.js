'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Static priority is deliberate: no duplicate requests and no hidden race billing.
const PRIORITY = ['claude-code', 'codex', 'glm', 'kimi'];
const MODELS = {
  glm: 'zai/glm-4.7-flash',
  kimi: 'moonshot/kimi-k3',
};
const PLACEHOLDER = /^REPLACE_WITH|^YOUR_|^$/i;

function usableKey(value) { return typeof value === 'string' && value.length > 8 && !PLACEHOLDER.test(value); }
function configuredProvider(name) {
  const env = name === 'glm' ? process.env.ZAI_API_KEY : process.env.MOONSHOT_API_KEY;
  if (usableKey(env)) return { key: env, baseUrl: name === 'glm' ? 'https://api.z.ai/api/paas/v4' : 'https://api.moonshot.ai/v1' };
  try {
    const file = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'models.json'), 'utf8'));
    const provider = file.providers?.[name === 'glm' ? 'zai' : 'moonshot'];
    if (provider && usableKey(provider.apiKey)) return { key: provider.apiKey, baseUrl: provider.baseUrl };
  } catch (_) {}
  return null;
}
function commandExists(command) {
  return new Promise((resolve) => execFile('sh', ['-lc', `command -v ${command}`], { timeout: 1200 }, (err, stdout) => resolve(!err && !!String(stdout).trim())));
}
async function detect() {
  const out = {};
  out['claude-code'] = await commandExists(process.env.CLAUDE_BIN || 'claude');
  out.codex = await commandExists(process.env.CODEX_BIN || 'codex');
  out.glm = !!configuredProvider('glm');
  out.kimi = !!configuredProvider('kimi');
  return out;
}
function availableOrder(availability) { return PRIORITY.filter((id) => availability[id]); }

function parseLine(provider, line, onDelta) {
  const raw = String(line || '').trim(); if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const delta = j.delta || j.text_delta || j.assistantMessageEvent?.delta || j.result?.text;
    if (delta) { onDelta?.(String(delta)); return String(delta); }
    if (j.type === 'result' && j.result) return String(j.result);
  } catch (_) {}
  if (provider === 'codex' || provider === 'claude-code') { onDelta?.(raw); return raw; }
  return '';
}
function runCli(provider, prompt, onDelta) {
  return new Promise((resolve, reject) => {
    const command = provider === 'codex' ? (process.env.CODEX_BIN || 'codex') : (process.env.CLAUDE_BIN || 'claude');
    const args = provider === 'codex'
      ? ['exec', '--json', '--sandbox', 'workspace-write', prompt]
      : ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    const child = spawn(command, args, { cwd: '/Users/yuma/Documents/CEOBigKiji', env: { ...process.env, BIGKIJI_FAST_ROUTE: provider }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; let error = '';
    child.stdout.on('data', (buf) => String(buf).split('\n').forEach((line) => { text += parseLine(provider, line, onDelta); }));
    child.stderr.on('data', (buf) => { error += String(buf).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 && text.trim() ? resolve(text.trim()) : reject(new Error(error.trim() || `${provider} exited ${code}`)));
  });
}
async function runApi(provider, prompt, onDelta) {
  const conf = configuredProvider(provider); if (!conf) throw new Error(`${provider} is not configured`);
  const model = MODELS[provider].split('/').pop();
  const response = await fetch(`${conf.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
  });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || `${provider} ${response.status}`);
  const text = String(body.choices?.[0]?.message?.content || '').trim(); if (!text) throw new Error(`${provider} returned empty response`);
  onDelta?.(text); return text;
}

async function route(prompt, { onStart, onDelta } = {}) {
  const started = Date.now(); const availability = await detect();
  const candidates = availableOrder(availability);
  if (!candidates.length) throw new Error('No fast provider available; configure Claude/Codex/GLM/Kimi or use local Pi fallback.');
  let lastError;
  for (const provider of candidates) {
    onStart?.(provider);
    try {
      const text = provider === 'claude-code' || provider === 'codex'
        ? await runCli(provider, String(prompt), onDelta)
        : await runApi(provider, String(prompt), onDelta);
      return { provider, text, latencyMs: Date.now() - started, availability, fallback: provider !== candidates[0] };
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('Fast routing failed');
}

module.exports = { PRIORITY, MODELS, detect, availableOrder, route };
