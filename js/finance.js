// Money logic: amounts, due dates, monthly summary, health alerts and voice commands.
// Pure functions (no DOM, no storage) so they are unit-tested in tests/finance.test.mjs.

import { parseTime, tidy } from './timeparse.js';

// ---------------------------------------------------------------- formatting
export function inr(n, { compact = false } = {}) {
  const v = Math.round(Number(n) || 0);
  const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
  if (compact && Math.abs(v) >= 100000) return `${v < 0 ? '−' : ''}₹${trim(Math.abs(v) / 100000)}L`;
  if (compact && Math.abs(v) >= 1000) return `${v < 0 ? '−' : ''}₹${trim(Math.abs(v) / 1000)}k`;
  return (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN');
}

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
export const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
export function parseDay(s) {
  if (s instanceof Date) return s;
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
}
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

// ---------------------------------------------------------------- amounts
/** "1,200", "₹500", "45k", "1.2 lakh", "2 cr" → number. NaN if none. */
export function parseAmount(s) {
  if (s == null) return NaN;
  if (typeof s === 'number') return s;
  const t = String(s).toLowerCase().replace(/₹|\brs\.?|\binr\b|\brupees?\b/g, ' ').replace(/(\d),(?=\d)/g, '$1');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|l|cr|crores?)?\b/);
  if (!m) return NaN;
  let n = parseFloat(m[1]);
  const u = m[2] || '';
  if (u === 'k' || u === 'thousand') n *= 1e3;
  else if (/^(lakhs?|lacs?|l)$/.test(u)) n *= 1e5;
  else if (/^(cr|crores?)$/.test(u)) n *= 1e7;
  return Math.round(n * 100) / 100;
}

const AMT = '(?:rs\\.?\\s*|₹\\s*|inr\\s*)?(\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:k|thousand|lakhs?|lacs?|cr|crores?)\\b)?)(?:\\s*(?:rupees|rs|inr)\\b)?';

// ---------------------------------------------------------------- categories
export const CATEGORIES = ['Food', 'Groceries', 'Shopping', 'Travel', 'Fuel', 'Bills', 'Health', 'Entertainment', 'Education', 'Home', 'Family', 'Other'];
const CATEGORY_WORDS = {
  Food: /lunch|dinner|breakfast|coffee|tea|snack|swiggy|zomato|restaurant|cafe|food|pizza|burger|biryani|chai|meal/,
  Groceries: /grocer|vegetable|fruit|milk|bigbasket|blinkit|zepto|dmart|kirana|supermarket|instamart/,
  Shopping: /amazon|flipkart|myntra|clothes|shoes|shirt|shopping|ajio|nykaa|gift|gadget|phone/,
  Travel: /uber|ola|rapido|cab|taxi|auto|flight|train|bus|metro|hotel|travel|trip|toll|parking/,
  Fuel: /petrol|diesel|fuel|cng/,
  Bills: /electric|water bill|gas bill|internet|wifi|broadband|recharge|mobile bill|dth|bill/,
  Health: /doctor|medicine|pharmacy|hospital|gym|clinic|health|medical|apollo|lab test/,
  Entertainment: /movie|netflix|prime|hotstar|spotify|concert|game|party|drinks|bar|pvr|inox/,
  Education: /course|book|school|college|tuition|class|udemy|fees/,
  Home: /rent|furniture|repair|maid|cook|cleaning|plumber|electrician|home/,
  Family: /kids|family|parents|mom|dad|wife|husband|son|daughter/,
};
export function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  for (const [cat, re] of Object.entries(CATEGORY_WORDS)) if (re.test(t)) return cat;
  return 'Other';
}

// ---------------------------------------------------------------- data shapes
export function emptyFinance() {
  return {
    income: 0, budget: 0, categoryBudgets: {}, remindDays: 2, spends: [], cards: [], obligations: [], invoices: [], notified: {},
    credits: [], holdings: [], bankInbox: [], zerodha: { lastUpload: null, history: [] },
  };
}

export const KIND_LABEL = { emi: 'EMI', sip: 'SIP', bill: 'Bill', invoice: 'Invoice', card: 'Card bill' };

