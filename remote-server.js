'use strict';
// v12 リモートサーバ — node:httpのみ（依存追加ゼロ）。
// 下り=SSE(/api/events)・上り=POST。WebSocket要求はこの組で充足する
// （EventSource自動再接続＋Last-Event-ID＝モバイル回線で最も堅牢な選択）。
// バインドは既定127.0.0.1: 外部公開は tailscale serve がHTTPS+tailnet認可で面倒を見る。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CFG_PATH = path.join(os.homedir(), '.bigkiji', 'remote.json');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (c && c.token) return c;
  } catch (_) {}
  const c = { enabled: true, port: 8777, bind: '127.0.0.1', token: crypto.randomBytes(24).toString('hex') };
  try {
    fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch (_) {}
  return c;
}

// SSEへ流すチャネル（pty生データやvault:files全量のような大物は流さない）
const SSE_MAP = {
  'bus:event': 'bus', 'pi:event': 'pi', 'pi:stats': 'stats', 'bk:commentary': 'commentary',
  'voice:live-state': 'voice', 'bk:swarm': 'swarm', 'vault:touch': 'touch',
};

function start(deps) {
  const cfg = loadConfig();
  if (cfg.enabled === false) return null;
  const clients = new Set(); // { res, deltaBuf, deltaTimer }
  let seq = 0;

  const sseWrite = (c, event, data, id) => {
    if (c.res.writableEnded) return;
    // 背圧: 眠ったiPhoneソケットに無限に溜めない（再接続時に/api/stateで追い付く）
    if (c.res.socket && c.res.socket.writableLength > 262144) return;
    c.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const publish = (channel, payload) => {
    const ev = SSE_MAP[channel];
    if (!ev || !clients.size) return;
    seq++;
    if (channel === 'pi:event' && payload && payload.kind === 'delta') {
      for (const c of clients) { // トークン毎deltaは120ms合体してから送る
        c.deltaBuf = (c.deltaBuf || '') + (payload.text || '');
        if (!c.deltaTimer) {
          c.deltaTimer = setTimeout(() => {
            const text = c.deltaBuf; c.deltaBuf = ''; c.deltaTimer = null;
            sseWrite(c, 'pi', { kind: 'delta', text }, seq);
          }, 120);
        }
      }
      return;
    }
    for (const c of clients) sseWrite(c, ev, payload, seq);
  };

  const okToken = (req, url) => {
    const q = url.searchParams.get('t');
    const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ck = /(?:^|;\s*)bk_t=([a-f0-9]+)/.exec(req.headers.cookie || '');
    const got = q || h || (ck && ck[1]) || '';
    if (got.length !== cfg.token.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(cfg.token)); } catch (_) { return false; }
  };

  const STATIC = {
    '/': ['remote/mobile.html', 'text/html; charset=utf-8'],
    '/manifest.webmanifest': ['remote/manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['remote/sw.js', 'text/javascript'],
    '/icon-192.png': ['remote/icon-192.png', 'image/png'],
    '/icon-512.png': ['remote/icon-512.png', 'image/png'],
    '/vendor/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript'],
    '/vendor/three.core.js': ['node_modules/three/build/three.core.js', 'text/javascript'], // r172分割ビルドの内部import先
    '/favicon.ico': ['remote/icon-192.png', 'image/png'],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && STATIC[p]) {
      const [rel, type] = STATIC[p];
      const f = path.join(deps.appDir, rel);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      const headers = {
        'content-type': type,
        'cache-control': (p.startsWith('/icon') || p.startsWith('/vendor')) ? 'public, max-age=86400' : 'no-cache',
      };
      // 初回だけ /?t=<token> で開けばcookie化され、以後は素のURLでOK
      if (p === '/' && url.searchParams.get('t') && okToken(req, url)) {
        headers['set-cookie'] = `bk_t=${cfg.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
      }
      res.writeHead(200, headers);
      fs.createReadStream(f).pipe(res);
      return;
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); res.end('not found'); return; }
    if (!okToken(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(deps.getState()));
      return;
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const c = { res, deltaBuf: '', deltaTimer: null };
      clients.add(c);
      sseWrite(c, 'state', deps.getState()); // 接続直後にスナップショット
      req.on('close', () => { clearTimeout(c.deltaTimer); clients.delete(c); });
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 8 * 1024 * 1024) req.destroy(); else chunks.push(d); });
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        try {
          if (p === '/api/prompt') {
            const { text } = JSON.parse(body.toString('utf8') || '{}');
            if (!text || !String(text).trim()) { res.writeHead(400); res.end('{"error":"empty"}'); return; }
            deps.piSendPrompt(String(text));
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end('{"accepted":true}');
          } else if (p === '/api/abort') {
            deps.piAbort();
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end('{"accepted":true}');
          } else if (p === '/api/voice') {
            // body = WAV(16k mono PCM16)そのもの → 二段STT → Pi（返答はSSEのdeltaで届く）
            const r = await deps.handleUtterance(body, 'mobile');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
          } else { res.writeHead(404); res.end('not found'); }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err.message).slice(0, 200) }));
        }
      });
      return;
    }
    res.writeHead(405); res.end();
  });

  const ping = setInterval(() => {
    for (const c of clients) if (!c.res.writableEnded) c.res.write(': ping\n\n');
  }, 15000);
  ping.unref();
  server.on('error', (err) => deps.log && deps.log(`remote server error: ${err.message}`));
  server.listen(cfg.port, cfg.bind, () => {
    deps.log && deps.log(`📡 remote server on http://${cfg.bind}:${cfg.port} — front with: tailscale serve --bg ${cfg.port}`);
  });
  return { publish, close: () => { clearInterval(ping); server.close(); }, cfg };
}

module.exports = { start, CFG_PATH };
