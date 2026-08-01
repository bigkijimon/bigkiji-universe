import assert from 'node:assert/strict';
import * as THREE from 'three';
import { radialShellPoint, fibonacciLeafPoint } from '../renderer/radial-folder-geometry.js';
import { SynapseSparkShedder } from '../renderer/synapse-spark-shedder.js';

const first = radialShellPoint('School/docs', 1, 2);
const again = radialShellPoint('School/docs', 1, 2);
assert(first.equals(again), 'folder shell placement must be deterministic');
const outer = radialShellPoint('School/docs/file', 2, 2);
assert(outer.length() > first.length(), 'shell 2 must sit outside shell 1');

const leaves = Array.from({ length: 64 }, (_, index) => fibonacciLeafPoint(index, 64, `file-${index}`, 2));
assert(leaves.some((point) => point.y > 0) && leaves.some((point) => point.y < 0), 'leaf particles must occupy both vertical hemispheres');
assert(Math.max(...leaves.map((point) => Math.abs(point.x))) > 1.2, 'leaf particles must disperse radially');

const scene = new THREE.Scene();
const shedder = new SynapseSparkShedder(scene, { capacity: 32 });
shedder.update(10);
const count = shedder.emit({ start: new THREE.Vector3(0, 0, 0), end: new THREE.Vector3(5, 0, 0), color: '#34d399', intensity: 1, eventId: 'event-1', sourceId: 'a' });
assert(count > 0 && count <= 32, 'spark emission must remain bounded');
for (let index = 0; index < count; index++) assert(shedder.attrs.velocity.getX(index) < 0, 'shed sparks must travel opposite the primary +X flow');
assert.equal(shedder.emit({ start: new THREE.Vector3(), end: new THREE.Vector3(5, 0, 0), eventId: 'event-1' }), 0, 'the same event must not emit twice');
shedder.dispose();
assert.equal(scene.children.includes(shedder.mesh), false);

console.log('radial/spark selftest: PASS');
