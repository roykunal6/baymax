// Email → tasks. While Baymax is open and unlocked, it checks the Zoho inbox every 15 minutes (and
// when you come back to the app) and adds tasks for calls, deadlines, people chasing you, and
// questions you haven't answered. A "reply" task ticks itself off once you reply.
// Runs on your devices because the Zoho connection only works with your unlocked mail key.

import { state, save } from './store.js';
import { cloud } from './cloud.js';
import { mailApi, loadMailboxes } from './mail.js';

const EVERY = 15 * 60 * 1000;
const LAST = 'baymax:mailtasks-last';
const KEEP_DAYS = 45;
let running = false;
let toast = () => {};

const last = () => { try { return Number(localStorage.getItem(LAST)) || 0; } catch { return 0; } };
const setLast = (t) => { try { localStorage.setItem(LAST, String(t)); } catch { /* ignore */ } };
export const lastMailCheck = () => last();

function triageState() {
  if (!state.mailTriage) state.mailTriage = { on: false, seen2: {} };
  if (!state.mailTriage.seen2) state.mailTriage.seen2 = {};
  // You asked for it on: switch on once (synced), after that your switch decides.
  if (!state.mailTriage.v) { state.mailTriage.on = true; state.mailTriage.v = 2; save(); }
  // v3: only emails addressed to you. Re-check open email tasks once (done or deleted ones stay gone).
  if (state.mailTriage.v < 3) {
    const open = state.tasks.filter((t) => t.source?.type === 'mail' && !t.done);
    const recheck = new Set(open.map((t) => t.source.messageId));
    state.tasks = state.tasks.filter((t) => !(t.source?.type === 'mail' && !t.done));
    state.mailTriage.seen2 = Object.fromEntries(Object.entries(state.mailTriage.seen || {}).filter(([k]) => !recheck.has(k)));
    state.mailTriage.v = 3;
    save();
  }
  return state.mailTriage;
}

/** Apply a triage result to the task list. Pure enough to unit-test with a plain state object. */
export function applyTriage(st, result, now = Date.now()) {
  const tri = st.mailTriage || (st.mailTriage = { on: false, seen: {} });
  const seen = tri.seen2 || (tri.seen2 = {});
  const added = [], completed = [];
  for (const it of result.items || []) {
    if (seen[it.messageId]) continue;
    seen[it.messageId] = now;
    const id = `mail-${it.messageId}`;
    if (st.tasks.some((t) => t.id === id)) continue;
    const task = {
      id, title: it.title, due: it.due || null, done: false, notified: false, isTimer: false,
      createdAt: new Date(now).toISOString(),
      source: { type: 'mail', kind: it.kind, messageId: it.messageId, folderId: it.folderId, subject: it.subject, from: it.from?.name || it.from?.email || '', mailbox: it.mailbox || 'primary', mailboxEmail: it.mailboxEmail || '' },
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
    const r = await triageAll(Object.keys(triageState().seen2));
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

/** First names you go by (Settings name, and the names in Money → Setup). */
const myNames = () => [state.settings?.name, ...String(state.finance?.selfNames || '').split(',')].map((n) => String(n || '').trim().split(/\s+/)[0]).filter(Boolean);

/** Run the check on every connected mailbox and combine the results. */
async function triageAll(skip) {
  const boxes = await loadMailboxes();
  const res = await Promise.allSettled(boxes.map((b) => mailApi('triage', { days: 14, skip, names: myNames(), mailbox: b.id })
    .then((r) => ({ ...r, items: (r.items || []).map((i) => ({ ...i, mailbox: b.id, mailboxEmail: b.email })), stats: { ...(r.stats || {}), mailbox: r.stats?.mailbox || b.email } }))));
  if (!boxes.length || res.every((x) => x.status === 'rejected')) throw res[0]?.reason || Object.assign(new Error('Zoho Mail isn’t connected yet.'), { code: 'not_connected' });
  const ok = res.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  return {
    items: ok.flatMap((r) => r.items), replied: ok.flatMap((r) => r.replied || []), examined: ok.flatMap((r) => r.examined || []),
    stats: ok.map((r) => r.stats), failed: res.map((x, i) => (x.status === 'rejected' ? `${boxes[i].email}: ${x.reason?.message}` : null)).filter(Boolean),
  };
}

/** Dry run: what would be added from all mailboxes right now, without adding anything. */
export async function previewMailTasks() {
  return triageAll([]);
}

export function setMailTasksOn(on) {
  triageState().on = !!on;
  save();
  if (on) checkMailForTasks({ force: true }).catch(() => {});
}
