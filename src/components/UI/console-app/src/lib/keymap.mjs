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
});

/** True when the event is the accelerator described by `binding`. */
export function matches(event, binding) {
  if (!binding) return false;
  if (binding.meta && !(event.metaKey || event.ctrlKey)) return false;
  return String(event.key).toLowerCase() === binding.key;
}
