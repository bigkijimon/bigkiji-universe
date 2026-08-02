// オーケストレーション・シナプスキャンバス v3
// 3層LOD（銀河 / 惑星系 / 博物館）+ 軌道沿いデュプレックス光流 + 実測トークンフロー。
// ログ・統計・プレート・ポップアップはすべて実データ（正直なコックピット）。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildOrbGroup } from './orb-core.js';
import { CoreInflowSynapse } from './core-inflow-synapse.js';
import { Roadmap3D } from './roadmap-3d.js';
import { ViralMembrane } from '../shaders/viral-membrane.js';
import { FileDetailPopup } from '../../../components/UI/file-detail-popup.js';
import { ParticleCluster } from './particle-cluster.js';
import { SmoothFocusController, zoomAroundPoint } from './camera-controls.js';
import { TelemetryStore } from '../../telemetry/components/telemetry-store.js';
import { RightTelemetryPanel } from '../../telemetry/components/right-telemetry-panel.js';
import { SynapseSparkShedder } from '../shaders/synapse-spark-shedder.js';
import { radialShellPoint, fibonacciLeafPoint } from './radial-folder-geometry.js';
import { ActiveAIModelsFleet } from '../../hud/components/active-ai-models-fleet.js';
import { HybridOrbitController } from './hybrid-orbit-controller.js';
import { RelationshipField } from './relationship-field.js';
import { CoreAccretionField } from '../shaders/core-accretion-field.js';
import { CoreRingMorph } from './core-ring-morph.js';

const wrap = document.getElementById('canvasWrap');
const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
const telemetryStore = new TelemetryStore({ limit: 120 });
const fleetBox = new ActiveAIModelsFleet({ root: document.getElementById('fleetHud') });
let roadmap3d = null;
window.bigkiji.onModelStatus?.((snapshot) => fleetBox.update(snapshot));
window.bigkiji.modelStatusSnapshot?.().then((snapshot) => fleetBox.update(snapshot)).catch(() => {});
let generatedMedia = null;
function applyGeneratedAsset(assetUrl, mime = '') {
  if (!assetUrl) return;
  generatedMedia?.remove();
  const video = /^video\//.test(mime) || /\.(mp4|webm)(?:$|\?)/i.test(assetUrl);
  const element = document.createElement(video ? 'video' : 'img');
  element.className = 'generated-hud-media';
  element.src = assetUrl;
  if (video) { element.autoplay = true; element.loop = true; element.muted = true; element.playsInline = true; }
  element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;mix-blend-mode:screen;opacity:.2;';
  document.getElementById('bgField').appendChild(element);
  generatedMedia = element;
}
const telemetryPanel = new RightTelemetryPanel({
  store: telemetryStore,
  root: document.getElementById('telemetryHud'),
  mirror: document.getElementById('telemetryMirror'),
  onComfyRetry: () => window.bigkiji.comfyStatus?.(),
  onComfyCancel: () => {
    const jobId = telemetryStore.snapshot().comfy.jobId;
    if (jobId) window.bigkiji.comfyCancel?.(jobId);
  },
  onApplyAsset: () => {
    const comfy = telemetryStore.snapshot().comfy;
    applyGeneratedAsset(comfy.assetUrl, comfy.mime);
  },
});
window.bigkiji.onComfyEvent?.((event) => {
  telemetryStore.setComfy(event);
  if (event.state === 'completed' && event.target === 'canvas-background') applyGeneratedAsset(event.assetUrl, event.mime);
});
window.bigkiji.comfyStatus?.().then((state) => telemetryStore.setComfy(state)).catch(() => {});
window.bigkiji.onTaskEvent((task) => { telemetryStore.upsertTask(task); roadmap3d?.ingestTask(task); });
window.bigkiji.onRunEvent((run) => telemetryStore.upsertRun(run));
window.bigkiji.onTaskLog((log) => telemetryStore.ingest({ ...log, source: log.provider || 'task', kind: 'exec' }, 'task-log'));

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 3)); // “4K”精細（オーナー指示）
renderer.toneMapping = THREE.ACESFilmicToneMapping;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05080f, 0.02);
const relationshipField = new RelationshipField(scene, { maxEdges: 180 });
window.bigkiji.onRelationshipSnapshot?.((snapshot) => {
  if (snapshot.state === 'ready') relationshipField.setSnapshot(snapshot);
});
window.bigkiji.relationshipSnapshot?.().then((snapshot) => {
  if (snapshot.state === 'ready') relationshipField.setSnapshot(snapshot);
}).catch(() => {});
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
// 既定＝惑星系（v9反転・オーナー指定）。拡大するとファイル銀河→博物館が展開。
// #mid=ファイル銀河 / #near=博物館（検証用プリセット）
if (location.hash === '#mid') camera.position.set(0, 2.6, 6.0);
else if (location.hash === '#near') camera.position.set(0, 2.0, 4.8);
else if (location.hash === '#side') camera.position.set(4.6, 2.2, 3.4); // 会社惑星の足元カスケード検証用
else camera.position.set(0, 4.5, 10.5);

const controls = new OrbitControls(camera, renderer.domElement);
const hybridOrbit = new HybridOrbitController();
controls.enableDamping = false; // input stops immediately: no motion-sickness inertia
// Motion-safe camera: no ambient drift or rotation. Explicit cluster/file
// focus, cursor-centred wheel zoom and the three view buttons may move it.
controls.autoRotate = false;
controls.enableRotate = true;
controls.enablePan = true;
controls.enableZoom = true; // pinch zoom; wheel is overridden below to anchor at the pointer
controls.rotateSpeed = 0.42;
controls.panSpeed = 0.58;
controls.zoomSpeed = 0.72;
controls.screenSpacePanning = true;
controls.minDistance = 2.6; controls.maxDistance = 34;

// ---------- テクスチャ/ラベル ----------
function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function ringTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
  return new THREE.CanvasTexture(c);
}
// ラベル: SWはフォント（太いコンデンス体）と色（黄）だけ真似る。グロー等の装飾は付けない（オーナー指示）
const SW_YELLOW = '#FFE81F';
function drawLabel(c, g, text, { glyph, glyphColor, size = 34, sub = '' } = {}) {
  g.clearRect(0, 0, 512, 200);
  g.textAlign = 'center';
  g.shadowBlur = 0;
  if (glyph) {
    g.font = '58px -apple-system';
    g.fillStyle = 'rgba(240,250,245,0.95)';
    g.fillText(glyph, 256, 66);
  }
  g.font = `800 ${size}px "Arial Narrow", "Helvetica Neue", -apple-system, sans-serif`;
  try { g.letterSpacing = '3px'; } catch (_) {}
  g.fillStyle = SW_YELLOW;
  g.fillText(text.toUpperCase(), 256, sub ? 128 : 148);
  if (sub) {
    g.font = '500 21px "SF Mono", Menlo, monospace';
    try { g.letterSpacing = '2px'; } catch (_) {}
    g.fillStyle = 'rgba(222,246,236,0.88)';
    g.fillText(sub, 256, 170);
  }
}
function labelSprite(text, opts = {}) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 200;
  const g = c.getContext('2d');
  drawLabel(c, g, text, opts);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, depthTest: false,
  }));
  s.renderOrder = 20;
  s.scale.set(2.7, 1.05, 1);
  s.userData.lbl = { c, g, text, opts, sub: '' };
  return s;
}
// ラベル2行目（実測の活動・トークン量）を差し替え描画
function setLabelSub(s, sub) {
  const L = s.userData.lbl;
  if (!L || L.sub === sub) return;
  L.sub = sub;
  drawLabel(L.c, L.g, L.text, { ...L.opts, sub });
  s.material.map.needsUpdate = true;
}
const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n | 0);

// ---------- ファイル銀河: 各惑星の足元に3層の放射状フォルダコロニー ----------
// 中心親コア → Shell 1(L1) → Shell 2(L2) → Shell 3(実ファイル)。
// パスhashによる決定的な球面分布なので再スキャン時にも位置が飛ばない。
const COMPANY_TO_AGENT = {
  English_School: 'marble', Creative_Media: 'justin', Design_Studio: 'risa', LocalAI: 'biglama',
};
const fileClouds = {}; // key(agentId|'core') → { grp, points, ptsMat, hubMat, edgeMat, files, leafHub, flow }
const galaxyState = { map: {}, pointsList: [], count: 0 };
const hash01 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 1000; };
// 丸い発光粒テクスチャ（四角い素のPointsをやめ、柔らかい光点に）
const roundTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
function disposeObject(root) {
  root?.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
    else object.material?.dispose?.();
  });
  root?.parent?.remove(root);
}
function clearFileGalaxy() {
  for (const key in fileClouds) {
    const cloud = fileClouds[key];
    cloud.membrane?.dispose();
    disposeObject(cloud.rootLink?.obj);
    disposeObject(cloud.grp);
    delete fileClouds[key];
  }
  galaxyState.map = {};
  galaxyState.pointsList = [];
  galaxyState.count = 0;
}
function buildFileGalaxy(files) {
  if (!files) return;
  if (!files.length) { clearFileGalaxy(); return; }
  // mtime/size-only updates are common during coding. Keep existing GPU
  // geometry when the path set is unchanged; rebuilding thousands of tubes on
  // every save was the main renderer-side interaction stall.
  if (galaxyState.count === files.length && files.every((file) => galaxyState.map[file.p])) {
    const updates = new Map(files.map((file) => [file.p, file]));
    for (const cloud of Object.values(fileClouds)) {
      cloud.files.forEach((file, index) => { cloud.files[index] = updates.get(file.p) || file; });
      cloud.points.userData.files = cloud.files;
    }
    return;
  }
  clearFileGalaxy();
  galaxyState.count = files.length;
  const groups = {};
  for (const f of files) {
    const key = COMPANY_TO_AGENT[f.c] || 'core';
    (groups[key] = groups[key] || []).push(f);
  }
  for (const key in groups) buildCloud(key, groups[key]);
}

