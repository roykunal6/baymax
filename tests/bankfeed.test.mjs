import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBankItems } from '../js/bankfeed.js';
import { emptyFinance } from '../js/finance.js';

const NOW = new Date(2026, 10, 20, 12);
const fin = () => ({
  ...emptyFinance(),
  cards: [{ id: 'c1', name: 'HDFC', last4: '1234', limit: 100000, dueDay: 15, paid: {} }],
  obligations: [
    { id: 'e1', kind: 'emi', name: 'Car loan', amount: 18500, schedule: { type: 'monthly', day: 10 }, paid: {} },
    { id: 's1', kind: 'sip', name: 'Axis Bluechip', amount: 5000, schedule: { type: 'monthly', day: 20 }, paid: {} },
  ],
  invoices: [{ id: 'i1', party: 'Thestral', number: 'T-12', amount: 45000, dueDate: '2026-11-25', direction: 'in' }],
  spends: [
    { id: 'm1', amount: 450, note: 'lunch', category: 'Food', method: 'upi', date: '2026-11-20' },
    { id: 'o1', amount: 30000, note: 'phone', category: 'Shopping', method: 'c1', date: '2026-10-05' },
  ],
});
const tx = (o) => ({ id: Math.random().toString(36).slice(2), amount: 100, type: 'debit', channel: 'upi', bank: 'HDFC Bank', merchant: '', last4: '', text: '', date: '2026-11-20', ...o });

test('card spend → spend on the right card with category', () => {
  const r = planBankItems(fin(), [tx({ amount: 650, channel: 'credit card', last4: '1234', merchant: 'SWIGGY', text: 'Rs.650 spent on HDFC card x1234 at SWIGGY' })], NOW);
  assert.equal(r.spends.length, 1);
  assert.deepEqual([r.spends[0].method, r.spends[0].category, r.spends[0].note, r.spends[0].source], ['c1', 'Food', 'SWIGGY', 'email']);
});

test('debit matching an EMI/SIP marks it paid instead of logging a spend', () => {
  const r = planBankItems(fin(), [tx({ amount: 5000, date: '2026-11-20', text: 'Rs 5000 debited towards ACH mandate' }), tx({ amount: 18500, date: '2026-11-10', text: 'NACH debit' })], NOW);
  assert.equal(r.spends.length, 0);
  assert.deepEqual(r.paid.map((p) => p.id).sort(), ['e1', 's1']);
});

test('credit card bill payment marks the card bill paid (not a spend)', () => {
  const r = planBankItems(fin(), [tx({ amount: 30000, date: '2026-11-14', merchant: 'HDFC Credit Card', text: 'Rs 30000 debited for HDFC credit card payment via BillDesk' })], NOW);
  assert.equal(r.spends.length, 0);
  assert.deepEqual(r.paid, [{ ref: 'card', id: 'c1', key: '2026-11' }]);
});

test('duplicates of hand-logged spends are skipped; same email twice is skipped', () => {
  const f = fin();
  const t = tx({ amount: 450, date: '2026-11-20', merchant: 'CAFE' });
  let r = planBankItems(f, [t], NOW);
  assert.equal(r.spends.length, 0);
  assert.match(r.skipped[0].why, /lunch/);
  const t2 = tx({ id: 'gmail-1', amount: 999, merchant: 'NETFLIX' });
  r = planBankItems(f, [t2], NOW);
  f.spends.push(...r.spends);
  r = planBankItems(f, [t2], NOW);
  assert.equal(r.spends.length, 0);
  assert.equal(r.skipped[0].why, 'already imported');
});

test('credits: invoice payment, refund, income', () => {
  const r = planBankItems(fin(), [
    tx({ type: 'credit', amount: 45000, merchant: 'THESTRAL MEDIA', text: 'Credited INR 45,000 from THESTRAL MEDIA' }),
    tx({ type: 'credit', amount: 799, channel: 'credit card', last4: '1234', text: 'Rs.799 refunded to your card from MYNTRA' }),
  ], NOW);
  assert.deepEqual(r.paid, [{ ref: 'invoice', id: 'i1', key: 'once' }]);
  assert.deepEqual(r.credits.map((c) => c.kind), ['income', 'refund']);
});

test('own-account transfers are skipped, but an EMI paid that way still counts as paid', async () => {
  const { planBankItems } = await import('../js/bankfeed.js');
  const fin = { spends: [], credits: [], invoices: [], cards: [], obligations: [{ id: 'emi1', kind: 'emi', name: 'ICICI home loan', amount: 65479, schedule: { type: 'monthly', day: 5 }, payments: {} }] };
  const now = new Date(2026, 10, 21);
  const out = planBankItems(fin, [
    { id: 'a', type: 'debit', amount: 70189, date: '2026-11-19', self: true, text: 'IMPS to KUNAL ROY', channel: 'bank transfer' },
    { id: 'b', type: 'credit', amount: 5000, date: '2026-11-19', self: true, text: 'from Bandhan A/c XX0816', channel: 'bank transfer' },
    { id: 'c', type: 'debit', amount: 65479, date: '2026-11-05', self: true, text: 'to ICICI loan XX0879', channel: 'bank transfer' },
    { id: 'd', type: 'debit', amount: 634, date: '2026-11-21', merchant: 'ZOMATO', text: 'UPI ZOMATO', channel: 'upi' },
  ], now);
  assert.deepEqual(out.spends.map((x) => x.amount), [634]);
  assert.equal(out.credits.length, 0);
  assert.equal(out.paid.length, 1, 'EMI marked paid');
});
