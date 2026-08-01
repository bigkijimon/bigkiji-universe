import * as THREE from 'three';

const VERT = /* glsl */ `
uniform float uTime;
attribute vec3 iOrigin;
attribute vec3 iVelocity;
attribute vec3 iColor;
attribute float iBorn;
attribute float iLife;
attribute float iSeed;
attribute float iSize;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main(){
  float age = iLife > 0.0 ? (uTime - iBorn) / iLife : 2.0;
  float alive = step(0.0, age) * step(age, 1.0);
  float fade = (1.0 - age) * (1.0 - age);
  float flick = 0.7 + 0.3 * sin(uTime * (22.0 + iSeed * 13.0) + iSeed * 31.0);
  vec3 noise = vec3(
    sin(age * 8.0 + iSeed * 17.0),
    cos(age * 11.0 + iSeed * 23.0),
    sin(age * 7.0 + iSeed * 37.0)
  ) * age * age * 0.075;
  vec3 world = iOrigin + iVelocity * (age * iLife) + noise;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float scale = iSize * mix(1.0, 0.1, age) * (0.82 + flick * 0.18) * alive;
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vColor = mix(vec3(1.0, 0.965, 0.835), mix(vec3(1.0, 0.48, 0.10), iColor, 0.34), smoothstep(0.12, 0.9, iSeed));
  vAlpha = max(0.0, fade * flick * alive);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main(){
  vec2 p = vUv - 0.5;
  float core = smoothstep(0.5, 0.02, length(vec2(p.x * 0.65, p.y)));
  float streak = smoothstep(0.5, 0.0, abs(p.y)) * smoothstep(0.56, 0.05, abs(p.x));
  float alpha = max(core, streak * 0.42) * vAlpha;
  if(alpha < 0.012) discard;
  gl_FragColor = vec4(vColor * (1.25 + core * 1.8), alpha);
}`;

const lineDistance = (point, start, end, scratchLine, scratchPoint) => {
  scratchLine.set(start, end);
  scratchLine.closestPointToPoint(point, true, scratchPoint);
  return scratchPoint.distanceTo(point);
};

export class SynapseSparkShedder {
  constructor(scene, { capacity = 768 } = {}) {
    this.scene = scene;
    this.capacity = capacity;
    this.cursor = 0;
    this.time = 0;
    this.strands = [];
    this.seen = new Set();
    this.line = new THREE.Line3();
    this.closest = new THREE.Vector3();
    this.build();
  }

  build() {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -0.34, 0, 1, -0.34, 0, 1, 0.34, 0, -1, 0.34, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = {
      origin: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3),
      velocity: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3),
      color: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3),
      born: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity).fill(-1000), 1),
      life: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1),
      seed: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1),
      size: new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1),
    };
    geometry.setAttribute('iOrigin', this.attrs.origin);
    geometry.setAttribute('iVelocity', this.attrs.velocity);
    geometry.setAttribute('iColor', this.attrs.color);
    geometry.setAttribute('iBorn', this.attrs.born);
    geometry.setAttribute('iLife', this.attrs.life);
    geometry.setAttribute('iSeed', this.attrs.seed);
    geometry.setAttribute('iSize', this.attrs.size);
    geometry.instanceCount = this.capacity;
    this.uniforms = { uTime: { value: 0 } };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.scene.add(this.mesh);
  }

  registerStrand(id, getStart, getEnd, onSympathy) {
    this.strands.push({ id, getStart, getEnd, onSympathy });
  }

  emit({ start, end, color = '#34d399', intensity = 1, eventId = '', sourceId = '', reduced = false, performanceTier = 0 } = {}) {
    if (!start || !end || performanceTier >= 2) return 0;
    if (eventId && this.seen.has(eventId)) return 0;
    if (eventId) {
      this.seen.add(eventId);
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    }
    const from = start.clone(); const to = end.clone();
    const midpoint = from.clone().lerp(to, 0.5);
    midpoint.y += Math.min(0.34, from.distanceTo(to) * 0.045);
    const curve = new THREE.CatmullRomCurve3([from, midpoint, to], false, 'centripetal', 0.5);
    const count = reduced ? 2 : Math.max(4, Math.min(performanceTier === 1 ? 12 : 24, Math.round(6 + intensity * 8)));
    const tint = new THREE.Color(color);
    let sympathyChecked = false;
    for (let index = 0; index < count; index++) {
      const seed = Math.random();
      const along = 0.18 + Math.random() * 0.74;
      const origin = curve.getPointAt(along);
      const tangent = curve.getTangentAt(along).normalize();
      const life = 0.45 + Math.random() * 0.95;
      const speed = 0.18 + Math.random() * 0.68;
      const velocity = tangent.multiplyScalar(-speed * (0.55 + Math.random() * 0.45));
      velocity.add(new THREE.Vector3((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.22, (Math.random() - 0.5) * 0.25));
      const forward = curve.getTangentAt(along).normalize();
      if (velocity.dot(forward) > -0.03) velocity.addScaledVector(forward, -0.16);
      this.write(this.cursor, origin, velocity, tint, life, seed, 0.034 + Math.random() * 0.055);
      this.cursor = (this.cursor + 1) % this.capacity;
      if (!sympathyChecked && along > 0.3) {
        sympathyChecked = this.triggerSympathy(origin, velocity, life, sourceId);
      }
    }
    for (const attribute of Object.values(this.attrs)) attribute.needsUpdate = true;
    return count;
  }

  write(index, origin, velocity, color, life, seed, size) {
    this.attrs.origin.setXYZ(index, origin.x, origin.y, origin.z);
    this.attrs.velocity.setXYZ(index, velocity.x, velocity.y, velocity.z);
    this.attrs.color.setXYZ(index, color.r, color.g, color.b);
    this.attrs.born.setX(index, this.time);
    this.attrs.life.setX(index, life);
    this.attrs.seed.setX(index, seed);
    this.attrs.size.setX(index, size);
  }

  triggerSympathy(origin, velocity, life, sourceId) {
    const projected = origin.clone().addScaledVector(velocity, life * 0.7);
    for (const strand of this.strands) {
      if (strand.id === sourceId) continue;
      const start = strand.getStart?.(); const end = strand.getEnd?.();
      if (!start || !end) continue;
      const d = Math.min(lineDistance(origin, start, end, this.line, this.closest), lineDistance(projected, start, end, this.line, this.closest));
      if (d < 0.42) { strand.onSympathy?.(Math.max(0.18, 1 - d / 0.42)); return true; }
    }
    return false;
  }

  update(time) { this.time = time; this.uniforms.uTime.value = time; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.strands.length = 0;
  }
}
