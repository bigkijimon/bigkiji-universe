import { useState } from 'react';
import { useStore } from '../lib/useStore.js';
import { api } from '../lib/ipc.js';
import { approvalSummary, buildApprovalPayload, isBlocked } from '../lib/approval-payload.mjs';

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

  return (
    <div className="approval">
      <div className="approval-text">
        <b>{summary.title}</b>
        <span>{error || summary.detail}</span>
      </div>
      <button className="ghost" type="button" onClick={() => run && api.abortRun(run.id).catch(() => {})}>Abort</button>
      <button className="primary" type="button" disabled={blocked || sending} onClick={approve}>
        {blocked ? 'Blocked' : 'Approve'}
      </button>
    </div>
  );
}
