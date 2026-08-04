import * as THREE from 'three';

export const stableHash = (value) => {
  const text = String(value);
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return ((hash >>> 0) % 100000) / 100000;
};

export function radialShellPoint(key, shell, baseRadius, flatten = 0.64) {
  const theta = stableHash(`${key}:theta`) * Math.PI * 2;
  const phi = Math.acos(2 * stableHash(`${key}:phi`) - 1);
  const shellBase = shell === 1 ? 0.34 : shell === 2 ? 0.6 : 0.86;
  const shellJitter = shell === 1 ? 0.1 : shell === 2 ? 0.12 : 0.22;
  const radius = baseRadius * (shellBase + stableHash(`${key}:radius`) * shellJitter);
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta) * radius,
    Math.cos(phi) * radius * flatten, Math.sin(phi) * Math.sin(theta) * radius);
}

// ---------- Flat spiral disc (2026-08-05) ----------
//
// The owner approved moving every particle: 「全粒子の表示動かしても構いません。
// しっかり繋がりがわかるようにシナプスの固まりを表してください」.
//
// The shells above scattered folders over a sphere, so a file's position said nothing
// and the strand from a file to its folder pointed in an arbitrary direction. Thousands
// of arbitrary directions cross, and crossing lines are what made the connections
// unreadable however bright they were drawn.
//
// The disc fixes it by making position mean something, exactly as the reference clip
// does (docs/reference-analysis.md §2): **angle is categorical, radius is continuous.**
// One folder owns one direction; depth and recency decide how far out. Every strand
// then runs inward along its own arm, nothing crosses, and a folder reads as a clump
// because its files genuinely share a sector.
export const ARM_WIND = 5.4; // radians of winding from core to rim ≈ 0.86 of a turn

/**
 * One point on a flat logarithmic-spiral arm.
 *
 * @param {number} armTheta   the arm's own direction. Categorical — one per folder.
 * @param {number} unitRadius 0..1 along the arm. Continuous — depth, then recency.
 * @param {number} sector     half-width of this arm's angular sector, in radians.
 * @param {string} key        seed; the same path always lands in the same place.
 * @param {number} baseRadius disc radius in world units.
 */
export function spiralArmPoint(armTheta, unitRadius, sector, key, baseRadius) {
  // Power-law scatter, not uniform: dense on the ridge and thinning outward, which is
  // what makes an arm read as an arm rather than as a band of equal brightness.
  const side = stableHash(`${key}:side`) < 0.5 ? -1 : 1;
  const spread = side * sector * Math.pow(stableHash(`${key}:spread`), 2.2);
  const radius = baseRadius * Math.max(0.06, unitRadius + (stableHash(`${key}:r`) - 0.5) * 0.05);
  const theta = armTheta + ARM_WIND * (radius / baseRadius) + spread;
  // Essentially zero thickness. Seen edge-on the whole disc collapses to a bright line,
  // and that collapse is the single biggest visual event in the reference clip.
  const y = baseRadius * 0.06 * (stableHash(`${key}:y`) - 0.5)
    * Math.pow(stableHash(`${key}:yy`), 1.8);
  return new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
}

export function fibonacciLeafPoint(orderIndex, count, key, baseRadius) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const theta = orderIndex * golden + stableHash(`${key}:theta`) * 0.42;
  const yUnit = 1 - 2 * ((orderIndex + 0.5) / Math.max(count, 1));
  const radial = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
  const radius = baseRadius * (0.86 + stableHash(`${key}:radius`) * 0.22);
  return new THREE.Vector3(Math.cos(theta) * radial * radius,
    yUnit * radius * 0.56 + Math.sin(theta * 2.2) * baseRadius * 0.035,
    Math.sin(theta) * radial * radius);
}
