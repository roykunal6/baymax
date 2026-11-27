// Money tab: overview, spends, dues (EMIs, SIPs, bills, card bills), invoices, setup.
// Also exports the add/edit forms and small renderers the Home dashboard reuses.

import {
  state, save, addSpend, addObligation, addInvoice, addCard, updateMoney, removeMoney, setPaid,
} from './store.js';
import {
  inr, healthCheck, dueItems, addDays, KIND_LABEL, CATEGORIES, ymd, parseDay, invoiceLabel, invoiceStatus,
  daysBetween, startOfDay, guessCategory, monthKey,
} from './finance.js';
import { openSheet } from './sheet.js';
import { parseHoldings, mergeHoldings, portfolioSummary, uploadDue, clientIdOf, clientIdFromName, byOwner } from './zerodha.js';
import { readTable } from './statement.js';
import { ordinal } from './money-actions.js';
import { fireCard, openFireSheet } from './fire.js';

const fin = () => state.finance;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
let toast = () => {};
export function setToast(fn) { toast = fn; }
const importer = { open: () => {} };
export function setImporter(fn) { importer.open = fn; }

// ---------------------------------------------------------------- shared bits
export function methodOptions() {
  return [
    { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank / debit card' },
    ...fin().cards.map((c) => ({ value: c.id, label: `${c.name} credit card` })),
  ];
}
export function methodLabel(m) {
  const c = fin().cards.find((x) => x.id === m);
  return c ? c.name : { upi: 'UPI', cash: 'Cash', bank: 'Bank' }[m] || m;
}
export function whenLabel(d, now = new Date()) {
  const n = daysBetween(now, d);
  if (n < 0) return { text: `${-n}d overdue`, cls: 'bad' };
  if (n === 0) return { text: 'Today', cls: 'warn' };
  if (n === 1) return { text: 'Tomorrow', cls: 'warn' };
  if (n <= 7) return { text: `In ${n} days`, cls: 'info' };
  return { text: shortDate(d), cls: 'neutral' };
}

export function statusCard(h, { compact = false } = {}) {
  const s = h.summary;
  const pill = { good: 'good', warn: 'warn', bad: 'bad', setup: 'neutral' }[h.status];
  const next7 = dueItems(fin(), new Date(), addDays(new Date(), 7)).filter((d) => !d.paid && d.direction !== 'in').reduce((a, d) => a + d.amount, 0);
  return `<div class="card status-card ${h.status}">
    <div class="card-head"><h3>Money this month</h3><span class="pill ${pill}">${esc(h.label)}</span></div>
    <p class="headline">${esc(h.headline)}</p>
    <div class="stats">
      <div class="stat"><div class="label">Spent</div><div class="value">${inr(s.spent, { compact: true })}</div></div>
      <div class="stat"><div class="label">${s.budget ? 'Left' : 'Budget'}</div><div class="value ${s.budget && s.left < 0 ? 'bad' : ''}">${s.budget ? inr(s.left, { compact: true }) : '—'}</div></div>
      <div class="stat"><div class="label">Due in 7 days</div><div class="value">${inr(next7, { compact: true })}</div></div>
    </div>
    ${!compact && s.budget ? budgetBar(s) : ''}
  </div>`;
}

export function budgetBar(s) {
  const pct = Math.min(100, (s.spent / s.budget) * 100);
  const expected = Math.min(100, (s.expectedByNow / s.budget) * 100);
  const cls = s.spent > s.budget ? 'bad' : s.spent > s.expectedByNow * 1.05 ? 'warn' : '';
  return `<div style="margin-top:14px">
    <div class="bar ${cls}" role="img" aria-label="${Math.round(pct)}% of budget used"><span style="width:${pct}%"></span><i class="marker" style="left:${expected}%"></i></div>
    <div class="legend"><span>${Math.round(pct)}% of ${inr(s.budget)} used</span><span>│ marker = where you should be by today</span></div>
  </div>`;
}

export function dueRow(d, now = new Date()) {
  const w = d.paid ? { text: 'Paid', cls: 'good' } : whenLabel(d.date, now);
  const isIn = d.direction === 'in';
  const btn = d.paid ? '' : `<button class="btn small" data-act="pay" data-ref="${d.ref}" data-id="${d.id}" data-key="${d.key}">${isIn ? 'Received' : 'Paid'}</button>`;
  return `<li class="row tap" data-act="edit-due" data-ref="${d.ref}" data-id="${d.id}">
    <div class="grow"><div class="title"><span class="kind ${d.kind}">${esc(KIND_LABEL[d.kind])}</span> ${esc(d.name)}</div>
      <div class="meta">${isIn ? 'To receive · ' : ''}${w.cls === 'neutral' ? '' : `${shortDate(d.date)} · `}<span class="pill ${w.cls}">${esc(w.text)}</span></div></div>
    <div class="right"><div class="amount">${inr(d.amount)}</div>${btn}</div></li>`;
}

export function categoryBars(s, limit = 6) {
  const entries = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!entries.length) return '<p class="empty">No spends logged this month yet.</p>';
  const max = entries[0][1];
  return entries.map(([cat, amt]) => {
    const cap = fin().categoryBudgets?.[cat];
    const cls = cap && amt > cap ? 'bad' : cap && amt > cap * 0.8 ? 'warn' : '';
    return `<div class="bar-row"><span>${esc(cat)}${cap ? ` <span class="muted">/ ${inr(cap, { compact: true })}</span>` : ''}</span><b class="num">${inr(amt)}</b>
      <div class="bar ${cls}"><span style="width:${Math.max(3, (amt / (cap || max)) * 100)}%"></span></div></div>`;
  }).join('');
}

