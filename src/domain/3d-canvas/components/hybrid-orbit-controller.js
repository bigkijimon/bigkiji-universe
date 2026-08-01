import * as THREE from 'three';

export class HybridOrbitController {
  constructor() {
    this.interacting = false;
    this.resumeAt = 0;
    this.motionScale = 1;
    this.selectedId = null;
  }

  beginInteraction(now = performance.now()) { this.interacting = true; this.resumeAt = now + 2000; }
  endInteraction(now = performance.now()) { this.interacting = false; this.resumeAt = now + 2000; }
  select(id = null) { this.selectedId = id; }

  updateNode(node, delta, { reduced = false, now = performance.now(), hovered = false, activity = 0 } = {}) {
    const frozen = this.interacting || now < this.resumeAt || this.selectedId === node.id;
    const desired = frozen ? 0 : reduced ? 0.2 : hovered ? 0.2 : Math.min(1.35, 1 + activity * 0.35);
    node.motionScale = THREE.MathUtils.damp(node.motionScale ?? 1, desired, frozen ? 8 : 2.8, delta);
    this.motionScale = THREE.MathUtils.damp(this.motionScale, desired, frozen ? 7 : 2.2, delta);
    node.angleNow = Number.isFinite(node.angleNow) ? node.angleNow : node.angle0;
    node.angleNow += delta * node.w * node.motionScale;
    const breath = reduced ? 0 : Math.sin(now * 0.00035 + node.angle0 * 3) * 0.012;
    const radius = node.radius * (1 + breath);
    return new THREE.Vector3(
      Math.cos(node.angleNow) * radius,
      node.yBase + Math.sin(node.angleNow + node.tiltPhase) * node.tiltAmp + (reduced ? 0 : Math.sin(now * 0.00023 + node.angle0) * 0.12),
      Math.sin(node.angleNow) * radius * node.orbitFlat,
    );
  }
}
