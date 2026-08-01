import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const COLORS = { pending: 0x51606d, 'in-progress': 0xffe81f, completed: 0x34d399, blocked: 0xfb7185 };
const safeLabel = (value) => String(value || 'UNPLANNED').replace(/[^\w\- ./ぁ-んァ-ヶ一-龯]/g, ' ').trim().slice(0, 42) || 'UNPLANNED';

export class Roadmap3D {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.position.set(-5.15, -1.0, -4.4);
    this.group.rotation.y = -0.28;
    this.group.scale.setScalar(0.4);
    scene.add(this.group);
    this.font = null;
    this.lanes = [];
    this.items = [];
    this.transit = [];
    this.clock = 0;
    this.planState = null;
    new FontLoader().load('../../../node_modules/three/examples/fonts/helvetiker_bold.typeface.json', (font) => {
      this.font = font; this.rebuild();
    });
  }

  setPlans(state = {}) {
    this.planState = state;
    if (this.font) this.rebuild();
  }

  phasesFromState() {
    const plans = (this.planState?.plans || []).slice(-3);
    if (!plans.length) return [{ taskId: 'unplanned', label: 'LIVE TASK', phases: [{ label: 'UNPLANNED', status: 'pending' }] }];
    return plans.map((plan, laneIndex) => ({
      taskId: plan.taskId || `plan-${laneIndex}`,
      label: safeLabel(plan.plan?.split(/Goal:|Constraints:/i)[1] || plan.taskId || `TASK ${laneIndex + 1}`),
      phases: (plan.decisions?.length ? plan.decisions : ['UNPLANNED']).slice(0, 18).map((decision, index, all) => ({
        id: `${plan.taskId || laneIndex}:${index}`,
        label: safeLabel(decision),
        status: plan.status === 'completed' ? 'completed' : index === 0 ? 'in-progress' : 'pending',
        assignedAgent: '', progress: plan.status === 'completed' ? 100 : index === 0 ? 18 : 0,
      })),
    }));
  }

  clear() {
    this.group.traverse((object) => { object.geometry?.dispose?.(); object.material?.dispose?.(); });
    this.group.clear(); this.items = []; this.lanes = [];
    for (const particle of this.transit) { particle.mesh.geometry.dispose(); particle.mesh.material.dispose(); }
    this.transit = [];
  }

  text(value, size, color, opacity = 0.8) {
    const geometry = new TextGeometry(safeLabel(value), { font: this.font, size, depth: size * 0.24,
      bevelEnabled: true, bevelSize: size * 0.035, bevelThickness: size * 0.05, curveSegments: 2 });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.rotation.set(-0.22, 0.12, -0.025);
    return mesh;
  }

  rebuild() {
    this.clear();
    const laneData = this.phasesFromState();
    const title = this.text('BIGKIJI PHASE FABRIC', 0.23, 0xffe81f, 0.78);
    title.position.set(0, 2.25, 0.3); title.rotation.set(-0.5, 0.05, -0.04); this.group.add(title);

    laneData.forEach((lane, laneIndex) => {
      const y = laneIndex * 1.25;
      const laneGroup = new THREE.Group(); laneGroup.position.y = y; this.group.add(laneGroup);
      const laneTitle = this.text(lane.label, 0.105, 0xa7f3d0, 0.48); laneTitle.position.set(0, 0.72, 0.18); laneGroup.add(laneTitle);
      const laneItems = [];
      const spacing = Math.max(1.05, Math.min(1.55, 8.8 / Math.max(1, lane.phases.length)));
      lane.phases.forEach((phase, index) => {
        const x = index * spacing;
        const color = COLORS[phase.status] ?? COLORS.pending;
        const planeMaterial = new THREE.MeshBasicMaterial({ color, transparent: true,
          opacity: phase.status === 'pending' ? 0.045 : 0.16, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 1.18, 6, 8), planeMaterial);
        plane.position.set(x, 0, 0); plane.rotation.y = Math.PI / 2; laneGroup.add(plane);
        const grid = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.PlaneGeometry(0.92, 1.18, 6, 8)),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: phase.status === 'pending' ? 0.07 : 0.2,
            blending: THREE.AdditiveBlending, depthWrite: false }));
        grid.position.copy(plane.position); grid.rotation.copy(plane.rotation); laneGroup.add(grid);
        const label = this.text(`${index + 1} ${phase.label}`, 0.095, color, phase.status === 'pending' ? 0.28 : 0.75);
        label.position.set(x - 0.34, -0.76, 0.08); laneGroup.add(label);
        const item = { ...phase, index, laneIndex, laneGroup, plane, grid, label, pulse: 0,
          baseOpacity: phase.status === 'pending' ? 0.045 : 0.16, x };
        laneItems.push(item); this.items.push(item);
      });
      // Dense but restrained relationship bundle: every line passes through
      // every generated phase gate, mirroring the task's real phase order.
      for (let strand = 0; strand < Math.min(18, 6 + lane.phases.length * 2); strand++) {
        const points = laneItems.map((item, index) => new THREE.Vector3(item.x,
          (strand / 17 - 0.5) * 0.86 + Math.sin(index * 1.7 + strand) * 0.07,
          Math.sin(index * 0.9 + strand * 0.63) * 0.28));
        if (points.length === 1) points.push(points[0].clone().add(new THREE.Vector3(0.8, 0, 0)));
        const curve = new THREE.CatmullRomCurve3(points);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(18, points.length * 8))),
          new THREE.LineBasicMaterial({ color: strand % 3 === 0 ? 0xffe81f : 0x34d399,
            transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false }));
        laneGroup.add(line);
      }
      this.lanes.push({ ...lane, group: laneGroup, items: laneItems });
    });
  }

  ingestTask(task = {}) {
    const lane = this.lanes.find((entry) => entry.taskId === task.id || task.id?.startsWith(entry.taskId));
    if (!lane) return;
    const targetIndex = task.status === 'completed' ? lane.items.length - 1
      : task.status === 'running' ? Math.min(1, lane.items.length - 1) : 0;
    lane.items.forEach((item, index) => this.applyState(item,
      task.status === 'failed' && index === targetIndex ? 'blocked'
        : index < targetIndex || task.status === 'completed' ? 'completed'
          : index === targetIndex ? 'in-progress' : 'pending'));
  }

  setState(name, state) {
    const item = this.items.find((entry) => entry.index === name || entry.label === name || entry.label?.toUpperCase().includes(String(name).toUpperCase()));
    if (item) this.applyState(item, state);
  }

  applyState(item, state) {
    if (!item) return;
    const changed = item.status !== state;
    item.status = state; item.pulse = state === 'completed' ? 1 : state === 'in-progress' ? 0.72 : 0;
    item.baseOpacity = state === 'pending' ? 0.045 : 0.18;
    const color = COLORS[state] ?? COLORS.pending;
    item.plane.material.color.setHex(color); item.grid.material.color.setHex(color); item.label.material.color.setHex(color);
    if (changed) this.spawnTransit(item, color);
  }

  spawnTransit(item, color) {
    for (let index = 0; index < 5 && this.transit.length < 64; index++) {
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.025 + index * 0.004, 1),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false }));
      item.laneGroup.add(mesh);
      const y = (index - 2) * 0.13;
      this.transit.push({ mesh, item, start: new THREE.Vector3(item.x - 0.85, y, 0.35),
        end: new THREE.Vector3(item.x + 0.85, y * 0.6, -0.35), age: -index * 0.06, duration: 1.0, crossed: false });
    }
  }

  pulse(index) { const item = this.items[index]; if (item) this.spawnTransit(item, COLORS[item.status] ?? COLORS.completed); }

  update(delta, reduced = false) {
    this.clock += delta;
    for (const item of this.items) {
      item.pulse = Math.max(0, item.pulse - delta * 0.72);
      const shimmer = reduced ? 0 : (Math.sin(this.clock * 1.2 + item.index + item.laneIndex) + 1) * 0.012;
      item.plane.material.opacity = Math.min(0.58, item.baseOpacity + shimmer + item.pulse * 0.18);
      item.grid.material.opacity = Math.min(0.48, 0.06 + shimmer * 2 + item.pulse * 0.18);
    }
    for (let index = this.transit.length - 1; index >= 0; index--) {
      const particle = this.transit[index]; particle.age += delta;
      if (particle.age < 0) { particle.mesh.visible = false; continue; }
      particle.mesh.visible = true;
      const progress = Math.min(1, particle.age / particle.duration);
      particle.mesh.position.lerpVectors(particle.start, particle.end, 1 - Math.pow(1 - progress, 3));
      particle.mesh.position.y += Math.sin(progress * Math.PI) * 0.08;
      particle.mesh.material.opacity = Math.sin(progress * Math.PI) * 0.95;
      if (!particle.crossed && progress >= 0.5) { particle.crossed = true; particle.item.pulse = 1; }
      if (progress >= 1) {
        particle.mesh.parent?.remove(particle.mesh); particle.mesh.geometry.dispose(); particle.mesh.material.dispose(); this.transit.splice(index, 1);
      }
    }
  }
}
