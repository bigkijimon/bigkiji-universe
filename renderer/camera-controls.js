import * as THREE from 'three';

export function zoomAroundPoint(camera, target, anchor, scale, minimum = 2.2, maximum = 34) {
  if (!camera || !target || !anchor || !Number.isFinite(scale) || scale <= 0) return null;
  const currentDistance = camera.position.distanceTo(target);
  if (currentDistance < 0.0001) return null;
  const desiredDistance = THREE.MathUtils.clamp(currentDistance * scale, minimum, maximum);
  const ratio = desiredDistance / currentDistance;
  camera.position.sub(anchor).multiplyScalar(ratio).add(anchor);
  target.sub(anchor).multiplyScalar(ratio).add(anchor);
  return { distance: desiredDistance, ratio };
}

// Smooth focus layer for OrbitControls. A selected world point becomes the
// camera target; no frame ever snaps back to BigKiji Core while focus is active.
export class SmoothFocusController {
  constructor(camera, orbitControls, { home = new THREE.Vector3(), homeDistance = 11.5 } = {}) {
    this.camera = camera;
    this.controls = orbitControls;
    this.home = home.clone();
    this.homeDistance = homeDistance;
    this.point = null;
    this.distance = null;
  }

  focus(point, distance = 5.6) {
    if (!point) return;
    this.point = typeof point === 'function' ? point : point.clone();
    this.distance = Math.max(1.8, distance);
  }

  reset() { this.focus(this.home, this.homeDistance); }

  cancel() { this.point = null; this.distance = null; }

  get active() { return !!this.point; }

  update(delta) {
    if (!this.point || !this.distance) return;
    const point = typeof this.point === 'function' ? this.point() : this.point;
    if (!point) return;
    const targetAlpha = 1 - Math.exp(-5.5 * delta);
    const oldTarget = this.controls.target.clone();
    const view = this.camera.position.clone().sub(oldTarget);
    if (view.lengthSq() < 0.0001) view.set(0, 0.35, 1);
    view.normalize();
    this.controls.target.lerp(point, targetAlpha);
    const currentDistance = this.camera.position.distanceTo(oldTarget);
    const distance = THREE.MathUtils.damp(currentDistance, this.distance, 4.5, delta);
    this.camera.position.copy(this.controls.target).addScaledVector(view, distance);
  }
}
