import { useEffect, useRef } from 'react';
import { useStore } from '../lib/useStore.js';
import { setState } from '../lib/store.js';
import { api } from '../lib/ipc.js';
import { changedFiles, stepsForRun } from '../lib/steps.mjs';

// What came out of the work.
//
// Two tabs, both derived from things that already existed and were simply not shown here:
// `vault:deliverables` has been broadcast to this window all along and only the 3D canvas
// consumed it, and "this run" falls out of the step stream for free.
//
// It overlays rather than splits. The comment that used to sit above .panes records why:
// three fixed-width specialist panes once squeezed the conversation and its composer down
// to nothing, so the owner could watch the work but no longer talk to it. A permanent
// third column would repeat that.
//
// It does not open itself. A panel that appears while you are reading is an interruption,
// so a new deliverable marks the button instead and the owner opens it when they want it.

function name(item) {
  const path = String(item?.path || item?.name || '');
  return path.split('/').filter(Boolean).pop() || path;
}

function Row({ label, sub, onReveal, stat }) {
  return (
    <li className="artifact">
      <button className="artifact-main" type="button" onClick={onReveal} title={sub}>
        <span className="artifact-name">{label}</span>
        {sub ? <span className="artifact-sub">{sub}</span> : null}
      </button>
      {stat}
    </li>
  );
}

export default function ArtifactsPanel() {
  const open = useStore((s) => s.artifactsOpen);
  const artifacts = useStore((s) => s.artifacts);
  const steps = useStore((s) => s.steps);
  const run = useStore((s) => s.run);
  const closeRef = useRef(null);

  const changed = changedFiles(stepsForRun(steps, run));

  // Escape closes it and focus goes back where it came from, so the panel never traps the
  // keyboard on the way to the composer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setState({ artifactsOpen: false }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <aside className={`artifacts${open ? ' on' : ''}`} aria-label="Results" aria-hidden={!open}>
      <header className="artifacts-head">
        <h2>Results</h2>
        <span className="grow" />
        <button
          className="iconbtn"
          type="button"
          ref={closeRef}
          aria-label="Close results"
          onClick={() => setState({ artifactsOpen: false })}
        >✕</button>
      </header>

      <div className="artifacts-body">
        {changed.length ? (
          <section className="artifacts-group">
            <h3>This run</h3>
            <ul>
              {changed.map((file) => (
                <Row
                  key={file.path}
                  label={name(file)}
                  sub={file.path}
                  onReveal={() => api.reveal(file.path)}
                  stat={(
                    <span className="artifact-stat">
                      {file.added ? <b className="plus">{`+${file.added}`}</b> : null}
                      {file.removed ? <b className="minus">{`−${file.removed}`}</b> : null}
                    </span>
                  )}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="artifacts-group">
          <h3>Deliverables</h3>
          {artifacts.length ? (
            <ul>
              {artifacts.slice(0, 60).map((item, index) => (
                <Row
                  key={`${item?.path || index}`}
                  label={name(item)}
                  sub={String(item?.path || '')}
                  onReveal={() => api.reveal(item?.path)}
                  stat={null}
                />
              ))}
            </ul>
          ) : (
            <p className="artifacts-empty">Nothing produced yet.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
