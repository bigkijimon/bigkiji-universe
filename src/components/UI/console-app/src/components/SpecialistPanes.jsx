import { useEffect, useRef } from 'react';
import { useStore } from '../lib/useStore.js';

// When the coordinator plans a run it assigns roles to separate provider processes —
// leader to Claude Code, ui to Codex, debug to GLM, and so on. Each of those is a real
// process with its own model and its own output, so each gets a pane. This is the one
// place in the app where "several models are working at once" stops being a claim in a
// status line and becomes something the owner can watch.
function Pane({ assignment }) {
  const lines = useStore((s) => s.taskLogs[assignment.taskId]);
  const logRef = useRef(null);

  // Follow the tail only when already at it, so reading back through a long log is not
  // interrupted by the next chunk arriving.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (stuck) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="pane pane-agent" title={assignment.title || ''}>
      <div className="pane-head">
        <span className="role">{assignment.role || 'agent'}</span>
        {/* Provider and model together: "which brain" is part of what was approved, and a
            fallback can move the work to a different provider mid-run. */}
        <span className="who">{[assignment.provider, assignment.model].filter(Boolean).join(' · ')}</span>
        <span className="grow" />
        <span className="state" data-state={assignment.status || ''}>
          {String(assignment.status || '').replace(/_/g, ' ') || '—'}
        </span>
      </div>
      <div className="pane-log" ref={logRef}>
        {/* Set as text, never parsed — this is raw CLI output, already stripped of escape
            sequences by lib/ansi.js before it reached the store. */}
        {lines?.length
          ? lines.map((line, index) => <span key={index}>{`${line}\n`}</span>)
          : <span className="idle">Waiting for approval…</span>}
      </div>
    </div>
  );
}

export default function SpecialistPanes() {
  const run = useStore((s) => s.run);
  const assignments = Array.isArray(run?.assignments) ? run.assignments : [];
  return assignments.map((assignment) => <Pane key={assignment.taskId} assignment={assignment} />);
}
