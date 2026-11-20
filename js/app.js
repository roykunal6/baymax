// App wiring: tabs, chat + voice, Home dashboard, Money, Tasks, More (habits, routines, notes, settings).

import {
  state, subscribe, save, addTask, updateTask, removeTask, addNote, removeNote,
  upsertRoutine, removeRoutine, pushHistory, exportData, importData, wipe, uid,
  addHabit, toggleHabit, removeHabit, habitStreak, onSave,
} from './store.js';
import { parseCommand } from './parser.js';
import { parseTime, formatDue, tidy } from './timeparse.js';
import { execute, ACTION_TYPES, describeAction } from './actions.js';
import { runRoutine, nextRunText } from './routines.js';
import { startScheduler, requestNotifications, notify } from './scheduler.js';
import { createListener, speak, stopSpeaking, chime, getVoices, voiceSupported, initVoice, unlockSpeech } from './voice.js';
import { askAI, builtInAI } from './ai.js';
import { parseAmount, parseFinanceCommand, overdueItems, inr, ymd, addDays, KIND_LABEL } from './finance.js';
import { renderHome, bindHome } from './dashboard.js';
import { renderMoney, bindMoney, handleMoneyAction, setToast } from './money.js';
import { initSheet, openSheet } from './sheet.js';
import { avatarSVG } from './avatar.js';
import { lock, changePassword } from './auth.js';
import { cloud } from './cloud.js';
import { createSync, resetSyncMeta } from './sync.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fe = (f, n) => f.elements.namedItem(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- avatar
/** Baymax's picture: the user's own image if they chose one, else the built-in avatar. */
function avatarHTML(size, variant = 'face') {
  const img = state.settings.avatarImage;
  if (img && /^data:image\//.test(img)) return `<img class="avatar avatar-img" src="${esc(img)}" width="${size}" height="${size}" alt="Baymax">`;
  return avatarSVG({ size, variant });
}
function renderAvatars() {
  $('#brand-mark').innerHTML = avatarHTML(34);
  $('#avatar-preview').innerHTML = avatarHTML(72, 'full');
}

// ---------------------------------------------------------------- views
let currentView = 'home';
function showView(name, { scroll = true } = {}) {
  if (!$(`#view-${name}`)) name = 'home';
  currentView = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabs button').forEach((b) => { const on = b.dataset.view === name; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  document.body.classList.toggle('chat-open', name === 'chat');
  try { localStorage.setItem('voice-assistant:tab', name); } catch { /* ignore */ }
  if (name === 'chat') { measureComposer(); scrollChat(false); } else if (scroll) window.scrollTo(0, 0);
  if (name === 'home') renderHomeView();
  if (name === 'money') renderMoneyView();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

function measureComposer() {
  const h = $('#composer').offsetHeight;
  if (h) document.documentElement.style.setProperty('--composer-h', `${h}px`);
}
window.addEventListener('resize', measureComposer);

// ---------------------------------------------------------------- chat
const chat = $('#chat');

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.role}`;
  let html = esc(m.text);
  if (m.items?.length) html += `<ul>${m.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  if (m.link?.url && /^(https?:|mailto:|tel:)/.test(m.link.url)) {
    html += `<br><a class="link-btn" href="${esc(m.link.url)}" target="_blank" rel="noopener">${esc(m.link.label || 'Open')}</a>`;
  }
  if (m.at && m.role !== 'sys') html += `<time>${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>`;
  div.innerHTML = html;
  if (m.role !== 'bot') return div;
  const row = document.createElement('div');
  row.className = 'bot-row';
  row.innerHTML = avatarHTML(30);
  row.appendChild(div);
  return row;
}

function renderChat() {
  chat.innerHTML = '';
  if (!state.history.length) {
    const name = state.settings.name ? ` ${esc(state.settings.name.split(' ')[0])}` : '';
    chat.innerHTML = `<div class="welcome"><div class="face">${avatarHTML(96, 'full')}</div>
      <h1>Hi${name}, I’m Baymax</h1>
      <p>Your personal assistant. Tap the mic and tell me what you need: tasks, reminders, spends, bills, notes or habits.</p>
      ${voiceSupported.input || !voiceSupported.ready ? '' : `<p><strong>Voice input isn’t available in this browser.</strong> ${voiceSupported.engine === 'claude' ? 'It works in Chrome on a computer or Android phone.' : 'Use Safari on iPhone or Chrome on Android.'} You can type below.</p>`}</div>`;
  }
  state.history.slice(-60).forEach((m) => chat.appendChild(renderMessage(m)));
  scrollChat(false);
}

function scrollChat(smooth = true) {
  if (currentView !== 'chat') return;
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
}

function addMsg(role, text, extra = {}) {
  if (!state.history.length) chat.innerHTML = '';
  pushHistory(role, text, extra);
  chat.appendChild(renderMessage(state.history[state.history.length - 1]));
  scrollChat();
}

async function say(text) {
  if (!state.settings.speak || !text) return;
  const { voiceName, lang, rate } = state.settings;
  await speak(text, { voiceName, lang, rate: Number(rate) || 1 });
}

/** Show a result in chat and speak it. */
async function respond(result) {
  if (!result || result.silent) return;
  if (!result.reply && !result.items?.length) return;
  addMsg('bot', result.reply, { items: result.items, link: result.link });
  await say(result.speakText || result.reply);
}

const SUGGESTIONS = [
  'What’s my day?', 'How am I doing this month?', 'Spent 450 on lunch', 'What’s due this week?',
  'Add task call Ravi tomorrow at 4', 'Remind me to stretch in 30 minutes', 'Show my invoices', 'Help',
];
function renderSuggestions() {
  const routineChips = state.routines.filter((r) => r.enabled).slice(0, 2).map((r) => `Run ${r.name}`);
  $('#suggestions').innerHTML = [...SUGGESTIONS.slice(0, 4), ...routineChips, ...SUGGESTIONS.slice(4)]
    .map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
}
$('#suggestions').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) { unlockSpeech(); handleInput(b.textContent); }
});

