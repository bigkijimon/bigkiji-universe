import { useEffect, useRef } from 'react';
import Thread from './components/Thread.jsx';
import Composer from './components/Composer.jsx';
import ApprovalBar from './components/ApprovalBar.jsx';
import SpecialistPanes from './components/SpecialistPanes.jsx';
import TerminalView from './components/TerminalView.jsx';
import SessionDrawer from './components/SessionDrawer.jsx';
import WorkTimeline from './components/WorkTimeline.jsx';
import ArtifactsPanel from './components/ArtifactsPanel.jsx';
import { useStore } from './lib/useStore.js';
import { setState, getState } from './lib/store.js';
import { api, refreshSessions } from './lib/ipc.js';

import { KEYMAP, matches, nextExecutionMode } from './lib/keymap.mjs';

// The working surface.
//
// The Synapse Canvas is the story BigKiji tells about itself; this is the window you
// actually get work done in, so it is quiet on purpose: a light, opaque, high-density
// workspace with one thing on screen at a time. The 3D scene is one button away and never
// underneath the text.
//
// House rules that constrain everything here and in styles/console.css:
//   - No backdrop-filter anywhere. This window is opaque and sets no vibrancy, and mixing
//     the two breaks the material outright (electron#39529, measured in glass-lab).
//   - Motion is transform/opacity only, ease-out, under 300ms, and honours both
//     prefers-reduced-motion and appearance.reduceMotion.
//   - Every control is bound to a setting that exists.

let nextTurnId = 0;

