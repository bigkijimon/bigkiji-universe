import * as THREE from 'three';

export class RelationshipField {
  constructor(scene, { maxEdges = 180 } = {}) {
    this.scene = scene;
    this.maxEdges = maxEdges;
    this.group = new THREE.Group();
    this.group.name = 'graphify-relationship-field';
    scene.add(this.group);
    this.edges = [];
    this.elapsed = 0;
  }

  setSnapshot(snapshot = {}) {
    this.clear();
    for (const edge of (snapshot.edges || []).slice(0, this.maxEdges)) {
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.LineBasicMaterial({ color: 0x79d9be, transparent: true,
        opacity: 0.075, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geometry, material);
      line.userData.relationship = edge.relation || 'related';
      this.group.add(line);
      this.edges.push({ ...edge, line, phase: this.edges.length * 0.713 });
    }
  }

  update(delta, resolveWorldPoint, reduced = false) {
    this.elapsed += delta;
    if (this.elapsed < 0.34) return;
    this.elapsed = 0;
    for (const edge of this.edges) {
      const a = resolveWorldPoint(edge.source);
      const b = resolveWorldPoint(edge.target);
      edge.line.visible = !!(a && b);
      if (!a || !b) continue;
      const distance = a.distanceTo(b);
      const midpoint = a.clone().lerp(b, 0.5);
      const lift = Math.min(1.8, 0.16 + distance * 0.13);
      midpoint.y += lift + (reduced ? 0 : Math.sin(performance.now() * 0.00018 + edge.phase) * 0.06);
      midpoint.x += Math.sin(edge.phase * 2.7) * Math.min(0.55, distance * 0.06);
      const curve = new THREE.CatmullRomCurve3([a, a.clone().lerp(midpoint, 0.55), midpoint, midpoint.clone().lerp(b, 0.55), b]);
      edge.line.geometry.setFromPoints(curve.getPoints(reduced ? 9 : 15));
      edge.line.material.opacity = 0.045 + Math.min(0.08, Number(edge.weight || 1) * 0.012);
    }
  }

  pulse(paths = []) {
    const touched = new Set(paths);
    for (const edge of this.edges) {
      if (touched.has(edge.source) || touched.has(edge.target)) edge.line.material.opacity = 0.32;
    }
  }

  clear() {
    for (const edge of this.edges) { edge.line.geometry.dispose(); edge.line.material.dispose(); }
    this.group.clear(); this.edges = [];
  }

  dispose() { this.clear(); this.scene.remove(this.group); }
}
