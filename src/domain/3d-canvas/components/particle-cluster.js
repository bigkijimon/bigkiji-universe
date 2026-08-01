import * as THREE from 'three';

// Department node: a living colony of particles, not a black hole.
export class ParticleCluster {
  constructor({ color = '#34d399', seed = 0, texture, count = 64, radius = 0.72 } = {}) {
    this.group = new THREE.Group();
    this.color = new THREE.Color(color);
    this.seed = seed;
    this.count = Math.max(24, Math.min(count, 96));
    this.radius = radius;
    this.phase = new Float32Array(this.count);
    this.base = new Float32Array(this.count * 3);
    const positions = new Float32Array(this.count * 3);
    const colors = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const h = this.hash(i + 11);
      const phi = Math.acos(2 * this.hash(i + 23) - 1);
      const theta = this.hash(i + 37) * Math.PI * 2;
      const r = radius * (0.16 + Math.pow(this.hash(i + 53), 0.7) * 0.84);
      const x = Math.sin(phi) * Math.cos(theta) * r;
      const y = Math.cos(phi) * r * 0.82;
      const z = Math.sin(phi) * Math.sin(theta) * r;
      this.base.set([x, y, z], i * 3);
      this.phase[i] = h * Math.PI * 2;
      positions.set([x, y, z], i * 3);
      const c = this.color.clone().lerp(new THREE.Color('#ffffff'), 0.08 + h * 0.24);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.material = new THREE.PointsMaterial({
      size: 0.075, map: texture, vertexColors: true, transparent: true, opacity: 0.82,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    // Invisible, stable hit volume keeps interaction reliable while particles move.
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.12, 16, 10),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    this.group.add(this.mesh);
    this.mesh.userData.cluster = this;

    // One connected spanning membrane. Every cell participates, while a single
    // LineSegments draw call keeps the network cheaper than dozens of objects.
    this.networkSegments = 4;
    this.networkEdges = [];
    for (let index = 1; index < this.count; index++) {
      const parent = Math.floor(this.hash(index + 71) * index);
      this.networkEdges.push({ a: index, b: parent, phase: this.phase[index], bend: (this.hash(index + 91) - 0.5) * 0.24 });
    }
    const networkPositions = new Float32Array(this.networkEdges.length * this.networkSegments * 2 * 3);
    const networkGeometry = new THREE.BufferGeometry();
    networkGeometry.setAttribute('position', new THREE.BufferAttribute(networkPositions, 3));
    this.networkMaterial = new THREE.LineBasicMaterial({
      color: this.color, transparent: true, opacity: 0.27, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.network = new THREE.LineSegments(networkGeometry, this.networkMaterial);
    this.network.frustumCulled = false;
    this.group.add(this.network);
  }

  hash(n) {
    const x = Math.sin(n * 12.9898 + this.seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  update({ activity = 0, reduced = false, t = 0, delta = 0.016 } = {}) {
    const positions = this.points.geometry.attributes.position.array;
    const energy = Math.min(1.5, activity);
    for (let i = 0; i < this.count; i++) {
      const j = i * 3; const ph = this.phase[i];
      const amp = reduced ? 0.006 : 0.025 + energy * 0.025;
      positions[j] = this.base[j] + Math.sin(t * (0.65 + this.hash(i) * 0.7) + ph) * amp;
      positions[j + 1] = this.base[j + 1] + Math.cos(t * (0.52 + this.hash(i + 5) * 0.5) + ph) * amp;
      positions[j + 2] = this.base[j + 2] + Math.sin(t * 0.43 + ph * 1.7) * amp;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.material.opacity = 0.58 + energy * 0.22;
    this.material.size = 0.07 + energy * 0.018;
    const networkPositions = this.network.geometry.attributes.position.array;
    let cursor = 0;
    for (const edge of this.networkEdges) {
      const a = edge.a * 3, b = edge.b * 3;
      for (let segment = 0; segment < this.networkSegments; segment++) {
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const ratio = (segment + endpoint) / this.networkSegments;
          const arc = Math.sin(ratio * Math.PI) * edge.bend;
          networkPositions[cursor++] = THREE.MathUtils.lerp(positions[a], positions[b], ratio) + arc * Math.sin(edge.phase);
          networkPositions[cursor++] = THREE.MathUtils.lerp(positions[a + 1], positions[b + 1], ratio) + arc;
          networkPositions[cursor++] = THREE.MathUtils.lerp(positions[a + 2], positions[b + 2], ratio) + arc * Math.cos(edge.phase);
        }
      }
    }
    this.network.geometry.attributes.position.needsUpdate = true;
    this.networkMaterial.opacity = (0.14 + energy * 0.2) * (0.78 + 0.22 * Math.sin(t * 1.6 + this.seed));
    this.group.rotation.y += reduced ? 0 : delta * (0.018 + energy * 0.018);
  }

  dispose() {
    this.points.geometry.dispose(); this.material.dispose();
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.network.geometry.dispose(); this.networkMaterial.dispose();
    this.group.parent?.remove(this.group);
  }
}