// ---------------------------------------------------------------- command handling
let pending = null; // a follow-up question Baymax asked: {field, action}

const actionCtx = {
  ensureNotifications: () => { if ('Notification' in window && Notification.permission === 'default') requestNotifications().then(renderNotifState); },
  runRoutine: (r) => runRoutineWithUI(r),
  setPending: (p) => { pending = p; },
};

/** Turn the answer to a follow-up question into an action, or null if it doesn't fit. */
function answerPending(p, text) {
  switch (p.field) {
    case 'task': {
      const t = parseTime(text);
      return { type: 'add_task', title: tidy(t ? t.rest : text), due: t ? t.date.toISOString() : null };
    }
    case 'note': return { type: 'add_note', text };
    case 'habit': return { type: 'add_habit', name: text };
    case 'spend': return parseFinanceCommand(/^\d|^₹|^rs/i.test(text) ? text : `spent ${text}`, { fin: state.finance }) ||
      parseFinanceCommand(`spent ${text}`, { fin: state.finance });
    case 'amount': {
      const amount = parseAmount(text);
      return amount > 0 ? { ...p.action, amount, needsAmount: false } : null;
    }
    case 'time': {
      const t = parseTime(text);
      return t ? { type: 'remind', title: p.action.title, due: t.date.toISOString() } : null;
    }
    default: return null;
  }
}

async function handleInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  stopSpeaking();
  addMsg('user', text);

  if (pending) {
    const p = pending;
    pending = null;
    const isCancel = /^(cancel|never ?mind|stop|forget it)$/i.test(text);
    if (isCancel) return respond({ reply: 'Okay, cancelled.' });
    const answer = answerPending(p, text);
    if (answer) return respond(await execute(answer, actionCtx));
  }

  const action = parseCommand(text, { routines: state.routines, fin: state.finance });

  if (action.type === 'unknown' && (state.settings.ai || builtInAI())) {
    document.body.classList.add('thinking');
    setStatus('Thinking…', true);
    try {
      const ai = await askAI(text);
      if (ai.reply) await respond({ reply: ai.reply });
      for (const a of ai.actions) await respond(await execute(a, actionCtx));
      if (!ai.reply && !ai.actions.length) await respond({ reply: 'Sorry, I’m not sure how to help with that.' });
    } catch (err) {
      await respond({ reply: `AI mode is unavailable (${err.message}). Say “help” to see what I can do.` });
    } finally {
      document.body.classList.remove('thinking');
      setStatus('');
    }
    return;
  }

  if (action.type === 'remind' && action.needsTime) pending = { field: 'time', action };
  if (action.type === 'stop') stopSpeaking();
  await respond(await execute(action, actionCtx));
}

