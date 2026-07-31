import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SmoothFocusController } from '../renderer/camera-controls.js';
import { CoreInflowSynapse } from '../renderer/core-inflow-synapse.js';

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
camera.position.set(0, 4, 10);
const orbit = { target: new THREE.Vector3(0, 0, 0) };
let tracked = new THREE.Vector3(5, 1, -2);
const focus = new SmoothFocusController(camera, orbit);
focus.focus(() => tracked.clone(), 4.4);
for (let index = 0; index < 180; index++) focus.update(1 / 60);
assert(orbit.target.distanceTo(tracked) < 0.01, 'camera target must converge on the selected particle cluster');
assert(Math.abs(camera.position.distanceTo(orbit.target) - 4.4) < 0.02, 'camera must converge on the requested zoom distance');
tracked = new THREE.Vector3(-3, 2, 1);
for (let index = 0; index < 180; index++) focus.update(1 / 60);
assert(orbit.target.distanceTo(tracked) < 0.01, 'camera must continue following an orbiting cluster');

const scene = new THREE.Scene();
const inflow = new CoreInflowSynapse(scene, { maxParticles: 16 });
const core = new THREE.Vector3(0, 0, 0);
const outer = new THREE.Vector3(4, 1, 0);
inflow.handle({ kind: 'tool_end', isError: true }, () => core, () => outer);
assert.equal(inflow.particles.length, 1);
assert(inflow.particles[0].from.length() > outer.length(), 'error signal must begin outside its source cluster');
assert(inflow.particles[0].to.equals(core), 'error signal must flow inward to BigKiji Core');

console.log('interaction selftest: PASS');
