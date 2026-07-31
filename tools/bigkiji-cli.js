#!/usr/bin/env node
'use strict';
// bigkiji — BigKiji Universe リモートCLI（ゼロ依存）
// 常駐アプリの remote-server に直結。デスクトップキャンバス/モバイルPWAと同一バス＝完全同期:
// ここから送った指示はPC上のPi-Sandboxで即実行され、シナプス発光・実況・メトリクスに反映される。
//
//   bigkiji                対話REPL（実況ストリーム + π> プロンプト）
//   bigkiji "prompt"       ワンショット（ターン完了で終了・exit 0）
//   bigkiji status         接続確認と状態表示
//   /state /abort /quit    REPL内コマンド
//
// 接続情報は ~/.bigkiji/remote.json（アプリが自動生成）。--host/--port/--token で上書き可。
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const A = {
  reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', mag: '\x1b[35m', bold: '\x1b[1m',
};
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bigkiji', 'remote.json'), 'utf8')); }
  catch (_) { return {}; }
}
const cfg = loadCfg();
const argv = process.argv.slice(2);
const opt = { host: '127.0.0.1', port: cfg.port || 8777, token: cfg.token || '' };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--host') opt.host = argv[++i];
  else if (argv[i] === '--port') opt.port = +argv[++i];
  else if (argv[i] === '--token') opt.token = argv[++i];
  else rest.push(argv[i]);
}
const BASE = `http://${opt.host}:${opt.port}`;
const H = { authorization: `Bearer ${opt.token}` };

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${p}`);
  return r.json().catch(() => ({}));
}
async function getState() {
  const r = await fetch(BASE + '/api/state', { headers: H });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// SSE手パース（fetchストリーム・依存ゼロ）
async function stream(onEvent, signal) {
  const res = await fetch(`${BASE}/api/events`, { headers: H, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' (bad token? see ~/.bigkiji/remote.json)');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let ev = 'message'; let data = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') {
        if (data) { try { onEvent(ev, JSON.parse(data)); } catch (_) {} }
        ev = 'message'; data = '';
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
  }
}

function stateLine(s) {
  return `pi=${s.piRunning ? 'RUNNING' : 'idle'} model=${s.model} live-voice=${s.live ? 'on' : 'off'} ` +
    `vault=${s.vaultCount} nodes uptime=${s.startTs ? Math.round((Date.now() - s.startTs) / 60000) + 'm' : '?'}`;
}

(async () => {
  const oneShot = rest.length && rest[0] !== 'status' ? rest.join(' ') : null;

  if (rest[0] === 'status') {
    try {
      const s = await getState();
      console.log(`${A.green}● BigKiji Universe linked${A.reset} ${BASE}`);
      console.log('  ' + stateLine(s));
    } catch (err) {
      console.log(`${A.red}✗ cannot reach ${BASE}${A.reset} — is the BigKiji app running? (${err.message})`);
      process.exit(1);
    }
    return;
  }

  let printer;
  if (oneShot) {
    let sawTurn = false;
    printer = (ev, d) => {
      if (ev === 'pi' && d.kind === 'delta') { sawTurn = true; process.stdout.write(d.text); }
      if (ev === 'commentary' && !sawTurn) process.stdout.write(`${A.dim}${d.text}${A.reset}\n`);
      if (ev === 'stats' && sawTurn) {
        const t = d.turn || {};
        process.stdout.write(`\n${A.green}⚡ turn complete — in ${t.input ?? '?'} · out ${t.output ?? '?'} tok · ${((d.ms || 0) / 1000).toFixed(1)}s${A.reset}\n`);
        process.exit(0);
      }
    };
  } else {
    // REPL
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${A.mag}π>${A.reset} ` });
    const out = (line) => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(line + '\n');
      rl.prompt(true);
    };
    let deltaLine = '';
    printer = (ev, d) => {
      if (ev === 'commentary') out(`${A.cyan}${d.text}${A.reset}`);
      else if (ev === 'pi' && d.kind === 'turn_start') { deltaLine = ''; out(`${A.yellow}◆ turn start (${d.model || 'pi'})${A.reset}`); }
      else if (ev === 'pi' && d.kind === 'delta') {
        deltaLine += d.text;
        const parts = deltaLine.split('\n');
        deltaLine = parts.pop();
        for (const p of parts) out(`${A.dim}│ ${p}${A.reset}`);
        if (deltaLine.length > 160) { out(`${A.dim}│ ${deltaLine}${A.reset}`); deltaLine = ''; }
      } else if (ev === 'pi' && d.kind === 'tool_end') {
        out(`${A.dim}  ${d.isError ? A.red + '✗' : A.green + '✓'}${A.reset}${A.dim} ${d.toolName} ${d.ms ?? '—'}ms${A.reset}`);
      } else if (ev === 'stats') {
        if (deltaLine) { out(`${A.dim}│ ${deltaLine}${A.reset}`); deltaLine = ''; }
        const t = d.turn || {};
        out(`${A.green}⚡ turn complete — in ${t.input ?? '?'} · out ${t.output ?? '?'} tok · ${((d.ms || 0) / 1000).toFixed(1)}s${A.reset}`);
      } else if (ev === 'swarm' && d.mode === 'cache') out(`${A.yellow}⚡ CACHE HIT — playbook ${d.hash}${A.reset}`);
    };
    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) { rl.prompt(); return; }
      try {
        if (text === '/quit' || text === '/exit') process.exit(0);
        else if (text === '/state') { const s = await getState(); out(`${A.green}${stateLine(s)}${A.reset}`); }
        else if (text === '/abort') { await post('/api/abort'); out(`${A.red}⏹ abort sent${A.reset}`); }
        else await post('/api/prompt', { text });
      } catch (err) { out(`${A.red}✗ ${err.message}${A.reset}`); }
      rl.prompt();
    });
    rl.on('close', () => process.exit(0));
    try {
      const s = await getState();
      console.log(`${A.green}● linked${A.reset} ${BASE} — ${stateLine(s)}`);
      console.log(`${A.dim}type a prompt and ⏎ (runs on the Mac's Pi core) · /state /abort /quit${A.reset}`);
    } catch (err) {
      console.log(`${A.red}✗ cannot reach ${BASE}${A.reset} — is the BigKiji app running? (${err.message})`);
      process.exit(1);
    }
    rl.prompt();
  }

  // ストリーム常駐（切断時は3秒後に再接続）
  const run = async () => {
    for (;;) {
      try { await stream(printer); } catch (err) {
        if (oneShot) { console.error(`${A.red}✗ ${err.message}${A.reset}`); process.exit(1); }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  run();
  if (oneShot) {
    await new Promise((r) => setTimeout(r, 600)); // ストリーム確立を待ってから送信（応答を取りこぼさない）
    try { await post('/api/prompt', { text: oneShot }); } catch (err) {
      console.error(`${A.red}✗ ${err.message}${A.reset}`);
      process.exit(1);
    }
    setTimeout(() => { console.error(`${A.red}✗ timeout (10min)${A.reset}`); process.exit(1); }, 600000);
  }
})();
