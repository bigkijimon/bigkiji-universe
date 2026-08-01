import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SmoothFocusController, zoomAroundPoint } from '../src/domain/3d-canvas/components/camera-controls.js';
import { CoreInflowSynapse } from '../src/domain/3d-canvas/components/core-inflow-synapse.js';

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

camera.position.set(0, 0, 10);
orbit.target.set(0, 0, 0);
const anchor = new THREE.Vector3(5, 0, 0);
const zoom = zoomAroundPoint(camera, orbit.target, anchor, 0.5);
assert.equal(zoom.distance, 5);
assert.equal(camera.position.distanceTo(orbit.target), 5, 'cursor zoom must change camera distance');
assert(camera.position.equals(new THREE.Vector3(2.5, 0, 5)), 'camera must scale around the pointer anchor');
assert(orbit.target.equals(new THREE.Vector3(2.5, 0, 0)), 'target must scale around the same anchor');

const scene = new THREE.Scene();
const inflow = new CoreInflowSynapse(scene, { maxParticles: 16 });
const core = new THREE.Vector3(0, 0, 0);
const outer = new THREE.Vector3(4, 1, 0);
inflow.handle({ kind: 'tool_end', isError: true }, () => core, () => outer);
assert.equal(inflow.particles.length, 8, 'a real event must sample the whole source cluster, not emit one centre ray');
assert(inflow.particles.some((particle) => particle.from.distanceTo(outer) > 0.25), 'sources must spread across the particle cluster');
assert(inflow.particles.every((particle) => particle.to.distanceTo(core) > 0.1 && particle.to.distanceTo(core) < 1.2), 'destinations must cover the Core surface');
assert(inflow.particles.some((particle) => particle.c1.distanceTo(particle.from.clone().lerp(particle.to, 0.28)) > 0.15), 'gravity paths must bend instead of using straight interpolation');

console.log('interaction selftest: PASS');
