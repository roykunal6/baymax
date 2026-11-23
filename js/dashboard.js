// Home dashboard: Day / Week / Month views of tasks, payments, money and habits.

import { state } from './store.js';
import { habitStreak } from './store.js';
import {
  inr, healthCheck, dueItems, addDays, ymd, startOfWeek, startOfDay, endOfDay, sumSpends, daysInMonth, KIND_LABEL,
} from './finance.js';
import { formatDue } from './timeparse.js';
import { statusCard, dueRow, categoryBars, alertsList, budgetBar, esc, setMoneySub } from './money.js';
import { uploadDue } from './zerodha.js';
import { avatarSVG } from './avatar.js';
import { fireCard } from './fire.js';

let range = 'day';
let selDay = null; // YYYY-MM-DD selected in week/month views

export function setRange(r) { range = r; selDay = null; }

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function tasksOn(dayStart, dayEnd, { includeOverdue = false } = {}) {
  return state.tasks.filter((t) => !t.isTimer && !t.done && t.due && new Date(t.due) <= dayEnd && (includeOverdue || new Date(t.due) >= dayStart))
    .sort((a, b) => new Date(a.due) - new Date(b.due));
}

function taskRow(t, now = new Date()) {
  const overdue = new Date(t.due) < now;
  return `<li class="row" data-task="${t.id}">
    <input type="checkbox" aria-label="Mark done" data-act="task-done" data-id="${t.id}">
    <div class="grow"><div class="title">${esc(t.title)}</div>
      <div class="meta ${overdue ? 'bad' : ''}">${overdue ? 'Overdue · ' : ''}${esc(formatDue(t.due))}</div></div></li>`;
}

function habitsCard() {
  if (!state.habits.length) return '';
  const today = ymd(new Date());
  const done = state.habits.filter((h) => h.log[today]).length;
  return `<div class="card"><div class="card-head"><h3>Habits today</h3><span class="pill ${done === state.habits.length ? 'good' : 'neutral'}">${done}/${state.habits.length}</span></div>
    <div class="habit-chips">${state.habits.map((h) => {
      const on = !!h.log[today];
      const streak = habitStreak(h);
      return `<button type="button" class="habit-chip ${on ? 'done' : ''}" data-act="habit" data-id="${h.id}" aria-pressed="${on}">
        <span class="tick">✓</span><span class="t">${esc(h.name)}</span>${streak > 1 ? `<span class="muted num">🔥${streak}</span>` : ''}</button>`;
    }).join('')}</div></div>`;
}