let routineRunning = false;
async function runRoutineWithUI(r) {
  if (routineRunning) return;
  routineRunning = true;
  addMsg('sys', `▶ Running “${r.name}”`);
  try {
    await runRoutine(r, { execute: (a) => execute(a, actionCtx), onResult: (res) => respond(res) });
  } finally {
    routineRunning = false;
    addMsg('sys', `✓ “${r.name}” finished`);
  }
}

$('#text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockSpeech();
  const input = $('#text-input');
  handleInput(input.value);
  input.value = '';
});

// ---------------------------------------------------------------- voice
const micBtn = $('#mic');
const interim = $('#interim');
let listener = null;

function setStatus(text, live = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('live', live);
}

function buildListener() {
  listener = createListener({
    lang: state.settings.lang,
    onInterim: (t) => { interim.textContent = t; measureComposer(); },
    onFinal: (t) => { interim.textContent = ''; handleInput(t); },
    onState: (st) => {
      const on = st === 'listening';
      micBtn.classList.toggle('listening', on);
      micBtn.setAttribute('aria-pressed', on);
      document.body.classList.toggle('listening', on);
      setStatus(on ? 'Listening… pause when you’re done' : '', on);
      if (!on) interim.textContent = '';
    },
    onError: (msg) => { toast(msg); addMsg('sys', msg); },
  });
}

function enableMic() {
  if (voiceSupported.input) { buildListener(); micBtn.disabled = false; micBtn.title = 'Tap to talk'; }
  else { micBtn.disabled = true; micBtn.title = 'Voice input not supported in this browser'; }
}
enableMic();
if (voiceSupported.engine === 'claude') {
  initVoice().then(() => { enableMic(); if (!state.history.length) renderChat(); fillVoices(); });
}

/** Must run synchronously inside a tap: browsers only grant the mic from a user gesture. */
function toggleListening() {
  if (!listener) { toast('Voice input isn’t available in this browser. You can type instead.'); return; }
  unlockSpeech();
  stopSpeaking();
  if (listener.active) listener.stop();
  else listener.start(!!state.settings.continuous);
}
micBtn.addEventListener('click', toggleListening);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (currentView !== 'chat') showView('chat'); toggleListening(); }
});

// ---------------------------------------------------------------- home + money
const homeEl = $('#view-home');
const moneyEl = $('#view-money');
function renderHomeView() { if (currentView === 'home') renderHome(homeEl); }
function renderMoneyView() { if (currentView === 'money') renderMoney(moneyEl); }
setToast((m) => toast(m));
bindMoney(moneyEl, renderMoneyView);
bindHome(homeEl, {
  rerender: () => renderHome(homeEl),
  onAsk: () => { showView('chat'); toggleListening(); },
  onGo: (v) => showView(v),
  onTaskDone: (id) => { updateTask(id, { done: true, doneAt: new Date().toISOString() }); toast('Done ✓'); },
  onHabit: (id) => { const h = toggleHabit(id); if (h?.log[ymd(new Date())]) toast(`${h.name} ✓`); },
  onMoneyAction: (t) => handleMoneyAction(t, () => renderHome(homeEl)),
});

// ---------------------------------------------------------------- tasks
let taskFilter = 'open';
$('#task-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  taskFilter = b.dataset.filter;
  $$('#task-filter button').forEach((x) => x.classList.toggle('on', x === b));
  renderTasks();
});

