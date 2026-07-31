'use strict';

// Local-first memory and cost gate. This module deliberately has no network
// client: planning and memory lookup must stay in the free local path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(os.homedir(), '.pi', 'agent', 'knowledge', 'bigkiji-universe');
const STATE_PATH = path.join(ROOT, 'task_state.json');
const GRAPH_PATH = path.join(ROOT, 'knowledge_graph.json');
const ALLOWED_EXECUTORS = new Set(['claude-code', 'glm', 'ollama']);
const PAID_EXECUTORS = new Set(['claude-code', 'glm']);

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}
function cleanText(value, max = 1200) {
  return String(value || '').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,}]+/ig, '$1=[REDACTED]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function emptyState() {
  return { version: 1, project: 'bigkiji-universe', tasks: [], plans: [], events: [], updatedAt: null };
}
function emptyGraph() {
  return { version: 1, project: 'bigkiji-universe', nodes: [], edges: [], updatedAt: null };
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback(); }
}
function writeJson(file, data) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function loadState() { return readJson(STATE_PATH, emptyState); }
function loadGraph() { return readJson(GRAPH_PATH, emptyGraph); }
function saveState(state) { state.updatedAt = new Date().toISOString(); writeJson(STATE_PATH, state); return state; }
function saveGraph(graph) { graph.updatedAt = new Date().toISOString(); writeJson(GRAPH_PATH, graph); return graph; }

function createTask(ownerText, kind = 'plan') {
  const text = cleanText(ownerText);
  return { id: `bk-${Date.now().toString(36)}-${hash(text)}`, kind, ownerText: text,
    promptHash: hash(text), status: 'planned', provider: 'ollama', createdAt: new Date().toISOString() };
}
function rememberPlan(task, plan, decisions = []) {
  const state = loadState();
  const item = { taskId: task.id, promptHash: task.promptHash, planHash: hash(plan),
    plan: cleanText(plan, 5000), decisions: decisions.map((x) => cleanText(x, 300)),
    executorPolicy: ['claude-code', 'glm'], planningPolicy: 'ollama-only', status: 'planned',
    savedAt: new Date().toISOString() };
  state.plans = [...state.plans.filter((p) => p.promptHash !== item.promptHash), item].slice(-100);
  state.tasks = [...state.tasks.filter((t) => t.id !== task.id), { ...task, planHash: item.planHash }].slice(-100);
  saveState(state);
  const graph = loadGraph();
  upsertNode(graph, `task:${task.id}`, 'task', item.plan);
  upsertNode(graph, `plan:${item.planHash}`, 'plan', item.plan);
  edge(graph, `task:${task.id}`, `plan:${item.planHash}`, 'uses-plan');
  saveGraph(graph);
  return item;
}
function findPlan(ownerText) {
  const h = hash(cleanText(ownerText));
  return loadState().plans.find((p) => p.promptHash === h) || null;
}
function recordEvent(taskId, event) {
  const state = loadState();
  state.events.push({ taskId, type: cleanText(event.type, 80), status: cleanText(event.status, 80),
    provider: cleanText(event.provider, 80), evidence: cleanText(event.evidence, 300), at: new Date().toISOString() });
  state.events = state.events.slice(-300);
  saveState(state);
}
function upsertNode(graph, id, type, label) {
  const existing = graph.nodes.find((n) => n.id === id);
  if (existing) { existing.label = cleanText(label, 240); existing.updatedAt = new Date().toISOString(); return; }
  graph.nodes.push({ id, type, label: cleanText(label, 240), updatedAt: new Date().toISOString() });
  graph.nodes = graph.nodes.slice(-500);
}
function edge(graph, from, to, relation) {
  if (!graph.edges.some((e) => e.from === from && e.to === to && e.relation === relation)) graph.edges.push({ from, to, relation });
  graph.edges = graph.edges.slice(-1000);
}
function assertExecutor(provider) {
  if (!ALLOWED_EXECUTORS.has(provider)) throw new Error(`Provider blocked by strict budget policy: ${provider}`);
  return true;
}
function canSpend(provider, planned = false) { return assertExecutor(provider) && (!PAID_EXECUTORS.has(provider) || planned); }

module.exports = { ROOT, STATE_PATH, GRAPH_PATH, ALLOWED_EXECUTORS, PAID_EXECUTORS,
  cleanText, hash, loadState, loadGraph, saveState, saveGraph, createTask, rememberPlan,
  findPlan, recordEvent, assertExecutor, canSpend };
