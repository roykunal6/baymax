// Email → tasks. While Baymax is open and unlocked, it checks the Zoho inbox every 15 minutes (and
// when you come back to the app) and adds tasks for calls, deadlines, people chasing you, and
// questions you haven't answered. A "reply" task ticks itself off once you reply.
// Runs on your devices because the Zoho connection only works with your unlocked mail key.

import { state, save } from './store.js';
import { cloud } from './cloud.js';
import { mailApi } from './mail.js';

const EVERY = 15 * 60 * 1000;
const LAST = 'baymax:mailtasks-last';
const KEEP_DAYS = 45;
let running = false;
let toast = () => {};

const last = () => { try { return Number(localStorage.getItem(LAST)) || 0; } catch { return 0; } };
const setLast = (t) => { try { localStorage.setItem(LAST, String(t)); } catch { /* ignore */ } };
export const lastMailCheck = () => last();

function triageState() {
  if (!state.mailTriage) state.mailTriage = { on: true, seen: {} };
  if (!state.mailTriage.seen) state.mailTriage.seen = {};
  return state.mailTriage;
}

/** Apply a triage result to the task list. Pure enough to unit-test with a plain state object. */
export function applyTriage(st, result, now = Date.now()) {
  const tri = st.mailTriage || (st.mailTriage = { on: true, seen: {} });
  const seen = tri.seen || (tri.seen = {});
  const added = [], completed = [];
  for (const it of result.items || []) {
    if (seen[it.messageId]) continue;
    seen[it.messageId] = now;
    const id = `mail-${it.messageId}`;
    if (st.tasks.some((t) => t.id === id)) continue;
    const task = {
      id, title: it.title, due: it.due || null, done: false, notified: false, isTimer: false,
      createdAt: new Date(now).toISOString(),
      source: { type: 'mail', kind: it.kind, messageId: it.messageId, folderId: it.folderId, subject: it.subject, from: it.from?.name || it.from?.email || '' },
    };
    st.tasks.push(task);
    added.push(task);
  }
  for (const id of result.examined || []) if (!seen[id]) seen[id] = now;
  const replied = new Set(result.replied || []);
  for (const t of st.tasks) {
    if (!t.done && t.source?.type === 'mail' && (t.source.kind === 'reply' || t.source.kind === 'followup') && replied.has(t.source.messageId)) {
      t.done = true; t.doneAt = new Date(now).toISOString(); t.autoDone = 'replied';
      completed.push(t);
    }
  }
  const cutoff = now - KEEP_DAYS * 864e5;
  for (const [k, v] of Object.entries(seen)) if (v < cutoff) delete seen[k];
  return { added, completed };
}

/** Check the inbox now (or only if it's due). Quiet when Mail isn't connected or Baymax is locked. */
export async function checkMailForTasks({ force = false, announce = true } = {}) {
  if (running || !cloud.keys || !navigator.onLine) return null;
  if (!triageState().on && !force) return null;
  if (!force && Date.now() - last() < EVERY) return null;
  running = true;
  try {
    const r = await mailApi('triage', { days: 14, skip: Object.keys(triageState().seen) });
    setLast(Date.now());
    const out = applyTriage(state, r);
    if (out.added.length || out.completed.length) save();
    if (announce && out.added.length) toast(`Added ${out.added.length} task${out.added.length > 1 ? 's' : ''} from your email`);
    return out;
  } catch (e) {
    if (force) throw e;
    return null; // not connected / offline: try again next time
  } finally {
    running = false;
  }
}

let started = false;
export function startMailTasks(toastFn) {
  toast = toastFn || toast;
  if (started) return;
  started = true;
  setTimeout(() => checkMailForTasks(), 4000);
  setInterval(() => { if (!document.hidden) checkMailForTasks(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkMailForTasks(); });
}

export function setMailTasksOn(on) {
  triageState().on = !!on;
  save();
  if (on) checkMailForTasks({ force: true }).catch(() => {});
}
