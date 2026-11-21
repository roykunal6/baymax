// Persistence in localStorage, with a tiny pub/sub so the UI re-renders on change.

import { emptyFinance, ymd, addDays, nextMonthlyDate, monthKey } from './finance.js';

const KEY = 'voice-assistant:v1';
const listeners = new Set();
const saveHooks = new Set();

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DEFAULT_SETTINGS = {
  speak: true,
  voiceName: '',
  lang: 'en-IN',
  rate: 1,
  continuous: false,
  ai: false,
  aiUrl: 'api/assistant.php',
  aiPin: '',
  name: '',
};

function defaultRoutines() {
  return [
    {
      id: uid(), name: 'Morning briefing', enabled: true,
      phrases: ['good morning', 'start my day'],
      trigger: { type: 'time', time: '09:00', days: [1, 2, 3, 4, 5] },
      actions: [
        { type: 'briefing' },
        { type: 'open', url: 'https://mail.google.com' },
      ],
    },
    {
      id: uid(), name: 'End of day wrap-up', enabled: true,
      phrases: ['wrap up', 'end my day'],
      trigger: { type: 'voice' },
      actions: [
        { type: 'list_tasks', filter: 'open' },
        { type: 'speak', text: 'Anything left can move to tomorrow. Great work today.' },
        { type: 'add_task', title: 'Plan tomorrow’s top 3', dueIn: 15 * 60 },
      ],
    },
    {
      id: uid(), name: 'Focus session', enabled: true,
      phrases: ['focus mode', 'start focus'],
      trigger: { type: 'voice' },
      actions: [
        { type: 'speak', text: 'Starting a 25 minute focus session. I will let you know when it ends.' },
        { type: 'timer', seconds: 1500 },
      ],
    },
  ];
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return {
        tasks: s.tasks || [], notes: s.notes || [], routines: s.routines || [],
        history: s.history || [], log: s.log || [],
        settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
        finance: { ...emptyFinance(), ...(s.finance || {}) },
        habits: s.habits || defaultHabits(),
        mailTriage: { on: true, seen: {}, ...(s.mailTriage || {}) },
      };
    }
  } catch { /* storage blocked or corrupt: start fresh */ }
  return fresh();
}

function fresh() {
  return { tasks: [], notes: [], routines: defaultRoutines(), history: [], log: [], settings: { ...DEFAULT_SETTINGS }, finance: emptyFinance(), habits: defaultHabits(), mailTriage: { on: true, seen: {} } };
}

function defaultHabits() {
  return [
    { id: uid(), name: 'Drink 8 glasses of water', log: {} },
    { id: uid(), name: 'Exercise 30 minutes', log: {} },
    { id: uid(), name: 'Read 20 pages', log: {} },
  ];
}

export const state = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore quota / private mode */ }
  listeners.forEach((fn) => fn(state));
  saveHooks.forEach((fn) => { try { fn(state); } catch (e) { console.warn(e); } });
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Called after every save (used by cloud sync to upload changes). */
export function onSave(fn) { saveHooks.add(fn); return () => saveHooks.delete(fn); }

// ---- Tasks ---------------------------------------------------------------
export function addTask({ title, due = null, isTimer = false }) {
  const task = { id: uid(), title, due, done: false, notified: false, isTimer, createdAt: new Date().toISOString() };
  state.tasks.push(task);
  save();
  return task;
}

export function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (t) { Object.assign(t, patch); save(); }
  return t;
}

export function removeTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  save();
}

