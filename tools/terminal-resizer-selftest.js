'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const listeners = {};
const attributes = {};
const classes = new Set();
const values = new Map([['bigkiji.terminal-height.v1', '460']]);
let cssHeight = '';
let fitCalls = 0;
const handle = {
  title: '',
  addEventListener(type, callback) { listeners[type] = callback; },
  setAttribute(name, value) { attributes[name] = value; },
  setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return true; },
  classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
};
const container = { getBoundingClientRect: () => ({ height: Number.parseInt(cssHeight, 10) || 400 }) };
const frameQueue = [];
const context = {
  window: {
    innerHeight: 1000,
    localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    addEventListener() {},
  },
  document: {
    documentElement: { style: { setProperty: (_name, value) => { cssHeight = value; } } },
    body: { classList: { add() {}, remove() {} } },
  },
  requestAnimationFrame(callback) { frameQueue.push(callback); return frameQueue.length; },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'terminal', 'components', 'terminal-resizer.js'), 'utf8'), context);
const resizer = new context.window.TerminalResizer({ handle, container, onResize: () => { fitCalls++; }, storage: context.window.localStorage });
const mainHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'UI', 'main.html'), 'utf8');

assert.equal(cssHeight, '460px', 'saved height must be restored');
assert.equal(resizer.apply(20), 180, 'minimum height must preserve a usable terminal');
assert.equal(resizer.apply(9999), 780, 'maximum height must preserve the command and canvas area');
assert.equal(values.get('bigkiji.terminal-height.v1'), '780');
assert.equal(typeof listeners.pointerdown, 'function');
assert.equal(typeof listeners.pointermove, 'function');
assert.equal(typeof listeners.keydown, 'function');
while (frameQueue.length) frameQueue.shift()();
assert(fitCalls > 0, 'xterm fit callback must be requested after resize');
assert.match(mainHtml, /BIGKIJI SESSION/);
assert.match(mainHtml, /id="tabAddTerm"/);
assert.match(mainHtml, /id="tabPreview"/);

console.log('terminal resizer selftest: PASS');
