// FIRE (financial independence) tracker: corpus vs target with a progress bar, and when you get
// there at today's pace (flat SIPs) or with a yearly SIP step-up, including money freed when a
// loan ends. Your Zerodha value is live; other assets (partner's investments, US stocks, PF…) are
// entered once and edited any time. Pure maths is exported for tests.

import { state, save } from './store.js';
import { inr } from './finance.js';
import { portfolioSummary } from './zerodha.js';
import { openSheet } from './sheet.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fireSettings = () => state.finance.fire || null;

/** Corpus: live Zerodha value (if on) + other assets. */
export function fireCorpus(fin = state.finance) {
  const f = fin.fire || {};
  const zerodha = f.useZerodha !== false ? portfolioSummary(fin.holdings || []).value : 0;
  const others = (f.assets || []).map((a) => ({ name: a.name, amount: Number(a.amount) || 0 }));
  return { zerodha, others, total: zerodha + others.reduce((s, a) => s + a.amount, 0) };
}

/**
 * Month-by-month projection. Returns {date, months} when the target is reached (or null within
 * 50 years) and yearly values [{year, value}].
 * opts: {corpus, monthly, ret (% a year), stepUp (% a year), boost (₹/month), boostFrom 'YYYY-MM', target, start Date}
 */
export function project({ corpus, monthly, ret = 11, stepUp = 0, boost = 0, boostFrom = '', target, start = new Date() }) {
  const r = Math.pow(1 + ret / 100, 1 / 12) - 1;
  let v = corpus, m = monthly;
  let y = start.getFullYear(), mo = start.getMonth() + 1;
  const [by, bm] = boostFrom ? boostFrom.split('-').map(Number) : [9999, 1];
  const yearly = [{ year: y, value: v }];
  for (let i = 1; i <= 600; i++) {
    mo++; if (mo > 12) { mo = 1; y++; }
    if (i % 12 === 0) m *= 1 + stepUp / 100;
    const extra = y > by || (y === by && mo >= bm) ? boost : 0;
    v = v * (1 + r) + m + extra;
    if (mo === start.getMonth() + 1) yearly.push({ year: y, value: v });
    if (target && v >= target) return { date: new Date(y, mo - 1, 1), months: i, yearly, value: v };
  }
  return { date: null, months: null, yearly, value: v };
}

