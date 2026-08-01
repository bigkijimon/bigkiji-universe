'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

function compactGraph(graph) {
  const idToFile = new Map();
  for (const node of graph.nodes || []) {
    const file = String(node.source_file || '').replace(/\\/g, '/');
    if (file && !/node_modules|graphify-out|\.git\//.test(file)) idToFile.set(String(node.id), file);
  }
  const edgeKeys = new Set();
  const degree = new Map();
  const raw = [];
  for (const link of graph.links || []) {
    const source = idToFile.get(String(link.source));
    const target = idToFile.get(String(link.target));
    if (!source || !target || source === target) continue;
    const pair = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
    if (edgeKeys.has(pair)) continue;
    edgeKeys.add(pair);
    raw.push({ source, target, relation: String(link.relation || 'related'), weight: Number(link.weight) || 1 });
    degree.set(source, (degree.get(source) || 0) + 1);
    degree.set(target, (degree.get(target) || 0) + 1);
  }
  raw.sort((a, b) => ((degree.get(b.source) || 0) + (degree.get(b.target) || 0)) - ((degree.get(a.source) || 0) + (degree.get(a.target) || 0)));
  const edges = raw.slice(0, 1200);
  const files = new Set(); edges.forEach((edge) => { files.add(edge.source); files.add(edge.target); });
  const nodes = [...files].slice(0, 700).map((file) => ({ id: file, path: file, label: file.split('/').pop(),
    company: file.split('/')[0], degree: degree.get(file) || 0 }));
  const allowed = new Set(nodes.map((node) => node.id));
  return { version: 1, nodes, edges: edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
    source: 'graphify', graphUpdatedAt: Date.now() };
}

try {
  const graph = JSON.parse(fs.readFileSync(workerData.graphPath, 'utf8'));
  parentPort.postMessage({ ok: true, snapshot: compactGraph(graph) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error.message || error) });
}
