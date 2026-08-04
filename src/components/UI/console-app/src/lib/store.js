// A plain external store, read through useSyncExternalStore.
//
// No state-management library is added. What this window needs is one object that IPC
// writes to and React reads from, and React has had the primitive for that built in since
// 18. A reducer library would be more code and more indirection for the same result.
//
// The store is a module singleton on purpose — see ipc.js for why that matters.

const listeners = new Set();

let state = {
  // conversation
  turns: [],            // { id, role: 'owner'|'agent', text, model, ms, ttftMs, degraded, error, at }
  busy: false,
  context: { pct: null, used: 0, limit: 0 },

  // sessions
  sessions: [],
  activeSessionId: null,

  // runs and specialists
  run: null,
  steps: [],            // folded task:step events — see lib/steps.mjs
  artifacts: [],        // vault:deliverables broadcast
  artifactsOpen: false,
  taskLogs: {},         // taskId -> string[]
  diff: { added: 0, removed: 0 },

  // shell
  view: 'chat',         // 'chat' | 'terminal'
  sidebarOpen: true,
  sessionQuery: '',
  settings: null,
  agentName: 'PiAgent',
  workspace: null,
  buildId: '',
};

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Merge a patch and notify. Accepts a function for updates that depend on the previous
 * value, so callers never read getState() and write back a stale object.
 */
export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next) return;
  let changed = false;
  for (const key of Object.keys(next)) {
    if (!Object.is(state[key], next[key])) { changed = true; break; }
  }
  if (!changed) return;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
