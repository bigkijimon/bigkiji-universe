// The only place in this window that touches window.bigkiji's event subscriptions.
//
// THIS IS NOT A STYLE RULE. preload.js exposes on*(cb) helpers that call
// ipcRenderer.on(...) and nothing else — there is no off, no removeListener, no returned
// unsubscribe (see src/core/preload.js, every on* line). A handler registered from a
// component effect is registered forever. Under React that means:
//
//   - every remount adds another handler
//   - every HMR update adds another handler
//   - StrictMode's deliberate double-invoke adds another handler
//
// and pty bytes get written to the terminal twice, task logs double up, and a turn
// appended on conversation:update appears N times. The bug looks like a rendering
// problem and is not one.
//
// So: subscribe once at module scope, fan out into the store, and let React read the
// store. Components never call bk.on*. console-window-selftest asserts that no file
// outside this one does.
//
// Commands (invoke/send) are safe anywhere and are re-exported below for convenience.

import { setState, getState } from './store.js';
import { appendBounded } from './ansi.mjs';
import { foldSteps, progressOf } from './steps.mjs';

const bk = globalThis.window?.bigkiji;

// The change counter is derived from `steps`, not counted here.
//
// It used to run its own diff parser over task:log. That could never work and had never
// worked: task-runner.js passes every stdout chunk through cleanText(), whose body
// includes `.replace(/\s+/g, ' ')`, so by the time a log line reaches this window it has
// no newlines in it — a line-oriented patch counter fed a single line reported 0 added
// and 0 removed for the entire life of the window. The numbers the owner is shown before
// approving anything were therefore always zero.
//
// task:step carries `added` / `removed` already, counted by stream-steps.js from the raw
// buffer before that flattening happens, so the totals are a fold over state we hold
// rather than a second parse of a string that lost the information.

// pty bytes do not go through the store. They arrive at keystroke frequency and their
// only consumer is xterm, which keeps its own buffer — routing them through React state
// would re-render the window on every character for no benefit. Instead the single
// ipcRenderer subscription fans out to this Set, which components may join and leave
// freely because removing from a Set is something we can actually do.
const ptySinks = new Set();

export function onPtyData(sink) {
  ptySinks.add(sink);
  return () => ptySinks.delete(sink);
}

let started = false;

export function startIpc() {
  // Idempotent even if something calls this twice: the whole point of the module is that
  // the handlers are attached exactly once.
  if (started || !bk) return;
  started = true;

  bk.onSettingsChanged?.((settings) => applySettings(settings));

  bk.onConversation?.(() => { void refreshSessions(); });
  bk.onSessionUpdate?.((session) => {
    if (session?.id) setState({ activeSessionId: session.id });
    void refreshSessions();
  });

  bk.onRunEvent?.((run) => ingestRun(run));

  bk.onTaskLog?.((log) => {
    const taskId = log?.taskId;
    if (!taskId) return;
    const text = log?.text || '';
    setState((prev) => ({
      taskLogs: { ...prev.taskLogs, [taskId]: appendBounded(prev.taskLogs[taskId] || [], text) },
    }));
  });

  bk.onTaskEvent?.((task) => {
    if (!task?.id) return;
    setState((prev) => {
      const run = prev.run;
      if (!run?.assignments) return null;
      const assignments = run.assignments.map((item) => (item.taskId === task.id
        ? { ...item, status: task.status || item.status } : item));
      return { run: { ...run, assignments } };
    });
    if (task.error) {
      setState((prev) => ({
        taskLogs: { ...prev.taskLogs, [task.id]: appendBounded(prev.taskLogs[task.id] || [], task.error) },
      }));
    }
  });

  // Structured work steps. The raw task:log above still runs — the timeline is an
  // additional reading of the same run, never a replacement for the log the owner falls
  // back to when a provider changes its output format.
  bk.onTaskStep?.((step) => {
    if (!step) return;
    setState((prev) => {
      const steps = foldSteps(prev.steps, [step]);
      const { added, removed } = progressOf(steps);
      return { steps, diff: { added, removed } };
    });
  });

  // Already broadcast to this window (main.js), just never consumed here before.
  bk.onDeliverables?.((items) => {
    setState({ artifacts: Array.isArray(items) ? items : [] });
  });

  bk.onPtyData?.((data) => { for (const sink of ptySinks) sink(data); });

  bk.onComposerFocus?.(() => setState({ view: 'chat' }));
  bk.onOpenSettings?.(() => globalThis.window?.BKSettings?.open?.());
}

function applySettings(settings) {
  if (!settings) return;
  const agentName = String(settings.piAgent?.displayName || '').trim() || 'PiAgent';
  setState({ settings, agentName });
  document.body.classList.toggle('reduce-motion', !!settings.appearance?.reduceMotion);
}

// A new run starts a new count.
function ingestRun(run) {
  if (!run || !run.id) return;
  if (getState().run?.id !== run.id) {
    // A new run starts a new timeline as well as a new count. Carrying the previous
    // run's tally forward would overstate what the owner is about to approve.
    setState({ diff: { added: 0, removed: 0 }, steps: [] });
  }
  setState({ run });
}

export async function refreshSessions() {
  try {
    const list = await bk.listSessions();
    const sessions = Array.isArray(list) ? list : (list?.items || []);
    const { activeSessionId } = getState();
    // The store returns newest first, so the head is the current one. Taking the tail
    // selected the oldest, which then sat off the end of the strip with nothing
    // appearing selected.
    const stillThere = sessions.some((session) => session.id === activeSessionId);
    setState({
      sessions,
      activeSessionId: stillThere ? activeSessionId : (sessions[0]?.id ?? null),
    });
  } catch (_) { /* the daemon may not be up yet; the list stays as it is */ }
}

// ---- commands ---------------------------------------------------------------
export const api = {
  conversationTurn: (text, options) => bk.conversationTurn(text, options),
  piAbort: () => bk.piAbort(),
  approveRun: (payload) => bk.approveRun(payload),
  abortRun: (id) => bk.abortRun(id),
  listRuns: () => bk.listRuns(),
  getSession: (id) => bk.getSession(id),
  settingsGet: () => bk.settingsGet(),
  settingsUpdate: (patch) => bk.settingsUpdate(patch),
  workspaceState: () => bk.workspaceState(),
  getInfo: () => bk.getInfo(),
  openMain: () => bk.openMain(),
  openExternal: (url) => bk.openExternal(url),
  reveal: (p) => bk.reveal(p),
  ptyInput: (data) => bk.ptyInput(data),
  ptyResize: (cols, rows) => bk.ptyResize(cols, rows),
};
