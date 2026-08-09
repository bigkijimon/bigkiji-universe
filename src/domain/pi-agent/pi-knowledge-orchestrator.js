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
/**
 * @param {object} task
 * @param {string} plan  The spec as prose — what a human reads.
 * @param {string[]} decisions
 * @param {object|null} spec  The same spec with its fields intact. Prose is lossy:
 *   a cache hit that returns only `plan` cannot answer "what are the constraints",
 *   so callers that need fields silently degraded to whatever they already had.
 */
function rememberPlan(task, plan, decisions = [], spec = null) {
  const state = loadState();
  const listOf = (value) => (Array.isArray(value) ? value : [value].filter(Boolean)).map((x) => cleanText(String(x), 300));
  const item = { taskId: task.id, promptHash: task.promptHash, planHash: hash(plan),
    plan: cleanText(plan, 5000), decisions: decisions.map((x) => cleanText(x, 300)),
    spec: spec ? { goal: cleanText(String(spec.goal || ''), 900), constraints: listOf(spec.constraints),
      steps: listOf(spec.steps), acceptance: listOf(spec.acceptance) } : null,
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
/**
 * Tell a plan record how the work it planned actually went.
 *
 * `createTask` writes `status: 'planned'` and, until now, nothing could write it again —
 * there was no function that did. Measured 2026-08-09: 81 tasks in task_state.json, all
 * 81 reading `planned`, some of them plans for work that had finished days earlier and
 * one for a run that failed at dispatch. `planned` was never wrong, it was just the only
 * thing the file could ever say, so an agent reading it to find out what this company is
 * doing gets a list where finished, failed and never-started look identical. That is
 * worse than an empty file, because it looks like an answer.
 *
 * Silent when there is no matching record. The swarm planner only writes one for the
 * requests it plans, so most runs have nothing here to update, and that is normal rather
 * than an error worth throwing into a live run.
 */
function updateTaskStatus(taskId, status, evidence = '') {
  const id = cleanText(taskId, 96);
  return id ? writeTaskStatus((task) => task.id === id, status, evidence) : null;
}

/** The same, found by the owner's own words — how the coordinator knows a run's plan. */
function recordTaskOutcome(ownerText, status, evidence = '') {
  const h = hash(cleanText(ownerText));
  return writeTaskStatus((task) => task.promptHash === h, status, evidence);
}

function writeTaskStatus(match, status, evidence) {
  const state = loadState();
  const index = state.tasks.findIndex(match);
  if (index < 0) return null;
  state.tasks[index] = { ...state.tasks[index], status: cleanText(status, 40) || 'planned',
    evidence: cleanText(evidence, 300), updatedAt: new Date().toISOString() };
  saveState(state);
  return state.tasks[index];
}

// One stuck run must not erase the company's history.
//
// `events` is a 300-entry ring. A run that stalls emits a `run-checkpoint` every ten
// minutes forever, so on 2026-08-09 it held 244 checkpoints from a single run id — 81%
// of the whole record — and nothing from before 2026-08-07 08:58 survived. The
// checkpoints carry no information after the first one: same run, same status, same
// counts, a larger number of minutes.
//
// So consecutive checkpoints for the same run collapse into the newest one, carrying a
// `repeat` count. The information is preserved (how long, how many times) and the ring
// stops being a denial-of-service on the rest of the log.
const COLLAPSIBLE = new Set(['run-checkpoint']);
function recordEvent(taskId, event) {
  const state = loadState();
  const entry = { taskId, type: cleanText(event.type, 80), status: cleanText(event.status, 80),
    provider: cleanText(event.provider, 80), evidence: cleanText(event.evidence, 300), at: new Date().toISOString() };
  const last = state.events[state.events.length - 1];
  if (last && COLLAPSIBLE.has(entry.type) && last.type === entry.type && last.taskId === entry.taskId) {
    state.events[state.events.length - 1] = { ...entry, repeat: (last.repeat || 1) + 1, firstAt: last.firstAt || last.at };
  } else {
    state.events.push(entry);
  }
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
  findPlan, recordEvent, updateTaskStatus, recordTaskOutcome, savePhysicalLayout, saveFleetMetrics, rememberIdea, assertExecutor, canSpend };
