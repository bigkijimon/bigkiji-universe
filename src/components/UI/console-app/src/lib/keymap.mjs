// Every keyboard shortcut this window owns, in one place.
//
// These used to be `event.key === '1'` literals scattered through the handler, which the
// selftest pinned by grepping for that exact string. Naming them means the test imports
// the map and checks the contract, instead of asserting that a particular character
// appears somewhere in a file.
//
// Reserved elsewhere — do not reuse:
//   ⌘,  Settings          (app menu)
//   ⌘N  New Console Window (app menu — the menu accelerator fires before any renderer
//                           keydown, so ⌘N cannot be rebound to "new conversation" here)
//   ⌘O  Open
export const KEYMAP = Object.freeze({
  viewChat: { key: '1', meta: true, label: '⌘1' },
  viewTerminal: { key: '2', meta: true, label: '⌘2' },
  focusComposer: { key: 'l', meta: true, label: '⌘L' },
  toggleSidebar: { key: 'b', meta: true, label: '⌘B' },
  // The only binding here that is not an accelerator, and the only one that has to
  // preventDefault to exist at all: in a browser, shift+Tab moves focus backwards. That
  // is precisely what the owner saw when they pressed it — the mode never changed
  // because the key never reached us (2026-08-10).
  cycleMode: { key: 'tab', shift: true, label: '⇧⇥' },
});

// The same cycle as the terminal's, written in the vocabulary this window saves.
//
// cli-theme.js MODE_CYCLE is ['ask', 'plan', 'auto-edit', 'demo']; settings.json has
// always spelled the third one `auto`, and `transportMode()` is the bridge. Two spellings
// of one list is exactly how the two surfaces drift apart, so the console selftest asserts
// `EXECUTION_MODE_CYCLE` equals `MODE_CYCLE.map(transportMode)` — a copy held in place by
// a failing test rather than by a comment asking nicely.
export const EXECUTION_MODE_CYCLE = Object.freeze(['ask', 'plan', 'auto', 'demo']);

/** The next execution mode, wrapping. Anything unrecognised starts the cycle at `ask`. */
export function nextExecutionMode(current) {
  const index = EXECUTION_MODE_CYCLE.indexOf(String(current || ''));
  return EXECUTION_MODE_CYCLE[(index + 1) % EXECUTION_MODE_CYCLE.length];
}

/** True when the event is the accelerator described by `binding`. */
export function matches(event, binding) {
  if (!binding) return false;
  if (binding.meta && !(event.metaKey || event.ctrlKey)) return false;
  // Shift is checked in both directions. Required-and-absent would let a bare Tab cycle
  // the mode while the owner is tabbing between fields; present-and-unwanted would let
  // ⇧⌘1 pass as ⌘1.
  if (!!binding.shift !== !!event.shiftKey) return false;
  return String(event.key).toLowerCase() === binding.key;
}
