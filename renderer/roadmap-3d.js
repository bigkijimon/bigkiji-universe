import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

export class Roadmap3D {
  constructor(scene) {
    this.scene = scene; this.group = new THREE.Group(); this.group.position.set(-4.5, -1.4, -1.5); scene.add(this.group);
    this.pendingStates = new Map();
    this.phases = ['ROUTE', 'PLAN', 'EXECUTE', 'VERIFY']; this.items = [];
    const loader = new FontLoader();
    loader.load('../node_modules/three/examples/fonts/helvetiker_bold.typeface.json', (font) => {
      this.phases.forEach((name, i) => {
        const mat = new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.22,
          blending: THREE.AdditiveBlending });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.35, 1, 1), mat);
        plane.position.set(i * 2.35, i * 0.32, i * -0.35); plane.rotation.x = -0.4; plane.rotation.z = -0.08;
        this.group.add(plane);
        const text = new THREE.Mesh(new TextGeometry(name, { font, size: 0.22, depth: 0.035, curveSegments: 2 }),
          new THREE.MeshBasicMaterial({ color: 0x7fffd4, transparent: true, opacity: 0.45 }));
        text.position.set(-1.35 + i * 2.35, i * 0.32 + 0.05, i * -0.35 + 0.04); text.rotation.x = -0.4;
        this.group.add(text); this.items.push({ plane, text, state: 'pending', index: i, pulse: 0, baseZ: text.position.z });
      });
      for (const [phase, state] of this.pendingStates) this.setState(phase, state);
    });
  }
  setState(name, state) {
    const item = this.items.find((x) => x.index === name || this.phaseName(x.index) === name);
    if (!item) { this.pendingStates.set(name, state); return; }
    item.state = state; item.pulse = state === 'completed' ? 1 : state === 'in-progress' ? 0.7 : 0;
    const color = state === 'blocked' ? 0xfb7185 : state === 'completed' ? 0x34d399 : state === 'in-progress' ? 0xffe81f : 0x6b7280;
    item.plane.material.color.setHex(color); item.plane.material.opacity = state === 'pending' ? 0.08 : 0.32;
    item.text.material.color.setHex(color); item.text.material.opacity = state === 'pending' ? 0.16 : 0.8;
  }
  phaseName(i) { return this.phases[i]; }
  pulse(index) { const item = this.items[index]; if (item) item.pulse = 1; }
  update(delta, reduced = false) {
    for (const item of this.items) {
      item.pulse = Math.max(0, item.pulse - delta * 0.8);
      const boost = reduced ? 0 : item.pulse * 0.12;
      item.plane.material.opacity = Math.min(0.9, item.plane.material.opacity + boost);
      item.text.position.z = item.baseZ + boost;
    }
  }
}
