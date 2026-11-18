// Ticks every second: fires due reminders/timers and time-triggered routines.

import { state, updateTask } from './store.js';
import { dueTimedRoutines } from './routines.js';

export function startScheduler({ onReminder, onRoutine }) {
  const tick = () => {
    const now = new Date();
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
