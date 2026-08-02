'use strict';

// Local-first memory and cost gate. This module deliberately has no network
// client: planning and memory lookup must stay in the free local path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { redactPayload } = require('../pi-core/security/payload-redactor');

const { resolveDataRoot, dataLayout, defaultUserData } = require('../../core/data-root');
const ROOT = path.resolve(process.env.BIGKIJI_KNOWLEDGE_ROOT || process.env.KNOWLEDGE_ROOT
  || (() => { const data = resolveDataRoot({ userData: defaultUserData() });
    return dataLayout(data.dataRoot, data.overrides).knowledgeRoot; })());
const STATE_PATH = path.join(ROOT, 'task_state.json');
const GRAPH_PATH = path.join(ROOT, 'knowledge_graph.json');
const ALLOWED_EXECUTORS = new Set(['claude', 'claude-code', 'codex', 'gemini', 'glm', 'qwen', 'ollama']);
const PAID_EXECUTORS = new Set(['claude', 'claude-code', 'codex', 'gemini', 'glm']);

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}
function cleanText(value, max = 1200) {
  return redactPayload(String(value || '')).text
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function emptyState() {
  return { version: 2, project: 'bigkiji-universe', tasks: [], plans: [], ideas: [], events: [],
    physicalLayout: {}, fleetMetrics: null, updatedAt: null };
}
function emptyGraph() {
  return { version: 2, project: 'bigkiji-universe', nodes: [], edges: [], updatedAt: null };
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
function loadState() {
  const state = readJson(STATE_PATH, emptyState);
  return { ...emptyState(), ...state, version: 2, tasks: state.tasks || [], plans: state.plans || [], ideas: state.ideas || [], events: state.events || [] };
}
function loadGraph() {
  const graph = readJson(GRAPH_PATH, emptyGraph);
  return { ...emptyGraph(), ...graph, version: 2, nodes: graph.nodes || [], edges: graph.edges || [] };
}
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
    executorPolicy: ['claude', 'codex', 'gemini', 'glm'], planningPolicy: 'local-qwen-or-deterministic-local', status: 'planned',
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
function savePhysicalLayout(layout) {
  const state = loadState();
  state.physicalLayout = { ...layout, savedAt: new Date().toISOString() };
  saveState(state);
  const graph = loadGraph();
  for (const [domain, files] of Object.entries(layout.domains || {})) {
    const domainId = `source-domain:${domain}`;
    upsertNode(graph, domainId, 'source-domain', domain);
    for (const file of files) {
      const fileId = `source-file:${file}`;
      upsertNode(graph, fileId, 'source-file', file);
      edge(graph, domainId, fileId, 'contains');
    }
  }
  saveGraph(graph);
  return state.physicalLayout;
}
function saveFleetMetrics(metrics) {
  const state = loadState(); state.fleetMetrics = { ...metrics, savedAt: new Date().toISOString() }; saveState(state);
  return state.fleetMetrics;
}
function rememberIdea(draft, status = draft?.status || 'draft') {
  if (!draft?.id || !draft?.draftHash) return null;
  const item = { id: cleanText(draft.id, 96), title: cleanText(draft.title, 180), summary: cleanText(draft.summary, 900),
    status: cleanText(status, 40), draftHash: cleanText(draft.draftHash, 80), sessionId: cleanText(draft.sessionId, 96),
    promotedPath: cleanText(draft.promotedPath, 300), updatedAt: new Date().toISOString() };
  const state = loadState(); state.ideas = [...state.ideas.filter((idea) => idea.id !== item.id), item].slice(-200); saveState(state);
  const graph = loadGraph(); upsertNode(graph, `idea:${item.id}`, 'idea', `${item.title} · ${item.status}`);
  if (item.sessionId) { upsertNode(graph, `session:${item.sessionId}`, 'session', item.sessionId); edge(graph, `session:${item.sessionId}`, `idea:${item.id}`, 'produced-idea'); }
  if (item.promotedPath) { upsertNode(graph, `source-file:${item.promotedPath}`, 'source-file', item.promotedPath); edge(graph, `idea:${item.id}`, `source-file:${item.promotedPath}`, 'promoted-to'); }
  saveGraph(graph); return item;
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
  findPlan, recordEvent, savePhysicalLayout, saveFleetMetrics, rememberIdea, assertExecutor, canSpend };
