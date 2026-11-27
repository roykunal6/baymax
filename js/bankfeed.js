// Turns transactions read from bank/card alert emails into Baymax entries.
// Pure: takes the finance state and returns the changes to make, so it's unit-tested.

import { dueItems, addDays, parseDay, guessCategory, ymd, daysBetween } from './finance.js';

const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

function cardFor(fin, t) {
  if (t.last4) {
    const c = fin.cards.find((x) => x.last4 && String(x.last4) === String(t.last4));
    if (c) return c;
  }
  if (/card/.test(t.channel) && t.bank) {
    const matches = fin.cards.filter((x) => x.name.toLowerCase().includes(t.bank.toLowerCase().split(' ')[0]));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

const CARD_PAYMENT = /\b(credit ?card (bill|payment)|card ?payment|cc ?(bill|payment)|billdesk.*card|cred\b|payment (received|credited) (on|to|towards) your .*card)/i;
const SELF_TRANSFER = /\b(self|own account|to your .*account|sweep|fd booking|fixed deposit)\b/i;
// Axis 'FLEXI' (auto-sweep to and from a flexi deposit): your own money moving, never a spend or income.
const FLEXI = /flexi/i;
// Investments and loan repayments: tracked under Dues, never spends.
const SIP_OR_EMI = /\b(sip|systematic|mutual ?fund|\bmf\b|nach|ach ?d|ach-?dr|mandate|bse ?star|bse ?ltd|indian clearing|nse clearing|zerodha|coin by|groww|cams|kfin|kfintech|amc|emi|home ?loan|housing loan|loan (a\/?c|account|repay|recovery|emi)|lnemi)\b/i;

/** Transfers between your own accounts: your name (Money → Setup) or one of your other accounts' last 4 digits. */
export function isOwnTransfer(t, fin) {
  const text = ` ${String(t.text || '')} ${String(t.merchant || '')} `;
  if (SELF_TRANSFER.test(text)) return true;
  const plain = text.replace(/\b(dear|hi|hello)\s+[^,\n]{2,60}[,\n]/gi, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const names = String(fin.selfNames || '').split(',').map((n) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')).filter((n) => n.length >= 5);
  if (names.some((n) => plain.includes(` ${n} `))) return true;
  const mine = String(fin.ownAccounts || '').split(/[,\s]+/).map((x) => x.replace(/\D/g, '').slice(-4)).filter((x) => x.length === 4 && x !== t.last4);
  return mine.some((d) => new RegExp(`(?:x|\\*|ending|no|a c|ac|account)\\s*${d}\\b`).test(plain));
}

/**
 * @param {object} fin state.finance
 * @param {Array} items parsed transactions (bankInbox)
 * @param {Date} now
 * @returns {{ spends: Array, credits: Array, paid: Array<{ref, id, key}>, skipped: Array, messages: string[] }}
 */
export function planBankItems(fin, items, now = new Date(), { statement = false } = {}) {
  const out = { spends: [], credits: [], paid: [], skipped: [], messages: [] };
  const existingIds = new Set([...fin.spends.map((x) => x.id), ...(fin.credits || []).map((x) => x.id)]);
  const claimed = new Set(); // dues already matched in this batch

  for (const t of items) {
    const sid = `bank-${t.id || `${t.date}-${t.amount}-${t.last4}`}`;
    if (existingIds.has(sid)) { out.skipped.push({ t, why: 'already imported' }); continue; }
    const d = parseDay(t.date);
    const card = cardFor(fin, t);
    if (FLEXI.test(`${t.text || ''} ${t.merchant || ''}`)) { out.skipped.push({ t, why: 'FLEXI (ignored)' }); continue; }
    const own = t.self || isOwnTransfer(t, fin);

    if (t.type === 'credit') {
      // Payment received on a credit card = that card's bill is paid.
      if (card && /card/.test(t.channel) && /payment|received|thank/i.test(t.text || '')) {
        const due = dueItems(fin, addDays(d, -40), addDays(d, 10)).find((x) => x.ref === 'card' && x.id === card.id && !x.paid);
        if (due) { out.paid.push({ ref: 'card', id: card.id, key: due.key }); out.messages.push(`${card.name} card bill marked paid (${t.amount}).`); }
        else out.skipped.push({ t, why: 'card payment' });
        continue;
      }
      if (own) { out.skipped.push({ t, why: 'transfer between your own accounts' }); continue; }
      // Money for an unpaid invoice.
      const inv = fin.invoices.find((i) => !i.paidAt && (i.direction || 'in') === 'in' && near(i.amount, t.amount));
      if (inv) { out.paid.push({ ref: 'invoice', id: inv.id, key: 'once' }); out.messages.push(`Invoice ${inv.party} ${inv.number || ''} marked received.`); }
      const refund = /refund|revers|cashback/i.test(t.text || '');
      const dupCredit = statement && (fin.credits || []).find((x) => near(x.amount, t.amount, 0.01) && Math.abs(daysBetween(parseDay(x.date), d)) <= 1);
      if (dupCredit) { out.skipped.push({ t, why: 'already recorded from your bank alerts' }); continue; }
      out.credits.push({ id: sid, amount: t.amount, from: t.merchant || t.bank || 'Bank', kind: refund ? 'refund' : 'income', date: t.date, method: card ? card.id : t.channel === 'upi' ? 'upi' : 'bank', source: statement ? 'statement' : 'email', ...(t.bank ? { bank: t.bank } : {}), ...(t.last4 ? { last4: t.last4 } : {}) });
      continue;
    }

    // Debits ------------------------------------------------------------
    if (CARD_PAYMENT.test(t.text || '') || CARD_PAYMENT.test(t.merchant || '')) {
      const target = fin.cards.find((c) => (t.text || '').toLowerCase().includes(c.name.toLowerCase())) || null;
      const due = dueItems(fin, addDays(d, -40), addDays(d, 10)).find((x) => x.ref === 'card' && !x.paid && (!target || x.id === target.id) && near(x.amount, t.amount, Math.max(1, x.amount * 0.02)));
      if (due) { out.paid.push({ ref: 'card', id: due.id, key: due.key }); out.messages.push(`${due.name} marked paid.`); }
      else out.skipped.push({ t, why: 'credit card bill payment (not a new spend)' });
      continue;
    }

    // EMI / SIP / bill with the same amount due within ±5 days.
    const due = dueItems(fin, addDays(d, -5), addDays(d, 5))
      .find((x) => x.ref === 'obligation' && !x.paid && !claimed.has(`${x.id}:${x.key}`) && near(x.amount, t.amount));
    if (due) {
      claimed.add(`${due.id}:${due.key}`);
      out.paid.push({ ref: 'obligation', id: due.id, key: due.key });
      out.messages.push(`${due.name} (${due.kind.toUpperCase()}) marked paid (${t.amount} on ${t.date}).`);
      continue;
    }

    if (own) { out.skipped.push({ t, why: 'transfer between your own accounts' }); continue; }
    if (SIP_OR_EMI.test(`${t.text || ''} ${t.merchant || ''}`)) { out.skipped.push({ t, why: 'SIP / EMI (tracked under Dues, not a spend)' }); continue; }

    // Probably logged by hand already: same amount within a day.
    // From a statement, alert-logged spends count as duplicates too.
    const dup = fin.spends.find((x) => near(x.amount, t.amount, 0.01) && Math.abs(daysBetween(parseDay(x.date), d)) <= 1 && (statement || x.source !== 'email'));
    if (dup) { out.skipped.push({ t, why: `looks like “${dup.note || dup.category}” you already logged` }); continue; }

    const label = t.merchant || (t.channel === 'atm' ? 'ATM withdrawal' : `${t.bank || 'Bank'} ${t.channel}`);
    out.spends.push({
      id: sid, amount: t.amount, note: label, category: t.channel === 'atm' ? 'Other' : guessCategory(`${t.merchant} ${t.text}`),
      method: card ? card.id : t.channel === 'upi' ? 'upi' : /card/.test(t.channel) ? 'bank' : 'bank',
      date: t.date || ymd(now), source: statement ? 'statement' : 'email',
      ...(t.bank ? { bank: t.bank } : {}), ...(t.last4 ? { last4: t.last4 } : {}),
    });
  }
  return out;
}