// 1つの雲＝1惑星（or Core）の足元のディレクトリ階層ミニ銀河（ローカル座標・grpごと惑星に追従）
function buildCloud(key, files) {
  const isCore = key === 'core';
  // Real file particles need breathing room. The previous radii visually
  // collapsed unrelated paths into one bright knot.
  const R = isCore ? 2.75 : 1.72;
  const d0 = isCore ? 0 : 1;     // 階層の起点（Core雲はparts[0]=会社名がL1になる）
  const grp = new THREE.Group();
  scene.add(grp);
  const center = new THREE.Vector3(0, 0, 0);
  const N = files.length;
  const order = files.map((_, i) => i).sort((a, b) => files[b].t - files[a].t);
  const rank = new Array(N);
  order.forEach((fi, r) => { rank[fi] = r / N; });

  // 階層ハブ位置: L1/L2を別々の球殻へ置く。Yは上下対称にし、旧来の
  // 「indexが増えるほど下へ垂れる」ツリー構造を作らない。
  const hub = {}; // hubKey → THREE.Vector3
  const hubFiles = {}; // hubKey → 配下ファイル数（=関係の濃さ。幹線の本数に反映）
  const hubOf = (f) => {
    const parts = f.p.split('/');
    let h1 = null, h2 = null;
    if (parts.length > d0 + 1) h1 = parts.slice(0, d0 + 1).join('/');
    if (parts.length > d0 + 2) h2 = parts.slice(0, d0 + 2).join('/');
    if (h1) hubFiles[h1] = (hubFiles[h1] || 0) + 1;
    if (h2) hubFiles[h2] = (hubFiles[h2] || 0) + 1;
    if (h1 && !hub[h1]) {
      hub[h1] = radialShellPoint(h1, 1, R, 0.68);
      hub[h1].userData = { depth: 1, c: f.c };
    }
    if (h2 && !hub[h2]) {
      hub[h2] = radialShellPoint(h2, 2, R, 0.62);
      hub[h2].userData = { depth: 2, c: f.c };
    }
    return hub[h2] || hub[h1] || null;
  };

  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const basePos = new Float32Array(N * 3), motion = new Float32Array(N * 3);
  const leafHub = new Array(N);
  files.forEach((f, i) => {
    const h = hubOf(f);
    leafHub[i] = h;
    // 葉は最外殻へFibonacci風に分散。階層は筋繊維で読み、座標自体は
    // 垂直方向に並べない。わずかな扁平率で銀河ディスクのリップル感を残す。
    const ordered = rank[i] * Math.max(N - 1, 1);
    const leafPoint = fibonacciLeafPoint(ordered, N, f.p, R);
    const { x, y, z } = leafPoint;
    pos.set([x, y, z], i * 3);
    basePos.set([x, y, z], i * 3);
    motion.set([
      hash01(f.p + ':phase') * Math.PI * 2,
      0.11 + hash01(f.p + ':speed') * 0.19,
      R * (0.035 + hash01(f.p + ':drift') * 0.045),
    ], i * 3);
    const c = new THREE.Color((COMPANY_META[f.c] || [0, '#8fa89c'])[1]);
    c.lerp(new THREE.Color('#ffffff'), 0.06 + 0.22 * (1 - rank[i])); // ガス色主体・新しいものだけ微白熱（白い砂粒化の禁止）
    col.set([c.r, c.g, c.b], i * 3);
    galaxyState.map[f.p] = { key, i };
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const ptsMat = new THREE.PointsMaterial({
    size: 0.062, map: roundTex, vertexColors: true, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const points = new THREE.Points(geo, ptsMat);
  points.userData = { files, key };
  grp.add(points);
  galaxyState.pointsList.push(points);

  // Straight LineSegments are deliberately absent. The hierarchy is rendered
  // only by the curved ViralMembrane tubes built below.
  const hubKeys = Object.keys(hub);

  // 親コア粒子は標準ファイル粒子(0.062)の2.5倍。ハブとは別materialに
  // して、実活動に同期した呼吸を個別制御できるようにする。
  const rootGeo = new THREE.BufferGeometry();
  rootGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
  const rootMat = new THREE.PointsMaterial({ size: 0.155, map: roundTex,
    color: (COMPANY_META[files[0].c] || [0, '#34d399'])[1], transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const rootPoint = new THREE.Points(rootGeo, rootMat);
  rootPoint.userData.folderRoot = true;
  grp.add(rootPoint);

  // フォルダハブ（結節点・少し大きい粒）
  const hp = new Float32Array(hubKeys.length * 3), hc = new Float32Array(hubKeys.length * 3);
  hubKeys.forEach((hk, i) => {
    const h = hub[hk];
    hp.set([h.x, h.y, h.z], i * 3);
    const c = new THREE.Color((COMPANY_META[h.userData.c] || [0, '#cfe8dd'])[1]).lerp(new THREE.Color('#ffffff'), 0.22);
    hc.set([c.r, c.g, c.b], i * 3);
  });
  const hgeo = new THREE.BufferGeometry();
  hgeo.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  hgeo.setAttribute('color', new THREE.BufferAttribute(hc, 3));
  const hubMat = new THREE.PointsMaterial({
    size: 0.105, map: roundTex, vertexColors: true, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  grp.add(new THREE.Points(hgeo, hubMat));

  // 光の行き来: 階層エッジに沿って無数の小さな光が不規則に往来する（美観・オーナー指示）
  const FN = Math.min(Math.max(40, N), 220);
  const fpos = new Float32Array(FN * 3);
  const fedges = [];
  for (let i = 0; i < FN; i++) {
    let a, b;
    if (Math.random() < 0.7 || !hubKeys.length) { // 葉⇄ハブ
      const li = (Math.random() * N) | 0;
      a = new THREE.Vector3(pos[li * 3], pos[li * 3 + 1], pos[li * 3 + 2]);
      b = (leafHub[li] || center).clone();
    } else { // 幹（ハブ⇄親）
      const hk = hubKeys[(Math.random() * hubKeys.length) | 0];
      const h = hub[hk];
      const pk = h.userData.depth === 2 ? hk.split('/').slice(0, -1).join('/') : null;
      a = h.clone(); b = (pk && hub[pk] ? hub[pk] : center).clone();
    }
    fedges.push({ a, b, sp: 0.08 + Math.random() * 0.3, ph: Math.random(), dir: Math.random() < 0.5 ? 1 : -1 });
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  const baseCol = new THREE.Color((COMPANY_META[files[0].c] || [0, '#9fd8c2'])[1]).lerp(new THREE.Color('#ffffff'), 0.55);
  const flowMat = new THREE.PointsMaterial({
    size: 0.042, map: roundTex, color: baseCol, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flow = new THREE.Points(fgeo, flowMat);
  flow.frustumCulled = false; // 毎フレーム座標更新のため
  grp.add(flow);

  // One low-cost live hierarchy mesh connects every real file to its real
  // parent-folder hub. Piecewise quadratic arcs follow the drifting endpoints.
  const liveSegments = 3;
  const liveEdgePositions = new Float32Array(N * liveSegments * 2 * 3);
  const liveEdges = files.map((file, index) => ({
    index,
    from: (leafHub[index] || center).clone(),
    bendX: (hash01(file.p + ':bx') - 0.5) * R * 0.18,
    bendY: (hash01(file.p + ':by') - 0.5) * R * 0.18,
    bendZ: (hash01(file.p + ':bz') - 0.5) * R * 0.18,
  }));
  const liveNetworkGeo = new THREE.BufferGeometry();
  liveNetworkGeo.setAttribute('position', new THREE.BufferAttribute(liveEdgePositions, 3));
  const liveNetworkMat = new THREE.LineBasicMaterial({
    color: (COMPANY_META[files[0].c] || [0, '#34d399'])[1], transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const liveNetwork = new THREE.LineSegments(liveNetworkGeo, liveNetworkMat);
  liveNetwork.frustumCulled = false;
  grp.add(liveNetwork);

  // Organic membrane: curved strands replace the old white tree as the primary visual.
  const membrane = new ViralMembrane(scene, {
    color: (COMPANY_META[files[0].c] || [0, '#34d399'])[1], maxStrands: Math.min(72, 12 + N),
  });
  grp.add(membrane.group); // membrane shares the cluster's world transform
  for (const hk of hubKeys) {
    const h = hub[hk];
    const parentKey = h.userData.depth === 2 ? hk.split('/').slice(0, -1).join('/') : null;
    membrane.addStrand([center.clone(), (parentKey && hub[parentKey] ? hub[parentKey].clone() : center.clone()), h.clone()], hubFiles[hk] || 1);
  }
  for (let i = 0; i < N && membrane.strands.length < membrane.maxStrands; i++) {
    const h = leafHub[i] || center;
    const leaf = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const mid = h.clone().lerp(leaf, 0.5); mid.x += (hash01(files[i].p + 'm') - 0.5) * 0.08;
    membrane.addStrand([h.clone(), mid, leaf], 1);
  }

  fileClouds[key] = { grp, points, ptsMat, rootMat, rootPoint, hubMat, files, leafHub, center,
    flow, flowMat, fpos, fedges, membrane, boost: 0, basePos, motion, liveSegments,
    liveEdges, liveEdgePositions, liveNetwork, liveNetworkMat, liveNetworkNext: 0 };

  // 常設シナプス束（v11全結合）: 雲の根→担当BHを繋ぐミニ筋繊維束。LODで消えないため、
  // 全ファイル網が「オーケストレーションのシナプスに常時結合している」ことが遠景でも読める。
  if (key !== 'core') {
    fileClouds[key].rootLink = buildFiberBundle({
      colorHex: (COMPANY_META[files[0].c] || [0, '#8fa89c'])[1], fibers: 64, seg: 10, spread: 0.26,
    });
  }
}

function updateFileCloudDrift(cloud, time, now, opacity, reduced) {
  const positions = cloud.points.geometry.attributes.position.array;
  for (let index = 0; index < cloud.files.length; index++) {
    const j = index * 3; const phase = cloud.motion[j];
    const speed = reduced ? 0 : cloud.motion[j + 1]; const amp = reduced ? 0 : cloud.motion[j + 2];
    positions[j] = cloud.basePos[j] + Math.sin(time * speed + phase) * amp;
    positions[j + 1] = cloud.basePos[j + 1] + Math.cos(time * speed * 0.73 + phase * 1.31) * amp * 0.72;
    positions[j + 2] = cloud.basePos[j + 2] + Math.sin(time * speed * 0.57 + phase * 1.87) * amp;
  }
  cloud.points.geometry.attributes.position.needsUpdate = true;
  cloud.liveNetworkMat.opacity = Math.max(0.035, opacity * 0.13) * (1 + cloud.boost * 0.55);
  if (now < cloud.liveNetworkNext) return;
  cloud.liveNetworkNext = now + (reduced ? 260 : 110);
  let cursor = 0;
  for (const edge of cloud.liveEdges) {
    const j = edge.index * 3;
    const ax = edge.from.x, ay = edge.from.y, az = edge.from.z;
    const bx = positions[j], by = positions[j + 1], bz = positions[j + 2];
    for (let segment = 0; segment < cloud.liveSegments; segment++) {
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        const ratio = (segment + endpoint) / cloud.liveSegments;
        const arc = Math.sin(ratio * Math.PI);
        cloud.liveEdgePositions[cursor++] = THREE.MathUtils.lerp(ax, bx, ratio) + arc * edge.bendX;
        cloud.liveEdgePositions[cursor++] = THREE.MathUtils.lerp(ay, by, ratio) + arc * edge.bendY;
        cloud.liveEdgePositions[cursor++] = THREE.MathUtils.lerp(az, bz, ratio) + arc * edge.bendZ;
      }
    }
  }
  cloud.liveNetwork.geometry.attributes.position.needsUpdate = true;
}

// pi-sandbox.json の実権限はツールチップ/カードで表示（sandboxTopo）。
// Core⇄エージェントの関係線は「蜘蛛の糸」システム（後段）が担う。
let sandboxTopo = null;

// ファイルが実際に触られた瞬間の発光（fs.watch由来）
const fileFlashes = [];
function flashFile(rel) {
  const ref = galaxyState.map[rel];
  if (!ref) return;
  const cl = fileClouds[ref.key];
  if (!cl) return;
  const f = cl.files[ref.i];
  const p = cl.points.geometry.attributes.position.array;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: dotTex, color: (COMPANY_META[f.c] || [0, '#ffffff'])[1],
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 1,
  }));
  sp.position.set(p[ref.i * 3], p[ref.i * 3 + 1], p[ref.i * 3 + 2]);
  sp.scale.setScalar(0.3);
  cl.grp.add(sp); // 雲と一緒に惑星へ追従
  fileFlashes.push({ sp, t0: performance.now() });
}
function fileWorldPoint(rel) {
  const ref = galaxyState.map[rel]; if (!ref) return null;
  const cloud = fileClouds[ref.key]; if (!cloud) return null;
  const positions = cloud.points.geometry.attributes.position.array;
  const point = new THREE.Vector3(positions[ref.i * 3], positions[ref.i * 3 + 1], positions[ref.i * 3 + 2]);
  return cloud.grp.localToWorld(point);
}
window.bigkiji.onVaultFiles(buildFileGalaxy);
window.bigkiji.onVaultTouch((paths) => {
  paths.forEach(flashFile); relationshipField.pulse(paths);
  const first = paths.map((path) => galaxyState.map[path]).find(Boolean);
  if (first) autoFocusOn(first.key);
});

// ---------- 星（中景） ----------
const stars = (() => {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(1400 * 3);
  for (let i = 0; i < 1400; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(18 + Math.random() * 26);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x9fd8c2, size: 0.055, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  // Decorative points are disabled in data-only mode: every free-floating
  // particle visible to the owner must resolve to a file or a configured agent.
  p.visible = false;
  scene.add(p);
  return p;
})();

// ---------- GPU星屑スウォーム（v11.1） ----------
// 位置はCPUで毎フレーム書き換えず、楕円軌道を頂点シェーダで積分する。
// これにより遠景の密度を30k粒まで上げても、メインスレッドの負荷はuniform更新だけ。
const STARDUST_N = 30000;
const STARDUST_VERT = /* glsl */ `
uniform float uTime; uniform float uFade; uniform float uPixelRatio;
attribute vec4 aOrbit; // major, minor, inclination, phase
attribute vec3 aMotion; // angular speed, node rotation, size
attribute float aColor;
varying float vColor; varying float vTwinkle;
void main(){
  float angle = aOrbit.w + uTime * aMotion.x;
  vec3 p = vec3(cos(angle) * aOrbit.x, sin(angle) * aOrbit.y, 0.0);
  float ci = cos(aOrbit.z), si = sin(aOrbit.z);
  p.yz = mat2(ci, -si, si, ci) * p.yz;
  float cn = cos(aMotion.y), sn = sin(aMotion.y);
  p.xz = mat2(cn, -sn, sn, cn) * p.xz;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = clamp(1.0 - (-mv.z / 70.0), 0.12, 1.0);
  gl_PointSize = clamp(aMotion.z * uPixelRatio * (220.0 / max(-mv.z, 1.0)), 0.55, 3.8) * depth;
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vTwinkle = 0.72 + 0.28 * sin(uTime * (1.2 + aMotion.x * 3.0) + aOrbit.w * 9.0);
}`;
const STARDUST_FRAG = /* glsl */ `
uniform float uFade;
varying float vColor; varying float vTwinkle;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  vec3 cyan = vec3(0.0, 0.95, 1.0);
  vec3 emerald = vec3(0.0, 1.0, 0.62);
  vec3 violet = vec3(0.65, 0.48, 1.0);
  vec3 gold = vec3(1.0, 0.82, 0.48);
  vec3 c = vColor < 1.0 ? mix(cyan, emerald, vColor) : (vColor < 2.0 ? mix(emerald, violet, vColor - 1.0) : mix(violet, gold, vColor - 2.0));
  float soft = pow(1.0 - r, 2.1);
  gl_FragColor = vec4(c * (0.55 + soft * 1.4) * vTwinkle, soft * uFade * vTwinkle * 0.72);
}`;
const stardust = (() => {
  const geo = new THREE.BufferGeometry();
  const orbit = new Float32Array(STARDUST_N * 4);
  const motion = new Float32Array(STARDUST_N * 3);
  const color = new Float32Array(STARDUST_N);
  for (let i = 0; i < STARDUST_N; i++) {
    const j = i * 4, k = i * 3;
    const radius = 10 + Math.pow(Math.random(), 0.62) * 48;
    orbit[j] = radius;
    orbit[j + 1] = radius * (0.34 + Math.random() * 0.66);
    orbit[j + 2] = (Math.random() - 0.5) * 2.2;
    orbit[j + 3] = Math.random() * Math.PI * 2;
    motion[k] = (0.012 + Math.random() * 0.035) * (Math.random() < 0.5 ? -1 : 1);
    motion[k + 1] = Math.random() * Math.PI * 2;
    motion[k + 2] = 0.8 + Math.random() * 2.5;
    color[i] = Math.random() * 3.7;
  }
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aMotion', new THREE.BufferAttribute(motion, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFade: { value: 0.5 }, uPixelRatio: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: STARDUST_VERT, fragmentShader: STARDUST_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  return pts;
})();

// ---------- アンビエント神経叢（v11）: 線維に沿ってクラスタする微粒子網 ----------
// 一様な砂ではなく「神経線維」曲線に沿って粒を並べる＝脳のシナプス網に見える。
// 位置・明滅は頂点/フラグメントシェーダで計算（CPUコストゼロ）。パレットは環境色のみ
// （シアン/エメラルド/紫）で、会社の識別色とは競合しない。
const neural = (() => {
  const FIBERS = 56, PER = 340;
  const N = FIBERS * PER;
  const pos = new Float32Array(N * 3), colArr = new Float32Array(N * 3);
  const aSeed = new Float32Array(N), aPhase = new Float32Array(N);
  const PAL = [new THREE.Color('#00f3ff'), new THREE.Color('#00ff9d'), new THREE.Color('#a78bfa')];
  const p = new THREE.Vector3(), dir = new THREE.Vector3(), kick = new THREE.Vector3(), toC = new THREE.Vector3();
  let idx = 0;
  for (let f = 0; f < FIBERS; f++) {
    p.randomDirection().multiplyScalar(7 + Math.random() * 9);
    p.y *= 0.6;
    dir.randomDirection();
    const c = PAL[f % 3];
    for (let i = 0; i < PER; i++) {
      dir.add(kick.randomDirection().multiplyScalar(0.25)).normalize();
      dir.lerp(toC.copy(p).multiplyScalar(-1).normalize(), 0.045).normalize(); // 中心への弱い求心＝脳の収束構造
      p.addScaledVector(dir, 0.09);
      pos.set([p.x, p.y * 0.82, p.z], idx * 3);
      aSeed[idx] = Math.random();
      aPhase[idx] = Math.random() * 6.283;
      const cc = c.clone().multiplyScalar(0.5 + Math.random() * 0.5);
      colArr.set([cc.r, cc.g, cc.b], idx * 3);
      idx++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFade: { value: 0.5 }, uScale: { value: Math.min(devicePixelRatio, 3) * 4.4 } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uScale;
      attribute float aSeed; attribute float aPhase;
      varying vec3 vColor; varying float vSeed; varying float vPhase; varying float vNear;
      void main(){
        vColor = color; vSeed = aSeed; vPhase = aPhase;
        vec3 q = position + 0.07 * vec3(sin(uTime*0.31+aPhase), sin(uTime*0.23+aPhase*1.7), cos(uTime*0.27+aPhase*0.6));
        vec4 mv = modelViewMatrix * vec4(q, 1.0);
        // サイズ上限クランプ＋至近フェード: カメラ近傍の粒が巨大ソフトブロブ化して
        // 画面を緑の霧で覆う事故の禁止（c1実写で確認）
        gl_PointSize = clamp((1.4 + aSeed * 2.4) * uScale * (6.0 / max(-mv.z, 0.5)), 1.0, 18.0);
        vNear = smoothstep(1.0, 3.2, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uFade;
      varying vec3 vColor; varying float vSeed; varying float vPhase; varying float vNear;
      void main(){
        float soft = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5));
        float tw = 0.5 + 0.5 * sin(uTime * (0.5 + vSeed * 1.6) + vPhase);
        float a = soft * (0.25 + 0.75 * tw) * uFade * vNear;
        gl_FragColor = vec4(vColor * a, a);
      }`,
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  return { pts, mat };
})();

// ---------- Core（銀河核 = Pi・ブラックホール） ----------
const core = buildOrbGroup({ segments: 96, ringRadius: 1.3, baseScale: 0.88, style: 'blackhole',
  diskTexUrl: './assets/accretion.png', diskOpacity: 0.22 });
scene.add(core.group);
const coreLabel = labelSprite('BigKiji Core', { glyph: '❖', glyphColor: '#34d399' });
coreLabel.position.y = -2.35;
scene.add(coreLabel);
let coreActivity = 0;
// ComfyUI生成ハロー（Core背光・活動で呼吸）
const coreHalo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: new THREE.TextureLoader().load('./assets/halo.png'),
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4,
}));
coreHalo.scale.setScalar(4.8); // v11: 写実円盤を主役にするためハローは控えめ（c2実写で緑霧が円盤を洗った）
coreHalo.renderOrder = -1;
scene.add(coreHalo);
const coreFx = new CoreInflowSynapse(scene, { maxParticles: 512 });
const coreAccretion = new CoreAccretionField(scene, { count: 2600, radius: 2.75 });
let coreReveal = 0;
// ---------- コア演出7フェーズ（動画1〜4準拠・2026-08-02オーナー指示） ----------
// dormant → foreshock(予兆波) → infall(加速吸引) → detonation(爆発) →
// capture(放出粒子の重力捕獲・円盤整列) → steady(動画3) →
// ringmorph(progress≥70%・多重リング変形) → finale(完了・爆散消滅) → dormant
const SEQ = { foreshock: 900, infall: 2600, detonation: 430, capture: 1400, finale: 800 };
const coreSeq = {
  state: 'dormant', enteredAt: 0, rings: [], flash: null,
  progress: 0, steadyAt: 0, finaleQueued: false, lastInfallSpawn: 0,
  pull: 0,      // ファイル雲を中心へ引く係数(0..1)
  absorb: 1,    // 葉粒の残存率（吸引で暗転→捕獲で復帰）
};
const coreAwakening = coreSeq; // 旧名互換（外部参照は無いが検索性のため）
const ringMorph = new CoreRingMorph(scene, { perfLite: false });
let ringMorphTarget = 0;
core.group.visible = false; coreLabel.visible = false; coreHalo.visible = false; coreAccretion.group.visible = false;

function seqEnter(state, now = performance.now()) {
  coreSeq.state = state; coreSeq.enteredAt = now;
  if (state === 'steady') coreSeq.steadyAt = now;
}
function spawnSeqRings(colors, baseScale = 0.08) {
  for (let index = 0; index < colors.length; index++) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex,
      color: colors[index], transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.scale.setScalar(baseScale); ring.userData.delay = index * 150;
    scene.add(ring); coreSeq.rings.push(ring);
  }
}
function clearSeqRings() {
  for (const ring of coreSeq.rings) { scene.remove(ring); ring.material.dispose(); }
  coreSeq.rings.length = 0;
}
function seqFlash(strength = 1) {
  if (coreSeq.flash) { scene.remove(coreSeq.flash.sp); coreSeq.flash.sp.material.dispose(); }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, color: '#ffffff',
    transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.setScalar(0.4);
  scene.add(sp);
  coreSeq.flash = { sp, t0: performance.now(), dur: 620, strength };
}
function cloudPalette() {
  const list = [];
  for (const k in fileClouds) list.push((COMPANY_META[fileClouds[k].files?.[0]?.c] || [0, '#3fe3a8'])[1]);
  return list.length ? list : ['#3fe3a8'];
}
function triggerCoreAwakening() {
  if (coreSeq.state !== 'dormant') return;
  const reduced = reducedMq.matches;
  coreActivity = 1.5;
  coreSeq.progress = 0; coreSeq.finaleQueued = false;
  core.group.visible = true; coreLabel.visible = true; coreHalo.visible = true; coreAccretion.group.visible = true;
  core.group.scale.setScalar(0.025); coreAccretion.group.scale.setScalar(0.025);
  if (reduced) { // reduced: 演出を畳み、静かに0.5秒で顕現
    seqEnter('capture');
    return;
  }
  seqEnter('foreshock');
  // 予兆: 警告色の同心円衝撃波が先行して走る（動画2）
  spawnSeqRings(['#ffffff', '#f5ca69', '#fb923c']);
  spawnRipple(new THREE.Vector3(), new THREE.Color('#f5ca69'));
}
function updateCoreAwakening(now, reduced) {
  const seq = coreSeq;
  // 演出フラッシュ（白閃光）は状態に依らず減衰
  if (seq.flash) {
    const k = (now - seq.flash.t0) / seq.flash.dur;
    if (k >= 1) { scene.remove(seq.flash.sp); seq.flash.sp.material.dispose(); seq.flash = null; }
    else {
      seq.flash.sp.scale.setScalar(0.4 + easeOutCubic(k) * 9 * seq.flash.strength);
      seq.flash.sp.material.opacity = 0.95 * (1 - k) * (1 - k);
    }
  }
  if (seq.state === 'dormant') return;
  const el = now - seq.enteredAt;

  if (seq.state === 'foreshock') {
    const k = Math.min(1, el / SEQ.foreshock);
    for (const ring of seq.rings) {
      const rp = THREE.MathUtils.clamp((el - ring.userData.delay) / (SEQ.foreshock * 0.8), 0, 1);
      ring.scale.setScalar(0.1 + easeOutCubic(rp) * 6.5);
      ring.material.opacity = Math.sin(rp * Math.PI) * 0.8;
    }
    seq.pull = k * 0.12; // 予兆の段階でわずかに引かれ始める
    if (k >= 1) { clearSeqRings(); seqEnter('infall', now); }
    return;
  }

  if (seq.state === 'infall') {
    const k = Math.min(1, el / SEQ.infall);
    const accel = k * k; // だんだん速く
    seq.pull = 0.12 + accel * 0.5;
    seq.absorb = 1 - accel * 0.8;
    coreActivity = Math.min(coreActivity + accel * 0.05, 1.5);
    // 吸引ストリーム: 各雲から曲線でコア全体へ。間隔は220ms→55msへ短縮＝加速
    const interval = 220 - accel * 165;
    if (now - seq.lastInfallSpawn > interval) {
      seq.lastInfallSpawn = now;
      const density = Math.round(4 + accel * 10);
      for (const key in fileClouds) {
        const cl = fileClouds[key];
        const color = (COMPANY_META[cl.files?.[0]?.c] || [0, '#3fe3a8'])[1];
        coreFx.absorbCluster(cl.grp.position.clone(), core.group.position.clone(), color, density);
      }
    }
    // 中心に高密度の光球が育つ（コア本体はまだ小さい）
    coreReveal = 0.08 + accel * 0.2;
    coreHalo.scale.setScalar(1.2 + accel * 2.2);
    if (k >= 1) {
      seqEnter('detonation', now);
      seqFlash(1);
      // 爆発: 吸い込んだ粒子を全方位へ放出→円盤軌道へ捕獲（動画2→3）
      coreFx.detonationBurst(core.group.position.clone(), {
        count: perfStage >= 1 ? 56 : 96, colors: cloudPalette(), settleRadius: 1.85 * 0.88 });
      spawnSeqRings(['#ffffff', '#3fe3a8'], 0.2);
    }
    return;
  }

  if (seq.state === 'detonation') {
    const k = Math.min(1, el / SEQ.detonation);
    for (const ring of seq.rings) {
      const rp = THREE.MathUtils.clamp((el - ring.userData.delay * 0.4) / SEQ.detonation, 0, 1);
      ring.scale.setScalar(0.2 + easeOutCubic(rp) * 9.5);
      ring.material.opacity = Math.sin(rp * Math.PI) * 0.9;
    }
    seq.pull = (1 - k) * 0.62;
    if (k >= 1) { clearSeqRings(); seqEnter('capture', now); }
    return;
  }

  if (seq.state === 'capture') {
    const duration = reduced ? 500 : SEQ.capture;
    const k = Math.min(1, el / duration);
    const reveal = THREE.MathUtils.smoothstep(k, reduced ? 0 : 0.05, reduced ? 0.82 : 0.7);
    // わずかなオーバーシュート（1.05→1.0）で「一気に顕現して締まる」
    coreReveal = reveal * (1 + Math.sin(Math.min(k, 1) * Math.PI) * 0.05);
    seq.pull = 0;
    seq.absorb = 0.2 + k * 0.8; // 粒子は円盤へ整列しつつ雲も復帰
    coreAccretion.group.scale.setScalar(0.22 + reveal * 0.78);
    if (k >= 1) { coreReveal = 1; seq.absorb = 1; seqEnter('steady', now); }
    return;
  }

  if (seq.state === 'steady') {
    // 動画3の定常状態。progress≥70%でリング変形へ
    if (seq.progress >= 70) seqEnter('ringmorph', now);
    else if (seq.finaleQueued && now - seq.steadyAt > 2500) beginCoreFinale(now);
    return;
  }

  if (seq.state === 'ringmorph') {
    ringMorphTarget = Math.min(1, (now - seq.enteredAt) / (reduced ? 600 : 6000)); // ゆっくり変形
    if (seq.finaleQueued && ringMorphTarget > 0.35) beginCoreFinale(now);
    return;
  }

  if (seq.state === 'finale') {
    const k = Math.min(1, el / SEQ.finale);
    coreReveal = 1 - easeOutCubic(k);
    coreActivity *= 0.9;
    if (k >= 1) { // 完全消滅→次の会話で再誕生できる
      coreReveal = 0; ringMorphTarget = 0; ringMorph.reset();
      core.group.visible = false; coreLabel.visible = false;
      coreHalo.visible = false; coreAccretion.group.visible = false;
      seq.progress = 0; seq.finaleQueued = false; seq.reportRequested = false; seq.absorb = 1; seq.pull = 0;
      seqEnter('dormant', now);
    }
  }
}
function beginCoreFinale(now = performance.now()) {
  if (coreSeq.state === 'finale' || coreSeq.state === 'dormant') return;
  seqFlash(1.4);
  ringMorph.explode(now);
  coreFx.detonationBurst(core.group.position.clone(), {
    count: perfStage >= 1 ? 40 : 72, colors: cloudPalette(), settleRadius: 4.6 });
  seqEnter('finale', now);
}
// タスク完了通知（turn完了＝100%）: 消滅の前に必ず完了レポートをオーナーへ提示する
// （2026-08-02オーナー指示）。レポートUIが bk:report-dismissed を返して初めて爆散する。
function notifyCoreTaskComplete() {
  if (coreSeq.state === 'dormant' || coreSeq.reportRequested) return;
  coreSeq.reportRequested = true;
  window.dispatchEvent(new CustomEvent('bk:task-report', { detail: { progress: coreSeq.progress } }));
  // レポートUIが20秒以内に表示されない場合のみ従来どおり消滅（表示されたら無期限に待つ）
  coreSeq.reportFallbackTimer = setTimeout(() => { coreSeq.finaleQueued = true; }, 20000);
}
window.addEventListener('bk:task-report-shown', () => clearTimeout(coreSeq.reportFallbackTimer));
window.addEventListener('bk:report-dismissed', () => {
  clearTimeout(coreSeq.reportFallbackTimer);
  coreSeq.finaleQueued = true;
});
window.addEventListener('bk:wake-core', triggerCoreAwakening);
roadmap3d = new Roadmap3D(scene);
window.bigkiji.knowledgeState?.().then((state) => roadmap3d.setPlans(state)).catch(() => {});
const corePosition = () => core.group.position.clone();
const eventTarget = (evt) => {
  const id = evt && (evt.agent || evt.agentId);
  return id && nodes[id] ? nodes[id].grp.position.clone() : corePosition().multiplyScalar(1.4);
};
const fxFiles = new Set();
let fxInventoryReady = false;
window.bigkiji.onVaultFiles((files) => {
  // Initial inventory is not a creation event. Seed the local set silently so
  // Genesis flashes remain evidence of files that appeared after startup.
  if (!fxInventoryReady) {
    for (const f of files || []) fxFiles.add(f.p);
    fxInventoryReady = true;
    return;
  }
  for (const f of files || []) {
    if (fxFiles.has(f.p)) continue;
    fxFiles.add(f.p);
    const id = COMPANY_TO_AGENT[f.c];
    const target = id && nodes[id] ? nodes[id].grp.position.clone() : corePosition();
    const origin = target.clone().add(new THREE.Vector3((hash01(f.p) - 0.5) * 1.5, -0.5, (hash01(f.p + 'z') - 0.5) * 1.5));
    coreFx.genesisAt(origin, target, (COMPANY_META[f.c] || [0, '#34d399'])[1]);
  }
});

// ---------- 部門エージェント＝粒子クラスター ----------
// BigKiji Coreだけが中心核。部門は小さな細胞粒子と内部シナプスで表現する。
function buildAgentCluster(colorHex, id) {
  return new ParticleCluster({
    color: colorHex, seed: hash01(id) * 100, texture: roundTex,
    count: 56 + Math.floor(hash01(id + 'n') * 28), radius: 0.62 + hash01(id + 'r') * 0.16,
  });
}

// ---------- 惑星ノード + 軌道 + ムーン ----------
// Folder hubs are generated from vaultFiles. Static moon labels would imply
// folders that may not exist on another owner's machine, so they are disabled.
const MOONS = {};
const CORE_MOONS = [];
const nodes = {};
const ids = Object.keys(window.AGENT_META);
const ringTex = ringTexture();
const ORBIT_FLAT = 0.62;
const fadeSystem = []; // 中景でフェードする materials（軌道線・ラベル）
const fadeMuseum = []; // 近景のみ（ムーン・ムーンラベル）

function makeMoon(parent, name, color, radius, size, w, phase) {
  const grp = new THREE.Group();
  const ball = new THREE.Mesh(
    new THREE.IcosahedronGeometry(size, 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 })
  );
  const label = labelSprite(name, { size: 26 });
  label.scale.set(1.5, 0.58, 1);
  label.position.y = size + 0.16;
  label.material.opacity = 0;
  grp.add(ball, label);
  parent.add(grp);
  fadeMuseum.push(ball.material, label.material);
  return { grp, w, phase, radius };
}

ids.forEach((id, i) => {
  const meta = window.AGENT_META[id];
  const angle0 = (i / ids.length) * Math.PI * 2 - Math.PI / 2 + 0.45;
  const radius = 4.7 + [0, 0.8, -0.5][i % 3];
  const yBase = (i % 2 === 0 ? 1.05 : -1.05) + Math.sin(i * 2.1) * 0.25;
  // 軌道面の3D傾斜（v9）: 各軌道が波打つ立体軌道になり奥行きが出る
  const tiltAmp = 0.55 + (i % 3) * 0.45;
  const tiltPhase = i * 1.9;
  const col = new THREE.Color(meta.color);
  const orb = buildAgentCluster(meta.color, id);
  orb.mesh.userData.agentId = id;
  const sel = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTex, color: col, transparent: true, opacity: 0, depthWrite: false,
  }));
  sel.scale.setScalar(0.7);
  const label = labelSprite(meta.role);
  label.position.y = i % 2 === 0 ? 0.72 : -0.7;
  fadeSystem.push(label.material);
  const grp = new THREE.Group();
  grp.add(orb.group, sel, label);
  scene.add(grp);

  const pts = [];
  for (let k = 0; k <= 128; k++) {
    const a = (k / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(
      Math.cos(a) * radius,
      yBase + Math.sin(a + tiltPhase) * tiltAmp, // 軌道線も同じ波形（実軌道と一致）
      Math.sin(a) * radius * ORBIT_FLAT));
  }
  const oline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.11 }));
  scene.add(oline);
  fadeSystem.push(oline.material);

  const moons = (MOONS[id] || []).map((nm, j) =>
    makeMoon(grp, nm, col.clone().lerp(new THREE.Color('#ffffff'), 0.35),
      0.42 + j * 0.13, 0.035, (0.6 + j * 0.17) * (j % 2 ? -1 : 1), j * 2.4));

  nodes[id] = { id, grp, orb, sel, label, angle0, radius, yBase, tiltAmp, tiltPhase, orbitFlat: ORBIT_FLAT,
    w: (0.026 + i * 0.005) * (i % 2 ? -1 : 1), flash: 0, moons, lastText: '', angleNow: angle0 }; // 公転ゆっくり
});

// 装飾ミニオーブ（v9）: フレネル発光の小さなガラス球を3D空間に散りばめて奥行きを美しく
const miniOrbs = (() => {
  const grp = new THREE.Group();
  const PALETTE = ['#3fe3a8', '#a78bfa', '#f472b6', '#4e8cff', '#fbbf24'];
  for (let i = 0; i < 14; i++) {
    const r = 0.05 + Math.pow(Math.random(), 2) * 0.11;
    const u = {
      uColor: { value: new THREE.Color(PALETTE[i % PALETTE.length]) },
      uGlow: { value: 0.55 }, uIntensity: { value: 0.9 },
    };
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 20),
      new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: core.group.children[1].material.vertexShader,
        fragmentShader: core.group.children[1].material.fragmentShader,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    const v = new THREE.Vector3().randomDirection();
    v.y *= 0.55;
    v.multiplyScalar(6.5 + Math.random() * 8);
    m.position.copy(v);
    m.userData = { base: v.clone(), ph: Math.random() * 6.28, w: 0.1 + Math.random() * 0.25 };
    grp.add(m);
  }
  grp.visible = false;
  scene.add(grp);
  return grp;
})();
const coreMoons = CORE_MOONS.map((nm, j) =>
  makeMoon(core.group, nm, new THREE.Color('#7ddfc0'), (1.9 + j * 0.34) / 1.15, 0.05, (0.35 + j * 0.1) * (j % 2 ? -1 : 1), j * 2.1));

// ---------- 筋繊維シナプス束（v11・オーナー指示）: Core⇄BHを結ぶ数百本の極細光繊維 ----------
// 1本の線ではなく「筋繊維/光ファイバーの束」。繊維の曲線・縒り・揺らぎは全て頂点シェーダで
// 計算し、CPUは端点と可視率のuniformを更新するだけ（旧silksのCPU毎フレーム書換より軽い）。
// 可視本数=関係の深さ（実イベント+実測トークン）・束が濃いほど1本1本も明るい（v10.2則の継承）。
const FIBER_N = 260, FIBER_SEG = 22;
const SILK_MIX = new THREE.Color('#cfeee0'); // 中心（Core側）で混ざり合う色
const FIBER_VERT = /* glsl */ `
uniform vec3 uStart; uniform vec3 uEnd; uniform float uTime; uniform float uShow; uniform float uActive;
attribute float aT; attribute float aOff; attribute float aPhase; attribute float aIdx;
varying float vA; varying float vT;
void main(){
  float t = aT;
  vec3 span = uEnd - uStart;
  vec3 forward = normalize(span);
  vec3 side = normalize(cross(abs(forward.y) > 0.92 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0), forward));
  vec3 up = normalize(cross(forward, side));
  vec3 radial = side * cos(aPhase * 6.28318) + up * sin(aPhase * 6.28318);
  vec3 coreSurface = uStart + forward * (0.30 + abs(aOff) * 0.16) + radial * (0.16 + abs(aOff) * 0.34);
  vec3 clusterSurface = uEnd + radial * (0.20 + abs(aOff) * 0.74);
  float bow = sin(t * 3.14159);
  float sway = sin(uTime * (0.5 + aPhase * 0.13) + aPhase) * 0.16;
  float o = (aOff + sway * 0.6) * bow;
  vec3 p = mix(coreSurface, clusterSurface, t);
  // Gravity-curved arc: wide at the source cluster and increasingly tight as
  // it approaches a distributed absorption point on the Core surface.
  p += side * o * (0.35 + 0.65 * t) + up * bow * (0.13 + 0.12 * sin(uTime * 0.33 + aPhase * 2.0));
  // 繊維ごとの微細な縒り（ねじれ）＝束が「筋繊維」に見える肝。転送中は縒りが速まる
  float tw = sin(t * 12.0 + aPhase * 7.0 + uTime * (0.4 + uActive * 1.2));
  p += radial * tw * 0.013 + up * cos(t * 10.0 + aPhase * 5.0) * 0.015 * bow;
  vA = step(aIdx, uShow);
  vT = t;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FIBER_FRAG = /* glsl */ `
uniform vec3 uColA; uniform vec3 uColMix; uniform float uGlow; uniform float uBright;
uniform float uActive; uniform float uSympathy; uniform float uTime;
varying float vA; varying float vT;
void main(){
  if (vA < 0.5) discard;
  vec3 c = mix(uColMix, uColA, 1.0 - pow(1.0 - vT, 1.5)) * uBright;
  float flick = 0.75 + 0.25 * sin(uTime * 0.9 + vT * 6.0);
  float resonance = uSympathy * (0.55 + 0.45 * sin(uTime * 13.0 + vT * 19.0));
  float a = uGlow * flick * (1.0 + uActive * 0.9 + resonance * 1.8);
  gl_FragColor = vec4(c * (1.0 + uActive * 0.6 + resonance), a);
}`;
function buildFiberBundle({ colorHex, fibers = FIBER_N, seg = FIBER_SEG, spread = 1.0 }) {
  const V = fibers * seg * 2;
  const aT = new Float32Array(V), aOff = new Float32Array(V), aPhase = new Float32Array(V), aIdx = new Float32Array(V);
  let vi = 0;
  for (let f = 0; f < fibers; f++) {
    const off = (Math.random() - 0.5) * 1.05 * spread;
    const ph = Math.random() * 6.283;
    const fi = Math.random(); // 可視率の間引きはランダム順＝束の中で均等に薄まる
    for (let s2 = 0; s2 < seg; s2++) {
      aT[vi] = s2 / seg; aOff[vi] = off; aPhase[vi] = ph; aIdx[vi] = fi; vi++;
      aT[vi] = (s2 + 1) / seg; aOff[vi] = off; aPhase[vi] = ph; aIdx[vi] = fi; vi++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3)); // 実位置はシェーダ計算（draw数決定用）
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aOff', new THREE.BufferAttribute(aOff, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute('aIdx', new THREE.BufferAttribute(aIdx, 1));
  const uniforms = {
    uStart: { value: new THREE.Vector3() }, uEnd: { value: new THREE.Vector3() },
    uTime: { value: 0 }, uShow: { value: 0.3 }, uActive: { value: 0 }, uSympathy: { value: 0 },
    uGlow: { value: 0.06 }, uBright: { value: 1 },
    uColA: { value: new THREE.Color(colorHex) }, uColMix: { value: SILK_MIX.clone() },
  };
  const obj = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: FIBER_VERT, fragmentShader: FIBER_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  obj.frustumCulled = false;
  scene.add(obj);
  return { obj, uniforms };
}
const fiberBundles = ids.map((id) => ({ id, b: buildFiberBundle({ colorHex: window.AGENT_META[id].color }) }));
const sparkShedder = new SynapseSparkShedder(scene, { capacity: 768 });
for (const bundle of fiberBundles) {
  sparkShedder.registerStrand(bundle.id, () => core.group.position.clone(), () => nodes[bundle.id]?.grp.position.clone(), (amount) => {
    bundle.b.uniforms.uSympathy.value = Math.max(bundle.b.uniforms.uSympathy.value, amount);
  });
}

// 常時維持される軽量データパルス。実イベント時のburstとは別に、Core⇄Agentの
// 接続が生きていることを示す低輝度の流れを各Bezier束に置く。
const fiberPulses = fiberBundles.map(({ id }) => {
  const color = window.AGENT_META[id].color;
  const parts = Array.from({ length: 8 }, (_, i) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: roundTex, color, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sp.scale.setScalar(0.055 + (i % 3) * 0.012);
    scene.add(sp);
    return { sp, phase: i / 8 + Math.random() * 0.08, speed: 0.045 + Math.random() * 0.035, dir: 1 };
  });
  return { id, parts };
});
const fiberPulsePoint = (start, end, s, phase, out) => {
  const bow = Math.sin(s * Math.PI);
  const span = _fiberSpan.subVectors(end, start);
  _fiberForward.copy(span).normalize();
  _fiberSide.crossVectors(Math.abs(_fiberForward.y) > 0.92 ? _fiberAxisX : UP_Y, _fiberForward).normalize();
  _fiberUp.crossVectors(_fiberForward, _fiberSide).normalize();
  const radialAngle = phase * Math.PI * 2;
  _fiberRadial.copy(_fiberSide).multiplyScalar(Math.cos(radialAngle)).addScaledVector(_fiberUp, Math.sin(radialAngle));
  _fiberSource.copy(start).addScaledVector(_fiberRadial, 0.24 + (phase % 0.21) * 1.8);
  _fiberDestination.copy(end).addScaledVector(_fiberForward, -0.34).addScaledVector(_fiberRadial, 0.16 + (phase % 0.13));
  out.lerpVectors(_fiberSource, _fiberDestination, s);
  const gravityCurve = bow * (0.2 + 0.22 * (1 - s));
  out.addScaledVector(_fiberSide, Math.sin(phase * 9 + s * 4.8) * gravityCurve);
  out.addScaledVector(_fiberUp, gravityCurve * 0.56);
  return out;
};
const _fiberSpan = new THREE.Vector3();
const _fiberPulse = new THREE.Vector3();
const _fiberForward = new THREE.Vector3(), _fiberSide = new THREE.Vector3(), _fiberUp = new THREE.Vector3();
const _fiberRadial = new THREE.Vector3(), _fiberSource = new THREE.Vector3(), _fiberDestination = new THREE.Vector3();
const _fiberAxisX = new THREE.Vector3(1, 0, 0);

// ---------- デュプレックス光流（軌道沿い・実イベント/実トークン駆動） ----------
const dotTex = radialTexture('rgba(255,255,255,0.95)', 'rgba(120,255,200,0)');
const streams = {}; // agentId → {until, resultUntil, tokens, parts[]}
const PARTS = 24; // 上限。実際に見える本数は関係の濃さ（実イベント数+実トークン）で決まる
let perfStage = 0;
// 関係の濃さ（実測）: 累積イベント数 + 実測トークン。粒子の量と線の本数の源
function relStrength(id) {
  return (counters[id] ? counters[id].count : 0) + (tokByAgent[id] || 0) / 800;
}

function exciteStream(id, { result = false, tokens = 0 } = {}) {
  const nd = nodes[id];
  if (!nd) { coreActivity = Math.min(coreActivity + 0.3, 1.5); emitBurst('core', { tokens }); autoFocusOn('core'); return; }
  emitBurst(id, { tokens });
  const flowStart = result ? nd.grp.position : core.group.position;
  const flowEnd = result ? core.group.position : nd.grp.position;
  sparkShedder.emit({ start: flowStart, end: flowEnd, color: window.AGENT_META[id].color,
    intensity: Math.min(2, 0.55 + Math.log2(tokens + 2) * 0.16), eventId: `${id}:${result ? 'in' : 'out'}:${Math.floor(performance.now() / 180)}`,
    sourceId: id, reduced: reducedMq.matches, performanceTier: perfStage });
  autoFocusOn(id); // 伝達が始まったオーブへカメラが乗り移る
  let st = streams[id];
  if (!st) {
    const color = new THREE.Color(window.AGENT_META[id].color).lerp(new THREE.Color('#ffffff'), 0.4);
    const parts = [];
    for (let i = 0; i < PARTS; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dotTex, color, blending: THREE.AdditiveBlending, depthWrite: false,
        transparent: true, opacity: 0,
      }));
      p.scale.setScalar(0.16);
      scene.add(p);
      parts.push(p);
    }
    st = streams[id] = { until: 0, resultUntil: 0, tokens: 0, parts, ripT: 0, since: 0 };
  }
  const nowp = performance.now();
  if (nowp > st.until) st.since = nowp; // 新しい発火の開始点（転送が続くほど加速する基準）
  st.until = nowp + 2500;
  if (result) st.resultUntil = nowp + 2500;
  if (tokens) st.tokens = tokens;
}

// ---------- ブラックホール粒子放出（v9）----------
// AIが動いた瞬間、そのブラックホールから粒子が噴き出し、sandbox.jsonの書込領域＝
// 自分のファイル雲（.md等の実ファイル）へ飛ぶ。3回に1回はcanon（Core雲）への黄粒＝読取関係。
// 量は実測トークンでスケール（プロンプト/トークンの流れの表現）。
const bursts = [];
const burstLast = {}, burstSeq = {};
const _bv = new THREE.Vector3();
function emitBurst(key, { tokens = 0 } = {}) {
  if (reducedMq.matches || perfStage === 2) return;
  const bnow = performance.now();
  if (bnow - (burstLast[key] || 0) < 550) return;
  burstLast[key] = bnow;
  const nd = nodes[key];
  const from = nd ? nd.grp.position : core.group.position;
  const canon = !!nd && (burstSeq[key] = (burstSeq[key] || 0) + 1) % 3 === 0;
  const cl = canon ? fileClouds.core : (fileClouds[key] || fileClouds.core);
  if (!cl) return;
  const color = canon ? '#FFE81F' : (nd ? window.AGENT_META[key].color : '#3fe3a8');
  const arr = cl.points.geometry.attributes.position.array;
  const total = arr.length / 3;
  // 放出量＝関係の濃さ（実イベント累積）+ このターンの実測トークン
  const n = Math.min(3 + Math.round(Math.log2(relStrength(key) + 1)) + Math.round(tokens / 800), 12);
  for (let i = 0; i < n; i++) {
    const pi = (Math.random() * total) | 0;
    _bv.set(arr[pi * 3], arr[pi * 3 + 1], arr[pi * 3 + 2]);
    cl.grp.localToWorld(_bv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dotTex, color, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.95,
    }));
    sp.scale.setScalar(0.1);
    sp.position.copy(from);
    scene.add(sp);
    bursts.push({ sp, from: from.clone(), to: _bv.clone(), t0: bnow, dur: 600 + Math.random() * 550 });
  }
}

// pi toolが実ファイルに触れた瞬間: BHからそのファイル粒へ直行する高密度パルス（神経伝達物質）。
// どのAIとどのファイルがいまリンクして処理しているかが、色と粒流で直接読める。
function emitBurstTo(key, rel) {
  const ref = galaxyState.map[rel];
  const nd = nodes[key];
  if (!ref || !nd || reducedMq.matches || perfStage === 2) return;
  const cl = fileClouds[ref.key];
  if (!cl) return;
  const arr = cl.points.geometry.attributes.position.array;
  _bv.set(arr[ref.i * 3], arr[ref.i * 3 + 1], arr[ref.i * 3 + 2]);
  cl.grp.localToWorld(_bv);
  const bnow = performance.now();
  for (let i = 0; i < 4; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dotTex, color: window.AGENT_META[key].color, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.95,
    }));
    sp.scale.setScalar(0.09);
    sp.position.copy(nd.grp.position);
    scene.add(sp);
    bursts.push({ sp, from: nd.grp.position.clone(), to: _bv.clone(), t0: bnow + i * 70, dur: 420 });
  }
}

// 繊維束の中心線に沿う点（s: 0=Core → 1=ノード現在位置）。
// パルスはこの線上を走る＝FIBER_VERTの曲線式と同形なので「束の中を伝わる」ように見える。
const _sp = new THREE.Vector3();
function axonPoint(nd, s, out, tt) {
  const px = nd.grp.position.x, py = nd.grp.position.y, pz = nd.grp.position.z;
  const bow = Math.sin(s * Math.PI);
  out.set(px * s, py * s + bow * (0.14 + 0.06 * Math.sin(tt * 0.33)), pz * s);
  return out;
}

const ripples = [];
function spawnRipple(pos, color) {
  if (reducedMq.matches) return;
  const r = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTex, color, blending: THREE.AdditiveBlending, depthWrite: false,
    transparent: true, opacity: 0.8,
  }));
  r.position.copy(pos);
  r.scale.setScalar(0.5);
  scene.add(r);
  ripples.push({ sprite: r, t0: performance.now(), dur: 320 });
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// ---------- 実データ状態 ----------
const counters = {};
const evTimes = [];
let startTs = Date.now();
let lastStats = null;
let filter = null;
let tokTotal = { input: 0, output: 0 };
const tokByAgent = {}; // 実測トークンのターン関与ベース配分（正直表示: 均等割）

let snapSeq = 0;
let ready = false;
const preBuf = [];

window.bigkiji.getInfo().then((i) => {
  startTs = i.startTs || startTs;
  Object.assign(counters, i.counters || {});
  if (i.lastStats) lastStats = i.lastStats;
  snapSeq = i.seq || 0;
  document.getElementById('sMode').textContent = i.ptyMode === 'pty' ? 'LIVE·pty' : 'LIVE·pipe';
  document.getElementById('sBuild').textContent = `BUILD·${i.buildId || 'unknown'}`;
  if (i.loops && i.loops.length) {
    const coreLoop = i.loops.find((name) => /^core[-_]/i.test(name) && /\.(mp4|webm|ogg)$/i.test(name));
    if (coreLoop) {
      const coreUrl = './assets/loops/' + coreLoop;
      core.setDiskVideo && core.setDiskVideo(coreUrl);
      for (const id of ids) nodes[id].orb.setDiskVideo && nodes[id].orb.setDiskVideo(coreUrl);
    }
    const v = document.createElement('video');
    v.src = './assets/loops/' + i.loops[0];
    v.autoplay = v.loop = v.muted = true;
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;mix-blend-mode:screen;opacity:.22;';
    document.getElementById('bgField').appendChild(v);
  }
  renderDeliverables(i.deliverables);
  buildFileGalaxy(i.vaultFiles);
  sandboxTopo = i.sandboxTopo || null;
  (i.recent || []).forEach((evt) => handleEvt(evt, true));
  ready = true;
  preBuf.splice(0).forEach((evt) => handleEvt(evt, false));
});

// ---------- MISSION OUTPUT（成果物・実ファイル） ----------
const COMPANY_META = {
  English_School: ['School', '#34d399'], Creative_Media: ['Media', '#f472b6'],
  Design_Studio: ['Design', '#fbbf24'], LocalAI: ['LocalAI', '#a78bfa'],
  Executive_Office: ['Exec', '#4e8cff'],
};
const deliverCount = {};
const resultList = document.getElementById('resultList');
function renderDeliverables(items) {
  if (!items || !items.length) return;
  for (const k in deliverCount) delete deliverCount[k];
  resultList.innerHTML = '';
  for (const it of items.slice(0, 14)) {
    deliverCount[it.company] = (deliverCount[it.company] || 0) + 1;
    const [label, color] = COMPANY_META[it.company] || ['—', '#9fb8ac'];
    const row = document.createElement('div');
    row.className = 'rrow';
    row.innerHTML = `<span class="rchip" style="color:${color};background:${color}22">${label}</span>` +
      `<span class="rname"></span><time>${window.relTime(it.ts)}</time>`;
    row.querySelector('.rname').textContent = it.name;
    row.title = it.path + ' (click to reveal in Finder)';
    row.addEventListener('click', () => window.bigkiji.reveal(it.path));
    resultList.appendChild(row);
  }
}
window.bigkiji.onDeliverables(renderDeliverables);
document.querySelector('#results .rhead').addEventListener('click', () =>
  document.getElementById('results').classList.toggle('min'));

// ---------- イベントログ + フィルタ + ポップアップ ----------
const eventlog = document.getElementById('eventlog');
const liveChip = document.getElementById('liveChip');
const crawlText = document.getElementById('crawlText');
const popupsEl = document.getElementById('popups');
let crawlTimer = null;
const stamps = [];
let autoFollow = true;
const popups = []; // {el, agentId, until}

eventlog.addEventListener('scroll', () => {
  const nearBottom = eventlog.scrollHeight - eventlog.scrollTop - eventlog.clientHeight < 24;
  autoFollow = nearBottom;
  liveChip.classList.toggle('on', !nearBottom);
});
liveChip.addEventListener('click', () => {
  eventlog.scrollTop = eventlog.scrollHeight;
  autoFollow = true;
  liveChip.classList.remove('on');
});

function rowMatches(row) { return !filter || row.dataset.agent === filter; }
function applyFilter() {
  for (const row of eventlog.children) row.classList.toggle('hidden', !rowMatches(row));
  for (const id of ids) nodes[id].sel.material.opacity = filter === id ? 0.75 : 0;
  for (const chip of chipsEl.children) {
    chip.classList.toggle('on', (chip.dataset.agent || null) === filter || (!filter && !chip.dataset.agent));
  }
  if (autoFollow) eventlog.scrollTop = eventlog.scrollHeight;
}
const chipsEl = document.getElementById('chips');
{
  const all = document.createElement('button');
  all.className = 'fchip on';
  all.textContent = 'ALL';
  all.addEventListener('click', () => { filter = null; applyFilter(); });
  chipsEl.appendChild(all);
  for (const id of ids) {
    const m = window.AGENT_META[id];
    const b = document.createElement('button');
    b.className = 'fchip';
    b.dataset.agent = id;
    b.style.setProperty('--c', m.color);
    b.innerHTML = m.icon + '<span>' + m.short + '</span>';
    b.addEventListener('click', () => { filter = filter === id ? null : id; applyFilter(); });
    chipsEl.appendChild(b);
  }
}

function showPopup(agentId, text, tok) {
  const m = window.AGENT_META[agentId];
  if (!m) return;
  while (popups.length >= 3) { const p = popups.shift(); p.el.remove(); }
  const el = document.createElement('div');
  el.className = 'popup';
  el.style.setProperty('--c', m.color);
  el.innerHTML = `<b>${m.role}</b><span></span>${tok ? `<i>+${tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok} tok</i>` : ''}`;
  el.querySelector('span').textContent = String(text).slice(0, 60);
  popupsEl.appendChild(el);
  const p = { el, agentId, until: performance.now() + 3000 };
  popups.push(p);
  requestAnimationFrame(() => el.classList.add('on'));
}

const seen = new Set();
window.bigkiji.onBusEvent((evt) => { if (ready) handleEvt(evt, false); else preBuf.push(evt); });

// VITALS: システム実測はログを流さず1行をその場更新（＋負荷スパークライン）
const loadHist = [];
const vSpark = document.getElementById('vSpark');
const vsg = vSpark.getContext('2d');
function updateVitals(s) {
  document.getElementById('vLoad').textContent = s.load.toFixed(1);
  document.getElementById('vMem').textContent = `${s.usedGB}/${s.totalGB}G`;
  document.getElementById('vProc').textContent = String(s.procs);
  loadHist.push(s.load);
  while (loadHist.length > 27) loadHist.shift();
  vsg.clearRect(0, 0, 108, 26);
  const max = Math.max(6, ...loadHist);
  loadHist.forEach((v, i) => {
    const h = 3 + (v / max) * 21;
    vsg.fillStyle = i === loadHist.length - 1 ? '#34d399' : 'rgba(52,211,153,0.45)';
    vsg.fillRect(i * 4, 26 - h, 3, h);
  });
}

function handleEvt(evt, replay) {
  if (seen.has(evt.id)) return;
  seen.add(evt.id);
  if (seen.size > 600) seen.delete(seen.values().next().value);
  if (!replay && evt.id <= snapSeq) replay = true;
  if (!replay) telemetryStore.ingest(evt, 'bus');

  if (evt.type === 'pulse' && evt.stats) { // 実測値はVITALSへ集約＝ストリームを汚さない
    lastStats = evt.stats;
    updateVitals(evt.stats);
    if (!replay) coreActivity = Math.min(coreActivity + 0.12, 1.5);
    if (!replay) coreFx.handle(evt, corePosition, eventTarget);
    return;
  }
  if (!replay && evt.source === 'vault') roadmap3d.setState('VERIFY', 'in-progress');

  evTimes.push(evt.ts);
  if (!replay) lastEvtWall = Date.now();
  if (!replay && evt.agent && counters[evt.agent]) { counters[evt.agent].count++; counters[evt.agent].last = evt.ts; }
  if (evt.stats) lastStats = evt.stats;
  if (!replay) coreActivity = Math.min(coreActivity + (evt.agent ? 0.45 : evt.source === 'system' ? 0.15 : 0.3), 1.5);

  const now = performance.now();
  stamps.push(now);
  while (stamps.length && now - stamps[0] > 1000) stamps.shift();
  eventlog.classList.toggle('noanim', replay || stamps.length > 10);

  const meta = evt.agent ? window.AGENT_META[evt.agent] : null;
  const row = document.createElement('div');
  row.className = 'erow' + (evt.source === 'system' ? ' sys' : '');
  row.dataset.agent = evt.agent || '';
  const t = new Date(evt.ts);
  const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
  row.innerHTML = '<time>' + hh + '</time>' +
    (meta ? '<span class="chip" style="color:' + meta.color + ';background:' + meta.color + '22">' + meta.icon + meta.label + '</span>' : '') +
    '<span class="txt"></span>';
  row.querySelector('.txt').textContent = evt.text;
  if (!rowMatches(row)) row.classList.add('hidden');
  eventlog.appendChild(row);
  while (eventlog.children.length > 120) eventlog.removeChild(eventlog.firstChild);
  if (autoFollow) eventlog.scrollTop = eventlog.scrollHeight;

  if (!replay && !evt.agent && evt.source === 'pi') addThought(evt.text);
  if (!replay) coreFx.handle(evt, corePosition, eventTarget);
  if (!replay && evt.source === 'pi' && evt.type === 'task') { // ツール実行カード（実行中）
    const tn = (evt.text.match(/^pi:(\S+)/) || [])[1] || 'tool';
    const m2 = evt.agent ? window.AGENT_META[evt.agent] : null;
    const card = flowAdd(tn, '🔧', tn + (m2 ? ` → ${m2.role} 🛡` : ''), { running: true, color: m2 ? m2.color : '#4e8cff' });
    if (m2 && sandboxTopo && sandboxTopo[evt.agent]) { // 委任先の実sandbox権限＋モデルをツールチップに
      const tp = sandboxTopo[evt.agent];
      card.el.title = `sandbox: write=${tp.company} only / read=+canon · model=${curModel || 'pi'}`;
    }
    commsPush('◆ Core', m2 ? m2.role : 'Vault', tn + ' ' + evt.text.replace(/^pi:\S+\s*/, '').slice(0, 42),
      { color: m2 ? m2.color : '#4e8cff', model: curModel });
    // NEURALダッシュボード: コードストリーム＋探索グラフ＋STAGE（実イベント駆動）
    codeToolStart(tn, evt.text.replace(/^pi:\S+\s*/, ''));
    travHop(m2 ? m2.role : '◆ Core', tn, null, m2 ? m2.color : '#4e8cff');
    setStage(`STAGE 3/4: TOOL EXECUTION — ${tn}`, { busy: true, pct: 70 });
  }
  if (!replay && evt.source === 'vault' && evt.agent) { // 実ファイル書込＝そのAIとファイルの意思疎通
    commsPush(window.AGENT_META[evt.agent].role, 'Files', evt.text.slice(0, 44),
      { color: window.AGENT_META[evt.agent].color });
    const rel = (evt.text || '').replace(/^✎\s*/, '').trim();
    emitBurstTo(evt.agent, rel); // BH→触れたファイル粒へ直行パルス
    travHop(window.AGENT_META[evt.agent].role, null, rel.split('/').pop(), window.AGENT_META[evt.agent].color);
    codeLine(`<span class="ck">// FS:</span> ${esc(evt.text)}`);
  }
  if (!replay && evt.agent) {
    nodes[evt.agent] && (nodes[evt.agent].lastText = evt.text);
    exciteStream(evt.agent, { result: evt.source === 'vault' || evt.type === 'result', tokens: evt.tokens ? (evt.tokens.input + evt.tokens.output) : 0 });
    showPopup(evt.agent, evt.text, evt.tokens ? evt.tokens.input + evt.tokens.output : 0);
    setTimeout(() => { row.classList.add('arrive'); setTimeout(() => row.classList.remove('arrive'), 450); }, 400);
    showCrawl((window.AGENT_META[evt.agent].role + ' — ' + evt.text).slice(0, 90), false);
  }
}

// ---------- v12 LIVE COMMENTARY BAR: main発の英語実況が最優先。バス由来は隙間のみ表示 ----------
let crawlPriUntil = 0;
function showCrawl(text, pri) {
  const now = performance.now();
  if (!pri && now < crawlPriUntil) return;
  if (pri) crawlPriUntil = now + 3000;
  crawlText.textContent = text;
  crawlText.classList.add('on');
  clearTimeout(crawlTimer);
  crawlTimer = setTimeout(() => crawlText.classList.remove('on'), pri ? 5200 : 4000);
}
window.bigkiji.onCommentary((c) => {
  telemetryStore.ingest({ ...c, source: c.source || 'pi', status: c.sev === 'error' ? 'ERROR' : 'SYNC' }, 'commentary');
  showCrawl(('[LIVE] ' + c.text).slice(0, 110), true);
});

// ---------- Local-first preflight: Qwen plans; approved Claude/GLM execute after approval ----------
window.bigkiji.onSwarm((s) => {
  try {
    if (s.mode === 'consensus') {
      if (s.phase === 'start') setStage('SWARM CONSENSUS — DESIGNING WORKFLOW FOR UNKNOWN TASK', { busy: true, pct: 8 });
      if (s.phase === 'proposal') setStage(`SWARM CONSENSUS — PROPOSAL IN (${(s.lens || '').toUpperCase()})`, { busy: true, pct: 12 });
      if (s.phase === 'merge') setStage(`SWARM CONSENSUS — MERGED ${s.steps} STEPS · ${s.tok} tok`, { busy: true, pct: 18, hold: 2500 });
      for (const id of ['biglama', 'claude-code', 'glm']) if (nodes[id]) exciteStream(id, { tokens: 0 });
    } else if (s.mode === 'cache') {
      setStage(`CACHE HIT — PLAYBOOK ${s.hash} · ${Math.round((s.score || 0) * 100)}% MATCH · 0 DISCUSSION tok`, { pct: 10, hold: 2600 });
      codeLine(`<span class="ck">// CACHE:</span> playbook ${esc(s.hash || '')} injected (zero-discussion)`);
    } else if (s.mode === 'stored') {
      codeLine(`<span class="ck">// KNOWLEDGE:</span> pattern ${esc(s.hash || '')} stored → next run is discussion-free`);
    }
  } catch (_) {}
});

// ---------- Pi RPC（Core=Pi）: 応答デルタ/トークン実測 ----------
// 思考ボックス: Piの思考がライブで流れる（6秒静止で自動的に閉じる）
const thinkBox = document.getElementById('thinkBox');
const thinkText = document.getElementById('thinkText');
let thinkTimer = null;
let lastPiDeltaAt = 0;
function feedThink(text) {
  lastPiDeltaAt = performance.now();
  thinkText.textContent = (thinkText.textContent + text).slice(-700);
  thinkBox.classList.add('on');
  clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => { thinkBox.classList.remove('on'); thinkText.textContent = ''; }, 30000);
}

window.bigkiji.onPiEvent((e) => {
  telemetryStore.ingest({ ...e, source: e.provider || e.model || 'pi' }, 'pi');
  coreFx.handle(e, corePosition, eventTarget);
  if (e.kind === 'turn_start') roadmap3d.setState('ROUTE', 'in-progress');
  else if (e.kind === 'delta') roadmap3d.setState('PLAN', 'in-progress');
  else if (e.kind === 'degrade') roadmap3d.setState('EXECUTE', 'blocked');
  else if (e.kind === 'tool_end') roadmap3d.setState('EXECUTE', e.isError ? 'blocked' : 'completed');
  if (e.kind === 'turn_start') {
    triggerCoreAwakening();
    flowNewTurn(e);
    turnStartedAt = performance.now();
    setStage(`STAGE 1/4: ROUTING PROMPT → ${(e.model || 'pi').split('/').pop()}`, { busy: true, pct: 15 });
    codeLine(`<span class="ck">// PROMPT:</span> ${esc(e.text || '')}…`);
    return;
  }
  if (e.kind === 'speak') { // Macシステムボイスの発話フェーズ
    const c = flowAdd('speak', '🔊', e.text, { running: true, color: '#34d399' });
    setTimeout(() => { c.running = false; c.el.classList.remove('running'); c.el.classList.add('done'); }, 4000);
    commsPush('◆ Core', 'You', 'voice reply', { color: '#34d399' });
    return;
  }
  if (e.kind === 'tool_end') {
    flowDone(e.toolName, { err: e.isError });
    if (typeof e.ms === 'number') { latHist.push(e.ms); while (latHist.length > 8) latHist.shift(); }
    codeToolEnd(e.toolName, { err: e.isError, ms: e.ms, out: e.out });
    if (e.isError) travHop('◆ Core', e.toolName, null, '#fb7185', true);
    return;
  }
  if (e.kind === 'delta') {
    coreActivity = Math.min(coreActivity + 0.35, 1.5);
    autoFocusOn('core');
    if (!flowCards.some((c) => c.key === 'think' && c.running)) {
      flowAdd('think', '🧠', 'thinking…', { running: true, color: '#FFE81F' });
      commsPush('You', '◆ Core', 'thinking / planning…', { color: '#FFE81F', model: curModel });
    }
    addThought(e.text);
    feedThink(e.text);
    codeDelta(e.text);
    setStage('STAGE 2/4: REASONING [PROCESSING…]', { busy: true, pct: 40 });
    showCrawl(('PI — ' + e.text.replace(/\s+/g, ' ')).slice(0, 90), false);
  } else if (e.kind === 'status') {
    piRunning = !!e.running; // LIVE LINKS用（宛先ボタンの表示はdestが管理）
  }
});
window.bigkiji.onPhaseUpdate?.((phase) => {
  if (phase?.phase === 'PREFLIGHT' || phase?.phase === 'AWAITING_OWNER_DIRECTIVE') triggerCoreAwakening();
  // タスク完了率を演出へ配線: 70%以上で多重リング変形（daemonのprogress実値）
  if (typeof phase?.progress === 'number') coreSeq.progress = Math.max(coreSeq.progress, phase.progress);
  if (phase?.phase === 'COMPLETED' || coreSeq.progress >= 100) notifyCoreTaskComplete();
});
window.bigkiji.onPiStats((s) => {
  coreSeq.progress = 100; notifyCoreTaskComplete(); // ターン完了＝100%: 爆散消滅へ
  roadmap3d.setState('VERIFY', 'completed'); roadmap3d.pulse(3);
  flowFinish(s.turn ? `in ${s.turn.input} · out ${s.turn.output} tok` : 'done');
  { // TOKEN VELOCITY（実測）: ターン実消費 ÷ 実所要時間
    const tokSum = s.turn ? s.turn.input + s.turn.output : 0;
    const durMs = typeof s.ms === 'number' && s.ms > 0 ? s.ms : (turnStartedAt ? performance.now() - turnStartedAt : 0);
    if (tokSum && durMs > 400) lastTokRate = tokSum / (durMs / 1000);
    setStage(`STAGE 4/4: SYNTHESIS COMPLETE — in ${s.turn ? s.turn.input : 0} · out ${s.turn ? s.turn.output : 0} tok`, { pct: 100, hold: 6000 });
    codeLine(`<span class="ck">// TURN:</span> <span class="cms">in ${s.turn ? s.turn.input : 0} · out ${s.turn ? s.turn.output : 0} tok · ${(durMs / 1000).toFixed(1)}s</span>`, 'ok');
  }
  if (s.total) tokTotal = s.total;
  document.getElementById('sTok').textContent =
    `${(tokTotal.input / 1000).toFixed(1)}k/${(tokTotal.output / 1000).toFixed(1)}k`;
  const t = s.turn ? s.turn.input + s.turn.output : 0;
  const share = s.touched && s.touched.length ? Math.round(t / s.touched.length) : 0;
  for (const id of (s.touched || [])) {
    tokByAgent[id] = (tokByAgent[id] || 0) + share;
    exciteStream(id, { tokens: t });
    if (t) showPopup(id, 'tokens received (measured)', share);
    if (t) commsPush('◆ Core', window.AGENT_META[id].role, `+${share} tok (measured)`, { color: '#FFE81F', model: curModel });
  }
});
let piRunning = false;
// ---------- ターンフロー: 「何が終わり・何が動いているか」のカード列（すべて実イベント由来） ----------
const flowEl = document.getElementById('flow');
const flowCards = [];
let flowFadeTimer = null;
function flowAdd(key, icon, label, { running = false, color = '#34d399', err = false } = {}) {
  const el = document.createElement('div');
  el.className = 'fcard' + (running ? ' running' : err ? ' err' : ' done');
  el.style.setProperty('--c', color);
  el.innerHTML = `<span class="fi">${icon}</span><span class="fl"></span><span class="fs"></span>`;
  el.querySelector('.fl').textContent = label;
  flowEl.appendChild(el);
  const card = { el, key, running };
  flowCards.push(card);
  while (flowCards.length > 8) flowCards.shift().el.remove();
  flowEl.scrollLeft = flowEl.scrollWidth;
  return card;
}
function flowDone(key, { err = false } = {}) {
  for (let i = flowCards.length - 1; i >= 0; i--) {
    if (flowCards[i].key === key && flowCards[i].running) {
      flowCards[i].running = false;
      flowCards[i].el.classList.remove('running');
      flowCards[i].el.classList.add(err ? 'err' : 'done');
      return;
    }
  }
}
// フルパイプライン起点: sandbox接続 → 使用モデル → プロンプト → 思考（すべて実設定）
function flowNewTurn(meta) {
  curModel = (meta.model || '').replace('ollama/', '');
  commsPush('You', '◆ Core', (meta.text || '').slice(0, 40), { color: '#FFE81F', model: curModel });
  flowCards.splice(0).forEach((c) => c.el.remove());
  clearTimeout(flowFadeTimer);
  const sb = flowAdd('sandbox', '🛡', meta.sandbox || 'pi-sandbox', { color: '#a78bfa' });
  sb.el.title = '~/.pi/agent/sandbox.json (broad deny → allow pinholes · secrets denyRead) + Vault AGENTS.md';
  const md = flowAdd('model', '🤖', (meta.model || '').replace('ollama/', 'ollama · '), { color: '#4e8cff' });
  md.el.title = curModel.startsWith('ollama') ? 'Local Ollama — ¥0 token cost' : curModel + ' (cloud · real token billing)';
  flowAdd('prompt', '🗣', (meta.text || '').slice(0, 26), { color: '#9fd8c2' });
  flowAdd('think', '🧠', 'thinking…', { running: true, color: '#FFE81F' });
}
function flowFinish(tokText) {
  flowDone('think');
  for (const c of flowCards) if (c.running) { c.running = false; c.el.classList.remove('running'); c.el.classList.add('done'); }
  flowAdd('done', '✅', tokText, { color: '#34d399' });
  clearTimeout(flowFadeTimer);
  flowFadeTimer = setTimeout(() => flowCards.splice(0).forEach((c) => c.el.remove()), 25000);
}

// ---------- 指示バー: 既定の宛先はAI（ローカルPi・初回⏎で自動起動）。シェルはボタンで切替 ----------
let dest = 'ai';
const piBtnEl = document.getElementById('piBtn');
const ccmd = document.getElementById('ccmd');
function renderDest() {
  piBtnEl.textContent = window.t(dest === 'ai' ? 'aiBtn' : 'shellBtn');
  piBtnEl.classList.toggle('on', dest === 'ai');
  piBtnEl.style.setProperty('--c', dest === 'ai' ? '#FFE81F' : '#34d399');
  ccmd.placeholder = window.t(dest === 'ai' ? 'ph_ai' : 'ph_shell');
}
piBtnEl.addEventListener('click', () => { dest = dest === 'ai' ? 'shell' : 'ai'; renderDest(); ccmd.focus(); });
renderDest();
ccmd.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは送信しない
  if (e.key === 'Enter' && ccmd.value.trim()) {
    if (dest === 'ai' && /^\/media\s+/i.test(ccmd.value)) {
      const prompt = ccmd.value.replace(/^\/media\s+/i, '').trim();
      telemetryStore.setComfy({ state: 'queued', progress: 0, node: 'REQUEST', message: 'Preparing local media workflow' });
      window.bigkiji.comfyGenerate({ workflowId: 'bigkiji-hud', inputs: { prompt, width: 1024, height: 576 }, target: 'hud' })
        .catch((error) => telemetryStore.setComfy({ state: 'error', progress: 0, node: 'REQUEST', message: error.message }));
    } else if (dest === 'ai' && /^\/parallel\s+/i.test(ccmd.value)) {
      window.prepareParallelTasks && window.prepareParallelTasks(ccmd.value.replace(/^\/parallel\s+/i, '').trim());
    } else if (dest === 'ai') { triggerCoreAwakening(); window.bigkiji.piPrompt(ccmd.value); }
    else { window.bigkiji.ptyInput(ccmd.value + '\n'); window.bkShowTerm && window.bkShowTerm(); }
    ccmd.value = '';
  }
});
// v12: システムUIは全英語固定（切替UIは撤去・対話言語はPi側で入力言語をミラー）
window.applyI18n();
const focusCmd = () => { if (document.activeElement !== ccmd) ccmd.focus(); };
window.addEventListener('focus', focusCmd);
setTimeout(focusCmd, 350);

