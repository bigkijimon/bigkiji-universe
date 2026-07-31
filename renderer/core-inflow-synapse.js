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
    const c = new THREE.Color(color); const p = { from: from.clone(), to: to.clone(), color: c,
      born: performance.now(), duration: kind === 'genesis' ? 720 : 900 + Math.random() * 500,
      phase: Math.random() * Math.PI * 2, kind };
    this.particles.push(p); return p;
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
      const from = target.clone().multiplyScalar(1.5 + Math.random() * 1.7);
      this.spawn(from, core, event.color || '#34d399', 'inflow');
    }
    if (kind === 'degrade' || kind === 'tool_end' && event.isError) {
      const from = getTarget?.(event) || core.clone().multiplyScalar(0.7);
      this.spawn(core, from, '#fb7185', 'error');
    }
  }
  update(now = performance.now(), reduced = false) {
    const pos = this.geo.attributes.position.array; const col = this.geo.attributes.color.array;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; const k = Math.min(1, (now - p.born) / p.duration);
      if (k >= 1) { this.particles.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3); const j = i * 3; const arc = reduced ? 0 : Math.sin(k * Math.PI) * 0.28;
      pos[j] = THREE.MathUtils.lerp(p.from.x, p.to.x, e); pos[j + 1] = THREE.MathUtils.lerp(p.from.y, p.to.y, e) + arc;
      pos[j + 2] = THREE.MathUtils.lerp(p.from.z, p.to.z, e);
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
