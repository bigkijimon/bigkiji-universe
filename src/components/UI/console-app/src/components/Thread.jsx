import { useEffect, useRef, useState } from 'react';
import AssistantMarkdown from './AssistantMarkdown.jsx';
import { useStore } from '../lib/useStore.js';

const clock = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const timeOf = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Phrased as work this app can actually do, so nothing here dead-ends.
const QUICK = [
  { label: 'Review changes', icon: '◇', prompt: 'Review the changes in this workspace and tell me what looks wrong.' },
  { label: 'Explain this repo', icon: '◈', prompt: 'Explain how this workspace is structured and where the entry points are.' },
  { label: 'Run the tests', icon: '▷', prompt: 'Run the test suite and report what failed, with the actual output.' },
  { label: 'Simplify', icon: '⌁', prompt: 'Find the most over-complicated part of this workspace and propose a simpler shape.' },
];

function Empty({ agentName, onQuick }) {
  return (
    <div className="empty">
      <div>
        <div className="mark">{agentName.slice(0, 1).toUpperCase()}</div>
        <h1>{`Chat with ${agentName}`}</h1>
        <p>Pick an action or start typing</p>
        <hr />
        <div className="actions-grid">
          {QUICK.map((item) => (
            <button className="chip" type="button" key={item.label} onClick={() => onQuick(item.prompt)}>
              <span className="g">{item.icon}</span>{item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Turn({ turn, agentName, onRedo }) {
  // The owner's own text is rendered as text. JSX interpolation escapes by construction —
  // there is no path here that could parse it.
  if (turn.role === 'owner') {
    return <div className="turn owner"><div className="bubble">{turn.text}</div></div>;
  }
  if (turn.pending) {
    return (
      <div className="turn agent">
        <div className="who">{agentName}</div>
        <div className="thinking"><span className="pulse" /><span>Thinking…</span></div>
      </div>
    );
  }
  const who = [agentName, turn.model].filter(Boolean).join(' · ');
  const parts = [timeOf(new Date(turn.at)), clock(turn.ms)];
  if (turn.ttftMs != null) parts.push(`first token ${clock(turn.ttftMs)}`);
  if (turn.degraded && turn.error) parts.push(turn.error);
  return (
    <div className={`turn agent${turn.degraded ? ' degraded' : ''}`}>
      <div className="who">{who}</div>
      <AssistantMarkdown text={turn.text} />
      <div className="meta">
        <span className="stamp">{parts.join(' · ')}</span>
        <span className="rule" />
        <button className="redo" type="button" aria-label="Ask again" onClick={() => onRedo(turn)}>↻</button>
      </div>
    </div>
  );
}

export default function Thread({ onSend, timeline }) {
  const turns = useStore((s) => s.turns);
  const agentName = useStore((s) => s.agentName);
  const scrollRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);

  const isAtBottom = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const scrollDown = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = document.body.classList.contains('reduce-motion')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  };

  // Follow the tail only while the owner is already at it. Yanking the view back down
  // while they are reading something further up is the rudest thing a transcript can do.
  useEffect(() => { if (atBottom) scrollDown(); }, [turns]); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = (turn) => {
    const index = turns.indexOf(turn);
    for (let i = index - 1; i >= 0; i -= 1) {
      if (turns[i].role === 'owner') { onSend(turns[i].text); return; }
    }
  };

  return (
    <>
      <div id="scroll" ref={scrollRef} onScroll={() => setAtBottom(isAtBottom())}>
        <div className="thread">
          {turns.length === 0
            ? <Empty agentName={agentName} onQuick={onSend} />
            : turns.map((turn) => (
              <Turn key={turn.id} turn={turn} agentName={agentName} onRedo={redo} />
            ))}
          {/* The work timeline sits at the tail of the transcript rather than in a panel
              of its own: what the agent is doing is part of the conversation, and reading
              it should not mean looking somewhere else. */}
          {timeline}
        </div>
      </div>
      <button
        id="toBottom"
        className={atBottom ? '' : 'on'}
        title="Jump to latest"
        type="button"
        onClick={() => scrollDown()}
      >↓</button>
    </>
  );
}
