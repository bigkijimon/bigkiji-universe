import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const STATE_COLORS = {
  pending: 0x6b7280,
  'in-progress': 0xffe81f,
  completed: 0x34d399,
  blocked: 0xfb7185,
};

export class Roadmap3D {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.position.set(-4.5, -1.4, -1.5);
    this.scene.add(this.group);
    this.pendingStates = new Map();
    this.phases = ['ROUTE', 'PLAN', 'EXECUTE', 'VERIFY'];
    this.items = [];
    this.transit = [];
    this.lastTransit = new Map();
    this.clock = 0;

    new FontLoader().load('../node_modules/three/examples/fonts/helvetiker_bold.typeface.json', (font) => this.build(font));
  }

  build(font) {
    const titleGeometry = new TextGeometry('BIGKIJI PHASE VECTOR', {
      font, size: 0.28, depth: 0.105, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.018, curveSegments: 3,
    });
    titleGeometry.center();
    const title = new THREE.Mesh(titleGeometry, new THREE.MeshBasicMaterial({
      color: 0xffe81f, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending,
    }));
    title.position.set(3.4, 1.45, 0.05);
    title.rotation.set(-0.92, 0, -0.08); // opening-crawl perspective tilt
    this.group.add(title);

    this.phases.forEach((name, index) => {
      const x = index * 2.35;
      const y = index * 0.32;
      const z = index * -0.35;
      const material = new THREE.MeshBasicMaterial({
        color: STATE_COLORS.pending, transparent: true, opacity: 0.08,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.35, 8, 4), material);
      plane.position.set(x, y, z);
      plane.rotation.set(-0.4, 0, -0.08);
      this.group.add(plane);

      const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.PlaneGeometry(3.4, 1.35, 8, 4)),
        new THREE.LineBasicMaterial({ color: STATE_COLORS.pending, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending })
      );
      grid.position.copy(plane.position);
      grid.rotation.copy(plane.rotation);
      this.group.add(grid);

      const textGeometry = new TextGeometry(name, {
        font, size: 0.22, depth: 0.07, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.012, curveSegments: 2,
      });
      const text = new THREE.Mesh(textGeometry, new THREE.MeshBasicMaterial({
        color: STATE_COLORS.pending, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending,
      }));
      text.position.set(-1.35 + x, y + 0.05, z + 0.04);
      text.rotation.set(-0.68, 0.08, -0.08);
      this.group.add(text);
      this.items.push({ plane, grid, text, state: 'pending', index, pulse: 0, baseZ: text.position.z, baseOpacity: 0.08 });
    });
    for (const [phase, state] of this.pendingStates) this.setState(phase, state);
  }

  setState(name, state) {
    const item = this.items.find((entry) => entry.index === name || this.phaseName(entry.index) === name);
    if (!item) { this.pendingStates.set(name, state); return; }
    const changed = item.state !== state;
    item.state = state;
    item.pulse = state === 'completed' ? 1 : state === 'in-progress' ? 0.7 : 0;
    item.baseOpacity = state === 'pending' ? 0.08 : 0.3;
    const color = STATE_COLORS[state] ?? STATE_COLORS.pending;
    item.plane.material.color.setHex(color);
    item.grid.material.color.setHex(color);
    item.text.material.color.setHex(color);
    item.text.material.opacity = state === 'pending' ? 0.18 : 0.82;
    if (changed || this.clock - (this.lastTransit.get(item.index) || -10) > 0.55) this.spawnTransit(item, color);
  }

  spawnTransit(item, color) {
    this.lastTransit.set(item.index, this.clock);
    const count = item.state === 'completed' ? 7 : 3;
    for (let index = 0; index < count && this.transit.length < 48; index++) {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035 + Math.random() * 0.025, 1), material);
      const jitterX = (Math.random() - 0.5) * 2.6;
      const jitterY = (Math.random() - 0.5) * 0.85;
      const start = item.plane.position.clone().add(new THREE.Vector3(jitterX, jitterY, 1.25 + Math.random() * 0.4));
      const end = item.plane.position.clone().add(new THREE.Vector3(jitterX * 0.72, jitterY * 0.72, -1.2));
      mesh.position.copy(start);
      this.group.add(mesh);
      this.transit.push({ mesh, item, start, end, age: -index * 0.055, duration: 0.9 + Math.random() * 0.35, crossed: false });
    }
  }

  phaseName(index) { return this.phases[index]; }

  pulse(index) {
    const item = this.items[index];
    if (item) { item.pulse = 1; this.spawnTransit(item, STATE_COLORS[item.state] ?? STATE_COLORS.completed); }
  }

  update(delta, reduced = false) {
    this.clock += delta;
    for (const item of this.items) {
      item.pulse = Math.max(0, item.pulse - delta * 0.8);
      const shimmer = reduced ? 0 : (Math.sin(this.clock * 1.5 + item.index) + 1) * 0.018;
      const boost = reduced ? 0 : item.pulse * 0.12;
      item.plane.material.opacity = Math.min(0.72, item.baseOpacity + shimmer + boost);
      item.grid.material.opacity = Math.min(0.55, 0.1 + shimmer * 2 + boost);
      item.text.position.z = item.baseZ + boost;
    }
    for (let index = this.transit.length - 1; index >= 0; index--) {
      const transit = this.transit[index];
      transit.age += delta;
      if (transit.age < 0) { transit.mesh.visible = false; continue; }
      transit.mesh.visible = true;
      const progress = Math.min(1, transit.age / transit.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      transit.mesh.position.lerpVectors(transit.start, transit.end, eased);
      transit.mesh.position.x += Math.sin(progress * Math.PI * 2 + index) * 0.08;
      transit.mesh.material.opacity = Math.sin(progress * Math.PI) * 0.95;
      if (!transit.crossed && progress >= 0.5) { transit.crossed = true; transit.item.pulse = Math.max(transit.item.pulse, 0.85); }
      if (progress >= 1) {
        this.group.remove(transit.mesh);
        transit.mesh.geometry.dispose();
        transit.mesh.material.dispose();
        this.transit.splice(index, 1);
      }
    }
  }
}
