'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4' });

function inside(root, candidate) { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function injectReload(html) {
  const script = `<script>(()=>{const e=new EventSource('/__bigkiji/events');e.addEventListener('reload',()=>location.reload());e.addEventListener('status',x=>parent.postMessage({type:'bigkiji-preview-status',detail:JSON.parse(x.data)},'*'));window.addEventListener('error',x=>parent.postMessage({type:'bigkiji-preview-error',detail:String(x.message||x.error)},'*'));})();<\/script>`;
  return String(html).includes('</body>') ? String(html).replace('</body>', `${script}</body>`) : `${html}${script}`;
}

class PreviewServer extends EventEmitter {
  constructor({ root, preferredPort = 4317, bind = '127.0.0.1', maxPort = 4399, pollMs = 450 } = {}) {
    super(); this.root = path.resolve(root); this.preferredPort = preferredPort; this.bind = bind; this.maxPort = maxPort;
    this.pollMs = pollMs; this.server = null; this.port = null; this.clients = new Set(); this.timer = null; this.signature = '';
  }
  snapshot() { return { running: !!this.server, root: this.root, port: this.port,
    url: this.port ? `http://${this.bind}:${this.port}/preview/bigkiji-3d-shooter/` : '', liveReload: true }; }
  async start() {
    if (this.server) return this.snapshot();
    fs.mkdirSync(this.root, { recursive: true });
    for (let port = this.preferredPort; port <= this.maxPort; port++) {
      try { await this._listen(port); this.port = port; break; }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    if (!this.server) throw new Error(`No preview port available in ${this.preferredPort}-${this.maxPort}`);
    this.signature = this._signature(); this.timer = setInterval(() => this._poll(), this.pollMs); this.timer.unref?.();
    this.emit('status', this.snapshot()); return this.snapshot();
  }
  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._request(req, res));
      const fail = (error) => { server.close(); reject(error); };
      server.once('error', fail);
      server.listen(port, this.bind, () => { server.off('error', fail); server.on('error', (error) => this.emit('error', error)); this.server = server; resolve(); });
    });
  }
  _request(req, res) {
    const url = new URL(req.url, 'http://preview.local');
    if (url.pathname === '/__bigkiji/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(this.snapshot())}\n\n`); this.clients.add(res);
      req.on('close', () => this.clients.delete(res)); return;
    }
    const prefix = '/preview/bigkiji-3d-shooter/';
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end('Not found'); return; }
    const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const file = path.resolve(this.root, rel);
    if (!inside(this.root, file)) { res.writeHead(403); res.end('Forbidden'); return; }
    let target = file;
    try { if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html'); } catch (_) {}
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end('Preview is waiting for generated files.'); return; }
    const ext = path.extname(target).toLowerCase(); let body = fs.readFileSync(target);
    if (ext === '.html') body = Buffer.from(injectReload(body.toString('utf8')));
    // No access-control-allow-origin, deliberately.
    //
    // It used to send its own origin — `http://127.0.0.1:4317` — which is the one value
    // that can never be needed, because a same-origin request does not consult CORS at
    // all. Meanwhile the real consumer, the preview iframe in main.html, was sandboxed
    // WITHOUT allow-same-origin, so its origin was opaque (`null`) and every subresource
    // it fetched was cross-origin. The module script and the live-reload EventSource
    // were both blocked, every run, and nothing reported it: the SMOKE renderer-error
    // gate was comparing a string level to a number and never fired.
    //
    // The fix is on the consumer side (main.html now grants the frame allow-same-origin,
    // so it runs on this server's own origin and needs no CORS), which means this server
    // can stop advertising anything. Sending `null` here instead would have "worked" and
    // been the wrong trade: an opaque origin is indistinguishable from any other opaque
    // origin — measured, `Sec-Fetch-Site` reads `cross-site` for our own frame's
    // subresources — so `access-control-allow-origin: null` lets any web page read these
    // files through a sandboxed iframe pointed at this port.
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  }
  _signature() {
    const rows = [];
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file);
      else { const st = fs.statSync(file); rows.push(`${path.relative(this.root, file)}:${st.mtimeMs}:${st.size}`); }
    } };
    try { walk(this.root); } catch (_) {} return rows.sort().join('|');
  }
  _poll() {
    const next = this._signature(); if (next === this.signature) return; this.signature = next;
    for (const res of this.clients) if (!res.writableEnded) res.write(`event: reload\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    this.emit('reload', { at: Date.now(), ...this.snapshot() });
  }
  close() { clearInterval(this.timer); this.timer = null; for (const res of this.clients) res.end(); this.clients.clear();
    this.server?.close(); this.server = null; this.port = null; }
}

module.exports = { PreviewServer, injectReload, inside };
