// Automation engine: runs a routine's actions in order and fires time-based routines.

import { state, save, logActivity } from './store.js';

export async function runRoutine(routine, { execute, onResult, onStart, onDone }) {
  onStart?.(routine);
  logActivity(`Routine started: ${routine.name}`);
  for (const action of routine.actions || []) {
    try {
      const result = await execute(action);
      if (result && !result.silent && (result.reply || result.items)) await onResult?.(result, action);
    } catch (err) {
      await onResult?.({ reply: `Step failed (${action.type}): ${err.message}` }, action);
    }
  }
  routine.lastRun = new Date().toISOString();
  save();
  onDone?.(routine);
}

/** Return the routines whose time trigger matches `now` (minute precision) and haven't run this minute. */
export function dueTimedRoutines(now = new Date()) {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const stamp = `${now.toDateString()} ${hhmm}`;
  return state.routines.filter((r) => {
    if (!r.enabled || r.trigger?.type !== 'time') return false;
    if (r.trigger.time !== hhmm) return false;
    const days = r.trigger.days && r.trigger.days.length ? r.trigger.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(now.getDay())) return false;
    if (r._firedStamp === stamp) return false;
    r._firedStamp = stamp;
    return true;
  });
}

export function nextRunText(r) {
  if (r.trigger?.type !== 'time' || !r.trigger.time) return '';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = r.trigger.days && r.trigger.days.length && r.trigger.days.length < 7
    ? r.trigger.days.map((d) => names[d]).join(', ') : 'every day';
  return `${r.trigger.time} · ${days}`;
}
