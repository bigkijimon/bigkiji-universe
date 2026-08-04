import { useSyncExternalStore } from 'react';
import { subscribe, getState } from './store.js';

/**
 * Read one slice of the store. `select` must return a stable value for unchanged state —
 * the store replaces whole keys rather than mutating them, so selecting a key is stable;
 * building a new object or array inside the selector is not, and will re-render forever.
 */
export function useStore(select) {
  return useSyncExternalStore(subscribe, () => select(getState()));
}