// ---------- 思考ストリーム（Core周囲・実データ断片が周回） ----------
const thoughts = [];
function addThought(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return;
  const el = document.createElement('div');
  el.className = 'thought';
  el.textContent = s.slice(0, 46);
  popupsEl.parentElement.appendChild(el);
  thoughts.push({ el, a: Math.random() * Math.PI * 2, r: 110 + Math.random() * 120,
    born: performance.now(), w: (0.1 + Math.random() * 0.18) * (Math.random() < 0.5 ? -1 : 1) });
  while (thoughts.length > 12) thoughts.shift().el.remove();
}

// ---------- D&D: ファイルを落とすと @パス をターミナルへ挿入 ----------
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    try {
      const p = window.bigkiji.getPathForFile(f);
      if (p) window.bigkiji.ptyInput('@' + p + ' ');
    } catch (_) {}
  }
});

// ---------- COMMS: 「誰⇄誰・何を・どのモデルで」の1行カード（実イベント由来・最重要表示） ----------
const commsEl = document.getElementById('comms');
let curModel = ''; // 現ターンの実モデル（turn_startから）
function commsPush(fromLabel, toLabel, what, { color = '#34d399', model = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'crow';
  row.style.setProperty('--cc', color);
  row.innerHTML = '<span class="pair"></span><span class="arr">⇄</span><span class="pair"></span>' +
    '<span class="what"></span>' + (model ? '<span class="mdl"></span>' : '');
  const pairs = row.querySelectorAll('.pair');
  pairs[0].textContent = fromLabel; pairs[1].textContent = toLabel;
  row.querySelector('.what').textContent = what;
  if (model) row.querySelector('.mdl').textContent = model;
  commsEl.prepend(row);
  [...commsEl.children].forEach((el, i) => el.classList.toggle('old', i > 1));
  while (commsEl.children.length > 6) commsEl.removeChild(commsEl.lastChild);
}

// ---------- WORKING/IDLE: 動いているかを常に明示（実イベント/実ストリーム駆動） ----------
const workStateEl = document.getElementById('workState');
let lastEvtWall = 0;

// ---------- LIVE LINKS: いま「どことどこ」が作業中か（実ストリーム由来・500ms更新） ----------
const linksEl = document.getElementById('links');
setInterval(() => {
  const now = performance.now();
  const working = (now - lastPiDeltaAt < 2500)
    || Object.values(streams).some((st) => st.until > now)
    || (Date.now() - lastEvtWall < 5000);
  workStateEl.classList.toggle('idle', !working);
  workStateEl.classList.toggle('on', working);
  workStateEl.querySelector('span').textContent = working ? 'WORKING' : 'IDLE';
  const chips = [];
  if (now - lastPiDeltaAt < 2500) {
    chips.push(`<span class="lchip" style="--c:#FFE81F"><i></i>${window.t('youCore')}</span>`);
  }
  for (const id in streams) {
    if (streams[id].until > now) {
      const m = window.AGENT_META[id];
      chips.push(`<span class="lchip" style="--c:${m.color}"><i></i>Core ⇄ ${m.role}</span>`);
    }
  }
  linksEl.innerHTML = chips.length ? chips.join('')
    : `<span class="lchip idle"><i></i>${window.t('idleLink')}</span>`;
}, 500);

// ---------- ホバーフォーカス: 触れた場所を局所拡大し、接続チェーン（葉→フォルダ→惑星）を明示 ----------
let hoverCloudKey = null;
let focusObj = null; // { line, ring, cl, key, i }
function clearFocus() {
  if (!focusObj) return;
  focusObj.cl.grp.remove(focusObj.line, focusObj.ring);
  focusObj.line.geometry.dispose(); focusObj.line.material.dispose(); focusObj.ring.material.dispose();
  focusObj = null;
}
function setFocus(key, i) {
  if (focusObj && focusObj.key === key && focusObj.i === i) return;
  clearFocus();
  const cl = fileClouds[key];
  if (!cl) return;
  const p = cl.points.geometry.attributes.position.array;
  const leaf = new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  const hubV = (cl.leafHub[i] || cl.center).clone();
  const bend = leaf.clone().lerp(hubV, 0.52).add(new THREE.Vector3(0, 0.12, 0.08));
  const rootBend = hubV.clone().lerp(cl.center, 0.5).add(new THREE.Vector3(0.08, 0.1, 0));
  const curve = new THREE.CatmullRomCurve3([leaf, bend, hubV, rootBend, cl.center.clone()]);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
    new THREE.LineBasicMaterial({
      color: (COMPANY_META[cl.files[i].c] || [0, '#ffffff'])[1], transparent: true,
      opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTex, color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false,
  }));
  ring.position.copy(leaf);
  ring.scale.setScalar(0.2);
  cl.grp.add(line, ring);
  focusObj = { line, ring, cl, key, i };
}

