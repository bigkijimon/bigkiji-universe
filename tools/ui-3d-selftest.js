'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/main.html');
const synapse = read('renderer/synapse.js');
const inflow = read('renderer/core-inflow-synapse.js');
const roadmap = read('renderer/roadmap-3d.js');
const terminal = read('renderer/multi-terminal-manager.js');
const resizer = read('renderer/terminal-resizer.js');

assert.match(html, /height:\s*40vh/);
assert.match(html, /backdrop-filter:\s*blur\(24px\)/);
assert.match(html, /id="taskStreamTabs"/);
assert.match(html, /id="taskStreams"/);
assert.match(terminal, /Approve/);
assert.match(terminal, /Retry/);
assert.match(terminal, /Cancel/);
assert.match(html, /id="terminalResizeHandle"/);
assert.match(html, /--terminal-height/);
assert.match(resizer, /setPointerCapture/);
assert.match(resizer, /localStorage/);
assert.match(resizer, /ArrowUp/);
assert.match(synapse, /function pickAt\(e\)/);
assert.match(synapse, /localToWorld\(worldPoint\)/);
assert.match(synapse, /SmoothFocusController/);
assert.match(synapse, /controls\.enableRotate = false/);
assert.match(synapse, /controls\.enablePan = true/);
assert.match(synapse, /controls\.enableZoom = false/);
assert.doesNotMatch(synapse, /if \(autoCam\)/);
assert.match(synapse, /zoomAroundPoint\(camera, controls\.target, anchor, scale/);
assert.match(synapse, /cameraFocus\.cancel\(\); \/\/ stop a previous file focus/);
assert.doesNotMatch(synapse, /cl\.edgeMat/);
assert.doesNotMatch(inflow, /this\.spawn\(core,/);
assert.match(roadmap, /spawnTransit/);
assert.match(roadmap, /TextGeometry\('BIGKIJI PHASE VECTOR'/);
assert.match(roadmap, /progress >= 0\.5/);

console.log('ui/3d contract selftest: PASS');
