// UI wiring: chat, voice, tabs, tasks, notes, routines editor, settings.

import {
  state, subscribe, save, addTask, updateTask, removeTask, addNote, removeNote,
  upsertRoutine, removeRoutine, pushHistory, exportData, importData, wipe, uid,
} from './store.js';
import { parseCommand } from './parser.js';
import { parseTime, formatDue, tidy } from './timeparse.js';
import { execute, ACTION_TYPES, describeAction } from './actions.js';
import { runRoutine, nextRunText } from './routines.js';
import { startScheduler, requestNotifications, notify } from './scheduler.js';
import { createListener, speak, stopSpeaking, chime, getVoices, voiceSupported, initVoice } from './voice.js';
import { askAI, builtInAI } from './ai.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fe = (f, n) => f.elements.namedItem(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  return div;
}

function renderChat() {
  chat.innerHTML = '';
  if (!state.history.length) {
    const name = state.settings.name ? ` ${esc(state.settings.name)}` : '';
    chat.innerHTML = `<div class="welcome"><h1>Hi${name}, I’m Baymax 👋</h1>
      <p>Your personal assistant. Tap the mic and tell me what you need: tasks, reminders, notes, emails, or one of your routines.</p>
      ${voiceSupported.input || !voiceSupported.ready ? '' : `<p><strong>Voice input isn’t available here.</strong> ${voiceSupported.engine === 'claude' ? 'It works in Chrome on a computer or Android phone.' : 'Use Chrome, Edge or Safari.'} You can type below.</p>`}</div>`;
  }
  state.history.slice(-60).forEach((m) => chat.appendChild(renderMessage(m)));
  scrollChat();
}

function scrollChat() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); }

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
  'What’s my day?', 'Add task send FCL quote tomorrow at 11', 'Remind me to call the bank in 30 minutes',
  'Set a timer for 5 minutes', 'Note: client prefers WhatsApp', 'What are my tasks?', 'Help',
];
function renderSuggestions() {
  const routineChips = state.routines.filter((r) => r.enabled).slice(0, 3).map((r) => `Run ${r.name}`);
  $('#suggestions').innerHTML = [...SUGGESTIONS.slice(0, 2), ...routineChips, ...SUGGESTIONS.slice(2)]
    .map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
}
$('#suggestions').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) handleInput(b.textContent);
});

// ---------------------------------------------------------------- command handling
const actionCtx = {
  ensureNotifications: () => { if ('Notification' in window && Notification.permission === 'default') requestNotifications().then(renderNotifState); },
  runRoutine: (r) => runRoutineWithUI(r),
};

let pendingReminder = null; // follow-up: "remind me to pay rent" → "when?" → "at 6pm"

async function handleInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  stopSpeaking();
  addMsg('user', text);

  // Follow-up answer for a reminder that was missing its time
  if (pendingReminder) {
    const t = parseTime(text);
    const title = pendingReminder;
    pendingReminder = null;
    if (t) return respond(await execute({ type: 'remind', title, due: t.date.toISOString() }, actionCtx));
  }

  const action = parseCommand(text, { routines: state.routines });

  if (action.type === 'unknown' && (state.settings.ai || builtInAI())) {
    setStatus('Thinking…', true);
    try {
      const ai = await askAI(text);
      setStatus('');
      if (ai.reply) await respond({ reply: ai.reply });
      for (const a of ai.actions) await respond(await execute(a, actionCtx));
      if (!ai.reply && !ai.actions.length) await respond({ reply: 'Sorry, I’m not sure how to help with that.' });
    } catch (err) {
      setStatus('');
      await respond({ reply: `AI mode is unavailable (${err.message}). Say “help” to see built-in commands.` });
    }
    return;
  }

  if (action.type === 'remind' && action.needsTime) pendingReminder = action.title;
  if (action.type === 'stop') stopSpeaking();
  await respond(await execute(action, actionCtx));
}

let routineRunning = false;
async function runRoutineWithUI(r) {
  if (routineRunning) return;
  routineRunning = true;
  addMsg('sys', `▶ Running “${r.name}”`);
  try {
    await runRoutine(r, {
      execute: (a) => execute(a, actionCtx),
      onResult: (res) => respond(res),
    });
  } finally {
    routineRunning = false;
    addMsg('sys', `✓ “${r.name}” finished`);
  }
}

