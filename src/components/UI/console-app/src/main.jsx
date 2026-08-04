import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startIpc } from './lib/ipc.js';

// Shared with the Synapse Canvas, imported for their side effects rather than rewritten.
//
// markdown.js must not be touched: tools/markdown-selftest.js loads it with require(),
// so adding an `export` would break the test suite with a SyntaxError. It already ends
// with a guarded dual export — the `typeof module` check is safe under ESM, where it
// falls through and assigns window.BKMarkdown, which is what we read.
//
// settings-modal.js does the same for window.BKSettings. Two windows must never grow two
// different settings dialogs.
import '../../markdown.js';
import '../../settings-modal.js';
import '../../settings-modal.css';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/console.css';

// Subscribe before the first render. preload.js has no way to unsubscribe, so this
// happens exactly once, at module scope, and never from a component. See lib/ipc.js.
startIpc();

// No StrictMode.
//
// Its double-invoke is a good thing in an app whose effects are all idempotent, and this
// one's are not: the xterm instance is real, the pty behind it is a real process, and
// preload's on*() helpers stack handlers with no way to remove them. Mounting twice would
// open two terminals against one pty and write every byte twice.
createRoot(document.getElementById('root')).render(<App />);
