// Naming and ordering the owner's session history.
//
// A session is named after what the owner actually asked for. The store keeps that as
// promptSummary; falling back to the generated id produced a strip of
// "session-msb1cu3c-e744b1", which tells the owner nothing about which one to click.
//
// The store returns newest first (session-store.js sorts by updatedAt descending), so the
// current session is the head. Nothing here re-sorts; grouping preserves that order
// inside each bucket.

export const RUNNING = new Set(['running', 'EXECUTING', 'PREFLIGHT', 'REPAIRING']);

export function isRunning(session) {
  return RUNNING.has(session?.status);
}

export function sessionLabel(session) {
  const summary = String(session?.promptSummary || '').replace(/\s+/g, ' ').trim();
  if (summary) return summary.length > 34 ? `${summary.slice(0, 33)}…` : summary;
  const when = session?.updatedAt || session?.createdAt;
  return when ? new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Session';
}

const DAY = 86400000;

/**
 * Bucket sessions by age. `now` is a parameter rather than a Date.now() call so the test
 * can pin the boundaries instead of hoping it does not run at midnight.
 */
export function groupSessions(sessions, now = Date.now()) {
  // Midnight local, so "Today" means the calendar day the owner is looking at rather than
  // the last 24 hours. A session from 23:50 yesterday is yesterday's, not today's.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();

  const buckets = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'week', label: 'Previous 7 days', items: [] },
    { key: 'month', label: 'Previous 30 days', items: [] },
    { key: 'older', label: 'Older', items: [] },
  ];
  const at = (session) => new Date(session?.updatedAt || session?.createdAt || 0).getTime();

  for (const session of sessions || []) {
    const when = at(session);
    if (when >= today) buckets[0].items.push(session);
    else if (when >= today - DAY) buckets[1].items.push(session);
    else if (when >= today - 7 * DAY) buckets[2].items.push(session);
    else if (when >= today - 30 * DAY) buckets[3].items.push(session);
    else buckets[4].items.push(session);
  }
  return buckets.filter((bucket) => bucket.items.length);
}

/**
 * Client-side only. The store is not queried again — 53 sessions of metadata are already
 * in memory, and a round trip per keystroke would be slower and no more correct.
 */
export function filterSessions(sessions, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return sessions || [];
  return (sessions || []).filter((session) => {
    const summary = String(session?.promptSummary || '').toLowerCase();
    const id = String(session?.id || '').toLowerCase();
    return summary.includes(needle) || id.includes(needle);
  });
}
