import { useEffect, useRef } from 'react';
import { api } from '../lib/ipc.js';

// The ONLY place in this window that assigns HTML it did not construct itself.
//
// A model's reply is untrusted input: it quotes the owner's files, the output of tools,
// and text found on disk. window.BKMarkdown escapes first and marks up second — that
// order is not negotiable, and markdown.js documents why. Keeping the one
// dangerouslySetInnerHTML in a single named file is what makes the rule checkable:
// console-window-selftest asserts the string appears nowhere else.
//
// Everywhere else in this app, text goes through JSX interpolation and is escaped by
// React as a matter of construction.
export default function AssistantMarkdown({ text }) {
  const ref = useRef(null);
  const html = globalThis.window?.BKMarkdown?.renderMarkdown(text || '') ?? '';

  // Links open in the real browser. A renderer holding the whole bigkiji IPC surface must
  // never navigate itself, so the anchor's default action is cancelled and the URL is
  // handed to the shell. Code blocks copy from the DOM rather than from a cached string,
  // so what lands on the clipboard is what the owner can see.
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const onClick = (event) => {
      const link = event.target.closest('a[data-external]');
      if (link) { event.preventDefault(); api.openExternal(link.getAttribute('href')); return; }
      const copy = event.target.closest('[data-copy]');
      if (!copy) return;
      const code = copy.closest('figure.code')?.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      }).catch(() => { copy.textContent = 'Copy failed'; });
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, [html]);

  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