/** Fuzzy-find an open task by words in `query`. */
export function findTask(query, { includeDone = false } = {}) {
  const words = query.toLowerCase().replace(/^(the|my)\s+/, '').split(/\s+/).filter(Boolean);
  let best = null, bestScore = 0;
  for (const t of state.tasks) {
    if (t.done && !includeDone) continue;
    const title = t.title.toLowerCase();
    if (title === query.toLowerCase()) return t;
    const score = words.filter((w) => title.includes(w)).length / words.length;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---- Notes ---------------------------------------------------------------
export function addNote(text) {
  const note = { id: uid(), text, createdAt: new Date().toISOString() };
  state.notes.unshift(note);
  save();
  return note;
}
export function removeNote(id) { state.notes = state.notes.filter((n) => n.id !== id); save(); }

// ---- Routines ------------------------------------------------------------
export function upsertRoutine(r) {
  const i = state.routines.findIndex((x) => x.id === r.id);
  if (i >= 0) state.routines[i] = r; else state.routines.push({ ...r, id: r.id || uid() });
  save();
}
export function removeRoutine(id) { state.routines = state.routines.filter((r) => r.id !== id); save(); }

// ---- Conversation + activity log ----------------------------------------
export function pushHistory(role, text, extra = {}) {
  state.history.push({ role, text, ...extra, at: new Date().toISOString() });
  if (state.history.length > 200) state.history = state.history.slice(-200);
  save();
}
export function logActivity(text) {
  state.log.unshift({ text, at: new Date().toISOString() });
  if (state.log.length > 100) state.log.length = 100;
  save();
}

// ---- Backup --------------------------------------------------------------
export function exportData() {
  const { settings, ...rest } = state;
  const { aiPin, ...safeSettings } = settings; // never export the PIN
  return JSON.stringify({ ...rest, settings: safeSettings, exportedAt: new Date().toISOString() }, null, 2);
}
export function importData(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.tasks) || !Array.isArray(data.routines)) throw new Error('Not a valid backup file');
  state.tasks = data.tasks; state.notes = data.notes || []; state.routines = data.routines;
  state.history = data.history || []; state.log = data.log || [];
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.finance = { ...emptyFinance(), ...(data.finance || {}) };
  state.habits = data.habits || state.habits;
  save();
}
export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  Object.assign(state, fresh());
  save();
}

// ---- Money ---------------------------------------------------------------
const fin = () => state.finance;

export function addSpend({ amount, note = '', category = 'Other', method = 'upi', date = ymd(new Date()) }) {
  const x = { id: uid(), amount: Number(amount), note, category, method, date };
  fin().spends.push(x);
  save();
  return x;
}
export function addObligation({ kind, name, amount, schedule, endMonth = null, startMonth = null }) {
  // A new monthly payment starts from its next due date, so past months never show as missed.
  if (!startMonth && schedule?.type === 'monthly') startMonth = monthKey(nextMonthlyDate(schedule.day, new Date()));
  const o = { id: uid(), kind, name, amount: Number(amount), schedule, endMonth, startMonth, paid: {} };
  fin().obligations.push(o);
  save();
  return o;
}
export function addInvoice({ party, number = '', amount, dueDate, direction = 'in', issueDate = ymd(new Date()) }) {
  const inv = { id: uid(), party, number, amount: Number(amount), dueDate, direction, issueDate, paidAt: null };
  fin().invoices.push(inv);
  save();
  return inv;
}
export function addCard({ name, limit = 0, dueDay = null, last4 = '' }) {
  const c = { id: uid(), name, limit: Number(limit) || 0, dueDay: dueDay ? Number(dueDay) : null, last4: String(last4 || '').slice(-4), paid: {} };
  fin().cards.push(c);
  save();
  return c;
}
/** Update or delete an item in one of the money lists. */
export function updateMoney(list, id, patch) {
  const item = fin()[list].find((x) => x.id === id);
  if (item) { Object.assign(item, patch); save(); }
  return item;
}
export function removeMoney(list, id) {
  fin()[list] = fin()[list].filter((x) => x.id !== id);
  save();
}
/** Toggle paid for one occurrence (obligation/card: key = YYYY-MM or 'once'; invoice: paidAt). */
export function setPaid(ref, id, key, paid = true) {
  if (ref === 'invoice') return updateMoney('invoices', id, { paidAt: paid ? ymd(new Date()) : null });
  const list = ref === 'card' ? 'cards' : 'obligations';
  const item = fin()[list].find((x) => x.id === id);
  if (!item) return null;
  item.paid = item.paid || {};
  if (paid) item.paid[key] = ymd(new Date()); else delete item.paid[key];
  save();
  return item;
}

// ---- Habits --------------------------------------------------------------
export function addHabit(name) {
  const h = { id: uid(), name, log: {} };
  state.habits.push(h);
  save();
  return h;
}
export function toggleHabit(id, day = ymd(new Date()), done) {
  const h = state.habits.find((x) => x.id === id);
  if (!h) return null;
  const val = done ?? !h.log[day];
  if (val) h.log[day] = true; else delete h.log[day];
  save();
  return h;
}
export function removeHabit(id) { state.habits = state.habits.filter((h) => h.id !== id); save(); }
export function habitStreak(h, now = new Date()) {
  let n = 0;
  let d = h.log[ymd(now)] ? now : addDays(now, -1); // today not done yet doesn't break the streak
  while (h.log[ymd(d)]) { n++; d = addDays(d, -1); }
  return n;
}
export function findHabit(query) {
  const q = String(query || '').toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  return state.habits.find((h) => h.name.toLowerCase() === q) ||
    state.habits.find((h) => words.length && words.some((w) => h.name.toLowerCase().includes(w))) || null;
}