function renderTasks() {
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  let list = state.tasks.filter((t) => !t.isTimer || (!t.done && !t.notified));
  if (taskFilter === 'open') list = list.filter((t) => !t.done);
  if (taskFilter === 'today') list = list.filter((t) => !t.done && t.due && new Date(t.due) <= endOfDay);
  if (taskFilter === 'done') list = list.filter((t) => t.done).sort((a, b) => new Date(b.doneAt || 0) - new Date(a.doneAt || 0));
  else list.sort((a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity) || new Date(a.createdAt) - new Date(b.createdAt));

  $('#task-list').innerHTML = list.length ? list.map((t) => {
    const overdue = !t.done && t.due && new Date(t.due) < now;
    return `<li class="row ${t.done ? 'done' : ''}" data-id="${t.id}">
      <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done">
      <div class="grow"><div class="title">${t.isTimer ? '⏱ ' : ''}${esc(t.title)}</div>
        ${t.due ? `<div class="meta ${overdue ? 'bad' : ''}">${overdue ? 'Overdue · ' : ''}${esc(formatDue(t.due))}</div>` : ''}</div>
      <button class="del" aria-label="Delete">×</button></li>`;
  }).join('') : `<li class="empty">${taskFilter === 'done' ? 'Nothing completed yet.' : 'All clear. Say “add task …” to create one.'}</li>`;

  const due = state.tasks.filter((t) => !t.done && !t.isTimer && t.due && new Date(t.due) <= endOfDay).length;
  const badge = $('#task-badge');
  badge.hidden = !due;
  badge.textContent = due;
}

$('#task-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.matches('input[type=checkbox]')) updateTask(li.dataset.id, { done: e.target.checked, doneAt: e.target.checked ? new Date().toISOString() : null });
  if (e.target.closest('.del')) removeTask(li.dataset.id);
});

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#task-title');
  const t = parseTime(input.value);
  const title = tidy(t ? t.rest : input.value);
  if (!title) return;
  addTask({ title, due: t ? t.date.toISOString() : null });
  if (t) actionCtx.ensureNotifications();
  input.value = '';
  toast(t ? `Added, due ${formatDue(t.date)}` : 'Task added');
});

// ---------------------------------------------------------------- more: sub tabs
$('#more-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $$('#more-seg button').forEach((x) => x.classList.toggle('on', x === b));
  $$('#view-more .sub').forEach((s) => s.classList.toggle('on', s.id === `more-${b.dataset.sub}`));
});

// ---------------------------------------------------------------- habits
function renderHabits() {
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(now, i - 6));
  $('#habit-list').innerHTML = state.habits.length ? state.habits.map((h) => {
    const today = !!h.log[ymd(now)];
    const streak = habitStreak(h);
    return `<div class="habit" data-id="${h.id}">
      <div class="habit-top">
        <div class="grow"><div class="title" style="font-weight:650">${esc(h.name)}</div>
          <div class="meta muted" style="font-size:13px">${streak ? `🔥 ${streak}-day streak` : 'Start a streak today'}</div></div>
        <button type="button" class="link" data-act="edit-habit">Edit</button>
        <button type="button" class="check-btn ${today ? 'on' : ''}" data-act="toggle" data-day="${ymd(now)}" aria-label="Done today" aria-pressed="${today}">✓</button>
      </div>
      <div class="habit-days">${days.map((d) => `<button type="button" class="${h.log[ymd(d)] ? 'on' : ''}" data-act="toggle" data-day="${ymd(d)}" aria-label="${d.toDateString()}">
        <span>${d.toLocaleDateString('en-IN', { weekday: 'short' }).slice(0, 2)}</span><span>${d.getDate()}</span></button>`).join('')}</div>
    </div>`;
  }).join('') : '<p class="empty">No habits yet. Add one above, or say “add habit meditate”.</p>';
}
$('#habit-list').addEventListener('click', (e) => {
  const card = e.target.closest('.habit');
  const t = e.target.closest('[data-act]');
  if (!card || !t) return;
  const h = state.habits.find((x) => x.id === card.dataset.id);
  if (t.dataset.act === 'toggle') toggleHabit(h.id, t.dataset.day);
  if (t.dataset.act === 'edit-habit') {
    openSheet({
      title: 'Edit habit', values: { name: h.name },
      fields: [{ key: 'name', label: 'Habit', type: 'text', required: true }],
      onSave: (v) => { h.name = v.name; save(); toast('Habit saved'); },
      onDelete: () => { removeHabit(h.id); toast('Habit removed'); },
    });
  }
});
$('#habit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#habit-name');
  if (input.value.trim()) { addHabit(input.value.trim()); toast('Habit added'); }
  input.value = '';
});