// ---------- ノードhoverツールチップ + クリックフィルタ ----------
const tip = document.getElementById('tip');
const filePopup = new FileDetailPopup(document.getElementById('fileDetailPopup'));
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const balls = ids.map((id) => nodes[id].orb.mesh);
let hoverId = null;
let hoverFile = null;
let hoverPoint = { x: 0, y: 0 };
let gestureStart = null;
let suppressGestureClick = false;
function pickAt(e) {
  const r = wrap.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  // Check real file particles before the larger department hit volumes. This
  // makes the same operation reliable for mouse click, touch and trackpad tap.
  raycaster.params.Points = { threshold: 0.19 };
  const fileHit = galaxyState.pointsList.length ? raycaster.intersectObjects(galaxyState.pointsList, false)[0] : null;
  if (fileHit && fileHit.object.userData.files[fileHit.index]) {
    return { kind: 'file', file: fileHit.object.userData.files[fileHit.index], key: fileHit.object.userData.key,
      index: fileHit.index, point: fileHit.point.clone(), rect: r };
  }
  const clusterHit = raycaster.intersectObjects(balls, false)[0];
  return { kind: clusterHit ? 'cluster' : 'background', id: clusterHit?.object.userData.agentId || null,
    point: clusterHit?.point?.clone() || null, rect: r };
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (gestureStart && Math.hypot(e.clientX - gestureStart.x, e.clientY - gestureStart.y) > 5) suppressGestureClick = true;
  if (suppressGestureClick) { tip?.classList.remove('on'); return; }
  const picked = pickAt(e);
  const r = picked.rect;
  const id = picked.id;
  if (picked.kind === 'file') {
      const f = picked.file;
      const [label, color] = COMPANY_META[f.c] || [f.c, '#9fb8ac'];
      tip.innerHTML = '<div class="t" style="color:' + color + '"><span style="color:var(--ink)">📄 ' +
        f.p.split('/').pop() + '</span></div>' +
        '<div class="d">' + label + ' · ' + f.p.slice(0, 60) + ' · ' + window.relTime(f.t) + '</div>';
      tip.classList.add('on');
      tip.style.left = (e.clientX - r.left) + 'px';
      tip.style.top = (e.clientY - r.top) + 'px';
      hoverId = null;
      hoverFile = { ...f, color };
      hoverPoint = { x: e.clientX, y: e.clientY };
      hoverCloudKey = picked.key; // 局所拡大（レンズ）
      setFocus(picked.key, picked.index); // 接続チェーンを明示
      return;
  }
  hoverCloudKey = id || null; // 惑星hover=その雲をレンズ拡大
  hoverFile = null;
  if (!id) clearFocus();
  if (id !== hoverId) {
    hoverId = id;
    renderer.domElement.style.cursor = id ? 'pointer' : '';
    if (id) {
      const m = window.AGENT_META[id];
      const c = counters[id] || { count: 0, last: 0 };
      tip.innerHTML = '<div class="t" style="color:' + m.color + '">' + m.icon + '<span style="color:var(--ink)">' + m.role + '（' + m.short + '）</span></div>' +
        '<div class="d"><b>' + c.count + '</b> events · last ' + window.relTime(c.last) + '</div>';
      tip.classList.add('on');
    } else tip.classList.remove('on');
  }
  if (id) { tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px'; }
});
renderer.domElement.addEventListener('pointerleave', () => {
  hoverId = null; hoverFile = null; hoverCloudKey = null; clearFocus();
  tip.classList.remove('on'); renderer.domElement.style.cursor = '';
});
renderer.domElement.addEventListener('click', (event) => {
  if (suppressGestureClick) { suppressGestureClick = false; return; }
  const picked = pickAt(event);
  hoverPoint = { x: event.clientX, y: event.clientY };
  if (picked.kind === 'file') {
    const file = picked.file;
    const ref = galaxyState.map[file.p];
    if (ref) focusCloud(ref.key, ref.i, false);
    filePopup.open({ ...file, color: (COMPANY_META[file.c] || [0, '#34d399'])[1] }, hoverPoint);
  } else if (picked.kind === 'cluster') {
    filter = filter === picked.id ? null : picked.id;
    applyFilter(); focusAgent(picked.id);
  } else {
    // Background selection dismisses detail without snapping back to Core.
    filePopup.close(); cameraFocus.cancel(); clearFocus(); hybridOrbit.select(null);
  }
});
renderer.domElement.addEventListener('dblclick', (event) => {
  const picked = pickAt(event);
  if (picked.kind === 'file') {
    const ref = galaxyState.map[picked.file.p];
    if (ref) focusCloud(ref.key, ref.i, true);
    filePopup.open({ ...picked.file, color: (COMPANY_META[picked.file.c] || [0, '#34d399'])[1] }, { x: event.clientX, y: event.clientY });
  } else if (picked.kind === 'cluster') focusAgent(picked.id, true);
});