$('#text-form').addEventListener('submit', (e) => {
  e.preventDefault();
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
    onInterim: (t) => { interim.textContent = t; },
    onFinal: (t) => { interim.textContent = ''; handleInput(t); },
    onState: (st) => {
      const on = st === 'listening';
      micBtn.classList.toggle('listening', on);
      micBtn.setAttribute('aria-pressed', on);
      setStatus(on ? 'Listening…' : '', on);
      if (!on) interim.textContent = '';
    },
    onError: (msg) => { toast(msg); },
  });
}

function enableMic() {
  if (voiceSupported.input) { buildListener(); micBtn.disabled = false; micBtn.title = 'Tap to talk'; }
  else { micBtn.disabled = true; micBtn.title = 'Voice input not supported in this browser'; }
}
enableMic();
if (voiceSupported.engine === 'claude') {
  // Inside claude.ai the platform provides dictation and a voice; they resolve after load.
  initVoice().then(() => { enableMic(); if (!state.history.length) renderChat(); fillVoices(); });
}

micBtn.addEventListener('click', () => {
  if (!listener) return;
  stopSpeaking();
  if (listener.active) listener.stop();
  else listener.start(!!state.settings.continuous);
});

// Keyboard shortcut: hold-free toggle with Ctrl/Cmd + K
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); micBtn.click(); }
});

// ---------------------------------------------------------------- tabs
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  try { localStorage.setItem('voice-assistant:tab', name); } catch { /* ignore */ }
  if (name === 'assistant') scrollChat(); else window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

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

  const ul = $('#task-list');
  if (!list.length) {
    ul.innerHTML = `<li class="empty" style="border:0;background:none;justify-content:center">${taskFilter === 'done' ? 'Nothing completed yet.' : 'All clear. Say “add task …” to create one.'}</li>`;
  } else {
    ul.innerHTML = list.map((t) => {
      const overdue = !t.done && t.due && new Date(t.due) < now;
      return `<li class="${t.done ? 'done' : ''}" data-id="${t.id}">
        <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done">
        <div class="grow"><div class="title">${t.isTimer ? '⏱ ' : ''}${esc(t.title)}</div>
          ${t.due ? `<div class="meta ${overdue ? 'overdue' : ''}">${overdue ? 'Overdue · ' : ''}${esc(formatDue(t.due))}</div>` : ''}</div>
        <button class="del" aria-label="Delete">×</button></li>`;
    }).join('');
  }
  const openCount = state.tasks.filter((t) => !t.done && !t.isTimer && t.due && new Date(t.due) <= endOfDay).length;
  const badge = $('#task-badge');
  badge.hidden = !openCount;
  badge.textContent = openCount;
}

$('#task-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.matches('input[type=checkbox]')) {
    updateTask(li.dataset.id, { done: e.target.checked, doneAt: e.target.checked ? new Date().toISOString() : null });
  }
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

// ---------------------------------------------------------------- notes
function renderNotes() {
  const q = $('#note-search').value.trim().toLowerCase();
  const list = state.notes.filter((n) => !q || n.text.toLowerCase().includes(q));
  $('#note-list').innerHTML = list.length
    ? list.map((n) => `<li data-id="${n.id}"><div class="grow"><div class="title">${esc(n.text)}</div>
        <div class="meta">${new Date(n.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div></div>
        <button class="del" aria-label="Delete">×</button></li>`).join('')
    : `<li class="empty" style="border:0;background:none;justify-content:center">${q ? 'No matching notes.' : 'No notes yet. Say “note: …”.'}</li>`;
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
  const el = $('#routine-list');
  el.innerHTML = state.routines.map((r) => `
    <div class="routine ${r.enabled ? '' : 'off'}" data-id="${r.id}">
      <h4>${esc(r.name)}</h4>
      <div class="tags">
        ${r.trigger?.type === 'time' ? `<span class="tag time">⏰ ${esc(nextRunText(r))}</span>` : ''}
        ${(r.phrases || []).map((p) => `<span class="tag">🎙 “${esc(p)}”</span>`).join('')}
      </div>
      <ol>${(r.actions || []).map((a) => `<li>${esc(describeAction(a))}</li>`).join('')}</ol>
      <div class="btn-row">
        <button class="btn small primary" data-act="run">▶ Run</button>
        <button class="btn small" data-act="edit">Edit</button>
      </div>
    </div>`).join('') || '<p class="empty">No routines yet.</p>';

  $('#activity').innerHTML = state.log.slice(0, 15).map((l) =>
    `<li>${esc(l.text)} · ${new Date(l.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</li>`).join('') ||
    '<li>No activity yet.</li>';
}

