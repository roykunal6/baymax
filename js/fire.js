// FIRE (financial independence) tracker: corpus vs target with a progress bar, and when you get
// there at today's pace (flat SIPs) or with a yearly SIP step-up, including money freed when a
// loan ends. Your Zerodha value is live; other assets (partner's investments, US stocks, PF…) are
// entered once and edited any time. Pure maths is exported for tests.

import { state, save } from './store.js';
import { inr, nextMonthlyDate, monthKey } from './finance.js';
import { portfolioSummary, byOwner } from './zerodha.js';
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
      ${c.zerodha ? byOwner(state.finance.holdings).map((o) => `<div class="row-mini"><span>Zerodha — ${esc(state.finance.zerodha?.names?.[o.owner] || (o.owner || 'yours'))} (live)</span><b>${cr(o.value)}</b></div>`).join('') : ''}
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
  // Dues: EMIs, SIPs, bills. Updates one you already have (same kind, name matches `match`), else adds it.
  out.dues = 0;
  for (const d of Array.isArray(payload.dues) ? payload.dues.slice(0, 40) : []) {
    if (!d?.name || !(Number(d.amount) > 0) || !['emi', 'sip', 'bill'].includes(d.kind)) continue;
    const id = `ob-${String(d.key || d.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    const re = d.match ? new RegExp(d.match, 'i') : null;
    const obs = state.finance.obligations;
    const existing = obs.find((o) => o.id === id) || (re && obs.find((o) => o.kind === d.kind && re.test(o.name)));
    const day = Math.min(28, Math.max(1, Number(d.day) || 1));
    const fields = { kind: d.kind, name: String(d.name).slice(0, 80), amount: Number(d.amount), schedule: { type: 'monthly', day }, endMonth: d.endMonth || null };
    if (existing) Object.assign(existing, fields);
    else obs.push({ id, ...fields, startMonth: monthKey(nextMonthlyDate(day, new Date())), paid: {} });
    out.dues++;
  }
  for (const t of Array.isArray(payload.tasks) ? payload.tasks.slice(0, 50) : []) {
    if (!t?.title) continue;
    const id = String(t.id || '').replace(/[^\w-]/g, '').slice(0, 60) || null;
    if (id && state.tasks.some((x) => x.id === id)) continue;
    if (id && t.source?.messageId) { state.mailTriage = state.mailTriage || {}; state.mailTriage.seen2 = { ...(state.mailTriage.seen2 || {}), [t.source.messageId]: Date.now() }; }
    state.tasks.push({
      id: id || `imp-${Date.now().toString(36)}-${out.tasks}`, title: String(t.title).slice(0, 200), due: t.due || null, done: false, notified: false, isTimer: false,
      createdAt: new Date().toISOString(), ...(t.note ? { note: String(t.note).slice(0, 400) } : {}), ...(t.source ? { source: t.source } : {}),
    });
    out.tasks++;
  }
  save();
  return out;
}

// ---------------------------------------------------------------- full FIRE tab
function chartSVG(series, target, boostYear) {
  const w = 640, h = 240, l = 46, r = 12, t = 14, b = 26;
  const years = series[0].points.map((p) => p.year);
  const rawMax = Math.max(target * 1.15, ...series.flatMap((s) => s.points.map((p) => p.value)));
  const step = [1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8].find((u) => rawMax / u <= 6) || 1e8;
  const maxV = Math.ceil(rawMax / step) * step;
  const x = (i) => l + (i / Math.max(1, years.length - 1)) * (w - l - r);
  const y = (v) => t + (1 - v / maxV) * (h - t - b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const ticks = Array.from({ length: Math.round(maxV / step) + 1 }, (_, i) => i * step);
  const every = Math.ceil(years.length / 8);
  const bi = years.indexOf(boostYear);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Projected corpus by year">
    ${ticks.map((v) => `<line x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${v >= 1e7 ? (v / 1e7).toFixed(0) + ' Cr' : (v / 1e5).toFixed(0) + 'L'}</text>`).join('')}
    ${years.map((yr, i) => (i % every === 0 || i === years.length - 1 ? `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" class="axis">${yr}</text>` : '')).join('')}
    ${bi > 0 ? `<line x1="${x(bi)}" x2="${x(bi)}" y1="${t}" y2="${h - b}" class="boost"/><text x="${x(bi) + 4}" y="${t + 10}" class="axis">loan ends</text>` : ''}
    <line x1="${l}" x2="${w - r}" y1="${y(target)}" y2="${y(target)}" class="target"/><text x="${w - r}" y="${y(target) - 5}" text-anchor="end" class="axis tgt">🏁 ${(target / 1e7).toFixed(target % 1e7 ? 1 : 0)} Cr</text>
    ${series.map((s) => `<path d="${path(s.points)}" class="line ${s.cls}"/>`).join('')}
  </svg>`;
}

export function renderFireTab(el) {
  const f = fireSettings();
  if (!f?.target) { el.innerHTML = `<div class="page-head"><h1>FIRE</h1></div>${fireCard()}`; return; }
  const c = fireCorpus();
  const base = { corpus: c.total, monthly: Number(f.monthly) || 0, ret: Number(f.ret) || 11, boost: Number(f.boost) || 0, boostFrom: f.boostFrom || '' };
  const flat = project({ ...base, target: f.target });
  const step = Number(f.stepUp) ? project({ ...base, stepUp: Number(f.stepUp), target: f.target }) : null;
  const horizon = Math.max(flat.months || 0, step?.months || 0, 120) + 12;
  const run = (o) => project({ ...base, ...o, target: 0 }).yearly.slice(0, Math.ceil(horizon / 12) + 1);
  const flatPts = run({}), stepPts = step ? run({ stepUp: Number(f.stepUp) }) : null;
  const milestones = [0.25, 0.5, 0.75, 1].map((p) => {
    const a = project({ ...base, target: f.target * p }), s2 = step ? project({ ...base, stepUp: Number(f.stepUp), target: f.target * p }) : null;
    const done = c.total >= f.target * p;
    return `<li class="row"><span class="ms ${done ? 'done' : ''}">${p * 100}%</span><div class="grow"><div class="title">${cr(f.target * p)}${p === 1 ? ' 🔥 FIRE' : ''}</div><div class="meta">${done ? 'Reached ✓' : `Today’s pace: ${monthYear(a.date)}${s2 ? ` · with step-up: ${monthYear(s2.date)}` : ''}`}</div></div></li>`;
  }).join('');
  const fireTasks = state.tasks.filter((t) => t.id.startsWith('fire-') || /^🔥/.test(t.title));
  const table = flatPts.filter((_, i) => i % 2 === 0 || i === flatPts.length - 1).map((p) => {
    const sp = stepPts?.find((x) => x.year === p.year);
    return `<tr><td>${p.year}</td><td>${cr(p.value)}</td>${stepPts ? `<td>${sp ? cr(sp.value) : ''}</td>` : ''}</tr>`;
  }).join('');
  el.innerHTML = `
    <div class="page-head"><h1>FIRE</h1><button class="btn small" data-act="fire-edit">Edit goal</button></div>
    ${fireCard()}
    <div class="card"><div class="card-head"><h3>Projection</h3></div>
      <div class="chart-legend"><span><i class="lg flat"></i>Today’s pace</span>${step ? `<span><i class="lg step"></i>${f.stepUp}% yearly step-up</span>` : ''}<span><i class="lg tgt"></i>Target</span></div>
      <div class="fire-chart">${chartSVG([{ points: flatPts, cls: 'flat' }, ...(stepPts ? [{ points: stepPts, cls: 'step' }] : [])], f.target, f.boostFrom ? Number(f.boostFrom.slice(0, 4)) : null)}</div>
    </div>
    <div class="card"><h3>Milestones</h3><ul class="rows flat">${milestones}</ul></div>
    <div class="card"><div class="card-head"><h3>FIRE action items</h3><button class="link" data-act="go-tasks">All tasks</button></div>
      ${fireTasks.length ? `<ul class="rows flat">${fireTasks.map((t) => `<li class="row ${t.done ? 'done' : ''}"><input type="checkbox" data-act="fire-task" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''} aria-label="Done"><div class="grow"><div class="title">${esc(t.title.replace(/^🔥\s*/, ''))}</div>${t.note ? `<div class="meta">${esc(t.note)}</div>` : ''}</div></li>`).join('')}</ul>` : '<p class="empty">No FIRE action items. Add tasks starting with 🔥 to see them here.</p>'}
    </div>
    <div class="card"><h3>Year by year</h3><table class="fire-table"><thead><tr><th>Year</th><th>Today’s pace</th>${stepPts ? `<th>Step-up ${f.stepUp}%</th>` : ''}</tr></thead><tbody>${table}</tbody></table>
      <p class="hint">Assumes ${base.ret}% a year, compounded monthly${f.boost ? `, plus ${inr(f.boost)}/mo from ${f.boostFrom}` : ''}. Not financial advice.</p></div>`;
}
