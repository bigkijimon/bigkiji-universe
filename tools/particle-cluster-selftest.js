'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const canvasRoot = path.join(__dirname, '..', 'src', 'domain', '3d-canvas', 'components');
const synapse = fs.readFileSync(path.join(canvasRoot, 'synapse.js'), 'utf8');
const cluster = fs.readFileSync(path.join(canvasRoot, 'particle-cluster.js'), 'utf8');
const galaxy = synapse;
assert.equal(/buildAgentHole|全AI＝ブラックホール/.test(synapse), false);
assert.match(cluster, /index < this\.count/);
assert.match(cluster, /new THREE\.LineSegments/);
assert.doesNotMatch(cluster, /new THREE\.Line\(/);
// The layout became a flat spiral disc on 2026-08-05, with the owner's approval to move
// every particle: 「全粒子の表示動かしても構いません。しっかり繋がりがわかるように
// シナプスの固まりを表してください」.
//
// These checks used to name the two placement functions, which meant they broke on the
// rename and said nothing about whether the layout still meant anything. They now assert
// the PROPERTY the disc exists for — angle categorical, radius continuous — because that
// is what makes a file's position say something and the strands readable.
assert.match(galaxy, /spiralArmPoint\(armTheta\[h1\]/, 'first-level folders sit on their own arm');
assert.match(galaxy, /spiralArmPoint\(armTheta\[h2\]/, 'sub-folders sit inside their parent arm');
// Angle is categorical, and assigned from SORTED folder keys rather than a hash: a hash
// scatters neighbouring folders across the disc and piles others on top of each other.
assert.match(galaxy, /l1Keys\.sort\(\)/, 'arms are spaced by sorted order, not by hash');
assert.match(galaxy, /armTheta\[h1\] = \(Math\.PI \* 2 \* index\) \/ arms/, 'arms are evenly spaced');
// Radius is continuous, and a leaf takes its own folder's arm — that is what makes every
// strand run inward along one arm instead of across its neighbours'.
assert.match(galaxy, /armTheta\[h2\] \?\? armTheta\[h1\]/, 'a leaf inherits its folder arm');
assert.match(galaxy, /rank\[i\] \* 0\.60/, 'radius varies continuously with recency');
// The motion may add to the deterministic base, never replace it. uMotion is the switch
// that has to return every particle to exactly where hash01(path) put it.
assert.match(galaxy, /if \(uMotion < 1e-4[^\n]*\) return position;/, 'motion is switchable off');
assert.match(galaxy, /geo\.setAttribute\('aOrbit'/, 'the swing is integrated on the GPU');
// The file particles' own buffer is uploaded once and never re-sent. The strand and
// flow buffers still are, deliberately — they are two small arrays, not one per file.
assert.doesNotMatch(galaxy, /\.points\.geometry\.attributes\.position\.needsUpdate/,
  'the file particle buffer is uploaded once, not re-sent every frame');
assert.match(galaxy, /size: 0\.155/);
console.log('particle cluster policy selftest: PASS · flat spiral disc · angle categorical, '
  + 'radius continuous · motion added on the GPU and switchable off');