$('#routine-list').addEventListener('click', (e) => {
  const card = e.target.closest('.routine');
  const btn = e.target.closest('button');
  if (!card || !btn) return;
  const r = state.routines.find((x) => x.id === card.dataset.id);
  if (btn.dataset.act === 'run') { showView('assistant'); runRoutineWithUI(r); }
  if (btn.dataset.act === 'edit') openRoutineEditor(r);
});
$('#new-routine').addEventListener('click', () => openRoutineEditor(null));

// Routine editor
const dialog = $('#routine-dialog');
const form = $('#routine-form');
let draft = null;

$('#action-type').innerHTML = Object.entries(ACTION_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
$('#days').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  .map((d, i) => `<label><input type="checkbox" name="day" value="${i}"> ${d}</label>`).join('');

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
      return `<label>${esc(f.label)}<input type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} value="${val}" ${attrs}></label>`;
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

// ---------------------------------------------------------------- settings
const sform = $('#settings-form');

function fillVoices() {
  const sel = $('#voice-select');
  const voices = getVoices();
  sel.innerHTML = '<option value="">System default</option>' +
    voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
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

sform.addEventListener('change', () => {
  const s = state.settings;
  s.name = fe(sform, 'name').value.trim(); s.speak = fe(sform, 'speak').checked; s.continuous = fe(sform, 'continuous').checked;
  s.voiceName = fe(sform, 'voiceName').value; s.rate = parseFloat(fe(sform, 'rate').value);
  s.ai = fe(sform, 'ai').checked; s.aiUrl = fe(sform, 'aiUrl').value.trim() || 'api/assistant.php'; s.aiPin = fe(sform, 'aiPin').value;
  if (s.lang !== fe(sform, 'lang').value) { s.lang = fe(sform, 'lang').value; listener?.setLang(s.lang); }
  save();
  toast('Settings saved');
});

function renderNotifState() {
  const el = $('#notif-state');
  const btn = $('#notif-btn');
  if (!('Notification' in window)) { el.textContent = 'This browser does not support notifications. Reminders will still chime and speak while the app is open.'; btn.hidden = true; return; }
  const p = Notification.permission;
  el.textContent = p === 'granted' ? 'Notifications are on.' : p === 'denied' ? 'Notifications are blocked. Enable them in your browser’s site settings.' : 'Allow notifications so reminders reach you even when this tab is in the background.';
  btn.hidden = p !== 'default';
}
$('#notif-btn').addEventListener('click', async () => { await requestNotifications(); renderNotifState(); });

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([exportData()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `assistant-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { importData(await file.text()); toast('Backup restored'); renderAll(); }
  catch (err) { toast(`Import failed: ${err.message}`); }
  e.target.value = '';
});
$('#wipe-btn').addEventListener('click', (e) => {
  if (confirmTap(e.currentTarget, 'Tap again to erase everything')) { wipe(); renderAll(); toast('All data erased'); }
});

// ---------------------------------------------------------------- two-tap confirm
// Works everywhere, including embedded views where window.confirm() is unavailable.
function confirmTap(btn, prompt = 'Tap again to confirm') {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    return true;
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = prompt;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 3500);
  return false;
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- boot
function renderAll() { renderChat(); renderSuggestions(); renderTasks(); renderNotes(); renderRoutines(); renderSettings(); }

subscribe(() => { renderTasks(); renderNotes(); renderRoutines(); renderSuggestions(); });
renderAll();
try { const tab = localStorage.getItem('voice-assistant:tab'); if (tab && $(`#view-${tab}`)) showView(tab); } catch { /* ignore */ }

startScheduler({
  onReminder: async (t) => {
    chime();
    const title = t.isTimer ? `⏱ ${t.title} is done` : `⏰ Reminder: ${t.title}`;
    notify(t.isTimer ? 'Timer finished' : 'Reminder', t.title);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    addMsg('bot', title);
    await say(t.isTimer ? `Your ${t.title} is done.` : `Reminder: ${t.title}`);
  },
  onRoutine: (r) => {
    notify('Routine', `Running ${r.name}`);
    runRoutineWithUI(r);
  },
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

// Allow deep links like ?q=add%20task%20buy%20milk (handy for phone shortcuts / widgets)
const q = new URLSearchParams(location.search).get('q');
if (q) { history.replaceState(null, '', location.pathname); handleInput(q); }