// ---------------------------------------------------------------- notes
function renderNotes() {
  const q = $('#note-search').value.trim().toLowerCase();
  const list = state.notes.filter((n) => !q || n.text.toLowerCase().includes(q));
  $('#note-list').innerHTML = list.length
    ? list.map((n) => `<li class="row" data-id="${n.id}"><div class="grow"><div class="title">${esc(n.text)}</div>
        <div class="meta">${new Date(n.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div></div>
        <button class="del" aria-label="Delete">×</button></li>`).join('')
    : `<li class="empty">${q ? 'No matching notes.' : 'No notes yet. Say “note: …”.'}</li>`;
}
$('#note-search').addEventListener('input', renderNotes);
$('#note-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li && e.target.closest('.del')) removeNote(li.dataset.id);
});
$('#note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#note-text');
  if (input.value.trim()) addNote(input.value.trim());
  input.value = '';
});

// ---------------------------------------------------------------- routines
function renderRoutines() {
  $('#routine-list').innerHTML = state.routines.map((r) => `
    <div class="routine ${r.enabled ? '' : 'off'}" data-id="${r.id}">
      <h4>${esc(r.name)}</h4>
      <div class="tags">
        ${r.trigger?.type === 'time' ? `<span class="pill warn">⏰ ${esc(nextRunText(r))}</span>` : ''}
        ${(r.phrases || []).map((p) => `<span class="pill neutral">🎙 “${esc(p)}”</span>`).join('')}
      </div>
      <ol>${(r.actions || []).map((a) => `<li>${esc(describeAction(a))}</li>`).join('')}</ol>
      <div class="btn-row"><button class="btn small primary" data-act="run">▶ Run</button><button class="btn small" data-act="edit">Edit</button></div>
    </div>`).join('') || '<p class="empty">No routines yet.</p>';
  $('#activity').innerHTML = state.log.slice(0, 15).map((l) =>
    `<li class="row">${esc(l.text)} · ${new Date(l.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</li>`).join('') || '<li class="row">No activity yet.</li>';
}
$('#routine-list').addEventListener('click', (e) => {
  const card = e.target.closest('.routine');
  const btn = e.target.closest('button');
  if (!card || !btn) return;
  const r = state.routines.find((x) => x.id === card.dataset.id);
  if (btn.dataset.act === 'run') { showView('chat'); runRoutineWithUI(r); }
  if (btn.dataset.act === 'edit') openRoutineEditor(r);
});
$('#new-routine').addEventListener('click', () => openRoutineEditor(null));