// ---------- 博物館プレート（近景LOD・実データ展示） ----------
const plates = {};
for (const id of ids) {
  const m = window.AGENT_META[id];
  const el = document.createElement('div');
  el.className = 'plate';
  el.style.setProperty('--c', m.color);
  el.innerHTML = `<div class="ph">${m.icon}<b>${m.role}</b><span>${m.short}</span></div><div class="pb"></div>`;
  popupsEl.parentElement.appendChild(el);
  plates[id] = el;
}
setInterval(() => {
  for (const id of ids) {
    const c = counters[id] || { count: 0, last: 0 };
    const comp = { justin: 'Creative_Media', risa: 'Design_Studio', marble: 'English_School', biglama: 'LocalAI' }[id];
    const dc = comp ? (deliverCount[comp] || 0) : 0;
    plates[id].querySelector('.pb').innerHTML =
      `<i>${c.count}</i> events · last ${window.relTime(c.last)}` +
      (dc ? ` · deliverables <i>${dc}</i>` : '') +
      (nodes[id].lastText ? `<em></em>` : '');
    const em = plates[id].querySelector('em');
    if (em) em.textContent = nodes[id].lastText.slice(0, 44);
  }
}, 1000);

// ---------- NEURAL DASHBOARD（v11）: ログ垂れ流しの代替＝実測メトリクス可視化 ----------
// 正直の原則: メーターは全て実測値（イベント/分・実測tok/s・ツール往復ms・実ファイル数・
// 実モデル段位・実fps）。飾りの乱数は使わない。
const stageLine = document.getElementById('stageLine');
const stageBar = document.getElementById('stageBar');
let stageResetT = null;
let lastTokRate = 0, turnStartedAt = 0;
const latHist = []; // pi:event tool_end の実測msローリング（直近8件）
function setStage(text, { busy = false, pct = 0, hold = 0 } = {}) {
  stageLine.textContent = '> ' + text;
  stageLine.classList.toggle('busy', busy);
  stageBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  const upper = String(text).toUpperCase();
  const phase = /VERIFY|SYNTHESIS|COMPLETE/.test(upper) ? 'VERIFY' : /EXEC|TOOL|GENERAT/.test(upper) ? 'EXECUTE' : 'PREFLIGHT';
  telemetryStore.setPhase(phase, pct, text, busy ? 'active' : pct >= 100 ? 'completed' : 'idle');
  clearTimeout(stageResetT);
  if (hold) stageResetT = setTimeout(() => setStage('STANDBY — AWAITING DIRECTIVE'), hold);
}

