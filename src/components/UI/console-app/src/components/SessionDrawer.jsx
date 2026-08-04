import { useStore } from '../lib/useStore.js';
import { setState } from '../lib/store.js';
import { api } from '../lib/ipc.js';
import { groupSessions, filterSessions, sessionLabel, isRunning } from '../lib/sessions.mjs';
import { KEYMAP } from '../lib/keymap.mjs';

// Session history.
//
// This replaces a strip of at most eight horizontal tabs. There are 53 session files on
// this machine, so the strip could reach fewer than a sixth of them and gave no way to
// search — the history existed but was not reachable, which is the same as not having it.
//
// Sessions are grouped by day rather than listed flat because the owner looks for "the one
// from yesterday", not for position 27. Search filters client-side: the metadata for every
// session is already in memory, so a round trip per keystroke would be slower and no more
// correct.
export default function SessionDrawer() {
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const query = useStore((s) => s.sessionQuery);
  const agentName = useStore((s) => s.agentName);

  const groups = groupSessions(filterSessions(sessions, query));
  const shown = groups.reduce((n, group) => n + group.items.length, 0);

  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail-head">
        <input
          className="rail-search"
          type="search"
          value={query}
          placeholder="Search sessions"
          aria-label="Search sessions"
          onChange={(event) => setState({ sessionQuery: event.target.value })}
        />
      </div>

      <nav className="rail-list">
        {shown === 0 ? (
          <p className="rail-empty">
            {sessions.length ? 'No session matches that.' : 'No sessions yet.'}
          </p>
        ) : groups.map((group) => (
          <section className="sgroup" key={group.key}>
            <h2 className="sgroup-label">{group.label}</h2>
            {group.items.map((session) => (
              <button
                className="srow"
                type="button"
                key={session.id}
                title={session.id}
                aria-current={String(session.id) === String(activeSessionId)}
                onClick={() => {
                  setState({ activeSessionId: session.id });
                  // Read-only for now: opening a session shows what happened. Continuing
                  // one would mean passing a sessionId into conversation:turn, and that
                  // call is deliberately left byte-identical in this pass.
                  api.getSession(session.id).catch(() => {});
                }}
              >
                <span className="srow-dot">{agentName.slice(0, 1).toUpperCase()}</span>
                <span className="srow-label">{sessionLabel(session)}</span>
                {isRunning(session) ? <span className="spin" aria-label="running" /> : null}
              </button>
            ))}
          </section>
        ))}
      </nav>

      <div className="rail-foot">
        {/* The real number, not the number that fits. The old strip showed eight and said
            nothing about the rest. */}
        {query
          ? `${shown} of ${sessions.length}`
          : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        <span className="rail-hint">{KEYMAP.toggleSidebar.label}</span>
      </div>
    </aside>
  );
}