const dialog = $('#routine-dialog');
const form = $('#routine-form');
let draft = null;
$('#action-type').innerHTML = Object.entries(ACTION_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
$('#days').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<label><input type="checkbox" name="day" value="${i}"> ${d}</label>`).join('');

function fieldValue(a, f) {
  const v = a[f.key];
  if (f.type === 'minutes' || f.type === 'minutes-as-seconds') return v ? Math.round(v / 60 * 10) / 10 : '';
  return v ?? '';
}
function renderActionEditor() {
  $('#action-list').innerHTML = draft.actions.map((a, i) => {
    const def = ACTION_TYPES[a.type] || { label: a.type, fields: [] };
    const fields = def.fields.map((f) => {
      const val = esc(fieldValue(a, f));
      const attrs = `data-i="${i}" data-key="${f.key}" data-ftype="${f.type}"`;
      if (f.type === 'textarea') return `<label>${esc(f.label)}<textarea rows="2" ${attrs}>${val}</textarea></label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select ${attrs}>${f.options.map((o) => `<option ${String(a[f.key] || f.options[0]) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
      const type = f.type === 'url' ? 'url' : (f.type === 'number' || f.type.startsWith('minutes')) ? 'number' : 'text';
      return `<label>${esc(f.label)}<input type="${type}" ${type === 'number' ? 'inputmode="decimal" min="0" step="any"' : ''} value="${val}" ${attrs}></label>`;
    }).join('');
    return `<li><div class="ahead">${esc(def.label)}<span class="spacer"></span>
      <button type="button" data-move="-1" data-i="${i}" aria-label="Move up">↑</button>
      <button type="button" data-move="1" data-i="${i}" aria-label="Move down">↓</button>
      <button type="button" data-remove="${i}" aria-label="Remove">✕</button></div>${fields}</li>`;
  }).join('') || '<li class="hint">No steps yet. Add one below.</li>';
}
$('#action-list').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.key) return;
  const a = draft.actions[+el.dataset.i];
  let v = el.value;
  if (el.dataset.ftype === 'minutes' || el.dataset.ftype === 'minutes-as-seconds') v = v === '' ? null : Math.round(parseFloat(v) * 60);
  else if (el.dataset.ftype === 'number') v = parseFloat(v) || 0;
  a[el.dataset.key] = v;
});
$('#action-list').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = +b.dataset.i;
  if (b.dataset.remove != null) draft.actions.splice(+b.dataset.remove, 1);
  if (b.dataset.move) {
    const j = i + +b.dataset.move;
    if (j >= 0 && j < draft.actions.length) [draft.actions[i], draft.actions[j]] = [draft.actions[j], draft.actions[i]];
  }
  renderActionEditor();
});
$('#add-action').addEventListener('click', () => {
  const type = $('#action-type').value;
  const a = { type };
  if (type === 'timer') a.seconds = 300;
  if (type === 'remind') a.dueIn = 1800;
  if (type === 'webhook') a.method = 'POST';
  if (type === 'list_tasks') a.filter = 'open';
  if (type === 'list_dues') a.range = 'week';
  draft.actions.push(a);
  renderActionEditor();
});
function openRoutineEditor(r) {
  draft = r ? structuredClone(r) : { id: uid(), name: '', phrases: [], enabled: true, trigger: { type: 'voice' }, actions: [{ type: 'speak', text: '' }] };
  delete draft._firedStamp;
  $('#routine-dialog-title').textContent = r ? 'Edit routine' : 'New routine';
  fe(form, 'name').value = draft.name;
  fe(form, 'phrases').value = (draft.phrases || []).join(', ');
  fe(form, 'enabled').checked = draft.enabled !== false;
  $$('input[name=ttype]', form).forEach((x) => { x.checked = x.value === (draft.trigger?.type === 'time' ? 'time' : 'voice'); });
  fe(form, 'time').value = draft.trigger?.time || '09:00';
  const days = draft.trigger?.days?.length ? draft.trigger.days : [0, 1, 2, 3, 4, 5, 6];
  $$('input[name=day]', form).forEach((x) => { x.checked = days.includes(+x.value); });
  $('#delete-routine').hidden = !r;
  renderActionEditor();
  dialog.showModal();
}
form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  if (!fe(form, 'name').value.trim()) { e.preventDefault(); fe(form, 'name').focus(); return; }
  const ttype = $$('input[name=ttype]', form).find((x) => x.checked)?.value || 'voice';
  draft.name = fe(form, 'name').value.trim();
  draft.phrases = fe(form, 'phrases').value.split(',').map((s) => s.trim()).filter(Boolean);
  draft.enabled = fe(form, 'enabled').checked;
  draft.trigger = ttype === 'time'
    ? { type: 'time', time: fe(form, 'time').value || '09:00', days: $$('input[name=day]', form).filter((x) => x.checked).map((x) => +x.value) }
    : { type: 'voice' };
  upsertRoutine(draft);
  toast('Routine saved');
});
$('#delete-routine').addEventListener('click', (e) => {
  if (confirmTap(e.currentTarget)) { removeRoutine(draft.id); dialog.close(); }
});
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

// ---------------------------------------------------------------- settings
const sform = $('#settings-form');
function fillVoices() {
  const sel = $('#voice-select');
  const voices = getVoices();
  sel.innerHTML = '<option value="">System default</option>' + voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = state.settings.voiceName || '';
}
function renderSettings() {
  const s = state.settings;
  fe(sform, 'name').value = s.name; fe(sform, 'speak').checked = s.speak; fe(sform, 'continuous').checked = s.continuous;
  fe(sform, 'lang').value = s.lang; fe(sform, 'rate').value = s.rate; fe(sform, 'ai').checked = s.ai;
  fe(sform, 'aiUrl').value = s.aiUrl; fe(sform, 'aiPin').value = s.aiPin;
  fillVoices();
  renderNotifState();
}
if (voiceSupported.engine === 'browser' && typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', fillVoices);
sform.addEventListener('change', (e) => {
  if (e.target.type === 'file') return;
  const s = state.settings;
  s.name = fe(sform, 'name').value.trim(); s.speak = fe(sform, 'speak').checked; s.continuous = fe(sform, 'continuous').checked;
  s.voiceName = fe(sform, 'voiceName').value; s.rate = parseFloat(fe(sform, 'rate').value);
  s.ai = fe(sform, 'ai').checked; s.aiUrl = fe(sform, 'aiUrl').value.trim() || 'api/assistant.php'; s.aiPin = fe(sform, 'aiPin').value;
  if (s.lang !== fe(sform, 'lang').value) { s.lang = fe(sform, 'lang').value; listener?.setLang(s.lang); }
  save();
  toast('Settings saved');
});

// Custom picture: resized to 256px and kept in this device's storage only.
$('#avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    const size = 256;
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    URL.revokeObjectURL(url);
    state.settings.avatarImage = c.toDataURL('image/png');
    save();
    renderAvatars(); renderChat();
    toast('Picture updated');
  } catch { toast('Couldn’t read that picture. Try a PNG or JPG.'); }
});
$('#avatar-reset').addEventListener('click', () => {
  delete state.settings.avatarImage;
  save();
  renderAvatars(); renderChat();
  toast('Using the default picture');
});

function renderNotifState() {
  const el = $('#notif-state');
  const btn = $('#notif-btn');
  if (!('Notification' in window)) { el.textContent = 'This browser can’t show notifications. On iPhone, add Baymax to your Home Screen first. Reminders still chime and speak while the app is open.'; btn.hidden = true; return; }
  const p = Notification.permission;
  el.textContent = p === 'granted' ? 'Notifications are on.' : p === 'denied' ? 'Notifications are blocked. Turn them on in your browser’s site settings.' : 'Turn on notifications so reminders and payment alerts reach you.';
  btn.hidden = p !== 'default';
}
$('#notif-btn').addEventListener('click', async () => { await requestNotifications(); renderNotifState(); });

$('#lock-btn').addEventListener('click', async () => {
  if (cloud.client) { cloud.sync?.stop(); await cloud.client.auth.signOut(); }
  lock();
  location.reload();
});
$('#change-pass-btn').addEventListener('click', () => {
  let saving = false;
  openSheet({
    title: 'Change password',
    fields: [
      { key: 'current', label: 'Current password', type: 'password', required: true },
      { key: 'next', label: 'New password (8+ characters)', type: 'password', required: true },
      { key: 'confirm', label: 'Repeat new password', type: 'password', required: true },
    ],
    onSave: (v) => {
      if (saving) return 'Saving…';
      if (v.next !== v.confirm) return 'The new passwords don’t match.';
      saving = true;
      changeAccountPassword(v.current, v.next).then((err) => {
        saving = false;
        if (err) { const box = document.querySelector('#sheet .sheet-error'); if (box) box.textContent = err; else toast(err); return; }
        document.getElementById('sheet').close();
        toast('Password changed on this device');
      });
      return 'Checking…';
    },
  });
});

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([exportData()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `baymax-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { importData(await file.text()); toast('Backup restored'); renderAll(); } catch (err) { toast(`Import failed: ${err.message}`); }
  e.target.value = '';
});
$('#wipe-btn').addEventListener('click', async (e) => {
  if (cloud.client) {
    // Signed in to the cloud: erase this device only and sign out. Cloud data and other devices stay intact.
    if (!confirmTap(e.currentTarget, 'Tap again to erase this device')) return;
    cloud.offSave?.();
    cloud.sync?.stop();
    wipe();
    resetSyncMeta();
    await cloud.client.auth.signOut();
    location.reload();
    return;
  }
  if (confirmTap(e.currentTarget, 'Tap again to erase everything')) { wipe(); renderAll(); toast('All data erased'); }
});

function confirmTap(btn, prompt = 'Tap again to confirm') {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; return true; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = prompt;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 3500);
  return false;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- badges + boot
function renderBadges() {
  const n = overdueItems(state.finance).length;
  const b = $('#money-badge');
  b.hidden = !n;
  b.textContent = n;
}
function renderAll() {
  renderAvatars(); renderChat(); renderSuggestions(); renderTasks(); renderNotes(); renderRoutines(); renderHabits(); renderSettings(); renderBadges();
  renderHomeView(); renderMoneyView();
}
subscribe(() => { renderTasks(); renderNotes(); renderRoutines(); renderHabits(); renderSuggestions(); renderBadges(); renderHomeView(); renderMoneyView(); });

/** Change password: on the Supabase account when signed in to the cloud, otherwise on this device. */
async function changeAccountPassword(current, next) {
  if (!cloud.client) return changePassword(current, next);
  if (String(next).length < 8) return 'Use at least 8 characters.';
  const check = await cloud.client.auth.signInWithPassword({ email: cloud.user.email, password: current });
  if (check.error) return 'Your current password is wrong.';
  const { error } = await cloud.client.auth.updateUser({ password: next });
  return error ? error.message : null;
}

// ---------------------------------------------------------------- cloud sync
const SYNC_TEXT = {
  local: 'Your data is stored on this device only.',
  syncing: 'Syncing…',
  synced: 'All changes synced to your other devices.',
  offline: 'Offline. Changes will sync when you’re back online.',
};
function renderSyncState() {
  const el = $('#sync-state');
  if (!el) return;
  const wipeBtn = $('#wipe-btn');
  if (cloud.client && wipeBtn && wipeBtn.dataset.armed !== '1') wipeBtn.textContent = 'Erase this device';
  el.textContent = cloud.client ? `Signed in as ${cloud.user?.email || 'you'}. ${SYNC_TEXT[cloud.status] || ''}` : SYNC_TEXT.local;
}
function startCloudSync() {
  if (!cloud.client || !cloud.user) return;
  cloud.sync = createSync({
    client: cloud.client,
    userId: cloud.user.id,
    state,
    persist: save,
    onRemote: () => { renderAll(); },
    onStatus: (st) => { cloud.status = st; renderSyncState(); },
  });
  cloud.offSave = onSave(() => cloud.sync.noteLocalChange());
  cloud.sync.start().catch((e) => console.warn('Sync failed to start', e));
}

initSheet();
renderAll();
renderSyncState();
startCloudSync();
let startView = (location.hash || '').replace('#', '');
if (!startView) { try { startView = localStorage.getItem('voice-assistant:tab') || 'home'; } catch { startView = 'home'; } }
if (startView === 'assistant') startView = 'chat';
showView(startView, { scroll: false });
window.addEventListener('hashchange', () => showView(location.hash.replace('#', '')));

startScheduler({
  onReminder: async (t) => {
    chime();
    const title = t.isTimer ? `⏱ ${t.title} is done` : `⏰ Reminder: ${t.title}`;
    notify(t.isTimer ? 'Timer finished' : 'Reminder', t.title);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    addMsg('bot', title);
    await say(t.isTimer ? `Your ${t.title} is done.` : `Reminder: ${t.title}`);
  },
  onRoutine: (r) => { notify('Routine', `Running ${r.name}`); runRoutineWithUI(r); },
  onDues: (items) => {
    save();
    const lines = items.map((d) => `${KIND_LABEL[d.kind]} ${d.name} · ${inr(d.amount)} · ${d.date < new Date(new Date().setHours(0, 0, 0, 0)) ? 'overdue' : d.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
    notify(items.length === 1 ? 'Payment due' : `${items.length} payments due`, lines.join('\n'));
    addMsg('bot', `💳 Payment reminder: ${items.length === 1 ? 'this is' : 'these are'} coming up or overdue.`, { items: lines });
  },
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

// Some free hosts pin a badge to the bottom of the screen (Netlify adds #nl-badge-frame).
// Make the tab bar tall enough to sit the badge inside it, so it never covers a button.
function watchHostBadge() {
  const apply = () => {
    const badge = document.getElementById('nl-badge-frame');
    const box = badge?.getBoundingClientRect();
    const visible = box && box.height > 0 && getComputedStyle(badge).display !== 'none' && box.top < window.innerHeight;
    const h = visible ? Math.ceil(window.innerHeight - box.top) : 0;
    document.documentElement.style.setProperty('--badge-h', `${h}px`);
    measureComposer();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
  new MutationObserver(() => {
    const badge = document.getElementById('nl-badge-frame');
    if (badge && ro && !badge.dataset.watched) { badge.dataset.watched = '1'; ro.observe(badge); }
    apply();
  }).observe(document.body, { childList: true });
  window.addEventListener('resize', apply);
  apply();
}
watchHostBadge();

// Deep links like ?q=what's%20my%20day (phone shortcuts / widgets)
const q = new URLSearchParams(location.search).get('q');
if (q) { history.replaceState(null, '', location.pathname); showView('chat'); handleInput(q); }
