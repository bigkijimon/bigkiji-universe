import * as THREE from 'three';

// Organic file-cluster membrane. Geometry is built once per vault refresh;
// only shader uniforms and a small pulse phase are updated per frame.
export class ViralMembrane {
  constructor(scene, { color = '#34d399', maxStrands = 72 } = {}) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.color = new THREE.Color(color);
    this.maxStrands = maxStrands;
    this.materials = [];
    this.strands = [];
    this._buildUniforms();
  }

  _buildUniforms() {
    this.vertexShader = `
      uniform float uTime;
      uniform float uPulse;
      varying float vPhase;
      void main() {
        vPhase = position.y * 0.8;
        vec3 p = position;
        p.x += sin(uTime * 1.8 + position.y * 8.0) * 0.006 * uPulse;
        p.z += cos(uTime * 1.4 + position.y * 6.0) * 0.006 * uPulse;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`;
    this.fragmentShader = `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uOpacity;
      varying float vPhase;
      void main() {
        float pulse = 0.72 + 0.28 * sin(uTime * 2.2 + vPhase * 9.0);
        float edge = smoothstep(0.0, 0.18, gl_FrontFacing ? 1.0 : 0.0);
        gl_FragColor = vec4(uColor * (0.72 + pulse * 0.5), uOpacity * pulse * edge);
      }`;
  }

  addStrand(points, weight = 1) {
    if (!points || points.length < 2 || this.strands.length >= this.maxStrands) return;
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.55);
    const geometry = new THREE.TubeGeometry(curve, 12, 0.008 + Math.min(weight, 8) * 0.0015, 5, false);
    const uniforms = {
      uTime: { value: 0 }, uPulse: { value: 1 }, uOpacity: { value: 0 },
      uColor: { value: this.color.clone() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: this.vertexShader, fragmentShader: this.fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.materials.push(material);
    this.strands.push(mesh);
  }

  update(time, opacity = 1, boost = 0) {
    const value = Math.max(0, Math.min(1, opacity));
    for (const material of this.materials) {
      material.uniforms.uTime.value = time;
      material.uniforms.uOpacity.value = value * (0.52 + boost * 0.48);
      material.uniforms.uPulse.value = 1 + boost * 1.8;
    }
  }

  dispose() {
    for (const mesh of this.strands) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.strands.length = 0; this.materials.length = 0;
    this.group.parent?.remove(this.group);
  }
}
