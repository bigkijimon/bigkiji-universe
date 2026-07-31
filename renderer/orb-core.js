// BigKijiオーブ共有モジュール — VoiceOrb HeroScene.tsx から移植（vanilla Three.js化）
// 有機液体ブロブ: simplex FBM 3オクターブ変位 + 法線35:65ブレンド + ACES + 多層ハロー。
// BIGKIJI版はEventBusの実活動量(activity)が うねり/発光/流速 を駆動する。
import * as THREE from 'three';

const SNOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const ORB_VERTEX = SNOISE + /* glsl */ `
uniform float uTime; uniform float uAmp; uniform float uHover;
uniform float uPress; uniform float uRipple;
varying vec3 vNormal; varying vec3 vView;

float fbm(vec3 p){
  float n = 0.0;
  n += 0.70 * snoise(p * 1.05 + vec3(0.0, uTime * 0.22, uTime * 0.15)); // 大波・低速＝不気味な蠢き
  n += 0.22 * snoise(p * 2.60 + vec3(uTime * 0.33, 0.0, -uTime * 0.26));
  n += 0.10 * snoise(p * 5.20 + vec3(-uTime * 0.40, uTime * 0.36, 0.0));
  return n;
}
vec3 displace(vec3 pos){
  vec3 nr = normalize(pos);
  float d = fbm(nr) * uAmp;
  d += uHover * 0.016 * snoise(nr * 3.3 + vec3(0.0, uTime * 1.1, 0.0));
  float ang = acos(clamp(nr.z, -1.0, 1.0));
  d += uRipple * 0.026 * sin(ang * 8.0 - uTime * 3.4) * smoothstep(0.12, 0.7, ang);
  float facing = max(nr.z, 0.0);
  d -= uPress * 0.09 * pow(facing, 2.4);
  return pos + nr * d;
}
void main(){
  vec3 n0 = normalize(position);
  vec3 t0 = normalize(abs(n0.y) < 0.99 ? cross(n0, vec3(0.0,1.0,0.0)) : cross(n0, vec3(1.0,0.0,0.0)));
  vec3 b0 = normalize(cross(n0, t0));
  float e = 0.07;
  vec3 p  = displace(position);
  vec3 pt = displace(position + t0 * e);
  vec3 pb = displace(position + b0 * e);
  vec3 nBump = normalize(cross(pt - p, pb - p));
  vec3 nrm = normalize(mix(n0, nBump, 0.35)); // fresnel構造を保つ35%混合
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * nrm);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const ORB_FRAGMENT = /* glsl */ `
#include <common>
#include <dithering_pars_fragment>
uniform vec3 uColorDeep; uniform vec3 uColorSurface;
uniform float uGlow; uniform float uTime; uniform float uHover; uniform float uHole;
varying vec3 vNormal; varying vec3 vView;
void main(){
  vec3 viewDir = normalize(vView);
  vec3 n = normalize(vNormal);
  float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 2.6);
  // 体は闇に沈み、縁だけが強く発光する（不気味・神秘）
  vec3 col = mix(uColorDeep, uColorSurface, fres * 0.8);
  col += uColorSurface * fres * uGlow * 0.85;
  col += uColorSurface * (n.y * 0.5 + 0.5) * 0.025 * uGlow;
  // 表面を這う脈（鋭い明帯が蠢く）
  float band = sin(n.x*2.4 + uTime*0.34) * sin(n.y*3.1 - uTime*0.27) * sin(n.z*2.1 + uTime*0.31);
  float vein = pow(abs(band), 3.0);
  col += uColorSurface * vein * 0.24 * uGlow;
  // 強い虹彩リム（ゆっくり色相が回る）
  vec3 iri = 0.5 + 0.5 * cos(6.2832 * (fres * 2.2 + uTime * 0.03) + vec3(0.0, 2.094, 4.188));
  col += iri * pow(fres, 2.4) * 0.26 * (0.5 + 0.5 * uGlow);
  // 中心は暗い瞳（覗き込まれているような奥行き）
  float core = pow(max(dot(viewDir, n), 0.0), 2.2);
  col *= 1.0 - core * 0.48;
  col += mix(uColorDeep, uColorSurface, 0.3) * core * 0.07 * uGlow;
  col += uColorSurface * core * 0.08 * uHover;
  // ブラックホール様式(uHole=1): 事象の地平線＝中心は完全な闇・縁は光子リングとして白熱
  float photon = pow(fres, 4.0);
  vec3 hole = uColorSurface * photon * (1.9 + uGlow * 1.5);
  hole += vec3(1.0, 0.97, 0.88) * pow(fres, 9.0) * 2.4; // 内縁の白熱
  hole += iri * pow(fres, 3.0) * 0.35;                   // リングに虹彩の揺らめき
  hole += uColorSurface * vein * fres * 0.10;            // 地平線ぎわの脈だけ微かに
  col = mix(col, hole, uHole);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}`;

const ATMO_VERTEX = /* glsl */ `
varying vec3 vNormal;
void main(){
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMO_FRAGMENT = /* glsl */ `
#include <common>
#include <dithering_pars_fragment>
uniform vec3 uColor; uniform float uGlow; uniform float uIntensity;
varying vec3 vNormal;
void main(){
  float i = pow(0.62 - dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 2.0);
  i = clamp(i, 0.0, 1.0) * uIntensity;
  gl_FragColor = vec4(uColor * i * uGlow, i * uGlow);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}`;

// BigKijiエメラルド（深部/表層）— VoiceOrbの2色ペア方式
export const EMERALD = { deep: '#03120c', surface: '#3fe3a8', ring: '#34d399' }; // 深部はほぼ闇

// 降着円盤シェーダ: UV回転はシェーダ内(uSpin)で行い、メッシュ自体は回転させない。
// これによりドップラービーミング（視線へ向かって回り込む側の増光）が画面に対して固定され、
// 「円盤は回るのに明るい側は動かない」実物のブラックホール撮像と同じ見え方になる。
const DISK_VERTEX = /* glsl */ `
varying vec2 vUv; varying vec3 vWorld;
void main(){
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const DISK_FRAGMENT = /* glsl */ `
#include <common>
uniform sampler2D uMap; uniform float uSpin; uniform float uOpa; uniform float uDop;
uniform vec3 uCamPos; uniform vec3 uCenter; uniform vec3 uAxis; uniform vec3 uTint;
uniform float uInGeo; uniform float uTexIn;
varying vec2 vUv; varying vec3 vWorld;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x) - uSpin;
  // 半径リマップ: リング形状の内周(uInGeo)→テクスチャの白熱内縁(uTexIn)を対応させる。
  // これが無いと写実テクスチャの白熱リムが形状の穴の内側に隠れて見えない（実測）
  float rN = clamp((r - uInGeo) / (1.0 - uInGeo), 0.0, 1.0);
  float rT = mix(uTexIn, 1.0, rN);
  vec2 uv2 = vec2(cos(ang), sin(ang)) * rT * 0.5 + 0.5;
  vec3 col = texture2D(uMap, uv2).rgb * uTint;
  vec3 tang = normalize(cross(uAxis, vWorld - uCenter) + vec3(1e-4));
  float d = dot(tang, normalize(uCamPos - vWorld));
  col *= 1.0 + uDop * d;                                                  // 接近側の増光（ビーミング近似）
  col = mix(col, col * vec3(1.05, 0.90, 0.80), clamp(-d, 0.0, 1.0) * 0.6); // 後退側は赤方偏移ぎみに
  gl_FragColor = vec4(col, uOpa);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// レンズ湾曲アーク: カメラ正対のリングで「遠側円盤が地平線の上下に折れて見える」
