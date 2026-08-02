import * as THREE from 'three';

// タスク完了率70%以降の「不気味な多重リング」（参照: 動画4の抽象化・目玉なし）。
// 降着円盤の傾きから各リングが別々の傾斜へゆっくり起き上がり、交差しながら
// 低速回転する。不気味さは色（深緑→琥珀→暗赤）と遅さで表現する。
const RING_DEFS = [
  { radius: 1.55, tube: 0.028, color: '#1f6f52', speed: 0.11, axis: new THREE.Vector3(1, 0.18, 0) },
  { radius: 1.92, tube: 0.022, color: '#3fe3a8', speed: -0.08, axis: new THREE.Vector3(0.25, 1, 0.1) },
  { radius: 2.24, tube: 0.02, color: '#f5ca69', speed: 0.06, axis: new THREE.Vector3(0, 0.35, 1) },
  { radius: 2.58, tube: 0.017, color: '#b45309', speed: -0.045, axis: new THREE.Vector3(1, 0.6, 0.4) },
  { radius: 2.9, tube: 0.015, color: '#7f1d1d', speed: 0.035, axis: new THREE.Vector3(0.15, 1, 0.7) },
];
// 起点＝降着円盤の傾き（orb-coreのdisk.rotationと同値）。ここから各自の最終傾斜へ起き上がる
const DISK_EULER = new THREE.Euler(Math.PI / 2 - 0.42, 0.12, 0);

export class CoreRingMorph {
  constructor(scene, { perfLite = false } = {}) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.morph = 0;          // 0=円盤のまま → 1=完全なリング群
    this.explodeAt = 0;      // finale開始時刻（0=未発火）
    this.rings = RING_DEFS.slice(0, perfLite ? 3 : RING_DEFS.length).map((def, index) => {
      const segments = perfLite ? [48, 8] : [96, 12];
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(def.radius, def.tube, segments[1], segments[0]),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false }));
      // 発光の芯: 同径のわずかに太い淡いリングを重ねてブルームを擬似する
      const glow = new THREE.Mesh(
        new THREE.TorusGeometry(def.radius, def.tube * 3.2, segments[1], segments[0]),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false }));
      const holder = new THREE.Group();
      holder.add(mesh); holder.add(glow);
      this.group.add(holder);
      const fromQ = new THREE.Quaternion().setFromEuler(DISK_EULER);
      const toQ = new THREE.Quaternion().setFromAxisAngle(def.axis.clone().normalize(),
        (0.9 + index * 0.5) * (index % 2 ? -1 : 1));
      return { holder, mesh, glow, def, fromQ, toQ, spin: 0, delay: index * 0.12 };
    });
  }

  setMorph(value) {
    this.morph = THREE.MathUtils.clamp(value, 0, 1);
    this.group.visible = this.morph > 0.001 || this.explodeAt > 0;
  }

  explode(now = performance.now()) {
    if (this.explodeAt) return;
    this.explodeAt = now;
  }

  reset() {
    this.explodeAt = 0;
    this.setMorph(0);
    this.group.scale.setScalar(1);
  }

  update(t, delta, reduced, now = performance.now()) {
    if (!this.group.visible) return;
    // finale: 0.55秒でリング群が外側へ弾けて消える
    let explodeK = 0;
    if (this.explodeAt) {
      explodeK = Math.min(1, (now - this.explodeAt) / 550);
      this.group.scale.setScalar(1 + explodeK * explodeK * 2.6);
      if (explodeK >= 1) { this.reset(); return; }
    }
    for (const ring of this.rings) {
      // 各リングは少し遅れて起き上がる（ゆっくり変形＝各1.0の遅延スロープ）
      const k = THREE.MathUtils.clamp((this.morph - ring.delay) / (1 - ring.delay), 0, 1);
      const rise = reduced ? k : k * k * (3 - 2 * k); // smoothstep
      ring.holder.quaternion.slerpQuaternions(ring.fromQ, ring.toQ, rise);
      if (!reduced) {
        ring.spin += delta * ring.def.speed * (0.4 + rise);
        ring.holder.rotateOnAxis(ring.def.axis, delta * ring.def.speed * rise);
      }
      // 呼吸する不穏な明滅（遅い・非同期）
      const pulse = reduced ? 1 : 0.78 + 0.22 * Math.sin(t * (0.5 + ring.delay) + ring.def.radius * 3.1);
      const fade = 1 - explodeK;
      ring.mesh.material.opacity = rise * 0.85 * pulse * fade;
      ring.glow.material.opacity = rise * 0.16 * pulse * fade;
    }
  }

  dispose() {
    for (const ring of this.rings) {
      ring.mesh.geometry.dispose(); ring.mesh.material.dispose();
      ring.glow.geometry.dispose(); ring.glow.material.dispose();
    }
  }
}
