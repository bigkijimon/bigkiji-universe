import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/useStore.js';
import { api } from '../lib/ipc.js';

const clock = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// Every control here is bound to a setting that exists. Where a reference interface shows
// a "reasoning effort" dial, this shows execution mode and deliberation lenses, because
// those are the settings BigKiji actually has. Inventing a control that changes nothing is
// worse than not having one.
export default function Composer({ inputRef, onSend }) {
  const busy = useStore((s) => s.busy);
  const context = useStore((s) => s.context);
  const settings = useStore((s) => s.settings);
  const [value, setValue] = useState('');
  const [elapsed, setElapsed] = useState('');
  const startedAt = useRef(0);

  useEffect(() => {
    if (!busy) { setElapsed(''); return undefined; }
    startedAt.current = Date.now();
    const id = setInterval(() => setElapsed(clock(Date.now() - startedAt.current)), 100);
    return () => clearInterval(id);
  }, [busy]);

  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(210, el.scrollHeight)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    if (inputRef.current) { inputRef.current.style.height = 'auto'; }
    onSend(text);
  };

  const pct = context.pct;

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          id="input"
          ref={inputRef}
          rows={1}
          placeholder="Type a message…  (⌘L to focus)"
          aria-label="Message"
          value={value}
          onChange={(event) => { setValue(event.target.value); autoGrow(event.target); }}
          onKeyDown={(event) => {
            // isComposing matters: an IME candidate window is confirmed with Enter, and
            // sending there would cut the owner's sentence in half mid-word.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="metarow">
          <span className="sel" title="Local conversation model">
            <b>{settings?.conversation?.model || '—'}</b>
          </span>
          <span className="sel" title="Execution mode — what happens when work is planned">
            <select
              aria-label="Execution mode"
              value={settings?.routing?.executionMode || 'plan'}
              onChange={(event) => api.settingsUpdate({ routing: { executionMode: event.target.value } })}
            >
              <option value="plan">Plan</option>
              <option value="auto">Auto-plan</option>
              <option value="manual">Manual</option>
            </select>
          </span>
          <span className="sel optional" title="Independent proposals taken before work starts">
            <select
              aria-label="Deliberation"
              value={String(settings?.routing?.deliberationLenses ?? 2)}
              onChange={(event) => api.settingsUpdate({ routing: { deliberationLenses: Number(event.target.value) } })}
            >
              <option value="0">No deliberation</option>
              <option value="2">2 lenses</option>
              <option value="3">3 lenses</option>
            </select>
          </span>
          <span className="grow" />
          <span className="elapsed">{elapsed}</span>
          <span
            className="ring"
            style={{ '--pct': String(pct ?? 0) }}
            title={context.limit
              ? `Context used in the last turn: ${context.used} of ${context.limit} estimated tokens`
              : 'Context used in the last turn'}
          >
            <i>{pct == null ? '—' : `${pct}%`}</i>
          </span>
          <button
            className={`send${busy ? ' stop' : ''}`}
            id="send"
            type="button"
            aria-label={busy ? 'Stop' : 'Send'}
            disabled={!busy && !value.trim()}
            onClick={() => (busy ? api.piAbort() : submit())}
          >{busy ? '■' : '↑'}</button>
        </div>
      </div>
    </div>
  );
}