export function renderHome(el) {
  const now = new Date();
  const name = state.settings.name ? `, ${esc(state.settings.name.split(' ')[0])}` : '';
  const h = healthCheck(state.finance);
  el.innerHTML = `
    <div class="hello">
      <h1>${greeting()}${name}</h1>
      <p>${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <button type="button" class="ask-btn" data-act="ask"><span class="dot">${avatarSVG({ size: 30, title: '' })}</span>Ask Baymax anything…</button>
    </div>
    <div class="seg wide" data-group="range">
      ${['day', 'week', 'month'].map((r) => `<button type="button" data-range="${r}" class="${r === range ? 'on' : ''}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
    </div>
    ${({ day: dayView, week: weekView, month: monthView })[range](now, h)}`;
}

function dayView(now, h) {
  const tasks = tasksOn(startOfDay(now), endOfDay(now), { includeOverdue: true });
  const undated = state.tasks.filter((t) => !t.done && !t.isTimer && !t.due).slice(0, 3);
  const dues = [
    ...dueItems(state.finance, addDays(now, -60), addDays(now, -1)).filter((d) => !d.paid && d.direction !== 'in'),
    ...dueItems(state.finance, now, addDays(now, 7)).filter((d) => !d.paid),
  ];
  const s = h.summary;
  const z = state.finance.zerodha || {};
  const zDue = uploadDue(z.lastUpload) && (now.getDay() === 0 || !z.lastUpload || now - new Date(z.lastUpload) > 7 * 86400000);
  return `
    ${statusCard(h, { compact: true })}
    ${fireCard({ compact: true })}
    ${zDue ? `<div class="card status-card warn"><div class="card-head"><h3>📈 Zerodha upload due</h3></div><p class="hint" style="margin:0 0 12px">${z.lastUpload ? 'It’s been a week since your last holdings upload.' : 'Upload your holdings to track your investments here.'}</p><button class="btn block" data-act="go-invest">Upload holdings</button></div>` : ''}
    <div class="card"><div class="card-head"><h3>Today’s tasks</h3><button class="link" data-act="go" data-view="tasks">All tasks</button></div>
      ${tasks.length || undated.length ? `<ul class="rows flat">${tasks.map((t) => taskRow(t, now)).join('')}${undated.map((t) => `<li class="row"><input type="checkbox" aria-label="Mark done" data-act="task-done" data-id="${t.id}"><div class="grow"><div class="title">${esc(t.title)}</div><div class="meta">No due date</div></div></li>`).join('')}</ul>`
        : '<p class="empty">Nothing due today. Say “add task …” to plan something.</p>'}</div>
    <div class="card"><div class="card-head"><h3>Payments (next 7 days)</h3><button class="link" data-act="go" data-view="money">Money</button></div>
      ${dues.length ? `<ul class="rows flat">${dues.map((d) => dueRow(d, now)).join('')}</ul>` : '<p class="empty">No payments due this week.</p>'}</div>
    ${habitsCard()}
    <div class="card"><h3>Spending</h3>
      <div class="stats">
        <div class="stat"><div class="label">Today</div><div class="value">${inr(s.spentToday, { compact: true })}</div></div>
        <div class="stat"><div class="label">This week</div><div class="value">${inr(s.spentWeek, { compact: true })}</div></div>
        <div class="stat"><div class="label">${s.budget ? 'Per day left' : 'This month'}</div><div class="value">${s.budget ? inr(s.perDayLeft, { compact: true }) : inr(s.spent, { compact: true })}</div></div>
      </div>
      <button class="btn block" style="margin-top:12px" data-act="add-spend">＋ Log a spend</button>
    </div>`;
}

function weekView(now, h) {
  const ws = startOfWeek(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const we = endOfDay(days[6]);
  const allDues = dueItems(state.finance, ws, we);
  const sel = selDay || ymd(now);
  const strip = days.map((d) => {
    const key = ymd(d);
    const nTasks = tasksOn(startOfDay(d), endOfDay(d)).length;
    const nDues = allDues.filter((x) => ymd(x.date) === key && !x.paid).length;
    return `<button type="button" class="wday ${key === ymd(now) ? 'today' : ''} ${key === sel ? 'sel' : ''}" data-act="pick-day" data-day="${key}">
      <span class="dn">${d.toLocaleDateString('en-IN', { weekday: 'short' }).slice(0, 2)}</span><span class="dd">${d.getDate()}</span>
      <span class="dots">${nTasks ? '<i class="task"></i>' : ''}${nDues ? '<i class="due"></i>' : ''}</span></button>`;
  }).join('');
  const sd = new Date(sel + 'T00:00');
  const dayTasks = tasksOn(startOfDay(sd), endOfDay(sd));
  const dayDues = allDues.filter((x) => ymd(x.date) === sel);

  const doneThisWeek = state.tasks.filter((t) => t.done && t.doneAt && new Date(t.doneAt) >= ws).length;
  const openThisWeek = state.tasks.filter((t) => !t.done && !t.isTimer && t.due && new Date(t.due) <= we).length;
  const spentWeek = sumSpends(state.finance, ws, now);
  const lastWeek = sumSpends(state.finance, addDays(ws, -7), addDays(ws, -1));
  const habitTotal = state.habits.length * Math.min(7, Math.round((startOfDay(now) - ws) / 86400000) + 1);
  const habitDone = state.habits.reduce((a, hb) => a + days.filter((d) => hb.log[ymd(d)]).length, 0);
  const weekDuesLeft = allDues.filter((x) => !x.paid && x.direction !== 'in' && x.date >= startOfDay(now));
  const change = lastWeek ? Math.round(((spentWeek - lastWeek) / lastWeek) * 100) : null;

  return `
    <div class="week-strip" style="margin-bottom:14px">${strip}</div>
    <div class="card"><h3>${sd.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
      ${dayTasks.length || dayDues.length ? `<ul class="rows flat">${dayTasks.map((t) => taskRow(t, now)).join('')}${dayDues.map((d) => dueRow(d, now)).join('')}</ul>` : '<p class="empty">Nothing planned for this day.</p>'}</div>
    <div class="card"><h3>This week</h3>
      <div class="stats four">
        <div class="stat"><div class="label">Tasks done</div><div class="value">${doneThisWeek}</div></div>
        <div class="stat"><div class="label">Still open</div><div class="value">${openThisWeek}</div></div>
        <div class="stat"><div class="label">Spent</div><div class="value">${inr(spentWeek, { compact: true })}</div></div>
        <div class="stat"><div class="label">Habits</div><div class="value">${habitTotal ? Math.round((habitDone / habitTotal) * 100) + '%' : '—'}</div></div>
      </div>
      ${change !== null ? `<p class="hint" style="margin:12px 0 0">Spending is ${change > 0 ? `<b style="color:var(--bad)">up ${change}%</b>` : `<b style="color:var(--good)">down ${-change}%</b>`} compared with last week (${inr(lastWeek)}).</p>` : ''}
    </div>
    <div class="card"><h3>Still to pay this week</h3>
      ${weekDuesLeft.length ? `<ul class="rows flat">${weekDuesLeft.map((d) => dueRow(d, now)).join('')}</ul><p class="hint" style="margin:10px 0 0">Total ${inr(weekDuesLeft.reduce((a, d) => a + d.amount, 0))}</p>` : '<p class="empty">All of this week’s payments are done.</p>'}</div>
    ${habitsCard()}`;
}

function monthView(now, h) {
  const s = h.summary;
  const ms = new Date(now.getFullYear(), now.getMonth(), 1);
  const me = new Date(now.getFullYear(), now.getMonth(), daysInMonth(now));
  const dues = dueItems(state.finance, ms, me);
  const sel = selDay && selDay.startsWith(ymd(ms).slice(0, 7)) ? selDay : null;
  const lead = (ms.getDay() + 6) % 7;
  let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="h">${d}</div>`).join('');
  for (let i = 0; i < lead; i++) cells += '<div class="d out"></div>';
  for (let day = 1; day <= daysInMonth(now); day++) {
    const d = new Date(now.getFullYear(), now.getMonth(), day);
    const key = ymd(d);
    const dd = dues.filter((x) => ymd(x.date) === key);
    const unpaidPast = dd.some((x) => !x.paid && x.direction !== 'in' && d < startOfDay(now));
    const nTasks = tasksOn(startOfDay(d), endOfDay(d)).length;
    cells += `<button type="button" class="d ${key === ymd(now) ? 'today' : ''} ${key === sel ? 'sel' : ''}" data-act="pick-day" data-day="${key}" aria-label="${d.toDateString()}">
      <span>${day}</span><span class="dots">${nTasks ? '<i class="task"></i>' : ''}${dd.length ? `<i class="${unpaidPast ? 'bad' : 'due'}"></i>` : ''}</span></button>`;
  }
  const selItems = sel ? [
    ...tasksOn(startOfDay(new Date(sel + 'T00:00')), endOfDay(new Date(sel + 'T00:00'))).map((t) => taskRow(t, now)),
    ...dues.filter((x) => ymd(x.date) === sel).map((d) => dueRow(d, now)),
  ] : [];
  const kinds = ['emi', 'sip', 'bill', 'card', 'invoice'].map((k) => {
    const list = dues.filter((d) => d.kind === k && d.direction !== 'in');
    if (!list.length) return '';
    const paid = list.filter((d) => d.paid).reduce((a, d) => a + d.amount, 0);
    const total = list.reduce((a, d) => a + d.amount, 0);
    return `<div class="bar-row"><span><span class="kind ${k}">${KIND_LABEL[k]}</span></span><b class="num">${inr(paid)} <span class="muted">/ ${inr(total)} paid</span></b>
      <div class="bar"><span style="width:${Math.max(2, (paid / total) * 100)}%"></span></div></div>`;
  }).join('');

  return `
    <div class="card status-card ${h.status}">
      <div class="card-head"><h3>${now.toLocaleDateString('en-IN', { month: 'long' })} at a glance</h3><span class="pill ${{ good: 'good', warn: 'warn', bad: 'bad', setup: 'neutral' }[h.status]}">${esc(h.label)}</span></div>
      <div class="stats four">
        <div class="stat"><div class="label">Income</div><div class="value">${s.income ? inr(s.income, { compact: true }) : '—'}</div></div>
        <div class="stat"><div class="label">Spent</div><div class="value ${s.budget && s.spent > s.budget ? 'bad' : ''}">${inr(s.spent, { compact: true })}</div></div>
        <div class="stat"><div class="label">EMIs + bills</div><div class="value">${inr(s.fixed, { compact: true })}</div></div>
        <div class="stat"><div class="label">Saving</div><div class="value ${s.savingsRate !== null && s.savingsRate < 0.1 ? 'bad' : 'good'}">${s.savingsRate === null ? '—' : Math.round(s.savingsRate * 100) + '%'}</div></div>
      </div>
      ${s.budget ? budgetBar(s) : '<p class="hint" style="margin:12px 0 0">Set an income and budget in Money → Setup to see your pace.</p>'}
    </div>
    ${h.alerts.filter((a) => a.level !== 'info').length ? `<div class="card"><h3>What needs attention</h3>${alertsList(h, { includeInfo: false })}</div>` : ''}
    <div class="card"><h3>Calendar</h3><div class="cal">${cells}</div>
      <div class="legend"><span><i class="dots" style="display:inline-flex"><i class="task"></i></i> Tasks</span><span><i class="dots" style="display:inline-flex"><i class="due"></i></i> Payments</span><span><i class="dots" style="display:inline-flex"><i class="bad"></i></i> Missed payment</span></div>
      ${sel ? `<h3 style="margin-top:14px">${new Date(sel + 'T00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</h3>${selItems.length ? `<ul class="rows flat">${selItems.join('')}</ul>` : '<p class="empty">Nothing on this day.</p>'}` : ''}
    </div>
    ${kinds ? `<div class="card"><h3>Payments this month</h3>${kinds}</div>` : ''}
    <div class="card"><h3>Where it went</h3>${categoryBars(s)}</div>`;
}

export function bindHome(el, { rerender, onAsk, onGo, onTaskDone, onHabit, onMoneyAction }) {
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-group="range"] button');
    if (r) { setRange(r.dataset.range); rerender(); return; }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'ask') return onAsk();
    if (act === 'go') return onGo(t.dataset.view);
    if (act === 'go-invest') { setMoneySub('invest'); return onGo('money'); }
    if (act === 'pick-day') { selDay = t.dataset.day; return rerender(); }
    if (act === 'task-done') return onTaskDone(t.dataset.id);
    if (act === 'habit') return onHabit(t.dataset.id);
    return onMoneyAction(t);
  });
}
