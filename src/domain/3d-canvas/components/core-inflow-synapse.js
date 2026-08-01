import * as THREE from 'three';

// Lightweight, event-driven visual layer. It never invents a completion state:
// callers must provide a real event and a real destination position.
export class CoreInflowSynapse {
  constructor(scene, { maxParticles = 512 } = {}) {
    this.scene = scene; this.maxParticles = maxParticles; this.particles = []; this.genesis = [];
    this.group = new THREE.Group(); scene.add(this.group);
    const pos = new Float32Array(maxParticles * 3); const col = new Float32Array(maxParticles * 3);
    this.geo = new THREE.BufferGeometry(); this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mat = new THREE.PointsMaterial({ size: 0.085, vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.points = new THREE.Points(this.geo, this.mat); this.points.frustumCulled = false; this.group.add(this.points);
  }
  spawn(from, to, color = '#34d399', kind = 'inflow') {
    if (!from || !to || this.particles.length >= this.maxParticles) return;
    const c = new THREE.Color(color);
    const span = to.clone().sub(from); const side = new THREE.Vector3(-span.z, 0, span.x).normalize();
    if (side.lengthSq() < 0.1) side.set(1, 0, 0);
    const bend = (0.24 + Math.random() * 0.52) * (Math.random() < 0.5 ? -1 : 1);
    const c1 = from.clone().lerp(to, 0.28).addScaledVector(side, bend).add(new THREE.Vector3(0, 0.18 + Math.random() * 0.28, 0));
    const c2 = from.clone().lerp(to, 0.73).addScaledVector(side, bend * 0.58).add(new THREE.Vector3(0, 0.1 + Math.random() * 0.18, 0));
    const p = { from: from.clone(), to: to.clone(), c1, c2, color: c,
      born: performance.now(), duration: kind === 'genesis' ? 720 : 900 + Math.random() * 500,
      phase: Math.random() * Math.PI * 2, kind };
    this.particles.push(p); return p;
  }
  absorbCluster(fromCenter, coreCenter, color = '#34d399', density = 9) {
    if (!fromCenter || !coreCenter) return;
    const toward = coreCenter.clone().sub(fromCenter).normalize();
    const facing = toward.clone().negate();
    const tangent = new THREE.Vector3().crossVectors(facing, Math.abs(facing.y) > 0.92
      ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const bitangent = new THREE.Vector3().crossVectors(facing, tangent).normalize();
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < density && this.particles.length < this.maxParticles; index++) {
      // Source samples cover the whole file/agent particle cluster. Destination
      // samples cover the Core's facing hemisphere instead of its centre.
      const phase = index * goldenAngle; const layer = index % 4;
      const sourceRadius = 0.3 + layer * 0.13;
      const sourceNoise = tangent.clone().multiplyScalar(Math.cos(phase) * sourceRadius)
        .addScaledVector(bitangent, Math.sin(phase) * sourceRadius * 0.72)
        .addScaledVector(facing, ((index % 3) - 1) * 0.12);
      const source = fromCenter.clone().add(sourceNoise);
      const radius = 0.48 + layer * 0.05; const lateral = 0.14 + (index % 3) * 0.055;
      const surfaceNoise = facing.clone().multiplyScalar(Math.sqrt(Math.max(0.01, radius * radius - lateral * lateral)))
        .addScaledVector(tangent, Math.cos(phase) * lateral)
        .addScaledVector(bitangent, Math.sin(phase) * lateral);
      const destination = coreCenter.clone().add(surfaceNoise);
      this.spawn(source, destination, color, 'absorption');
    }
  }
  genesisAt(position, target, color = '#34d399') {
    if (!position || !target) return;
    const mid = position.clone().lerp(target, 0.45); mid.y += 0.25;
    const curve = new THREE.CatmullRomCurve3([position.clone(), mid, target.clone()]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(12)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    this.group.add(line); this.genesis.push({ line, born: performance.now(), duration: 1150 });
    for (let i = 0; i < 8; i++) this.spawn(position, target, color, 'genesis');
  }
  handle(event, getCore, getTarget) {
    const kind = event?.kind || event?.type;
    const core = getCore?.(); if (!core) return;
    if (['turn_start', 'delta', 'task', 'tool_start'].includes(kind)) {
      const target = getTarget?.(event) || core;
      const from = target.distanceToSquared(core) < 0.01
        ? core.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(3.2 + Math.random() * 2.2)) : target;
      this.absorbCluster(from, core, event.color || '#34d399', kind === 'delta' ? 4 : 9);
    }
    if (kind === 'degrade' || kind === 'tool_end' && event.isError) {
      // Errors are red inflow as well; nothing radiates outward from Core.
      const target = getTarget?.(event) || core;
      const from = target.distanceToSquared(core) < 0.01
        ? core.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(3.8)) : target;
      this.absorbCluster(from, core, '#fb7185', 8);
    }
  }
  update(now = performance.now(), reduced = false) {
    const pos = this.geo.attributes.position.array; const col = this.geo.attributes.color.array;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; const k = Math.min(1, (now - p.born) / p.duration);
      if (k >= 1) { this.particles.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 2.35); const j = i * 3;
      const omt = 1 - e; const a = omt * omt * omt; const b = 3 * omt * omt * e;
      const c2 = 3 * omt * e * e; const d = e * e * e;
      pos[j] = a*p.from.x + b*p.c1.x + c2*p.c2.x + d*p.to.x;
      pos[j + 1] = a*p.from.y + b*p.c1.y + c2*p.c2.y + d*p.to.y;
      pos[j + 2] = a*p.from.z + b*p.c1.z + c2*p.c2.z + d*p.to.z;
      col[j] = p.color.r; col[j + 1] = p.color.g; col[j + 2] = p.color.b;
    }
    for (let i = this.particles.length; i < this.maxParticles; i++) { const j = i * 3; pos[j] = pos[j + 1] = pos[j + 2] = 0; }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true;
    for (let i = this.genesis.length - 1; i >= 0; i--) {
      const g = this.genesis[i]; const k = (now - g.born) / g.duration;
      if (k >= 1) { this.group.remove(g.line); g.line.geometry.dispose(); g.line.material.dispose(); this.genesis.splice(i, 1); }
      else g.line.material.opacity = 0.9 * (1 - k);
    }
  }
}