// コードストリーム: 実行中のツール呼び出し/クエリ/思考を最小ハイライトで構造化表示
// The old raw stream is no longer rendered; retain a detached sink so the
// existing structured-log helpers remain compatible with task telemetry.
const codeStream = document.getElementById('codeStream') || document.createElement('div');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function codeLine(html, cls = '') {
  const el = document.createElement('div');
  el.className = 'cline' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
  codeStream.prepend(el);
  while (codeStream.children.length > 40) codeStream.removeChild(codeStream.lastChild);
  return el;
}
let deltaLine = null, deltaBuf = '';
function codeDelta(text) {
  deltaBuf = (deltaBuf + text).slice(-160);
  if (!deltaLine || codeStream.firstChild !== deltaLine) { deltaBuf = String(text).slice(-160); deltaLine = codeLine('', 'delta'); }
  deltaLine.textContent = '> ' + deltaBuf.replace(/\s+/g, ' ');
}
function codeToolStart(tn, argsStr) {
  let pretty = argsStr;
  try { pretty = JSON.stringify(JSON.parse(argsStr), null, 1); } catch (_) {} // 引数が途中で切れていれば生のまま
  const el = codeLine(
    `<span class="ck">// TOOL:</span> <span class="cn">${esc(tn)}</span> ` +
    (argsStr ? '<details><summary>{…}</summary><pre></pre></details> ' : '') +
    '<span class="cms">[RUNNING]</span>');
  const pre = el.querySelector('pre');
  if (pre) pre.textContent = pretty;
  el.dataset.tool = tn;
  return el;
}
function codeToolEnd(tn, { err = false, ms = null, out = '' } = {}) {
  for (const el of codeStream.children) {
    const cms = el.dataset.tool === tn ? el.querySelector('.cms') : null;
    if (cms && /RUNNING/.test(cms.textContent)) {
      el.classList.add(err ? 'err' : 'ok');
      cms.textContent = (err ? '✗ ERR' : '✓') + (ms != null ? ` ${ms}ms` : '');
      if (out) {
        const d = document.createElement('details');
        d.innerHTML = '<summary> ⇢ out</summary><pre></pre>';
        d.querySelector('pre').textContent = out;
        el.appendChild(d);
      }
      return;
    }
  }
}

