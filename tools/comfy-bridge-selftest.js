'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ComfyUIMediaBridge } = require('../comfyui-media-bridge');

const root = '/Users/yuma/Documents/ComfyUI';
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigkiji-comfy-'));
let spawned = false;
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body, arrayBuffer: async () => Buffer.from('png') });
const fetchImpl = async (url, options = {}) => {
  if (url.endsWith('/system_stats')) return json({ system: {} });
  if (url.endsWith('/prompt') && options.method === 'POST') return json({ prompt_id: 'prompt-1' });
  if (url.includes('/history/prompt-1')) return json({ 'prompt-1': { status: { completed: true }, outputs: { 13: { images: [{ filename: 'result.png', subfolder: 'BigKiji', type: 'output' }] } } } });
  if (url.includes('/view?')) return json({});
  throw new Error(`unexpected fetch ${url}`);
};

(async () => {
  const bridge = new ComfyUIMediaBridge({ root, outputDir, fetchImpl, spawnImpl: () => { spawned = true; throw new Error('must not spawn'); } });
  const detected = await bridge.detect();
  assert.equal(detected.state, 'ready');
  assert.equal(spawned, false, 'status detection must never auto-start ComfyUI');
  assert.throws(() => bridge.loadWorkflow('arbitrary-path', { prompt: 'x' }, 'job'), /UNSUPPORTED WORKFLOW/);
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('completion timeout')), 3000);
    bridge.on('event', (event) => { if (event.state === 'completed') { clearTimeout(timer); resolve(event); } });
  });
  const queued = await bridge.generate({ workflowId: 'bigkiji-hud', inputs: { prompt: 'neural aurora' }, target: 'hud' });
  assert.equal(queued.state, 'queued');
  const event = await completed;
  assert.equal(event.mime, 'image/png');
  assert(fs.existsSync(new URL(event.assetUrl)));
  assert.equal(spawned, false);
  fs.rmSync(outputDir, { recursive: true, force: true });
  console.log('comfy bridge selftest: PASS');
})().catch((error) => { console.error(error); process.exit(1); });
