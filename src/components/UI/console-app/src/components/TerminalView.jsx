import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, onPtyData } from '../lib/ipc.js';
// Side-effect import: defines window.BKXtermTheme. The Synapse Canvas loads the same file
// with a <script src>, so the two terminals mirroring one pty cannot drift apart.
import '../../../../../domain/terminal/xterm-theme.js';

// The pty is the one BigKiji already runs; this window mirrors it rather than starting a
// second shell, so what the owner sees here is the same session the Synapse Canvas shows.
//
// The terminal is created once and kept for the life of the window. It is deliberately
// not torn down when the view switches to the conversation: destroying it would drop the
// scrollback, and re-attaching to a live pty mid-stream loses bytes.
export default function TerminalView({ active }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (termRef.current || !hostRef.current) return undefined;
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      // Colours come from the stylesheet, so a theme change is a re-read rather than a
      // second copy of the palette living here.
      theme: window.BKXtermTheme.themeFor(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try { fit.fit(); api.ptyResize(term.cols, term.rows); } catch (_) { /* not attached yet */ }
    };
    doFit();

    term.onData((data) => api.ptyInput(data));
    // A Set membership, not an ipcRenderer subscription — see lib/ipc.js for why that
    // distinction is the difference between one terminal and two.
    const detach = onPtyData((data) => term.write(data));
    // Follows both the OS changing and the owner picking light/dark by hand: the main
    // process drives prefers-color-scheme through nativeTheme.themeSource, so one media
    // query listener covers both.
    const unwatch = window.BKXtermTheme.watchTheme(term);
    window.addEventListener('resize', doFit);

    return () => {
      detach();
      unwatch();
      window.removeEventListener('resize', doFit);
    };
  }, []);

  // Fitting a hidden element measures zero rows. Refit when it becomes visible instead.
  useEffect(() => {
    if (!active || !termRef.current) return;
    try {
      fitRef.current?.fit();
      api.ptyResize(termRef.current.cols, termRef.current.rows);
      termRef.current.focus();
    } catch (_) { /* nothing attached */ }
  }, [active]);

  return <div id="termHost" ref={hostRef} />;
}