const monthYear = (d) => (d ? d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : 'Not within 50 yrs');
const cr = (n) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(n >= 1e8 ? 1 : 2)} Cr` : inr(n, { compact: true }));

/** The FIRE card (Home + Money → Invest). */
export function fireCard({ compact = false } = {}) {
  const f = fireSettings();
  if (!f?.target) {
    return `<div class="card fire-card"><div class="card-head"><h3>🔥 FIRE progress</h3></div>
      <p class="hint">Set your FIRE number and what you invest each month to see your progress and the year you get there.</p>
      <button class="btn primary block" data-act="fire-edit">Set up FIRE goal</button></div>`;
  }
  const c = fireCorpus();
  const pct = Math.min(100, (c.total / f.target) * 100);
  const base = { corpus: c.total, monthly: Number(f.monthly) || 0, ret: Number(f.ret) || 11, boost: Number(f.boost) || 0, boostFrom: f.boostFrom || '', target: f.target };
  const flat = project(base);
  const step = Number(f.stepUp) ? project({ ...base, stepUp: Number(f.stepUp) }) : null;
  const goalYear = Number(f.goalYear) || null;
  const swrIncome = f.swr ? (f.target * (f.swr / 100)) / 12 : 0;
  const marks = [25, 50, 75].map((m) => `<i class="fire-mark" style="left:${m}%"></i>`).join('');
  const half = project({ ...base, target: f.target / 2, ...(step ? { stepUp: Number(f.stepUp) } : {}) });
  return `<div class="card fire-card">
    <div class="card-head"><h3>🔥 FIRE progress</h3><button class="link" data-act="fire-edit">Edit</button></div>
    <div class="fire-top"><div><div class="fire-now">${cr(c.total)}</div><div class="muted">of ${cr(f.target)}${swrIncome ? ` · ${inr(swrIncome, { compact: true })}/mo at ${f.swr}%` : ''}</div></div>
      <div class="fire-pct">${pct.toFixed(1)}%</div></div>
    <div class="fire-bar" role="progressbar" aria-valuenow="${pct.toFixed(1)}" aria-valuemin="0" aria-valuemax="100" aria-label="FIRE progress"><span style="width:${Math.max(pct, 1.5)}%"></span>${marks}</div>
    <div class="fire-scale muted"><span>Today</span><span>50% · ${half.date ? half.date.getFullYear() : '—'}</span><span>🏁 ${step?.date ? step.date.getFullYear() + '–' : ''}${flat.date ? flat.date.getFullYear() : '—'}</span></div>
    <div class="stats fire-stats">
      <div class="stat"><div class="label">FIRE at today’s pace</div><div class="value">${monthYear(flat.date)}</div></div>
      ${step ? `<div class="stat"><div class="label">With ${f.stepUp}% yearly step-up</div><div class="value good">${monthYear(step.date)}</div></div>` : ''}
    </div>
    ${goalYear && flat.date && flat.date.getFullYear() > goalYear ? `<p class="hint bad" style="margin:8px 0 0">Behind your ${goalYear} goal at today’s pace${step?.date && step.date.getFullYear() <= goalYear ? ' — the step-up gets you there' : ''}.</p>` : ''}
    ${compact ? '' : `<div class="fire-break">
      <div class="row-mini"><span>Investing every month</span><b>${inr(base.monthly)}</b></div>
      ${c.zerodha ? `<div class="row-mini"><span>Your Zerodha (live)</span><b>${cr(c.zerodha)}</b></div>` : ''}
      ${c.others.map((a) => `<div class="row-mini"><span>${esc(a.name)}</span><b>${cr(a.amount)}</b></div>`).join('')}
      ${f.boost ? `<div class="row-mini muted"><span>From ${esc(new Date(f.boostFrom + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }))}: +${inr(f.boost)}/mo (loan ends)</span><span></span></div>` : ''}
      <p class="hint" style="margin:6px 0 0">Assumes ${base.ret}% a year. Upload Zerodha every Sunday and this updates itself.</p>
    </div>`}
  </div>`;
}

/** Edit sheet. Other assets as "name = amount" lines. */
export function openFireSheet(onDone = () => {}) {
  const f = fireSettings() || {};
  openSheet({
    title: 'FIRE goal',
    values: {
      target: f.target || '', monthly: f.monthly || '', ret: f.ret ?? 11, stepUp: f.stepUp ?? 10, swr: f.swr ?? 4,
      boost: f.boost || '', boostFrom: f.boostFrom || '', goalYear: f.goalYear || '', useZerodha: f.useZerodha !== false,
      assets: (f.assets || []).map((a) => `${a.name} = ${a.amount}`).join('\n'),
    },
    fields: [
      { key: 'target', label: 'FIRE number (₹)', type: 'amount', required: true, placeholder: 'e.g. 10 cr' },
      { key: 'monthly', label: 'Invested every month (₹)', type: 'amount', required: false },
      { key: 'useZerodha', label: 'Count my Zerodha holdings (live)', type: 'check' },
      { key: 'assets', label: 'Other investments — one per line: name = amount', type: 'textarea', rows: 4, placeholder: 'Partner’s Zerodha = 29.87 lakh\nVested (US) = 50000' },
      { key: 'ret', label: 'Expected return % a year', type: 'number', half: true },
      { key: 'stepUp', label: 'SIP step-up % a year', type: 'number', half: true },
      { key: 'swr', label: 'Withdrawal rate %', type: 'number', half: true },
      { key: 'goalYear', label: 'Goal year (optional)', type: 'number', half: true },
      { key: 'boost', label: 'Extra monthly once a loan ends (₹, optional)', type: 'amount', required: false, half: true },
      { key: 'boostFrom', label: 'From (month)', type: 'month', half: true },
    ],
    onSave: (v) => {
      const assets = String(v.assets || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, amt] = l.split('=').map((x) => x.trim());
        return { name, amount: parseAmountLoose(amt) };
      }).filter((a) => a.name && a.amount > 0);
      state.finance.fire = {
        ...(state.finance.fire || {}), target: v.target, monthly: v.monthly || 0, useZerodha: v.useZerodha, assets,
        ret: v.ret ?? 11, stepUp: v.stepUp ?? 0, swr: v.swr ?? 4, goalYear: v.goalYear || null, boost: v.boost || 0, boostFrom: v.boostFrom || '',
      };
      save();
      onDone();
    },
  });
}

/** "29.87 lakh", "1.5 cr", "50,000", "50k" → number. */
export function parseAmountLoose(s) {
  const t = String(s || '').toLowerCase().replace(/[₹,\s]/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)(k|thousand|l|lakh|lakhs|lac|lacs|cr|crore|crores)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 }[m[2]] || 1;
  return Math.round(n * mult);
}

/** One-time import from a link (#import=…): FIRE settings and tasks. Kept out of the code on purpose. */
export function importFromLink(payload, { addTask } = {}) {
  const out = { fire: false, tasks: 0 };
  if (payload.fire && typeof payload.fire === 'object') {
    state.finance.fire = { ...(state.finance.fire || {}), ...payload.fire };
    out.fire = true;
  }
  for (const t of Array.isArray(payload.tasks) ? payload.tasks.slice(0, 50) : []) {
    if (!t?.title) continue;
    const id = String(t.id || '').replace(/[^\w-]/g, '').slice(0, 60) || null;
    if (id && state.tasks.some((x) => x.id === id)) continue;
    if (id && state.mailTriage?.seen && t.source?.messageId) state.mailTriage.seen[t.source.messageId] = Date.now();
    state.tasks.push({
      id: id || `imp-${Date.now().toString(36)}-${out.tasks}`, title: String(t.title).slice(0, 200), due: t.due || null, done: false, notified: false, isTimer: false,
      createdAt: new Date().toISOString(), ...(t.note ? { note: String(t.note).slice(0, 400) } : {}), ...(t.source ? { source: t.source } : {}),
    });
    out.tasks++;
  }
  save();
  return out;
}