function travHop(actor, tool, file, color, err) {
  telemetryStore.ingest({ source: actor || 'core', tool, file, isError: err,
    kind: err ? 'error' : tool ? 'tool' : file ? 'sync' : 'exec',
    text: [actor, tool, file].filter(Boolean).join(' → ') }, 'traversal');
}
setStage('STANDBY — AWAITING DIRECTIVE');

// ---------- 実測ライブ統計 + 劣化ラダー ----------
let frames = 0, fps = 60;
const fpsLow = [];
setInterval(() => {
  fps = frames; frames = 0;
  const cut = Date.now() - 60000;
  while (evTimes.length && evTimes[0] < cut) evTimes.shift();
  document.getElementById('sEvm').textContent = String(evTimes.length);
  const up = Math.max(0, (Date.now() - startTs) / 1000);
  document.getElementById('sUp').textContent = `${(up / 60) | 0}:${String((up % 60) | 0).padStart(2, '0')}`;
  if (lastStats) {
    document.getElementById('sLoad').textContent = lastStats.load.toFixed(1);
    document.getElementById('sMem').textContent = `${lastStats.usedGB}/${lastStats.totalGB}G`;
  }
  document.getElementById('sFps').textContent = String(fps);
  { // NEURALメーター（全て実測値）
    const setM = (vId, bId, val, pct) => {
      document.getElementById(vId).textContent = val;
      document.getElementById(bId).style.width = Math.max(0, Math.min(100, pct)) + '%';
    };
    setM('mFlux', 'bFlux', String(evTimes.length), evTimes.length / 60 * 100);
    setM('mTok', 'bTok', lastTokRate ? String(Math.round(lastTokRate)) : '—', Math.min(lastTokRate / 300, 1) * 100);
    const latAvg = latHist.length ? Math.round(latHist.reduce((a, b) => a + b, 0) / latHist.length) : 0;
    setM('mLat', 'bLat', latAvg ? String(latAvg) : '—', latAvg ? Math.max(8, 100 - latAvg / 40) : 0);
    const liveLinks = Object.values(streams).filter((st) => st.until > performance.now()).length;
    setM('mGraph', 'bGraph', String(galaxyState.count), Math.min(galaxyState.count / 400, 1) * 100);
    document.getElementById('mGraphSub').textContent = `nodes · ${liveLinks} live`;
    const tier = !curModel ? 0 : curModel.includes('preview') ? 1 : curModel.includes('qwen') ? 3 : 2;
    setM('mTier', 'bTier', curModel ? curModel.split('/').pop().replace('qwen3.5:', 'Qwen ').slice(0, 11) : '—',
      tier ? (4 - tier) / 3 * 100 : 0);
    document.getElementById('mTierSub').textContent = tier === 3 ? 'LOCAL ¥0' : tier ? `T${tier} free` : '';
    setM('mFps', 'bFps', String(fps), Math.min(fps / 120, 1) * 100);
  }
  // ラベル2行目 = 実測の活動・トークン配分（オーブ自身が情報を語る）
  for (const id of ids) {
    const c = counters[id] || { count: 0 };
    setLabelSub(nodes[id].label, `${c.count}ev${tokByAgent[id] ? ' · ' + fmtTok(tokByAgent[id]) : ''}`);
  }
  setLabelSub(coreLabel, `${fmtTok(tokTotal.input + tokTotal.output)} tok · ${evTimes.length}ev/m`);
  if (hoverId) {
    const c = counters[hoverId] || { count: 0, last: 0 };
    const d = tip.querySelector('.d');
    if (d) d.innerHTML = '<b>' + c.count + '</b> events · last ' + window.relTime(c.last);
  }
  fpsLow.push(fps);
  if (fpsLow.length > 3) fpsLow.shift();
  if (fpsLow.length === 3 && fpsLow.every((f) => f < 28) && perfStage < 2) { perfStage++; fpsLow.length = 0; }
  else if (fpsLow.length === 3 && fpsLow.every((f) => f > 45) && perfStage > 0) { perfStage--; fpsLow.length = 0; }
}, 1000);

// ---------- メインループ（LODクロスフェード込み） ----------
function resize() {
  const { clientWidth: w, clientHeight: h } = wrap;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
resize();

// ---------- 固定カメラ: 選択時だけ一度移動し、到着後は追尾しない ----------
const cameraFocus = new SmoothFocusController(camera, controls, { home: new THREE.Vector3(0, 0, 0), homeDistance: 11.5 });
function focusCloud(key, index, deep = false) {
  const cl = fileClouds[key]; if (!cl) return;
  const p = cl.points.geometry.attributes.position.array;
  const worldPoint = new THREE.Vector3(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
  cl.grp.localToWorld(worldPoint);
  hybridOrbit.select(key);
  cameraFocus.focus(worldPoint, deep ? 2.8 : 4.4);
}
function focusAgent(id, deep = false) {
  const nd = nodes[id]; if (!nd) return;
  hybridOrbit.select(id);
  cameraFocus.focus(nd.grp.position.clone(), deep ? 3.2 : 5.2);
  filePopup.close();
}
const autoCamBtn = document.getElementById('autoCamBtn');
const AUTO_CAM_KEY = 'bigkiji.camera.auto.v2';
let autoCam = localStorage.getItem(AUTO_CAM_KEY) === 'on';
let autoPausedUntil = 0;
let autoLastMove = 0;
let autoReleaseTimer = null;
function renderAutoCam() {
  const paused = autoCam && performance.now() < autoPausedUntil;
  autoCamBtn.textContent = paused ? '⏸ AUTO PAUSED' : autoCam ? '🎥 AUTO' : '📷 MANUAL';
  autoCamBtn.title = autoCam ? 'Follows important real events · manual input pauses for 12 seconds' : 'Manual camera · click to enable event focus';
  autoCamBtn.classList.toggle('on', autoCam);
  autoCamBtn.disabled = false;
}
function setAutoCam(enabled) {
  autoCam = !!enabled;
  localStorage.setItem(AUTO_CAM_KEY, autoCam ? 'on' : 'off');
  if (!autoCam) { autoPausedUntil = 0; clearTimeout(autoReleaseTimer); }
  renderAutoCam();
}
function pauseAutoCam(ms = 12000) {
  if (!autoCam) return;
  autoPausedUntil = performance.now() + ms;
  renderAutoCam();
  setTimeout(renderAutoCam, ms + 20);
}
function autoFocusOn(id) {
  const now = performance.now();
  if (!autoCam || now < autoPausedUntil || now - autoLastMove < 8000 || !nodes[id]) return false;
  autoLastMove = now;
  focusAgent(id, false);
  clearTimeout(autoReleaseTimer);
  autoReleaseTimer = setTimeout(() => hybridOrbit.select(null), 4600);
  return true;
}
function disableAutoCam() { setAutoCam(false); }
autoCamBtn.addEventListener('click', (event) => { event.stopPropagation(); setAutoCam(!autoCam); });
renderAutoCam();

// ビュー切替（SYSTEM/FILES/CLOSE）— カメラ距離をなめらかに遷移
let targetDist = null;
const viewsEl = document.getElementById('views');
viewsEl.addEventListener('click', (e) => {
  const b = e.target.closest('.fchip');
  if (!b || b.id === 'autoCamBtn') return;
  disableAutoCam(); // 手動プリセット中はオートカメラを止める
  targetDist = +b.dataset.d;
  for (const c of viewsEl.children) { if (c.id !== 'autoCamBtn') c.classList.toggle('on', c === b); }
});
const zoomPlane = new THREE.Plane();
const zoomAnchor = new THREE.Vector3();
const viewNormal = new THREE.Vector3();
let wheelReleaseTimer = null;
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  targetDist = null;
  hybridOrbit.beginInteraction(); pauseAutoCam();
  clearTimeout(wheelReleaseTimer);
  wheelReleaseTimer = setTimeout(() => hybridOrbit.endInteraction(), 180);
  cameraFocus.cancel(); // stop a previous file focus from pulling the camera back
  const picked = pickAt(event);
  let anchor = picked.point;
  if (!anchor) {
    camera.getWorldDirection(viewNormal);
    zoomPlane.setFromNormalAndCoplanarPoint(viewNormal, controls.target);
    anchor = raycaster.ray.intersectPlane(zoomPlane, zoomAnchor);
  }
  if (!anchor) return;
  const wheelDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * innerHeight : event.deltaY;
  const scale = Math.exp(THREE.MathUtils.clamp(wheelDelta, -240, 240) * 0.0015);
  // Scale both camera and target around the world point under the pointer. The
  // point therefore remains under the cursor while zooming in and out.
  zoomAroundPoint(camera, controls.target, anchor, scale, 2.2, 34);
  controls.update();
}, { passive: false, capture: true });
renderer.domElement.addEventListener('pointerdown', (event) => {
  gestureStart = { x: event.clientX, y: event.clientY };
  suppressGestureClick = false;
  targetDist = null; hybridOrbit.beginInteraction(); pauseAutoCam();
});
renderer.domElement.addEventListener('pointerup', () => { gestureStart = null; hybridOrbit.endInteraction(); });
renderer.domElement.addEventListener('pointercancel', () => { gestureStart = null; suppressGestureClick = false; hybridOrbit.endInteraction(); });
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  filePopup.close(); clearFocus(); cameraFocus.cancel(); hybridOrbit.select(null);
});

