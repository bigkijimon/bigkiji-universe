import * as THREE from 'three';

// Particle-first BigKiji Core: a dark centre wrapped by a sparse, living
// accretion network.  No bitmap determines its silhouette; every visible
// strand is built from GPU points and reacts to measured app activity.
export class CoreAccretionField {
  constructor(scene, { count = 2400, radius = 3.9 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'bigkiji-core-accretion-field';
    this.group.rotation.x = -0.24;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    const palette = [new THREE.Color(0xf8fafc), new THREE.Color(0xffd36a), new THREE.Color(0x34d399)];

    for (let index = 0; index < count; index++) {
      const seed = (index * 0.61803398875) % 1;
      const arm = index % 7;
      const progress = Math.pow((index + 1) / count, 0.72);
      const r = 0.86 + progress * radius + Math.sin(index * 12.9898) * 0.075;
      const angle = arm * (Math.PI * 2 / 7) + progress * Math.PI * 7.2 + Math.sin(index * 0.137) * 0.22;
      const thickness = (Math.sin(index * 78.233) * 0.5 + 0.5) ** 2;
      positions[index * 3] = Math.cos(angle) * r;
      positions[index * 3 + 1] = (thickness - 0.5) * (0.12 + progress * 0.55) + Math.sin(angle * 2.2) * 0.055;
      positions[index * 3 + 2] = Math.sin(angle) * r * (0.72 + thickness * 0.12);
      const color = palette[index % palette.length].clone().lerp(new THREE.Color(0x061018), 0.18 + progress * 0.28);
      colors.set([color.r, color.g, color.b], index * 3);
      seeds[index] = seed;
      sizes[index] = 0.72 + (1 - progress) * 1.6 + seed * 0.9;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uActivity: { value: 0 },
        uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
        uReduced: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uActivity; uniform float uPixelRatio; uniform float uReduced;
        attribute float aSeed; attribute float aSize; varying vec3 vColor; varying float vAlpha;
        void main() {
          vec3 p = position;
          float ripple = sin(uTime * (0.12 + aSeed * 0.08) + aSeed * 37.0);
          p.y += ripple * 0.055 * (1.0 - uReduced);
          float pulse = 1.0 + uActivity * (0.06 + aSeed * 0.09);
          p.xz *= pulse;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(aSize * uPixelRatio * (7.0 / max(-mv.z, 1.0)) * (1.0 + uActivity * 0.65), 1.0, 13.0);
          gl_Position = projectionMatrix * mv;
          vColor = color;
          vAlpha = 0.34 + aSeed * 0.48 + uActivity * 0.16;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float glow = smoothstep(0.5, 0.0, d);
          float core = smoothstep(0.16, 0.0, d);
          float alpha = glow * vAlpha;
          gl_FragColor = vec4(vColor * (0.55 + glow + core * 1.8), alpha);
        }`,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    scene.add(this.group);
  }

  update(time, activity = 0, reduced = false, delta = 0.016) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uActivity.value = THREE.MathUtils.damp(this.material.uniforms.uActivity.value, Math.min(1.4, activity), 3.2, delta);
    this.material.uniforms.uReduced.value = reduced ? 1 : 0;
    if (!reduced) this.group.rotation.y += delta * (0.007 + activity * 0.003);
  }

  dispose() {
    this.scene.remove(this.group);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
