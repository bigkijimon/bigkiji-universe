'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PreviewServer } = require('../src/core/preview-server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-preview-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><body>BigKiji preview</body>');
  const server = new PreviewServer({ root, preferredPort: 44317, maxPort: 44327, pollMs: 40 });
  const status = await server.start();
  assert(status.running); assert(status.url.includes(String(status.port)));
  const response = await fetch(status.url); const html = await response.text();
  assert(response.ok); assert.match(html, /BigKiji preview/); assert.match(html, /__bigkiji\/events/);
  assert.strictEqual((await fetch(`http://127.0.0.1:${status.port}/preview/bigkiji-3d-shooter/..%2F..%2Fetc%2Fpasswd`)).status, 403);
  server.close(); assert.strictEqual(server.snapshot().running, false);
  console.log('preview server selftest: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
