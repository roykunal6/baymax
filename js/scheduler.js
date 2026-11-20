// Ticks every second: fires due reminders/timers and time-triggered routines.

import { state, updateTask } from './store.js';
import { dueTimedRoutines } from './routines.js';
import { dueItems, addDays, ymd } from './finance.js';

/** Payments due within the reminder window (or overdue) that haven't been announced today. */
function duesToAnnounce(now) {
  const fin = state.finance;
  if (!fin) return [];
  const today = ymd(now);
  const items = dueItems(fin, addDays(now, -30), addDays(now, Number(fin.remindDays ?? 2)))
    .filter((d) => !d.paid && d.direction !== 'in');
  fin.notified = fin.notified || {};
  const fresh = items.filter((d) => fin.notified[`${d.ref}:${d.id}:${d.key}`] !== today);
  for (const d of fresh) fin.notified[`${d.ref}:${d.id}:${d.key}`] = today;
  // keep the map small
  for (const [k, v] of Object.entries(fin.notified)) if (v < ymd(addDays(now, -60))) delete fin.notified[k];
  return fresh;
}

export function startScheduler({ onReminder, onRoutine, onDues }) {
  let lastDueCheck = 0;
  const tick = () => {
    const now = new Date();
    if (onDues && now - lastDueCheck > 60000 && now.getHours() >= 8) {
      lastDueCheck = +now;
      const fresh = duesToAnnounce(now);
      if (fresh.length) { onDues(fresh); }
    }
    for (const t of state.tasks) {
      if (!t.done && !t.notified && t.due && new Date(t.due) <= now) {
        updateTask(t.id, t.isTimer ? { notified: true, done: true } : { notified: true });
        onReminder(t);
      }
    }
    for (const r of dueTimedRoutines(now)) onRoutine(r);
  };
  tick();
  return setInterval(tick, 1000);
}

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, { body, icon: 'icon.svg', badge: 'icon.svg', tag: title + body, requireInteraction: true }); return true; }
    new Notification(title, { body, icon: 'icon.svg' });
    return true;
  } catch { return false; }
}
