import { useState } from 'react';
import { useStore } from '../lib/useStore.js';
import { progressOf } from '../lib/steps.mjs';

// What the agent is doing, while it does it.
//
// Before this, a run was visible only as raw provider stdout in the specialist panes —
// enough to prove something was happening, not enough to read. This is the same run,
// stated: which tool, on what, and how it went.
//
// Two rules it holds itself to.
//
// It never invents a denominator. The provider does not announce how many tools it will
// use, so there is no "step 3 of 7" here — that would be a progress bar that lies. The
// count is of work actually seen.
//
// It never becomes the only surface. The specialist panes stay. If a provider changes its
// stream format this timeline goes quiet, and a quiet timeline beside a live log is a
// degradation; a timeline that had replaced the log would be a blackout at exactly the
// moment the owner is deciding whether to approve.

const VERB = {
  Read: 'Read', Grep: 'Search', Glob: 'Find', Bash: 'Run',
  Edit: 'Edit', Write: 'Write', NotebookEdit: 'Edit',
};

function shortTarget(target) {
  if (!target) return '';
  // Paths read better from the end; commands read better from the start.
  if (target.includes('/')) {
    const parts = target.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }
  return target.length > 44 ? `${target.slice(0, 43)}…` : target;
}

function Step({ step }) {
  const [open, setOpen] = useState(false);
  const changed = step.status === 'ok' && (step.added || step.removed);
  return (
    <li className="step" data-state={step.status} data-tool={step.tool}>
      <span className="step-icon" aria-hidden="true" />
      <span className="step-verb">{VERB[step.tool] || step.tool}</span>
      <span className="step-target" title={step.target}>{shortTarget(step.target)}</span>
      {changed ? (
        <span className="step-stat">
          {step.added ? <b className="plus">{`+${step.added}`}</b> : null}
          {step.removed ? <b className="minus">{`−${step.removed}`}</b> : null}
        </span>
      ) : null}
      {step.durationMs != null && step.durationMs >= 100
        ? <span className="step-time">{`${(step.durationMs / 1000).toFixed(1)}s`}</span>
        : null}
      {step.errorText ? (
        <button
          className="step-expand"
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide detail' : 'Show detail'}
          onClick={() => setOpen(!open)}
        >⌄</button>
      ) : null}
      {open && step.errorText ? <pre className="step-detail">{step.errorText}</pre> : null}
    </li>
  );
}

export default function WorkTimeline() {
  const steps = useStore((s) => s.steps);
  const run = useStore((s) => s.run);
  const [collapsed, setCollapsed] = useState(false);

  if (!steps.length) return null;

  const { done, total, running, failed, added, removed } = progressOf(steps);
  const provider = run?.assignments?.[0]?.provider || steps[0]?.provider || '';

  // While work is in flight the tail is what matters; afterwards the whole run is a record
  // worth keeping but not worth filling the transcript with.
  const visible = collapsed ? [] : (running ? steps.slice(-6) : steps);

  const summary = running
    ? `Working · ${done} done`
    : `${total} step${total === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;

  return (
    <section className="worklog" data-running={!!running} aria-label="Work in progress">
      <header className="worklog-head">
        <span className="worklog-title">{summary}</span>
        {added || removed ? (
          <span className="worklog-stat">
            {added ? <b className="plus">{`+${added}`}</b> : null}
            {removed ? <b className="minus">{`−${removed}`}</b> : null}
          </span>
        ) : null}
        <span className="grow" />
        {provider ? <span className="worklog-who">{provider}</span> : null}
        <button
          className="worklog-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >⌄</button>
      </header>
      {visible.length ? (
        <ol className="worklog-steps">
          {visible.map((step) => <Step key={step.key} step={step} />)}
        </ol>
      ) : null}
      {/* Said plainly rather than left as an empty box: glm runs with --no-tools and the
          local models have no tool layer, so for those the absence of steps is the truth. */}
      {!running && !total ? <p className="worklog-none">This provider does not report tool steps.</p> : null}
    </section>
  );
}