export function alertsList(h, { includeInfo = true } = {}) {
  const list = h.alerts.filter((a) => includeInfo || a.level !== 'info');
  if (!list.length) return '';
  const icon = { bad: '⚠️', warn: '⚡', info: '🔔', good: '✅' };
  return `<div class="alerts">${list.map((a) => `<div class="alert ${a.level}"><i>${icon[a.level]}</i><span>${esc(a.text)}</span></div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- forms
export function spendForm(x = null) {
  openSheet({
    title: x ? 'Edit spend' : 'Add spend',
    values: x || { date: ymd(new Date()), method: 'upi', category: '' },
    fields: [
      { key: 'amount', label: 'Amount (₹)', type: 'amount', required: true, placeholder: '450', half: true },
      { key: 'date', label: 'Date', type: 'date', required: true, half: true },
      { key: 'note', label: 'What for', type: 'text', placeholder: 'Lunch at office' },
      { key: 'category', label: 'Category', type: 'select', options: [{ value: '', label: 'Guess from description' }, ...CATEGORIES], half: true },
      { key: 'method', label: 'Paid with', type: 'select', options: methodOptions(), half: true },
    ],
    onSave: (v) => {
      v.category = v.category || guessCategory(v.note);
      if (x) updateMoney('spends', x.id, v); else addSpend(v);
      toast(x ? 'Spend updated' : `Logged ${inr(v.amount)}`);
    },
    onDelete: x ? () => { removeMoney('spends', x.id); toast('Spend deleted'); } : null,
  });
}

export function dueForm(o = null, kind = 'emi') {
  const v = o ? {
    kind: o.kind, name: o.name, amount: o.amount, repeat: o.schedule.type,
    day: o.schedule.type === 'monthly' ? o.schedule.day : '', date: o.schedule.type === 'once' ? o.schedule.date : '', endMonth: o.endMonth || '',
  } : { kind, repeat: 'monthly', day: new Date().getDate(), date: ymd(addDays(new Date(), 7)) };
  openSheet({
    title: o ? `Edit ${KIND_LABEL[o.kind]}` : 'Add EMI, SIP or bill',
    values: v,
    fields: [
      { key: 'kind', label: 'Type', type: 'select', options: [{ value: 'emi', label: 'EMI / loan' }, { value: 'sip', label: 'SIP / investment' }, { value: 'bill', label: 'Bill / subscription / rent' }], half: true },
      { key: 'repeat', label: 'Repeats', type: 'select', options: [{ value: 'monthly', label: 'Every month' }, { value: 'once', label: 'One time' }], half: true },
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Car loan, Axis Bluechip, Electricity…' },
      { key: 'amount', label: 'Amount (₹)', type: 'amount', required: true, half: true },
      { key: 'day', label: 'Day of month (monthly)', type: 'day', half: true },
      { key: 'date', label: 'Due date (one time)', type: 'date', half: true },
      { key: 'endMonth', label: 'Last month (optional)', type: 'month', half: true },
    ],
    onSave: (f) => {
      if (f.repeat === 'monthly' && !f.day) return 'Add the day of the month it’s due, e.g. 10.';
      if (f.repeat === 'once' && !f.date) return 'Pick the due date.';
      const data = {
        kind: f.kind, name: f.name, amount: f.amount, endMonth: f.endMonth || null,
        schedule: f.repeat === 'monthly' ? { type: 'monthly', day: f.day } : { type: 'once', date: f.date },
      };
      if (o) { if (o.schedule.type === 'monthly' && data.schedule.type === 'monthly' && o.schedule.day !== data.schedule.day) data.startMonth = null; updateMoney('obligations', o.id, data); } else addObligation(data);
      toast(o ? 'Saved' : `${KIND_LABEL[f.kind]} added`);
    },
    onDelete: o ? () => { removeMoney('obligations', o.id); toast('Deleted'); } : null,
  });
}

export function invoiceForm(inv = null) {
  openSheet({
    title: inv ? 'Edit invoice' : 'Add invoice',
    values: inv ? { ...inv, paid: !!inv.paidAt } : { party: 'Thestral', direction: 'in', dueDate: ymd(addDays(new Date(), 15)) },
    fields: [
      { key: 'party', label: 'Client / vendor', type: 'text', required: true, half: true },
      { key: 'number', label: 'Invoice no.', type: 'text', placeholder: 'T-12', half: true },
      { key: 'amount', label: 'Amount (₹)', type: 'amount', required: true, half: true },
      { key: 'dueDate', label: 'Due date', type: 'date', required: true, half: true },
      { key: 'direction', label: 'Type', type: 'select', options: [{ value: 'in', label: 'I will receive this (I billed them)' }, { value: 'out', label: 'I have to pay this (they billed me)' }] },
      { key: 'paid', label: 'Already paid', type: 'check' },
    ],
    onSave: (f) => {
      const data = { party: f.party, number: f.number, amount: f.amount, dueDate: f.dueDate, direction: f.direction, paidAt: f.paid ? (inv?.paidAt || ymd(new Date())) : null };
      if (inv) updateMoney('invoices', inv.id, data); else { const n = addInvoice(data); if (data.paidAt) updateMoney('invoices', n.id, { paidAt: data.paidAt }); }
      toast(inv ? 'Invoice saved' : 'Invoice added');
    },
    onDelete: inv ? () => { removeMoney('invoices', inv.id); toast('Invoice deleted'); } : null,
  });
}

export function cardForm(c = null) {
  openSheet({
    title: c ? `Edit ${c.name} card` : 'Add credit card',
    values: c || {},
    fields: [
      { key: 'name', label: 'Card name', type: 'text', required: true, placeholder: 'HDFC Regalia' },
      { key: 'limit', label: 'Credit limit / monthly cap (₹)', type: 'amount', required: false, half: true },
      { key: 'dueDay', label: 'Bill due day', type: 'day', half: true },
      { key: 'last4', label: 'Last 4 digits of the card (to match bank alerts)', type: 'text', placeholder: '1234' },
    ],
    onSave: (f) => {
      const last4 = String(f.last4 || '').replace(/\D/g, '').slice(-4);
      if (f.last4 && last4.length !== 4) return 'Enter the last 4 digits of the card number.';
      const data = { name: f.name, limit: f.limit > 0 ? f.limit : 0, dueDay: f.dueDay || null, last4 };
      if (c) updateMoney('cards', c.id, data); else addCard(data);
      toast(c ? 'Card saved' : 'Card added');
    },
    onDelete: c ? () => { removeMoney('cards', c.id); toast('Card removed'); } : null,
  });
}

export function handlePay(ref, id, key) {
  setPaid(ref, id, key, true);
  toast('Marked as paid');
}

// ---------------------------------------------------------------- Money view
let sub = 'overview';
let spendMonth = 0; // 0 = this month, -1 = last month…
let spendFilter = 'all';
let invDir = 'in';

export function renderMoney(el) {
  const h = healthCheck(fin());
  const tabs = [['overview', 'Overview'], ['spends', 'Spends'], ['dues', 'Dues'], ['invest', 'Invest'], ['invoices', 'Invoices'], ['setup', 'Setup']];
  el.innerHTML = `
    <div class="page-head"><h1>Money</h1><span class="muted">${new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span></div>
    <div class="seg wide" data-group="money-sub">${tabs.map(([k, l]) => `<button type="button" data-sub="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="money-body">${({ overview, spends, dues, invest, invoices, setup })[sub](h)}</div>`;
}

function overview(h) {
  const s = h.summary;
  const now = new Date();
  const upcoming = [
    ...dueItems(fin(), addDays(now, -60), addDays(now, -1)).filter((d) => !d.paid && d.direction !== 'in'),
    ...dueItems(fin(), now, addDays(now, 30)).filter((d) => !d.paid),
  ];
  return `
    ${statusCard(h)}
    <div class="quick">
      <button type="button" data-act="add-spend"><b>＋</b>Spend</button>
      <button type="button" data-act="add-due"><b>＋</b>EMI / SIP / bill</button>
      <button type="button" data-act="add-invoice"><b>＋</b>Invoice</button>
      <button type="button" data-act="add-card"><b>＋</b>Credit card</button>
    </div>
    <h3 class="section-title">This month</h3>
    <div class="card">
      <div class="stats four">
        <div class="stat"><div class="label">Income</div><div class="value">${s.income ? inr(s.income, { compact: true }) : '—'}</div></div>
        <div class="stat"><div class="label">EMIs + bills</div><div class="value">${inr(s.fixed, { compact: true })}</div></div>
        <div class="stat"><div class="label">SIPs</div><div class="value">${inr(s.sip, { compact: true })}</div></div>
        <div class="stat"><div class="label">Saving</div><div class="value ${s.savingsRate !== null && s.savingsRate < 0.1 ? 'bad' : 'good'}">${s.savingsRate === null ? '—' : Math.round(s.savingsRate * 100) + '%'}</div></div>
      </div>
      ${s.toReceive ? `<p class="hint" style="margin:12px 0 0">To receive from invoices: <b>${inr(s.toReceive)}</b>${s.overdueInvoices.length ? ` · <span style="color:var(--bad)">${s.overdueInvoices.length} overdue</span>` : ''}</p>` : ''}
    </div>
    <div class="card"><div class="card-head"><h3>Where it went</h3><button class="link" data-act="goto" data-sub="spends">All spends</button></div>${categoryBars(s)}</div>
    ${fin().cards.length ? `<div class="card"><h3>Credit cards</h3>${fin().cards.map((c) => {
      const used = s.byCard[c.id] || 0;
      const pct = c.limit ? Math.min(100, (used / c.limit) * 100) : 0;
      return `<div class="bar-row"><span>${esc(c.name)}</span><b class="num">${inr(used)}${c.limit ? ` <span class="muted">/ ${inr(c.limit, { compact: true })}</span>` : ''}</b>
        ${c.limit ? `<div class="bar ${pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : ''}"><span style="width:${Math.max(2, pct)}%"></span></div>` : ''}</div>`;
    }).join('')}</div>` : ''}
    <div class="card"><div class="card-head"><h3>Coming up (30 days)</h3><button class="link" data-act="goto" data-sub="dues">All dues</button></div>
      ${upcoming.length ? `<ul class="rows flat">${upcoming.map((d) => dueRow(d, now)).join('')}</ul>` : '<p class="empty">Nothing due. Add EMIs, SIPs and bills to get reminders.</p>'}</div>
    ${h.alerts.length ? `<h3 class="section-title">Alerts</h3>${alertsList(h)}` : ''}`;
}

function spends() {
  const now = new Date();
  const ref = new Date(now.getFullYear(), now.getMonth() + spendMonth, 1);
  const mk = monthKey(ref);
  const filters = [['all', 'All'], ...fin().cards.map((c) => [c.id, c.name]), ['upi', 'UPI'], ['cash', 'Cash'], ['bank', 'Bank']];
  const list = fin().spends.filter((x) => String(x.date).startsWith(mk) && (spendFilter === 'all' || x.method === spendFilter))
    .sort((a, b) => b.date.localeCompare(a.date));
  const total = list.reduce((a, x) => a + x.amount, 0);
  const byDay = {};
  for (const x of list) (byDay[x.date] = byDay[x.date] || []).push(x);
  return `
    <div class="card-head" style="margin:4px 0 10px">
      <div class="btn-row"><button class="btn small" data-act="month" data-d="-1" aria-label="Previous month">‹</button>
      <b>${ref.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</b>
      <button class="btn small" data-act="month" data-d="1" aria-label="Next month" ${spendMonth >= 0 ? 'disabled' : ''}>›</button></div>
      <div class="btn-row"><button class="btn small" data-act="import-statement">Import statement</button><button class="btn primary small" data-act="add-spend">＋ Spend</button></div>
    </div>
    <div class="chips">${filters.map(([k, l]) => `<button type="button" class="chip ${spendFilter === k ? 'on' : ''}" data-act="filter" data-f="${esc(k)}">${esc(l)}</button>`).join('')}</div>
    ${(() => {
      const credits = spendFilter === 'all' ? (fin().credits || []).filter((x) => String(x.date).startsWith(mk)).sort((a, b) => b.date.localeCompare(a.date)) : [];
      const inTotal = credits.reduce((a, x) => a + x.amount, 0);
      return `<div class="card"><div class="card-head"><h3>${credits.length ? 'Net spent' : 'Total'}</h3><b class="num" style="font-size:20px">${inr(Math.max(0, total - inTotal))}</b></div>
      ${credits.length ? `<div class="row-mini"><span>Money out (${list.length})</span><b>${inr(total)}</b></div><div class="row-mini"><span>Money in (${credits.length})</span><b style="color:var(--good)">− ${inr(inTotal)}</b></div>
        <details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-weight:650">Money in this month</summary>
        <ul class="rows flat">${credits.map((x) => `<li class="row"><div class="grow"><div class="title">${esc(x.from || 'Money in')}</div><div class="meta">${esc(parseDay(x.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))} · ${esc(x.kind || 'credit')}</div></div><div class="amount" style="color:var(--good)">+${inr(x.amount)}</div></li>`).join('')}</ul></details>`
        : `<p class="hint" style="margin:0">${list.length} spend${list.length === 1 ? '' : 's'}. Tip: say “spent 450 on lunch with ${esc(fin().cards[0]?.name || 'UPI')}”.</p>`}</div>`;
    })()}
    ${Object.keys(byDay).length ? Object.entries(byDay).map(([day, items]) => `
      <div class="group-label"><span>${parseDay(day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span><span class="num">${inr(items.reduce((a, x) => a + x.amount, 0))}</span></div>
      <ul class="rows">${items.map((x) => `<li class="row tap" data-act="edit-spend" data-id="${x.id}">
        <div class="grow"><div class="title">${esc(x.note || x.category)}</div><div class="meta">${esc(x.category)} · ${esc(methodLabel(x.method))}</div></div>
        <div class="amount">${inr(x.amount)}</div></li>`).join('')}</ul>`).join('') : '<p class="empty">No spends here yet.</p>'}
    ${list.length || (fin().credits || []).some((x) => String(x.date).startsWith(mk)) ? `<button class="btn small danger" style="margin-top:16px" data-act="clear-month" data-month="${mk}" data-label="Delete all spends for ${ref.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}">Delete all spends for ${ref.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</button>` : ''}`;
}

function dues() {
  const now = new Date();
  const mk = monthKey(now);
  const group = (kind, title) => {
    const items = fin().obligations.filter((o) => o.kind === kind);
    if (!items.length) return '';
    const total = items.filter((o) => o.schedule.type === 'monthly' && (!o.endMonth || o.endMonth >= mk)).reduce((a, o) => a + o.amount, 0);
    return `<div class="group-label"><span>${title}</span><span class="num">${inr(total)}/month</span></div>
      <ul class="rows">${items.map((o) => {
        const next = dueItems(fin(), addDays(now, -60), addDays(now, 400)).find((d) => d.ref === 'obligation' && d.id === o.id && !d.paid);
        const thisMonth = dueItems(fin(), new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 0)).find((d) => d.ref === 'obligation' && d.id === o.id);
        const sched = o.schedule.type === 'monthly' ? `Every month on the ${ordinal(o.schedule.day)}${o.endMonth ? ` until ${o.endMonth}` : ''}` : `One time, ${shortDate(parseDay(o.schedule.date))}`;
        const w = thisMonth?.paid ? { text: 'Paid this month', cls: 'good' } : next ? whenLabel(next.date, now) : { text: 'Finished', cls: 'neutral' };
        return `<li class="row tap" data-act="edit-ob" data-id="${o.id}">
          <span class="kind ${o.kind}">${KIND_LABEL[o.kind]}</span>
          <div class="grow"><div class="title">${esc(o.name)}</div><div class="meta">${esc(sched)} · <span class="pill ${w.cls}">${esc(w.text)}</span></div></div>
          <div class="amount">${inr(o.amount)}</div>
          ${next && !thisMonth?.paid ? `<button class="btn small" data-act="pay" data-ref="obligation" data-id="${o.id}" data-key="${next.key}">Paid</button>` : ''}</li>`;
      }).join('')}</ul>`;
  };
  const cardBills = dueItems(fin(), addDays(now, -45), addDays(now, 45)).filter((d) => d.kind === 'card');
  const any = fin().obligations.length || cardBills.length;
  return `
    <button class="btn primary block" data-act="add-due" style="margin:4px 0 6px">＋ Add EMI, SIP or bill</button>
    ${group('emi', 'EMIs')}${group('sip', 'SIPs')}${group('bill', 'Bills & subscriptions')}
    ${cardBills.length ? `<div class="group-label"><span>Credit card bills</span><span class="muted">from last month’s spends</span></div><ul class="rows">${cardBills.map((d) => dueRow(d, now)).join('')}</ul>` : ''}
    ${any ? '' : '<p class="empty">No dues yet. Add your EMIs, SIPs and bills, or say “add EMI car loan 18500 on 10th”.</p>'}`;
}

function invest() {
  const f = fin();
  const holdings = (f.holdings || []).slice().sort((a, b) => b.value - a.value);
  const s = portfolioSummary(holdings);
  const last = f.zerodha?.lastUpload ? new Date(f.zerodha.lastUpload) : null;
  const due = uploadDue(f.zerodha?.lastUpload);
  const sips = f.obligations.filter((o) => o.kind === 'sip');
  const sipTotal = sips.filter((o) => o.schedule.type === 'monthly').reduce((a, o) => a + o.amount, 0);
  const hist = (f.zerodha?.history || []).slice(-12);
  const spark = hist.length > 1 ? (() => {
    const vals = hist.map((x) => x.value), min = Math.min(...vals), max = Math.max(...vals), w = 280, hgt = 48;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${hgt - ((v - min) / ((max - min) || 1)) * (hgt - 6) - 3}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${hgt}" width="100%" height="${hgt}" role="img" aria-label="Portfolio value trend"><polyline points="${pts}" fill="none" stroke="var(--good)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  })() : '';
  const pnlCls = s.pnl >= 0 ? 'good' : 'bad';
  return `
    ${fireCard()}
    <div class="card status-card ${due ? 'warn' : 'good'}">
      <div class="card-head"><h3>Zerodha portfolio</h3><span class="pill ${due ? 'warn' : 'good'}">${due ? 'Upload due' : 'Up to date'}</span></div>
      <p class="hint" style="margin:0 0 12px">${last ? `Last upload ${last.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}.` : 'No holdings uploaded yet.'} Upload every Sunday: Zerodha Console → Portfolio → Holdings → Download (Equity, then Mutual funds).</p>
      <label class="btn primary block">Upload holdings file<input type="file" id="zerodha-file" accept=".xlsx,.xls,.csv" multiple hidden></label>
    </div>
    ${holdings.length ? `
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="label">Current value</div><div class="value">${inr(s.value, { compact: true })}</div></div>
        <div class="stat"><div class="label">Invested</div><div class="value">${inr(s.invested, { compact: true })}</div></div>
        <div class="stat"><div class="label">Gain</div><div class="value ${pnlCls}">${s.pnl >= 0 ? '+' : ''}${s.pnlPct.toFixed(1)}%</div></div>
      </div>
      <p class="hint" style="margin:10px 0 0">${s.pnl >= 0 ? 'Up' : 'Down'} <b class="num">${inr(Math.abs(s.pnl))}</b> overall.</p>
      ${s.value ? `<div class="bar" style="margin-top:12px" role="img" aria-label="Stocks vs funds"><span style="width:${(s.equity.value / s.value) * 100}%;background:var(--info)"></span></div>
      <div class="legend"><span>Stocks ${inr(s.equity.value, { compact: true })} (${Math.round((s.equity.value / s.value) * 100)}%)</span><span>Funds ${inr(s.mf.value, { compact: true })} (${Math.round((s.mf.value / s.value) * 100)}%)</span></div>` : ''}
      ${spark ? `<div style="margin-top:12px">${spark}<div class="legend"><span>Value over your last ${hist.length} uploads</span></div></div>` : ''}
    </div>
    ${(() => { const per = byOwner(holdings); const nm = f.zerodha?.names || {}; return per.length > 1 || per[0]?.owner ? `<div class="card"><h3>By account</h3><ul class="rows flat">${per.map((o) => `<li class="row"><div class="grow"><div class="title">${esc(nm[o.owner] || o.owner || 'Earlier upload')}</div><div class="meta">${o.owner ? `${esc(o.owner)} · ` : ''}${o.count} holdings · invested ${inr(o.invested, { compact: true })}</div></div><div class="right"><div class="amount">${inr(o.value, { compact: true })}</div><div class="meta" style="color:var(--${o.pnl >= 0 ? 'good' : 'bad'});font-weight:650">${o.pnl >= 0 ? '+' : '−'}${inr(Math.abs(o.pnl), { compact: true }).replace('−', '')}</div></div></li>`).join('')}</ul></div>` : ''; })()}
    <div class="group-label"><span>Holdings</span><span>${holdings.length}</span></div>
    <ul class="rows">${holdings.slice(0, 60).map((x) => `<li class="row">
      <span class="kind ${x.type === 'mf' ? 'sip' : 'bill'}">${x.type === 'mf' ? 'FUND' : 'STOCK'}</span>
      <div class="grow"><div class="title">${esc(x.symbol)}</div><div class="meta">${x.owner && f.zerodha?.names?.[x.owner] ? `<span class="box-tag">${esc(f.zerodha.names[x.owner])}</span> ` : ''}${x.qty} × ${inr(x.avg)} → ${inr(x.price)}</div></div>
      <div class="right"><div class="amount">${inr(x.value)}</div><div class="meta" style="color:var(--${x.pnl >= 0 ? 'good' : 'bad'});font-weight:650">${x.pnl >= 0 ? '+' : '−'}${inr(Math.abs(x.pnl)).replace('−', '')}</div></div></li>`).join('')}</ul>` : ''}
    <div class="group-label"><span>SIPs</span><span class="num">${inr(sipTotal)}/month</span></div>
    ${sips.length ? `<ul class="rows">${sips.map((o) => `<li class="row tap" data-act="edit-ob" data-id="${o.id}"><span class="kind sip">SIP</span><div class="grow"><div class="title">${esc(o.name)}</div><div class="meta">${o.schedule.type === 'monthly' ? `Every month on the ${ordinal(o.schedule.day)}` : 'One time'}</div></div><div class="amount">${inr(o.amount)}</div></li>`).join('')}</ul>`
      : '<p class="empty">Add your SIPs so Baymax reminds you and tracks them: say “add SIP 5000 Axis Bluechip on 7th”.</p>'}`;
}

/** Read one or more Zerodha files and update holdings. */
export async function uploadHoldings(files) {
  let uploaded = [];
  const f = fin();
  f.zerodha = { ...(f.zerodha || {}) };
  const names = { ...(f.zerodha.names || {}) };
  for (const file of files) {
    const rows = await readTable(file);
    const owner = clientIdOf(rows) || clientIdFromName(file.name);
    if (owner && !names[owner]) {
      const n = typeof prompt === 'function' ? prompt(`Whose Zerodha account is ${owner}? (e.g. Kunal, Anmol)`, '') : '';
      names[owner] = (n || owner).trim().slice(0, 30);
    }
    uploaded = uploaded.concat(parseHoldings(rows, { owner }));
  }
  if (!uploaded.length) throw new Error('No holdings found. Use Zerodha Console → Portfolio → Holdings → Download.');
  f.zerodha.names = names;
  // FIRE: holdings uploaded for someone now count live, so drop a fixed "<name> … Zerodha" amount for them.
  if (f.fire?.assets) {
    const uploadedNames = [...new Set(uploaded.map((h) => names[h.owner]).filter(Boolean))].map((n) => n.toLowerCase());
    f.fire.assets = f.fire.assets.filter((a) => !(/zerodha/i.test(a.name) && uploadedNames.some((n) => a.name.toLowerCase().includes(n))));
  }
  f.holdings = mergeHoldings(f.holdings, uploaded);
  const s = portfolioSummary(f.holdings);
  f.zerodha = { ...(f.zerodha || {}), lastUpload: new Date().toISOString() };
  f.zerodha.history = [...(f.zerodha.history || []), { date: ymd(new Date()), value: Math.round(s.value), invested: Math.round(s.invested) }].slice(-104);
  save();
  return { count: uploaded.length, summary: s };
}

function invoices() {
  const now = new Date();
  const list = fin().invoices.filter((i) => (i.direction || 'in') === invDir)
    .sort((a, b) => (a.paidAt ? 1 : 0) - (b.paidAt ? 1 : 0) || String(a.dueDate).localeCompare(b.dueDate));
  const open = list.filter((i) => !i.paidAt);
  const overdue = open.filter((i) => invoiceStatus(i, now) === 'overdue');
  const pill = { paid: ['good', invDir === 'in' ? 'Received' : 'Paid'], overdue: ['bad', 'Overdue'], pending: ['info', 'Pending'] };
  return `
    <div class="card-head" style="margin:4px 0 10px">
      <div class="seg" data-group="inv"><button type="button" data-dir="in" class="${invDir === 'in' ? 'on' : ''}">To receive</button><button type="button" data-dir="out" class="${invDir === 'out' ? 'on' : ''}">To pay</button></div>
      <button class="btn primary small" data-act="add-invoice">＋ Invoice</button>
    </div>
    <div class="card"><div class="stats">
      <div class="stat"><div class="label">Outstanding</div><div class="value">${inr(open.reduce((a, i) => a + i.amount, 0), { compact: true })}</div></div>
      <div class="stat"><div class="label">Overdue</div><div class="value ${overdue.length ? 'bad' : ''}">${inr(overdue.reduce((a, i) => a + i.amount, 0), { compact: true })}</div></div>
      <div class="stat"><div class="label">${invDir === 'in' ? 'Received' : 'Paid'} (month)</div><div class="value">${inr(list.filter((i) => i.paidAt && String(i.paidAt).startsWith(monthKey(now))).reduce((a, i) => a + i.amount, 0), { compact: true })}</div></div>
    </div></div>
    ${list.length ? `<ul class="rows">${list.map((i) => {
      const st = invoiceStatus(i, now);
      return `<li class="row tap" data-act="edit-inv" data-id="${i.id}">
        <span class="kind invoice">INV</span>
        <div class="grow"><div class="title">${esc(invoiceLabel(i))}</div>
          <div class="meta">${i.paidAt ? `${pill.paid[1]} ${shortDate(parseDay(i.paidAt))}` : `Due ${shortDate(parseDay(i.dueDate))}`} · <span class="pill ${pill[st][0]}">${pill[st][1]}</span></div></div>
        <div class="amount">${inr(i.amount)}</div>
        ${i.paidAt ? '' : `<button class="btn small" data-act="pay" data-ref="invoice" data-id="${i.id}" data-key="once">${invDir === 'in' ? 'Received' : 'Paid'}</button>`}</li>`;
    }).join('')}</ul>` : `<p class="empty">No invoices ${invDir === 'in' ? 'to receive' : 'to pay'}. Say “add Thestral invoice 45000 due next Friday”.</p>`}`;
}

function setup() {
  const f = fin();
  return `
    <form class="card form-grid" id="money-setup">
      <h3>Monthly numbers</h3>
      <div class="form-row">
        <label>Monthly income (₹)<input name="income" inputmode="decimal" value="${f.income || ''}" placeholder="150000" autocomplete="off"></label>
        <label>Spending budget (₹)<input name="budget" inputmode="decimal" value="${f.budget || ''}" placeholder="40000" autocomplete="off"></label>
      </div>
      <p class="hint" style="margin:-4px 0 0">Budget is for day-to-day spending (food, shopping, travel…). EMIs, bills and SIPs are tracked separately. Leave it empty to use income minus EMIs, bills and SIPs.</p>
      <h3 style="margin-top:6px">Your accounts</h3>
      <label>Your name as it appears on transfers<input name="selfNames" value="${esc(f.selfNames || '')}" placeholder="Kunal Roy, Kunal Partha Roy" autocomplete="off"></label>
      <label>Your account / card numbers (last 4 digits)<input name="ownAccounts" value="${esc(f.ownAccounts || '')}" placeholder="9361, 0879, 7004, 0816" autocomplete="off" inputmode="numeric"></label>
      <p class="hint" style="margin:-4px 0 0">Money moved between these accounts, SIPs, EMIs and anything mentioning FLEXI are never counted as spending.</p>
      <label>Remind me about payments<select name="remindDays">${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${Number(f.remindDays) === n ? 'selected' : ''}>${n === 0 ? 'On the due date' : `${n} day${n > 1 ? 's' : ''} before`}</option>`).join('')}</select></label>
      <details><summary class="muted" style="cursor:pointer;font-weight:650">Category budgets (optional)</summary>
        <div class="form-row" style="margin-top:12px">${CATEGORIES.map((c) => `<label>${c}<input name="cat-${c}" inputmode="decimal" value="${f.categoryBudgets?.[c] || ''}" autocomplete="off"></label>`).join('')}</div>
      </details>
      <button class="btn primary">Save</button>
    </form>
    <div class="card"><div class="card-head"><h3>Credit cards</h3><button class="btn small" data-act="add-card">＋ Add card</button></div>
      ${f.cards.length ? `<ul class="rows flat">${f.cards.map((c) => `<li class="row tap" data-act="edit-card" data-id="${c.id}">
        <span class="kind card">CARD</span><div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="meta">${c.last4 ? `•••• ${esc(c.last4)} · ` : ''}${c.limit ? `Limit ${inr(c.limit)}` : 'No limit set'}${c.dueDay ? ` · bill due on the ${ordinal(c.dueDay)}` : ''}</div></div></li>`).join('')}</ul>` : '<p class="empty">Add your cards to track spends and bill dates per card.</p>'}
    </div>`;
}

/** One delegated handler for everything clickable in the Money view and money rows elsewhere. */
export function bindMoney(el, rerender) {
  el.addEventListener('click', (e) => {
    const segBtn = e.target.closest('[data-group="money-sub"] button');
    if (segBtn) { sub = segBtn.dataset.sub; rerender(); return; }
    const dirBtn = e.target.closest('[data-group="inv"] button');
    if (dirBtn) { invDir = dirBtn.dataset.dir; rerender(); return; }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    handleMoneyAction(t, rerender);
  });
  el.addEventListener('change', async (e) => {
    if (e.target.id !== 'zerodha-file' || !e.target.files.length) return;
    try {
      const r = await uploadHoldings([...e.target.files]);
      toast(`Updated ${r.count} holdings · ${inr(r.summary.value)} total`);
    } catch (err) { toast(err.message || 'Couldn’t read that file'); }
    e.target.value = '';
  });
  el.addEventListener('submit', (e) => {
    if (e.target.id !== 'money-setup') return;
    e.preventDefault();
    const fd = new FormData(e.target);
    const num = (k) => { const n = Number(String(fd.get(k) || '').replace(/[,₹\s]/g, '')); return n > 0 ? n : 0; };
    const f = fin();
    f.income = num('income'); f.budget = num('budget'); f.remindDays = Number(fd.get('remindDays'));
    f.selfNames = String(fd.get('selfNames') || '').trim().slice(0, 200); f.ownAccounts = String(fd.get('ownAccounts') || '').trim().slice(0, 100);
    f.categoryBudgets = {};
    for (const c of CATEGORIES) { const n = num(`cat-${c}`); if (n) f.categoryBudgets[c] = n; }
    save();
    toast('Money settings saved');
  });
}

export function handleMoneyAction(t, rerender = () => {}) {
  const act = t.dataset.act;
  const id = t.dataset.id;
  switch (act) {
    case 'clear-month': {
      if (t.dataset.armed !== '1') { t.dataset.armed = '1'; t.textContent = 'Tap again to delete'; setTimeout(() => { t.dataset.armed = ''; t.textContent = t.dataset.label; }, 3500); return; }
      const mk = t.dataset.month;
      const f = fin();
      const before = f.spends.length + (f.credits || []).length;
      f.spends = f.spends.filter((x) => !String(x.date).startsWith(mk));
      f.credits = (f.credits || []).filter((x) => !String(x.date).startsWith(mk));
      if (f.statementUploads) { const { [mk]: _gone, ...rest } = f.statementUploads; f.statementUploads = rest; }
      save();
      toast(`Deleted ${before - f.spends.length - f.credits.length} spends and money-in entries for ${mk}`);
      return rerender();
    }
    case 'add-spend': return spendForm();
    case 'fire-edit': return openFireSheet(rerender);
    case 'add-due': return dueForm();
    case 'add-invoice': return invoiceForm();
    case 'add-card': return cardForm();
    case 'import-statement': return importer.open();
    case 'edit-spend': return spendForm(fin().spends.find((x) => x.id === id));
    case 'edit-ob': return dueForm(fin().obligations.find((x) => x.id === id));
    case 'edit-inv': return invoiceForm(fin().invoices.find((x) => x.id === id));
    case 'edit-card': return cardForm(fin().cards.find((x) => x.id === id));
    case 'edit-due': {
      const ref = t.dataset.ref;
      if (ref === 'obligation') return dueForm(fin().obligations.find((x) => x.id === id));
      if (ref === 'invoice') return invoiceForm(fin().invoices.find((x) => x.id === id));
      if (ref === 'card') return cardForm(fin().cards.find((x) => x.id === id));
      return null;
    }
    case 'pay': return handlePay(t.dataset.ref, id, t.dataset.key);
    case 'goto': sub = t.dataset.sub; return rerender();
    case 'month': spendMonth = Math.min(0, spendMonth + Number(t.dataset.d)); return rerender();
    case 'filter': spendFilter = t.dataset.f; return rerender();
    default: return null;
  }
}

export function setMoneySub(s) { sub = s; }
export { startOfDay };