let galaxyO = 0, museumO = 0;
const UP_Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const clock = new THREE.Clock();
(function tick() {
  requestAnimationFrame(tick);
  if (document.hidden) { clock.getDelta(); return; }
  frames++;
  const delta = clock.getDelta();
  const t = clock.getElapsedTime();
  const now = performance.now();
  const reduced = reducedMq.matches;
  updateCoreAwakening(now, reduced);
  if (targetDist != null) {
    const len = camera.position.length();
    const next = THREE.MathUtils.damp(len, targetDist, 4, delta);
    camera.position.multiplyScalar(next / len);
    if (Math.abs(next - targetDist) < 0.15) targetDist = null;
  }
  cameraFocus.update(delta);
  controls.autoRotate = false;
  const dist = camera.position.distanceTo(controls.target); // LODは注視点との距離で判定（追尾中も正しく展開）

  // LOD（v9反転）: 既定=惑星系。拡大(dist<8.5)でファイル銀河が展開・(<7)で博物館
  galaxyO = THREE.MathUtils.damp(galaxyO, dist < 8.5 ? 1 : 0, 5, delta);
  museumO = THREE.MathUtils.damp(museumO, dist < 5.5 ? 1 : 0, 5, delta);
  const sysO = 1; // 惑星系は常時表示
  const gO = Math.max(galaxyO, 0.12); // 遠景でも「オーブの下に粒子」の気配
  for (const k in fileClouds) {
    const cl = fileClouds[k];
    // ホバーレンズ: 触れた雲は拡大し、糸と粒が明るくなる（解像度を上げる）
    cl.boost = THREE.MathUtils.damp(cl.boost, hoverCloudKey === k ? 1 : 0, 7, delta);
    cl.grp.scale.setScalar(1 + cl.boost * 0.24);
    cl.ptsMat.opacity = gO * 0.92 * (1 + cl.boost * 0.4) * coreSeq.absorb;
    cl.membrane?.update(t, Math.max(galaxyO, 0.06), cl.boost);
    // v11全結合: ハブ/幹線は全LODで微発光を維持（葉粒だけLODゲート＝負荷対策）
    cl.hubMat.opacity = Math.max(galaxyO * 0.8, 0.22) * (1 + cl.boost * 0.4);
    cl.rootMat.opacity = Math.max(galaxyO * 0.9, 0.5) * (0.86 + 0.14 * Math.sin(t * 2.1 + hash01(k) * 6));
    cl.rootMat.size = 0.155 * (1 + (reduced ? 0 : 0.12 * Math.sin(t * 2.1 + hash01(k) * 6)) + cl.boost * 0.18);
    updateFileCloudDrift(cl, t, now, gO, reduced || perfStage >= 2);
    const nd = nodes[k];
    if (nd) { // 雲は自惑星の足元に追従
      cl.grp.position.set(nd.grp.position.x, nd.grp.position.y - 0.48, nd.grp.position.z);
    } else {
      cl.grp.position.set(0, -1.3 + (reduced ? 0 : Math.sin(t * 0.3) * 0.05), 0);
    }
    // 会話開始シーケンス: 予兆〜吸引の間だけ雲全体が中心へ引かれる（爆発で解放）
    if (coreSeq.pull > 0.001) cl.grp.position.lerp(core.group.position, coreSeq.pull);
    if (cl.rootLink && nd) { // 常設シナプス束: 雲の根⇄BH（転送中は増光・形状はGPU計算）
      const ru = cl.rootLink.uniforms;
      ru.uStart.value.copy(cl.grp.position);
      ru.uEnd.value.copy(nd.grp.position);
      ru.uTime.value = t;
      const act = streams[k] && streams[k].until > now ? 1 : 0;
      ru.uShow.value = 0.5 + act * 0.5;
      ru.uGlow.value = 0.045 + galaxyO * 0.03 + act * 0.09;
      ru.uActive.value = act;
    }
    if (!reduced) cl.grp.rotation.y += delta * 0.008 * hybridOrbit.motionScale * (k === 'core' ? 1 : -1); // Obsidian風の緩い漂い
    // 光の行き来: 無数の小さな光がエッジ上を不規則に往来（perf降格時は消灯）
    const flowOn = perfStage < 2 && !reduced && (galaxyO > 0.04 || cl.boost > 0.05);
    cl.flowMat.opacity = flowOn ? Math.max(0.22 * gO + 0.55 * galaxyO, 0.06) * (0.7 + cl.boost * 0.8) : 0;
    if (flowOn) {
      for (let fi = 0; fi < cl.fedges.length; fi++) {
        const e2 = cl.fedges[fi];
        let s = (t * e2.sp + e2.ph) % 1;
        if (e2.dir < 0) s = 1 - s;
        const j = fi * 3;
        cl.fpos[j] = e2.a.x + (e2.b.x - e2.a.x) * s;
        cl.fpos[j + 1] = e2.a.y + (e2.b.y - e2.a.y) * s + Math.sin((t + fi * 1.7) * 2.3) * 0.009;
        cl.fpos[j + 2] = e2.a.z + (e2.b.z - e2.a.z) * s;
      }
      cl.flow.geometry.attributes.position.needsUpdate = true;
    }
  }
  stars.material.opacity = perfStage === 0 ? 0.5 : perfStage === 1 ? 0.28 : 0;
  stars.visible = false;
  stardust.material.uniforms.uTime.value = reduced ? 0 : t;
  stardust.material.uniforms.uFade.value = reduced ? 0.16 : perfStage === 0 ? 0.58 : perfStage === 1 ? 0.3 : 0.04;
  stardust.material.uniforms.uPixelRatio.value = Math.min(devicePixelRatio, 2);
  stardust.visible = false;
  coreFx.update(now, reduced || perfStage >= 2);
  roadmap3d.update(delta, reduced || perfStage >= 2);
  relationshipField.update(delta, fileWorldPoint, reduced || perfStage >= 2);
  // 神経叢の明滅（シェーダ駆動・perf降格で減光）
  neural.mat.uniforms.uTime.value = t;
  neural.mat.uniforms.uFade.value = reduced ? 0.2 : perfStage === 0 ? 0.5 : perfStage === 1 ? 0.3 : 0.12;
  neural.pts.visible = false;
  for (const m of fadeSystem) m.opacity = Math.min(m.userData?.base ?? 1, 1) * (m.map ? 1 : 0.11);
  for (const m of fadeMuseum) m.opacity = museumO * (m.map ? 0.95 : 0.9);
  coreLabel.material.opacity = (1 - museumO * 0.4) * coreReveal;

  coreActivity *= 0.975;
  core.update({ activity: coreActivity + galaxyO * 0.15, reduced, t, delta, camera });
  // ringmorph: コアと円盤は退き、多重リングが主役になる（動画4・ゆっくり）
  const morphK = THREE.MathUtils.damp(ringMorph.morph, ringMorphTarget, 2.5, delta);
  ringMorph.setMorph(morphK);
  ringMorph.update(t, delta, reduced || perfStage >= 2, now);
  // uOpaはorb-core側が非reduced時のみ毎フレーム再設定するため、乗算はその場合に限る
  if (core.disk && !reduced) core.disk.material.uniforms.uOpa.value *= (1 - morphK * 0.9); // レンズアークも同uniform共有
  core.group.scale.multiplyScalar(Math.max(0.025, coreReveal) * (1 - morphK * 0.42));
  coreAccretion.update(t, (coreActivity + galaxyO * 0.18) * (1 - morphK * 0.85), reduced || perfStage >= 2, delta);
  coreAccretion.group.visible = coreSeq.state !== 'dormant' && morphK < 0.92;
  coreHalo.material.opacity = (0.22 + Math.min(coreActivity, 1) * 0.3 + (reduced ? 0 : Math.sin(t * 1.57) * 0.04)) * coreReveal * (1 - morphK * 0.7);
  coreHalo.scale.setScalar((4.8 + Math.min(coreActivity, 1) * 0.8) * Math.max(0.08, coreReveal));

  for (const id of ids) {
    const nd = nodes[id];
    const active = streams[id] && streams[id].until > now ? 1 : 0;
    nd.grp.position.copy(hybridOrbit.updateNode(nd, delta, { reduced, now, hovered: hoverCloudKey === id, activity: active }));
    nd.flash *= 0.92;
    nd.orb.update({ activity: 0.06 + nd.flash * 1.2, reduced, t, delta, camera });
    if (nd.sel.material.opacity > 0.01) nd.sel.material.rotation += delta * 0.8;
    for (const mo of nd.moons) {
      const a = t * mo.w + mo.phase;
      mo.grp.position.set(Math.cos(a) * mo.radius, Math.sin(a * 0.7) * 0.06, Math.sin(a) * mo.radius * 0.8);
    }
  }
  for (const mo of coreMoons) {
    const a = t * mo.w + mo.phase;
    mo.grp.position.set(Math.cos(a) * mo.radius, Math.sin(a * 0.6) * 0.1, Math.sin(a) * mo.radius * 0.8);
  }

  // デュプレックス光流
  for (const id in streams) {
    const st = streams[id];
    const nd = nodes[id];
    const active = now < st.until;
    const env = active ? 1 : Math.max(0, 1 - (now - st.until) / 450);
    const tokBoost = Math.min(st.tokens / 3000, 1.5);
    // 粒子の行き来の量＝関係の濃さ（実イベント累積+実トークン）でスケール
    const relParts = Math.round(Math.min(PARTS, 6 + Math.log2(relStrength(id) + 1) * 2.6));
    const usable = Math.min(relParts, perfStage === 0 ? PARTS : perfStage === 1 ? 10 : 6);
    // v11: 速度＝実測tok/s（lastTokRate）に比例して伸び、転送が続くほど加速（神経発火の増強）
    const age = active && st.since ? (now - st.since) / 1000 : 0;
    const accel = 1 + Math.min(age * 0.22, 1.2);
    const rate = Math.min(lastTokRate / 60, 2.2);
    const speed = 0.00042 * (1.1 + tokBoost * 0.6) * (1 + rate * 0.5) * accel;
    const isResult = now < st.resultUntil;
    for (let i = 0; i < st.parts.length; i++) {
      const p = st.parts[i];
      if (i >= usable || env <= 0.01) { p.material.opacity = 0; continue; }
      const outbound = i % 2 === 0;
      const phase = ((now * speed) + i / usable) % 1;
      const s = outbound ? phase : 1 - phase;
      axonPoint(nd, Math.max(s, 0.02), _sp, t);
      p.position.copy(_sp);
      const flick = 0.6 + 0.4 * Math.sin(now * 0.02 + i * 2.4);
      p.material.opacity = env * flick * Math.max(sysO, 0.55) * (0.5 + tokBoost * 0.3) * (isResult && !outbound ? 1 : 0.75); // 銀河モードでも光流は見せる
      p.scale.setScalar((isResult && !outbound ? 0.24 : 0.15) * (0.8 + tokBoost * 0.4));
    }
    if (active && now - st.ripT > 700) {
      st.ripT = now;
      spawnRipple(nd.grp.position, new THREE.Color(window.AGENT_META[id].color));
      nd.flash = 1;
    }
  }

  // 筋繊維シナプス束: 端点・可視率・輝度のuniformだけCPUで更新（形状はGPU計算）
  const fiberCap = perfStage === 0 ? 1 : perfStage === 1 ? 0.6 : 0.35;
  for (const fb of fiberBundles) {
    const nd = nodes[fb.id];
    const rel = relStrength(fb.id);
    const show8 = Math.min(8, 2 + Math.floor(Math.log2(rel + 1))); // v10.2の本数則を可視率に写像
    const st2 = streams[fb.id];
    const active = st2 && st2.until > now ? 1 : 0;
    const u = fb.b.uniforms;
    u.uEnd.value.copy(nd.grp.position);
    u.uTime.value = t;
    u.uShow.value = (0.18 + (show8 / 8) * 0.82) * fiberCap * coreReveal;
    u.uActive.value = THREE.MathUtils.damp(u.uActive.value, active, 6, delta);
    u.uSympathy.value = THREE.MathUtils.damp(u.uSympathy.value, 0, 4.5, delta);
    u.uGlow.value = 0.035 + 0.012 * show8;  // 束が濃いほど1本1本も明るい
    u.uBright.value = 1 + Math.min(0.6, show8 * 0.07);
  }
  for (const fp of fiberPulses) {
    const nd = nodes[fp.id];
    const active = streams[fp.id] && streams[fp.id].until > now;
    const pulseOpacity = (active ? 0.38 : (perfStage === 0 ? 0.16 : perfStage === 1 ? 0.09 : 0)) * coreReveal;
    for (const part of fp.parts) {
      const s = (t * part.speed + part.phase) % 1;
      const source = fileClouds[fp.id]?.grp.position || nd.grp.position;
      fiberPulsePoint(source, core.group.position, s, part.phase, _fiberPulse);
      part.sp.position.copy(_fiberPulse);
      part.sp.material.opacity = pulseOpacity * (0.72 + 0.28 * Math.sin(t * 4 + part.phase * 10));
      part.sp.scale.setScalar((active ? 0.07 : 0.055) + (part.phase % 0.13));
    }
  }
  sparkShedder.update(t);
  // ブラックホール放出粒子（BH→ファイル雲/canonへ・弧を描いて飛ぶ）
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    const k = (now - b.t0) / b.dur;
    if (k < 0) { b.sp.material.opacity = 0; continue; } // 時差発射（emitBurstTo）の待機中
    if (k >= 1) { scene.remove(b.sp); bursts.splice(i, 1); continue; }
    const e = easeOutCubic(k);
    b.sp.position.lerpVectors(b.from, b.to, e);
    b.sp.position.y += Math.sin(k * Math.PI) * 0.28; // 弧
    b.sp.material.opacity = 0.95 * (1 - k * k);
    b.sp.scale.setScalar(0.1 * (1 - k * 0.45));
  }
  // 装飾ミニオーブの漂い
  if (!reduced) {
    for (const m of miniOrbs.children) {
      const u = m.userData;
      m.position.set(
        u.base.x + Math.sin(t * u.w + u.ph) * 0.5,
        u.base.y + Math.sin(t * u.w * 0.8 + u.ph * 2) * 0.35,
        u.base.z + Math.cos(t * u.w * 0.6 + u.ph) * 0.5);
    }
  }
  // 実ファイル発光のフェード
  for (let i = fileFlashes.length - 1; i >= 0; i--) {
    const ff = fileFlashes[i];
    const k = (now - ff.t0) / 1800;
    if (k >= 1) { ff.sp.parent && ff.sp.parent.remove(ff.sp); fileFlashes.splice(i, 1); continue; }
    ff.sp.material.opacity = 1 - k;
    ff.sp.scale.setScalar(0.35 + k * 0.5);
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const k = (now - r.t0) / r.dur;
    if (k >= 1) { scene.remove(r.sprite); ripples.splice(i, 1); continue; }
    const e = easeOutCubic(k);
    r.sprite.scale.setScalar(0.5 + e * 1.1);
    r.sprite.material.opacity = 0.8 * (1 - e);
  }

  // DOMオーバーレイの3D追従（ポップアップ・博物館プレート）
  const rect = { w: wrap.clientWidth, h: wrap.clientHeight };
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    if (now > p.until) { p.el.classList.remove('on'); setTimeout(() => p.el.remove(), 250); popups.splice(i, 1); continue; }
    const nd = nodes[p.agentId];
    if (!nd) continue;
    _v.copy(nd.grp.position); _v.y += 0.55; _v.project(camera);
    p.el.style.left = ((_v.x * 0.5 + 0.5) * rect.w) + 'px';
    p.el.style.top = ((-_v.y * 0.5 + 0.5) * rect.h) + 'px';
  }
  const showPlates = museumO > 0.05 && sysO > 0.5;
  for (const id of ids) {
    const el = plates[id];
    if (!showPlates) { el.style.opacity = 0; continue; }
    const nd = nodes[id];
    _v.copy(nd.grp.position); _v.x += 0.0; _v.y -= 0.15; _v.project(camera);
    if (_v.z > 1) { el.style.opacity = 0; continue; }
    el.style.opacity = museumO;
    el.style.left = ((_v.x * 0.5 + 0.5) * rect.w + 74) + 'px';
    el.style.top = ((-_v.y * 0.5 + 0.5) * rect.h) + 'px';
  }

  // 思考ストリーム: Core投影点の周りを実データ断片が周回（近景ほど濃い）
  _v.set(0, 0, 0).project(camera);
  const cx = (_v.x * 0.5 + 0.5) * rect.w, cy = (-_v.y * 0.5 + 0.5) * rect.h;
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i];
    const age = (now - th.born) / 20000;
    if (age >= 1) { th.el.remove(); thoughts.splice(i, 1); continue; }
    const ang = th.a + t * th.w;
    th.el.style.left = (cx + Math.cos(ang) * th.r * (1 + museumO * 0.8)) + 'px';
    th.el.style.top = (cy + Math.sin(ang) * th.r * 0.55 * (1 + museumO * 0.8)) + 'px';
    th.el.style.opacity = (0.25 + 0.75 * museumO) * (1 - age) * 0.95;
  }

  controls.update();
  renderer.render(scene, camera);
})();