export default function App() {
  const view = useStore((s) => s.view);
  const sessions = useStore((s) => s.sessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const artifactsOpen = useStore((s) => s.artifactsOpen);
  const artifacts = useStore((s) => s.artifacts);
  const workspace = useStore((s) => s.workspace);
  const buildId = useStore((s) => s.buildId);
  const diff = useStore((s) => s.diff);
  const inputRef = useRef(null);

  // Persisted, because a drawer that reopens itself every launch is a drawer the owner
  // has to close every launch. Default is open: there are already 53 sessions to show, so
  // it is never an empty panel taking up room.
  const toggleSidebar = () => {
    const next = !getState().sidebarOpen;
    setState({ sidebarOpen: next });
    api.settingsUpdate({ appearance: { consoleSidebar: next } }).catch(() => {});
  };

  const setView = (next) => {
    setState({ view: next });
    if (next === 'chat') setTimeout(() => inputRef.current?.focus(), 0);
  };

  async function send(text) {
    const value = String(text ?? '').trim();
    if (!value || getState().busy) return;
    const ownerId = `t${nextTurnId += 1}`;
    const pendingId = `t${nextTurnId += 1}`;
    setState((prev) => ({
      busy: true,
      turns: prev.turns.concat(
        { id: ownerId, role: 'owner', text: value },
        { id: pendingId, role: 'agent', pending: true },
      ),
    }));
    const began = Date.now();
    try {
      const turn = await api.conversationTurn(value, {}) || {};
      const ms = Date.now() - began;
      const used = turn?.context?.estimatedTokens || 0;
      const limit = turn?.context?.limit || 0;
      setState((prev) => ({
        turns: prev.turns.map((item) => (item.id === pendingId
          ? {
            id: pendingId,
            role: 'agent',
            text: turn.reply || '',
            model: turn.model,
            degraded: turn.degraded,
            error: turn.error,
            ttftMs: turn.ttftMs,
            ms,
            at: Date.now(),
          }
          : item)),
        context: limit
          ? { pct: Math.max(0, Math.min(100, Math.round((used / limit) * 100))), used, limit }
          : prev.context,
      }));
    } catch (error) {
      setState((prev) => ({
        turns: prev.turns.map((item) => (item.id === pendingId
          ? {
            id: pendingId,
            role: 'agent',
            degraded: true,
            text: String(error?.message || error),
            ms: Date.now() - began,
            at: Date.now(),
          }
          : item)),
      }));
    } finally {
      setState({ busy: false });
    }
  }

  // Keyboard. The bindings live in lib/keymap.mjs so the selftest can check the contract
  // rather than grep for a character literal.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (matches(event, KEYMAP.viewChat)) { event.preventDefault(); setView('chat'); }
      else if (matches(event, KEYMAP.viewTerminal)) { event.preventDefault(); setView('terminal'); }
      else if (matches(event, KEYMAP.focusComposer)) { event.preventDefault(); setView('chat'); }
      else if (matches(event, KEYMAP.toggleSidebar)) { event.preventDefault(); toggleSidebar(); }
      else if (matches(event, KEYMAP.cycleMode)) {
        // preventDefault is the whole feature here: without it the browser moves focus
        // backwards and the mode never changes, which is what the owner reported.
        // getState() rather than a captured value — this effect has an empty dep list,
        // so a closed-over `settings` would be the one from mount, forever.
        event.preventDefault();
        const current = getState().settings?.routing?.executionMode || 'plan';
        api.settingsUpdate({ routing: { executionMode: nextExecutionMode(current) } })
          .catch(() => { /* the select stays where it was; nothing to say about it */ });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Boot.
  useEffect(() => {
    (async () => {
      try {
        const settings = await api.settingsGet();
        if (settings) {
          setState({
            settings,
            agentName: String(settings.piAgent?.displayName || '').trim() || 'PiAgent',
            sidebarOpen: settings.appearance?.consoleSidebar !== false,
          });
          document.body.classList.toggle('reduce-motion', !!settings.appearance?.reduceMotion);
        }
      } catch (_) { /* settings may not be readable yet */ }

      let info = null;
      try { info = await api.getInfo(); } catch (_) { /* daemon may be down */ }
      setState({ buildId: info?.buildId ? String(info.buildId) : '' });

      // Registered workspaces first. With none registered, the vault BigKiji is actually
      // reading is still the honest answer — saying "no workspace" while the app is
      // happily indexing one would be worse than saying nothing.
      try {
        const state = await api.workspaceState();
        const roots = (state?.roots || []).filter((root) => root.status === 'ok');
        if (roots.length) {
          setState({
            workspace: {
              label: roots[0].label || roots[0].path,
              extra: roots.length > 1 ? ` +${roots.length - 1}` : '',
              title: roots.map((root) => root.path).join('\n'),
            },
          });
        } else {
          const vault = info?.paths?.vaultRoot || '';
          setState({
            workspace: vault
              ? { label: vault.split('/').pop(), extra: ' · not registered', title: vault }
              : { label: 'No workspace', extra: '', title: '' },
          });
        }
      } catch (_) { setState({ workspace: { label: '—', extra: '', title: '' } }); }

      await refreshSessions();

      // A run may already be in flight, or already waiting for an approval the owner never
      // saw because this window was not open yet.
      try {
        const runs = await api.listRuns();
        const live = (Array.isArray(runs) ? runs : [])
          .filter((run) => !['COMPLETED', 'FAILED'].includes(run.status)).pop();
        if (live) setState({ run: live });
      } catch (_) { /* no coordinator yet */ }

      inputRef.current?.focus();
    })();
  }, []);

  // The gear is wired against the same settings surface the Synapse Canvas uses. Two
  // windows must never grow two different settings dialogs.
  const settingsBtn = useRef(null);
  useEffect(() => {
    if (settingsBtn.current) globalThis.window?.BKSettings?.init?.(settingsBtn.current);
  }, []);

  return (
    <>
      <div className="titlebar">
        <button
          className="iconbtn"
          type="button"
          aria-label="Toggle sessions"
          aria-expanded={sidebarOpen}
          title={`Sessions (${KEYMAP.toggleSidebar.label})`}
          onClick={toggleSidebar}
        >☰</button>
        <span className="title">BigKiji Console</span>
        <span className="sub">{buildId}</span>
        <span className="spacer" />
        <div className="actions">
          <button
            className={`iconbtn${artifacts.length ? ' marked' : ''}`}
            type="button"
            aria-label="Results"
            aria-expanded={artifactsOpen}
            title="Results"
            onClick={() => setState({ artifactsOpen: !artifactsOpen })}
          >◱</button>
          <button className="iconbtn" type="button" title="Open Synapse Canvas" onClick={() => api.openMain()}>◎</button>
          <button className="iconbtn accent" type="button" title="Settings (⌘,)" ref={settingsBtn}>⚙</button>
        </div>
      </div>

      {/* The rail and the work area translate together inside one track, so opening the
          drawer is a single transform rather than an animated width — no layout is
          animated, which is the house rule. */}
      <div className="shell" data-sidebar={sidebarOpen ? 'on' : 'off'}>
        <SessionDrawer />
        <div className="body">
          <section className={`view${view === 'chat' ? ' on' : ''}`} role="tabpanel" aria-label="Conversation">
            <ApprovalBar />
            <div className="panes">
              <div className="pane pane-chat">
                <Thread onSend={send} timeline={<WorkTimeline />} />
                <Composer inputRef={inputRef} onSend={send} />
              </div>
              <SpecialistPanes />
            </div>
          </section>

          <section className={`view${view === 'terminal' ? ' on' : ''}`} role="tabpanel" aria-label="Terminal">
            <TerminalView active={view === 'terminal'} />
          </section>
          <ArtifactsPanel />
        </div>
      </div>

      <footer className="status">
        <span title={workspace?.title || ''}>
          <b>{workspace?.label || '—'}</b>{workspace?.extra || ''}
        </span>
        <span
          className="add"
          title={diff.added || diff.removed
            ? `${diff.added} line${diff.added === 1 ? '' : 's'} added, ${diff.removed} removed across this run`
            : ''}
        >
          {diff.added || diff.removed ? (
            <>
              <span className="plus">{`+${diff.added}`}</span>
              <span className="minus">{`−${diff.removed}`}</span>
            </>
          ) : null}
        </span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
          <button type="button" aria-pressed={view === 'terminal'} onClick={() => setView('terminal')}>Terminal</button>
        </div>
        <button className="link" type="button" onClick={() => api.openMain()}>Synapse ◎</button>
      </footer>
    </>
  );
}
