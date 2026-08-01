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
