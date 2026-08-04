import { useState } from 'react';
import { useStore } from '../lib/useStore.js';
import { api } from '../lib/ipc.js';
import { approvalPlan, approvalSummary, buildApprovalPayload, isBlocked } from '../lib/approval-payload.mjs';

// The approval gate. Nothing that can mutate anything starts without passing through
// here, and it is the loudest thing in the window on purpose: this is the moment the
// owner decides to spend money and let something write to disk, and the plan hash is what
// they are agreeing to.
//
// The payload is built by a pure function from the run object the coordinator last sent,
// never from component state — core-execution-coordinator.js approve() rejects a stale
// revision, plan or disclosure rather than running something the owner did not see.
export default function ApprovalBar() {
  const run = useStore((s) => s.run);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  const summary = approvalSummary(run);
  if (!summary) return null;

  const blocked = isBlocked(run);
  const plan = approvalPlan(run);

  const approve = async () => {
    const payload = buildApprovalPayload(run);
    if (!payload || sending) return;
    setSending(true);
    try {
      await api.approveRun(payload);
    } catch (err) {
      setError(String(err?.message || err));
      setSending(false);
    }
  };

  // The bar states the decision; the block under it states what the decision is about.
  // Who, on which model, allowed to write or not, and which files they will open —
  // every field already arrived in the run object and none of it used to be shown.
  return (
    <div className="approval">
      <div className="approval-head">
        <div className="approval-text">
          <b>{summary.title}</b>
          <span>{error || summary.detail}</span>
        </div>
        <button className="ghost" type="button" onClick={() => run && api.abortRun(run.id).catch(() => {})}>Abort</button>
        <button className="primary" type="button" disabled={blocked || sending} onClick={approve}>
          {blocked ? 'Blocked' : 'Approve'}
        </button>
      </div>
      {plan ? (
        <div className="approval-plan">
          {plan.goal ? <p className="approval-goal">{plan.goal}</p> : null}
          {/* A question the plan could not answer is the one thing here that can make
              the whole run wrong, so it sits above the assignments, not below them. */}
          {plan.questions.map((question) => (
            <p className="approval-question" key={question}>⚠ unanswered · {question}</p>
          ))}
          {/* Groundwork that did not happen. The owner watched both lenses die and was
              still shown a plan with nothing marking it as uninformed — so this sits with
              the unanswered questions, above the assignments, and only appears when the
              groundwork genuinely failed. A run that never had a deliberation stage says
              nothing here rather than warning about an absence that was never planned. */}
          {plan.groundwork && plan.groundwork.lenses > 0 && plan.groundwork.completed === 0 ? (
            <div className="approval-groundwork">
              <p className="approval-question">
                ⚠ 下調べ 0/{plan.groundwork.lenses} 成立 · この計画は下調べなしで書かれています
              </p>
              {plan.groundwork.failures.map((failure) => (
                <p className="approval-groundwork-why" key={`${failure.who}-${failure.engine}`}>
                  {[failure.who, failure.engine].filter(Boolean).join(' · ')} — {failure.reason || 'failed'}
                </p>
              ))}
            </div>
          ) : null}
          <ul className="approval-rows">
            {plan.rows.map((row) => (
              <li key={row.key}>
                <span className="approval-who">{row.who || row.engine}</span>
                <span className="approval-engine">{row.who ? row.engine : ''}</span>
                {row.access ? <span className={`approval-access is-${row.access}`}>{row.access}</span> : null}
                <span className="approval-title">{row.title}</span>
              </li>
            ))}
          </ul>
          {plan.reads.map((entry) => (
            <p className="approval-reads" key={entry.provider}>
              {entry.provider} reads {entry.files.length} file{entry.files.length === 1 ? '' : 's'} · {entry.files.slice(0, 4).join(' · ')}
              {entry.files.length > 4 ? ` … +${entry.files.length - 4}` : ''}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