function monthlyDate(y, m, day) {
  return new Date(y, m, Math.min(Number(day) || 1, new Date(y, m + 1, 0).getDate()));
}

/** Occurrences of an EMI/SIP/bill between two dates: [{date, key}] (key = YYYY-MM for monthly, 'once' otherwise). */
export function occurrences(ob, start, end) {
  const s = startOfDay(start), e = endOfDay(end), out = [];
  if (!ob?.schedule) return out;
  if (ob.schedule.type === 'once') {
    const d = parseDay(ob.schedule.date);
    if (d >= s && d <= e) out.push({ date: d, key: 'once' });
    return out;
  }
  let y = s.getFullYear(), m = s.getMonth();
  while (new Date(y, m, 1) <= e) {
    const d = monthlyDate(y, m, ob.schedule.day);
    const mk = `${y}-${pad(m + 1)}`;
    const inRange = (!ob.startMonth || mk >= ob.startMonth) && (!ob.endMonth || mk <= ob.endMonth);
    if (d >= s && d <= e && inRange) out.push({ date: d, key: mk });
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

export function cardSpendInMonth(fin, cardId, y, m) {
  const mk = `${y}-${pad(m + 1)}`;
  return fin.spends.filter((x) => x.method === cardId && String(x.date).startsWith(mk)).reduce((a, x) => a + x.amount, 0);
}

/**
 * Everything due between start and end: EMIs, SIPs, bills, invoices and credit card bills.
 * Card bill amount = that card's spends in the month before the due date.
 */
export function dueItems(fin, start, end) {
  const items = [];
  for (const ob of fin.obligations || []) {
    for (const o of occurrences(ob, start, end)) {
      items.push({ ref: 'obligation', id: ob.id, kind: ob.kind, name: ob.name, amount: ob.amount, date: o.date, key: o.key, paid: !!ob.paid?.[o.key] });
    }
  }
  for (const inv of fin.invoices || []) {
    const d = parseDay(inv.dueDate);
    if (d >= startOfDay(start) && d <= endOfDay(end)) {
      items.push({ ref: 'invoice', id: inv.id, kind: 'invoice', name: invoiceLabel(inv), amount: inv.amount, date: d, key: 'once', paid: !!inv.paidAt, direction: inv.direction || 'in' });
    }
  }
  for (const card of fin.cards || []) {
    if (!card.dueDay) continue;
    for (const o of occurrences({ schedule: { type: 'monthly', day: card.dueDay } }, start, end)) {
      const prev = new Date(o.date.getFullYear(), o.date.getMonth() - 1, 1);
      const amount = cardSpendInMonth(fin, card.id, prev.getFullYear(), prev.getMonth());
      if (amount > 0) items.push({ ref: 'card', id: card.id, kind: 'card', name: `${card.name} card bill`, amount, date: o.date, key: o.key, paid: !!card.paid?.[o.key] });
    }
  }
  return items.sort((a, b) => a.date - b.date || a.name.localeCompare(b.name));
}

export function invoiceLabel(inv) {
  return `${inv.party || 'Invoice'}${inv.number ? ` #${inv.number}` : ''}`;
}

export function invoiceStatus(inv, now = new Date()) {
  if (inv.paidAt) return 'paid';
  return startOfDay(parseDay(inv.dueDate)) < startOfDay(now) ? 'overdue' : 'pending';
}

/** Unpaid outgoing items whose date has passed (looks back 90 days). Incoming invoices are excluded. */
export function overdueItems(fin, now = new Date()) {
  return dueItems(fin, addDays(now, -90), addDays(now, -1)).filter((i) => !i.paid && i.direction !== 'in');
}

// ---------------------------------------------------------------- summaries
export function sumSpends(fin, start, end, filter = () => true) {
  const s = ymd(start), e = ymd(end);
  return fin.spends.filter((x) => x.date >= s && x.date <= e && filter(x)).reduce((a, x) => a + x.amount, 0);
}

export function monthSummary(fin, now = new Date()) {
  const ms = new Date(now.getFullYear(), now.getMonth(), 1);
  const me = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const mk = monthKey(now);
  const spends = fin.spends.filter((x) => String(x.date).startsWith(mk));
  const credits = (fin.credits || []).filter((x) => String(x.date).startsWith(mk));
  const refunds = credits.filter((x) => x.kind === 'refund').reduce((a, x) => a + x.amount, 0);
  const moneyIn = credits.filter((x) => x.kind !== 'refund').reduce((a, x) => a + x.amount, 0);
  const spent = Math.max(0, spends.reduce((a, x) => a + x.amount, 0) - refunds);
  const byCategory = {};
  for (const x of spends) byCategory[x.category || 'Other'] = (byCategory[x.category || 'Other'] || 0) + x.amount;
  const byCard = {};
  for (const c of fin.cards) byCard[c.id] = spends.filter((x) => x.method === c.id).reduce((a, x) => a + x.amount, 0);

  const dues = dueItems(fin, ms, me);
  // Monthly totals count every active EMI/SIP/bill, even one added after this month's due date.
  const allThisMonth = dueItems({ ...fin, obligations: fin.obligations.map((o) => ({ ...o, startMonth: null })) }, ms, me);
  const ofKind = (k) => allThisMonth.filter((d) => d.kind === k);
  const total = (list) => list.reduce((a, d) => a + d.amount, 0);
  const emi = total(ofKind('emi')), sip = total(ofKind('sip')), bills = total(ofKind('bill'));
  const fixed = emi + bills;
  const fixedPaid = total(dues.filter((d) => (d.kind === 'emi' || d.kind === 'bill' || d.kind === 'sip') && d.paid));

  const invoicesIn = fin.invoices.filter((i) => (i.direction || 'in') === 'in');
  const received = invoicesIn.filter((i) => i.paidAt && String(i.paidAt).startsWith(mk)).reduce((a, i) => a + i.amount, 0);
  const toReceive = invoicesIn.filter((i) => !i.paidAt);
  const overdueInvoices = toReceive.filter((i) => invoiceStatus(i, now) === 'overdue');

  const income = (Number(fin.income) || 0) + received;
  const day = now.getDate(), dim = daysInMonth(now);
  const budget = Number(fin.budget) || (fin.income ? Math.max(0, fin.income - fixed - sip) : 0);
  const budgetIsDerived = !fin.budget && !!fin.income;
  const projected = day > 0 ? Math.round((spent / day) * dim) : spent;
  const left = budget - spent;
  const daysLeft = dim - day + 1;
  const savings = income - spent - fixed; // SIPs count as savings
  return {
    month: mk, day, daysInMonth: dim, daysLeft, early: day < 5,
    spent, refunds, moneyIn, byCategory, byCard, spends,
    spentToday: sumSpends(fin, now, now),
    spentWeek: sumSpends(fin, startOfWeek(now), now),
    emi, sip, bills, fixed, fixedPaid, dues,
    income, received, toReceive: toReceive.reduce((a, i) => a + i.amount, 0), overdueInvoices,
    budget, budgetIsDerived, projected, left, perDayLeft: daysLeft > 0 ? Math.max(0, left) / daysLeft : 0,
    expectedByNow: budget * (day / dim),
    savings, savingsRate: income > 0 ? savings / income : null,
  };
}

/** Health check: status good | warn | bad | setup, a headline and alerts [{level, text}]. */
export function healthCheck(fin, now = new Date()) {
  const s = monthSummary(fin, now);
  const alerts = [];
  const push = (level, text) => alerts.push({ level, text });
  const fmtDate = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  for (const o of overdueItems(fin, now)) {
    push('bad', `${KIND_LABEL[o.kind]} “${o.name}” (${inr(o.amount)}) was due ${fmtDate(o.date)} and isn’t marked paid.`);
  }
  if (s.budget > 0) {
    if (s.spent > s.budget) push('bad', `You’ve spent ${inr(s.spent)}, ${inr(s.spent - s.budget)} over your ${inr(s.budget)} budget.`);
    else if (!s.early && s.projected > s.budget * 1.05) {
      push('warn', `At this pace you’ll spend ${inr(s.projected)} this month, ${inr(s.projected - s.budget)} over budget. Keep to ${inr(s.perDayLeft)} a day.`);
    }
  }
  if (s.income > 0) {
    const outflow = s.spent + s.fixed + s.sip;
    if (outflow > s.income) push('bad', `This month’s outflow (${inr(outflow)}) is more than your income (${inr(s.income)}).`);
    else if (!s.early && s.savingsRate !== null && s.savingsRate < 0.1) push('warn', `You’re saving ${Math.max(0, Math.round(s.savingsRate * 100))}% of income this month. Aim for at least 20%.`);
    if (s.emi / s.income > 0.4) push('warn', `EMIs take ${Math.round((s.emi / s.income) * 100)}% of your income. Try to keep them under 40%.`);
  }
  for (const [cat, cap] of Object.entries(fin.categoryBudgets || {})) {
    if (cap > 0 && (s.byCategory[cat] || 0) > cap) push('warn', `${cat} is over its ${inr(cap)} budget (${inr(s.byCategory[cat])} spent).`);
  }
  for (const c of fin.cards) {
    const used = s.byCard[c.id] || 0;
    if (c.limit > 0 && used >= c.limit * 0.8) push(used >= c.limit ? 'bad' : 'warn', `${c.name} card is at ${Math.round((used / c.limit) * 100)}% of its ${inr(c.limit)} limit this month.`);
  }
  for (const inv of s.overdueInvoices) {
    push('warn', `${invoiceLabel(inv)} (${inr(inv.amount)}) is ${daysBetween(parseDay(inv.dueDate), now)} days overdue. Follow up for payment.`);
  }
  const soon = dueItems(fin, now, addDays(now, 3)).filter((d) => !d.paid && d.direction !== 'in');
  for (const d of soon) {
    const n = daysBetween(now, d.date);
    push('info', `${KIND_LABEL[d.kind]} “${d.name}” ${inr(d.amount)} due ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}.`);
  }

  const hasSetup = s.budget > 0 || s.income > 0;
  let status = 'good';
  if (alerts.some((a) => a.level === 'bad')) status = 'bad';
  else if (alerts.some((a) => a.level === 'warn')) status = 'warn';
  else if (!hasSetup) status = 'setup';

  const headline = {
    bad: alerts.find((a) => a.level === 'bad')?.text,
    warn: alerts.find((a) => a.level === 'warn')?.text,
    good: s.budget > 0 ? `You’re within budget: ${inr(Math.max(0, s.left))} left, about ${inr(s.perDayLeft)} a day.` : 'All payments are on track.',
    setup: 'Add your monthly income and budget in Money → Setup to get spending alerts.',
  }[status];
  const label = { good: 'On track', warn: 'Watch your spending', bad: 'Needs attention', setup: 'Set up your budget' }[status];
  return { status, label, headline, alerts, summary: s };
}

// ---------------------------------------------------------------- voice / text commands
function findCard(fin, text) {
  const t = String(text || '').toLowerCase();
  return fin.cards.find((c) => t.includes(c.name.toLowerCase())) || null;
}

export function resolveMethod(fin, text) {
  const t = String(text || '').toLowerCase().replace(/\b(my|the|credit|debit)\b/g, '').replace(/\bcard\b/, '').trim();
  if (!t) return null;
  const card = findCard(fin, t);
  if (card) return card.id;
  if (/\b(upi|gpay|google pay|phonepe|paytm|bhim)\b/.test(t)) return 'upi';
  if (/\bcash\b/.test(t)) return 'cash';
  if (/\b(debit|bank|netbanking|account)\b/.test(t)) return 'bank';
  return null;
}

function dayPhrase(text) {
  const m = text.match(/\b(?:on|every|due(?:\s+on)?|by)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+of\s+every\s+month|\s+every\s+month|\s+monthly|\s+of\s+the\s+month)?/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  return day >= 1 && day <= 31 ? { day, match: m[0] } : null;
}

function stripAmount(text) {
  return text.replace(new RegExp(`(?:of|for|worth|amount|for an amount of)?\\s*${AMT}`, 'i'), ' ');
}

/** Next date (today or later) that falls on `day` of a month. */
export function nextMonthlyDate(day, now = new Date()) {
  const thisMonth = monthlyDate(now.getFullYear(), now.getMonth(), day);
  return thisMonth >= startOfDay(now) ? thisMonth : monthlyDate(now.getFullYear(), now.getMonth() + 1, day);
}

/**
 * Money commands → action object, or null if the text isn't about money.
 * @param {string} text cleaned command text
 * @param {{fin: object, now?: Date}} ctx
 */
export function parseFinanceCommand(text, { fin = emptyFinance(), now = new Date() } = {}) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  let m;

  // Queries
  if (/\b(how am i doing|how'?s my (money|budget|spending|finances?)|how is my (money|budget|spending|finances?)|financ(e|ial) (summary|health|status)|money summary|budget status|am i overspending|my finances)\b/.test(lower)) {
    return { type: 'finance_summary' };
  }
  if (/^(what('?s| is| are)?\s+)?(due|upcoming)\b|\bupcoming (payments?|bills?|dues|emis?|sips?)\b|\b(payments?|bills?|dues|emis?|sips?)\s+(are\s+)?(due\s+)?(this|next) (week|month)\b|\bwhat do i (have to |need to )?pay\b/.test(lower)) {
    return { type: 'list_dues', range: /\bmonth\b/.test(lower) ? 'month' : 'week' };
  }
  if (/\bhow much (did|have) i (spen[dt]|spend)\b|\bmy (spends?|spending|expenses)\b(?! budget)/.test(lower)) {
    const range = /\btoday\b/.test(lower) ? 'today' : /\bweek\b/.test(lower) ? 'week' : 'month';
    const card = findCard(fin, lower);
    const catWord = lower.match(/\bon\s+([a-z ]+?)(?:\s+(?:this|today|in|with)\b|$)/);
    const category = catWord ? CATEGORIES.find((c) => c.toLowerCase() === catWord[1].trim()) || null : null;
    return { type: 'spend_query', range, card: card?.id || null, category };
  }
  if (/\b(credit )?card (spends?|spending|bills?|usage)\b/.test(lower)) return { type: 'card_summary' };
  if (/^(show|list|read|what are|pending|my|any)?\s*(my\s+)?(pending\s+|unpaid\s+|open\s+)?invoices\b/.test(lower) || /\binvoices? (pending|due|outstanding)\b/.test(lower)) {
    return { type: 'list_invoices' };
  }

  // Settings
  if ((m = lower.match(new RegExp(`^(?:set\\s+)?(?:my\\s+)?(?:monthly\\s+)?budget\\s+(?:is\\s+|to\\s+|as\\s+|of\\s+)?${AMT}`)))) return { type: 'set_budget', amount: parseAmount(m[1]) };
  if ((m = lower.match(new RegExp(`^(?:set\\s+)?(?:my\\s+)?(?:monthly\\s+)?(?:salary|income|take[- ]home)\\s+(?:is\\s+|to\\s+|as\\s+|of\\s+)?${AMT}`)))) return { type: 'set_income', amount: parseAmount(m[1]) };

  // Invoices: mark paid
  if ((m = lower.match(/^(?:mark\s+)?(?:the\s+)?(.+?)\s+invoice\s*(?:#|no\.?|number)?\s*([\w-]+)?\s+(?:as\s+)?(?:paid|received|settled|cleared)$/))) {
    return { type: 'invoice_paid', party: m[1].trim(), number: m[2] || null };
  }
  if ((m = lower.match(new RegExp(`^(?:received|got)\\s+(?:a\\s+)?(?:payment\\s+(?:of\\s+)?)?(?:${AMT}\\s+)?(?:payment\\s+)?from\\s+(.+)$`)))) {
    return { type: 'invoice_paid', party: m[2].trim(), amount: m[1] ? parseAmount(m[1]) : null };
  }

  // Invoices: add
  if (/\binvoice\b/.test(lower) && !/\binvoices\b/.test(lower)) {
    const numM = lower.match(/(?:#\s*|\bno\.?\s*|\bnumber\s+)([a-z]*-?\d[\w-]*|[\w-]+)/);
    const noNumber = numM ? lower.replace(numM[0], ' ') : lower;
    const amtM = noNumber.match(new RegExp(AMT));
    if (amtM) {
      let party = null, direction = 'in';
      const pm = t.match(/\b(for|to|from)\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*)?)/);
      if (pm && !/^(due|next|this|the|rs|inr)$/i.test(pm[2].split(' ')[0])) {
        party = pm[2].replace(/\s+(due|of|worth|for|on|by|next)$/i, '');
        if (pm[1].toLowerCase() === 'from') direction = 'out';
      } else {
        const bm = t.match(/(?:^|\s)([A-Za-z][\w&.'-]*)\s+invoice\b/);
        if (bm && !/^(add|new|an|a|my|raise|create|log|record|sent|send)$/i.test(bm[1])) party = bm[1];
      }
      if (party) party = party.replace(/\b\w/g, (c) => c.toUpperCase());
      let dueDate = null;
      const dueM = t.match(/\bdue\s+(.+)$/i);
      if (dueM) {
        const dp = dayPhrase('on ' + dueM[1].replace(/^on\s+/i, ''));
        const pt = parseTime(dueM[1], now);
        dueDate = pt ? pt.date : dp ? nextMonthlyDate(dp.day, now) : null;
      }
      if (!dueDate) dueDate = addDays(now, 15);
      return { type: 'add_invoice', party: party || 'Client', number: numM ? numM[1].toUpperCase() : '', amount: parseAmount(amtM[1]), dueDate: ymd(dueDate), direction };
    }
  }

  // EMIs, SIPs, bills
  if ((m = t.match(/^(?:add|new|create|set\s*up|start|track)\s+(?:an?\s+|my\s+|new\s+)?(emi|sip|bill|subscription|rent|insurance(?:\s+premium)?|loan)\b\s*(.*)$/i))) {
    const word = m[1].toLowerCase();
    const kind = word === 'emi' || word === 'loan' ? 'emi' : word === 'sip' ? 'sip' : 'bill';
    let rest = m[2];
    const amtM = rest.match(new RegExp(AMT, 'i'));
    const amount = amtM ? parseAmount(amtM[1]) : NaN;
    rest = stripAmount(rest);
    let endMonth = null;
    const durM = rest.match(/\bfor\s+(\d{1,3})\s+(months?|years?)\b/i);
    if (durM) {
      const n = parseInt(durM[1], 10) * (/year/i.test(durM[2]) ? 12 : 1);
      endMonth = monthKey(new Date(now.getFullYear(), now.getMonth() + n - 1, 1));
      rest = rest.replace(durM[0], ' ');
    }
    let schedule;
    const dp = dayPhrase(rest);
    if (dp) {
      schedule = { type: 'monthly', day: dp.day };
      rest = rest.replace(dp.match, ' ');
    } else {
      const pt = parseTime(rest, now);
      if (pt) {
        schedule = kind === 'bill' && !/\b(every|monthly)\b/i.test(rest) ? { type: 'once', date: ymd(pt.date) } : { type: 'monthly', day: pt.date.getDate() };
        rest = pt.rest;
      } else schedule = { type: 'monthly', day: now.getDate() };
    }
    rest = rest.replace(/\b(every month|monthly|per month|a month|due|each month)\b/gi, ' ');
    let name = tidy(rest.replace(/^\s*(?:for|of|in|on|to|called|named)\s+/i, '').replace(/\s+(?:for|of|in|on|to)\s*$/i, ''));
    if (!name) name = word === 'rent' ? 'Rent' : word.startsWith('insurance') ? 'Insurance' : KIND_LABEL[kind];
    else if (word === 'rent' || word.startsWith('insurance')) name = `${word[0].toUpperCase()}${word.slice(1)} ${name}`;
    name = name.replace(/^\w/, (c) => c.toUpperCase());
    return { type: 'add_obligation', kind, name, amount, schedule, endMonth, needsAmount: isNaN(amount) };
  }

  // Spends: "spent 450 on lunch with HDFC card", "paid 1200 for groceries via UPI", "500 on petrol"
  if ((m = t.match(new RegExp(`^(?:i\\s+)?(?:just\\s+)?(?:spent|spend|paid|pay|used|bought\\s+.+?\\s+for)?\\s*${AMT}\\s+(?:on|for|at|towards|to)\\s+(.+)$`, 'i'))) && (/^(i\s+)?(just\s+)?(spent|spend|paid|pay|used|bought)\b/i.test(t) || /^(rs\.?|₹|inr)?\s*\d/i.test(t))) {
    const amount = parseAmount(m[1]);
    let rest = m[2];
    let method = null;
    const mm = rest.match(/^(.*?)\s+(?:with|using|via|by|through|from|on)\s+(?:my\s+|the\s+)?(.+?)$/i);
    if (mm) {
      const r = resolveMethod(fin, mm[2]);
      if (r) { method = r; rest = mm[1]; }
    }
    let date = ymd(now);
    if (/\byesterday\b/i.test(rest)) { date = ymd(addDays(now, -1)); rest = rest.replace(/\s*\byesterday\b/i, ''); }
    rest = rest.replace(/\s*\btoday\b/i, '');
    const note = tidy(rest);
    const ob = fin.obligations.find((o) => note.toLowerCase().includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(note.toLowerCase()));
    if (ob && /^(i\s+)?paid\b/i.test(t)) return { type: 'mark_paid', query: ob.name };
    return { type: 'add_spend', amount, note, category: guessCategory(note), method: method || 'upi', date };
  }

  // Mark a due as paid: "paid my car loan emi", "mark rent as paid", "paid hdfc card bill"
  if ((m = lower.match(/^(?:i\s+)?(?:have\s+)?paid\s+(?:my\s+|the\s+)?(.+)$/)) || (m = lower.match(/^(?:mark\s+)?(?:my\s+|the\s+)?(.+?)\s+(?:as\s+)?paid$/))) {
    return { type: 'mark_paid', query: m[1].replace(/\s+(?:for\s+)?this month$/, '').trim() };
  }

  // Cards: "add card HDFC limit 2 lakh due on 15th"
  if ((m = t.match(/^(?:add|new)\s+(?:a\s+)?(?:credit\s+)?card\s+(.+)$/i))) {
    let rest = m[1];
    const last4M = rest.match(/\b(?:ending|ends)(?:\s+(?:in|with))?\s+(\d{4})\b/i);
    if (last4M) rest = rest.replace(last4M[0], ' ');
    const lim = rest.match(new RegExp(`\\blimit\\s+(?:of\\s+)?${AMT}`, 'i'));
    const dp = dayPhrase(rest);
    if (lim) rest = rest.replace(lim[0], ' ');
    if (dp) rest = rest.replace(dp.match, ' ');
    const name = tidy(rest.replace(/\bcard\b/i, '')) || 'Card';
    return { type: 'add_card', name: name.replace(/^\w/, (c) => c.toUpperCase()), limit: lim ? parseAmount(lim[1]) : 0, dueDay: dp ? dp.day : null, ...(last4M ? { last4: last4M[1] } : {}) };
  }

  return null;
}

/** Find the due (obligation or card) that best matches words like "car loan" or "hdfc card bill". */
export function findDue(fin, query) {
  const q = String(query || '').toLowerCase().replace(/\b(emi|sip|bill|my|the|card)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const words = q.split(' ').filter(Boolean);
  const score = (name) => {
    const n = name.toLowerCase();
    if (!words.length) return 0;
    return words.filter((w) => n.includes(w)).length / words.length;
  };
  let best = null, bestScore = 0;
  for (const ob of fin.obligations) { const s = score(ob.name); if (s > bestScore) { best = { ref: 'obligation', item: ob }; bestScore = s; } }
  for (const c of fin.cards) { const s = score(c.name); if (s > bestScore) { best = { ref: 'card', item: c }; bestScore = s; } }
  return bestScore >= 0.5 ? best : null;
}