// Interstellar的な重力レンズ像を近似する。横方向は実円盤があるので上下だけ出す。
const LENS_FRAGMENT = /* glsl */ `
#include <common>
uniform sampler2D uMap; uniform float uSpin; uniform float uOpa; uniform vec3 uTint; uniform float uIn;
varying vec2 vUv; varying vec3 vWorld;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);
  float rn = clamp((r - uIn) / (1.0 - uIn), 0.0, 1.0);
  float ang = atan(dir.y, dir.x) - uSpin * 0.7;
  vec2 uv2 = vec2(cos(ang), sin(ang)) * mix(0.16, 0.26, rn) + 0.5;         // 円盤の高温域をサンプル
  vec3 col = texture2D(uMap, uv2).rgb * uTint * (1.2 + (1.0 - rn) * 0.8);
  float arc = pow(abs(dir.y), 1.35);
  float fade = sin(rn * 3.14159);
  gl_FragColor = vec4(col, arc * fade * uOpa * 0.85);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const _AX = new THREE.Vector3();

// 降着円盤テクスチャ: ComfyUI生成アセットがあればそれを使い、無ければプロシージャル
// （角度方向の細いストリークをリング状に散らす）で即席生成する。
function accretionTexture(colorHex) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const col = new THREE.Color(colorHex);
  g.translate(256, 256);
  for (let i = 0; i < 2600; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 120 + Math.pow(Math.random(), 1.6) * 120;
    const len = 0.05 + Math.random() * 0.22;
    const heat = Math.max(0, 1 - (r - 120) / 120); // 内側ほど白熱
    const cc = col.clone().lerp(new THREE.Color('#fff7e0'), heat * 0.75);
    g.strokeStyle = `rgba(${cc.r * 255 | 0},${cc.g * 255 | 0},${cc.b * 255 | 0},${(0.12 + Math.random() * 0.3) * (0.5 + heat)})`;
    g.lineWidth = 0.8 + Math.random() * 2.0;
    g.beginPath(); g.arc(0, 0, r, a, a + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// Optional ComfyUI/Wan loop input. The static accretion texture remains the
// deterministic fallback; a video is only attached when an explicit asset is
// present under renderer/assets/loops/.
function makeVideoTexture(url) {
  const video = document.createElement('video');
  video.src = url; video.muted = true; video.loop = true; video.autoplay = true;
  video.playsInline = true; video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;inset:-1px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);
  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  video.play().catch(() => {});
  return { video, tex };
}

export function buildOrbGroup({ segments = 160, ringRadius = 1.42, ring = true, colors = EMERALD, seed = 0, baseScale = 1, style = 'orb', diskTexUrl = null, tint = null } = {}) {
  const group = new THREE.Group();
  const isHole = style === 'blackhole';
  const uniforms = {
    uTime: { value: seed }, uAmp: { value: 0.05 },
    uColorDeep: { value: new THREE.Color(colors.deep) },
    uColorSurface: { value: new THREE.Color(colors.surface) },
    uGlow: { value: 0.5 }, uHover: { value: 0 }, uPress: { value: 0 }, uRipple: { value: 0 },
    uHole: { value: isHole ? 1 : 0 },
  };
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(1, segments, segments),
    new THREE.ShaderMaterial({ uniforms, vertexShader: ORB_VERTEX, fragmentShader: ORB_FRAGMENT, dithering: true })
  );
  group.add(orb);

  // 多層ブルーム: 内殻1.32x(0.8) / 外殻1.7x(0.32) / 最外殻2.15x(0.16)
  // ミニBH（segments小）ではハローも同解像度に落として8体ぶんの頂点負荷を抑える
  const atmoUniforms = [];
  for (const [scale, seg, intensity] of [[1.32, Math.min(96, segments), 0.8], [1.7, Math.min(64, segments), 0.32], [2.15, Math.min(48, segments), 0.16]]) {
    const au = {
      uColor: { value: new THREE.Color(colors.surface) },
      uGlow: { value: 0.5 }, uIntensity: { value: intensity },
    };
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1, seg, seg),
      new THREE.ShaderMaterial({
        uniforms: au, vertexShader: ATMO_VERTEX, fragmentShader: ATMO_FRAGMENT,
        side: THREE.BackSide, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, dithering: true,
      })
    );
    halo.scale.setScalar(scale);
    atmoUniforms.push(au);
    group.add(halo);
  }

  // 外周ヘアラインリング（惑星ノードでは省略可）
  let ringMesh = null;
  if (ring) {
    ringMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ringRadius, 64, 32),
      new THREE.MeshBasicMaterial({ color: colors.ring || colors.surface, transparent: true, opacity: 0.55 })
    );
    group.add(ringMesh);
  }

  // 降着円盤（ブラックホール様式のみ）: シェーダ円盤＋レンズ湾曲アーク。
  // メッシュは静止させ回転はuSpin（ドップラー増光を画面に固定するため）。
  let disk = null, lens = null, diskU = null, videoInput = null;
  if (isHole) {
    const tintCol = new THREE.Color(tint || '#ffffff');
    diskU = {
      uMap: { value: accretionTexture(colors.surface) },
      uSpin: { value: seed }, uOpa: { value: 0.5 }, uDop: { value: 0.85 },
      uCamPos: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector3() },
      uAxis: { value: new THREE.Vector3(0, 1, 0) }, uTint: { value: tintCol },
      uInGeo: { value: 1.22 / 2.05 }, uTexIn: { value: 0.28 }, // 形状内周→テクスチャ白熱内縁の対応
    };
    if (diskTexUrl) {
      new THREE.TextureLoader().load(diskTexUrl, (tex) => { tex.anisotropy = 4; diskU.uMap.value = tex; });
    }
    disk = new THREE.Mesh(
      new THREE.RingGeometry(1.22, 2.05, 96, 1),
      new THREE.ShaderMaterial({
        uniforms: diskU, vertexShader: DISK_VERTEX, fragmentShader: DISK_FRAGMENT,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    disk.rotation.x = Math.PI / 2 - 0.42; // 傾いた円盤
    disk.rotation.y = 0.12;
    group.add(disk);
    // レンズアーク: 地平線シルエットの外周（内径>1）だけを覆う正対リング → 球に隠れない
    const lensU = { uMap: diskU.uMap, uSpin: diskU.uSpin, uOpa: diskU.uOpa, uTint: diskU.uTint, uIn: { value: 1.05 / 1.55 } };
    lens = new THREE.Mesh(
      new THREE.RingGeometry(1.05, 1.55, 64, 1),
      new THREE.ShaderMaterial({
        uniforms: lensU, vertexShader: DISK_VERTEX, fragmentShader: LENS_FRAGMENT,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    group.add(lens);
  }

  function setDiskVideo(url) {
    if (!diskU || !url || videoInput?.video?.src === url) return false;
    if (videoInput) { videoInput.video.pause(); videoInput.video.remove(); videoInput.tex.dispose(); }
    videoInput = makeVideoTexture(url);
    diskU.uMap.value = videoInput.tex;
    return true;
  }

  const sim = { scale: 0.95, hover: 0, press: 0, pressV: 0, flow: 1, flowT: seed };

  // 毎フレーム更新。state = { activity(0..1.5), hover(bool), pressed(bool), reduced(bool), t, delta, camera? }
  // camera を渡すとドップラー増光の視線・レンズアークの正対が実カメラに追従する
  function update({ activity = 0, hover = false, pressed = false, reduced = false, t = 0, delta = 0.016, camera = null }) {
    const a = Math.min(activity, 1.5);

    // ノイズ流速: 活動量で速く煮える（実データ駆動）
    sim.flow = THREE.MathUtils.damp(sim.flow, 1.0 + a * 0.7, 5, delta);
    if (!reduced) { sim.flowT += delta * sim.flow; uniforms.uTime.value = sim.flowT; }

    sim.hover = THREE.MathUtils.damp(sim.hover, hover ? 1 : 0, 14, delta);
    uniforms.uHover.value = reduced ? (hover || pressed ? 1 : 0) : sim.hover;

    // press: スプリング積分 k=380 c=20（離すと「ぷにっ」と反発）
    const dt = Math.min(delta, 0.033);
    const pressTarget = !reduced && pressed ? 1 : 0;
    sim.pressV += (-(sim.press - pressTarget) * 380 - sim.pressV * 20) * dt;
    sim.press += sim.pressV * dt;
    uniforms.uPress.value = reduced ? 0 : sim.press;

    // うねり主振幅: 静穏0.055 → 高活動0.19（ブラックホールは地平線を保つため半減）
    uniforms.uAmp.value = THREE.MathUtils.damp(
      uniforms.uAmp.value, (reduced ? 0 : 0.055 + a * 0.09 + sim.hover * 0.015) * (isHole ? 0.5 : 1), 10, delta);

    // 降着円盤: アイドルでも静かに自転し、活動量で回転と輝度が上がる（実データ駆動）
    if (disk && !reduced) {
      diskU.uSpin.value += delta * (0.35 + a * 1.7);
      diskU.uOpa.value = 0.5 + Math.min(a, 1) * 0.42 + sim.hover * 0.08; // 写実円盤はアイドルでも主役級に見せる
    }
    if (disk && camera) {
      diskU.uCamPos.value.copy(camera.position);
      group.getWorldPosition(diskU.uCenter.value);
      disk.updateWorldMatrix(true, false);
      diskU.uAxis.value.copy(_AX.set(0, 0, 1).transformDirection(disk.matrixWorld));
      lens.quaternion.copy(camera.quaternion); // レンズ像は常にカメラ正対（groupは無回転が前提）
    }

    // 放射同心波: 活動の波及を薄く（実イベントが流れている時だけ）
    uniforms.uRipple.value = THREE.MathUtils.damp(
      uniforms.uRipple.value, reduced ? 0 : a * 0.25, 7, delta);

    // グロー: 4s発光呼吸 + 活動量 + hover
    let glowTarget = reduced ? 0.6
      : 0.5 + 0.07 * Math.sin(t * (Math.PI * 2 / 4)) + a * 0.26;
    glowTarget += (reduced ? (hover || pressed ? 1 : 0) : sim.hover) * 0.1;
    uniforms.uGlow.value = THREE.MathUtils.damp(uniforms.uGlow.value, Math.min(glowTarget, 0.92), 12, delta);
    for (const au of atmoUniforms) au.uGlow.value = uniforms.uGlow.value;

    // スケール: 4s呼吸(1→1.02) + 活動微脈動 + hover1.5% + press凹み
    const breath = !reduced ? 0.01 + 0.01 * Math.sin(t * (Math.PI * 2 / 4)) : 0;
    const target = (1 + breath + (reduced ? 0 : a * 0.02 + sim.hover * 0.015)) * (reduced ? 1 : 1 - sim.press * 0.03);
    sim.scale = THREE.MathUtils.damp(sim.scale, target, 11, delta);
    group.scale.setScalar(sim.scale * baseScale); // baseScale=惑星サイズ等の基準倍率（呼吸はその上に乗る）
  }

  return { group, update, uniforms, ring: ringMesh, mesh: orb, disk, lens, setDiskVideo };
}

// 単体マウント（tray用）: 専用renderer+camera+ループ+ポインタ操作つき
export function mountOrb(container, { segments = 160, onClick, style = 'blackhole' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 3)); // DPR上限3（“4K”精細）
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.cssText = 'position:absolute;inset:0;';
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 0, 4.35);

  const orb = buildOrbGroup({ segments, style, diskTexUrl: './assets/accretion.png' }); // ComfyUI生成円盤
  scene.add(orb.group);

  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  let activity = 0, hover = false, pressed = false, running = true;

  container.addEventListener('pointerenter', () => { hover = true; });
  container.addEventListener('pointerleave', () => { hover = false; pressed = false; });
  container.addEventListener('pointerdown', () => { pressed = true; });
  container.addEventListener('pointerup', () => {
    if (pressed && onClick) onClick();
    pressed = false;
  });

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const clock = new THREE.Clock();
  (function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    if (document.hidden) { clock.getDelta(); return; } // 非表示中は描画停止（rAF自体もOSが抑制）
    const delta = clock.getDelta();
    const t = clock.getElapsedTime();
    activity *= 0.972; // 実イベントが止まれば静まる
    orb.update({ activity, hover, pressed, reduced: reducedMq.matches, t, delta, camera });
    renderer.render(scene, camera);
  })();

  return {
    spike(v = 0.5) { activity = Math.min(activity + v, 1.5); },
    dispose() { running = false; renderer.dispose(); },
  };
}
