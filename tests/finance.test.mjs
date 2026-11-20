import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, inr, occurrences, dueItems, monthSummary, healthCheck, parseFinanceCommand,
  emptyFinance, guessCategory, findDue, overdueItems,
} from '../js/finance.js';

const NOW = new Date(2026, 10, 18, 10, 0); // Wed 18 Nov 2026
const fin = () => ({
  ...emptyFinance(),
  income: 100000, budget: 30000,
  cards: [{ id: 'c1', name: 'HDFC', limit: 50000, dueDay: 15, paid: {} }],
  obligations: [
    { id: 'o1', kind: 'emi', name: 'Car loan', amount: 18500, schedule: { type: 'monthly', day: 10 }, paid: { '2026-11': '2026-11-10' } },
    { id: 'o2', kind: 'sip', name: 'Axis Bluechip', amount: 5000, schedule: { type: 'monthly', day: 20 }, paid: {} },
    { id: 'o3', kind: 'bill', name: 'Electricity', amount: 2400, schedule: { type: 'monthly', day: 5 }, paid: {} },
    { id: 'o4', kind: 'bill', name: 'Car insurance', amount: 12000, schedule: { type: 'once', date: '2026-12-02' }, paid: {} },
  ],
  invoices: [
    { id: 'i1', party: 'Thestral', number: 'T-12', amount: 45000, dueDate: '2026-11-12', direction: 'in' },
    { id: 'i2', party: 'Thestral', number: 'T-11', amount: 40000, dueDate: '2026-11-01', direction: 'in', paidAt: '2026-11-03' },
  ],
  spends: [
    { id: 's1', amount: 12000, category: 'Groceries', method: 'c1', date: '2026-11-02' },
    { id: 's2', amount: 9000, category: 'Shopping', method: 'upi', date: '2026-11-15' },
    { id: 's3', amount: 800, category: 'Food', method: 'c1', date: '2026-11-18' },
    { id: 's4', amount: 7000, category: 'Food', method: 'c1', date: '2026-10-20' },
  ],
});

test('amounts', () => {
  assert.equal(parseAmount('1,200'), 1200);
  assert.equal(parseAmount('₹450'), 450);
  assert.equal(parseAmount('45k'), 45000);
  assert.equal(parseAmount('1.2 lakh'), 120000);
  assert.equal(parseAmount('rs 99.5'), 99.5);
  assert.ok(isNaN(parseAmount('lunch')));
  assert.equal(inr(123456), '₹1,23,456');
  assert.equal(inr(150000, { compact: true }), '₹1.5L');
});

test('occurrences: monthly clamps to month end, once, end month', () => {
  const ob = { schedule: { type: 'monthly', day: 31 } };
  const d = occurrences(ob, new Date(2026, 1, 1), new Date(2026, 2, 31)).map((o) => o.date.getDate());
  assert.deepEqual(d, [28, 31]);
  assert.equal(occurrences({ schedule: { type: 'once', date: '2026-12-02' } }, NOW, new Date(2026, 11, 31)).length, 1);
  assert.equal(occurrences({ schedule: { type: 'monthly', day: 5 }, endMonth: '2026-12' }, NOW, new Date(2027, 2, 1)).length, 1); // 5 Nov already passed; 5 Dec only
});

test('due items include card bill from last month spends', () => {
  const items = dueItems(fin(), new Date(2026, 10, 1), new Date(2026, 10, 30));
  const card = items.find((i) => i.kind === 'card');
  assert.equal(card.amount, 7000);
  assert.equal(card.date.getDate(), 15);
  assert.equal(items.find((i) => i.name === 'Car loan').paid, true);
  const overdue = overdueItems(fin(), NOW).map((i) => i.name);
  assert.ok(overdue.includes('Electricity'));
  assert.ok(overdue.includes('HDFC card bill'));
  assert.ok(!overdue.includes('Thestral #T-12'), 'incoming invoices are not "your" overdue payments');
});

test('month summary', () => {
  const s = monthSummary(fin(), NOW);
  assert.equal(s.spent, 21800);
  assert.equal(s.emi, 18500);
  assert.equal(s.sip, 5000);
  assert.equal(s.bills, 2400);
  assert.equal(s.income, 140000); // salary + Thestral invoice received this month
  assert.equal(s.toReceive, 45000);
  assert.equal(s.overdueInvoices.length, 1);
  assert.equal(s.byCard.c1, 12800);
  assert.equal(s.projected, Math.round(21800 / 18 * 30));
});

test('health check flags overspending pace, overdue bills and invoices', () => {
  const h = healthCheck(fin(), NOW);
  assert.equal(h.status, 'bad');
  const text = h.alerts.map((a) => a.text).join('\n');
  assert.match(text, /Electricity/);
  assert.match(text, /over budget/);
  assert.match(text, /Thestral #T-12.*overdue/);
  assert.match(text, /SIP “Axis Bluechip” ₹5,000 due in 2 days/);
  const calm = { ...emptyFinance(), income: 100000, budget: 30000, spends: [{ id: 'x', amount: 5000, category: 'Food', method: 'upi', date: '2026-11-10' }] };
  assert.equal(healthCheck(calm, NOW).status, 'good');
  assert.equal(healthCheck(emptyFinance(), NOW).status, 'setup');
});

test('finance commands', () => {
  const f = fin();
  const p = (s) => parseFinanceCommand(s, { fin: f, now: NOW });
  assert.deepEqual(p('spent 450 on lunch with HDFC card'), { type: 'add_spend', amount: 450, note: 'lunch', category: 'Food', method: 'c1', date: '2026-11-18' });
  assert.equal(p('spent 2.5k on groceries yesterday').date, '2026-11-17');
  assert.equal(p('spent 2.5k on groceries yesterday').amount, 2500);
  assert.equal(p('paid 1200 for petrol via upi').method, 'upi');
  assert.equal(p('500 on uber').category, 'Travel');
  assert.deepEqual([p('spent 320 on uber on 12th').note, p('spent 320 on uber on 12th').date], ['uber', '2026-11-12']);
  assert.equal(p('spent 900 on dinner on 25th').date, '2026-10-25'); // 25th hasn't come yet this month
  assert.equal(p('spent 900 on dinner on 2 Nov').date, '2026-11-02');
  assert.deepEqual(p('paid 2400 for electricity'), { type: 'mark_paid', query: 'Electricity' });

  let r = p('add EMI car loan 18500 on 10th for 24 months');
  assert.equal(r.kind, 'emi'); assert.equal(r.name, 'Car loan'); assert.equal(r.amount, 18500);
  assert.deepEqual(r.schedule, { type: 'monthly', day: 10 }); assert.equal(r.endMonth, '2028-10');
  r = p('add SIP of 5000 in Axis Bluechip on 7th every month');
  assert.equal(r.kind, 'sip'); assert.equal(r.name, 'Axis Bluechip'); assert.equal(r.schedule.day, 7);
  r = p('add bill electricity 2400 due on 5th');
  assert.equal(r.name, 'Electricity'); assert.equal(r.schedule.type, 'monthly');
  r = p('add bill car insurance 12000 due tomorrow');
  assert.deepEqual(r.schedule, { type: 'once', date: '2026-11-19' });
  r = p('add rent 25000 on 1st');
  assert.equal(r.name, 'Rent'); assert.equal(r.kind, 'bill');

  r = p('add Thestral invoice 45000 due next friday');
  assert.equal(r.type, 'add_invoice'); assert.equal(r.party, 'Thestral'); assert.equal(r.amount, 45000); assert.equal(r.dueDate, '2026-11-20');
  r = p('raise invoice #T-13 to thestral for 1.2 lakh due on 30th');
  assert.equal(r.party, 'Thestral'); assert.equal(r.number, 'T-13'); assert.equal(r.amount, 120000); assert.equal(r.dueDate, '2026-11-30');
  assert.equal(p('invoice from AWS 3400 due on 5th').direction, 'out');
  assert.deepEqual(p('thestral invoice T-12 paid'), { type: 'invoice_paid', party: 'thestral', number: 't-12' });
  assert.equal(p('received 45000 from thestral').party, 'thestral');

  assert.deepEqual(p('paid my car loan emi'), { type: 'mark_paid', query: 'car loan emi' });
  assert.deepEqual(p('mark electricity as paid'), { type: 'mark_paid', query: 'electricity' });
  assert.equal(p('how am I doing this month').type, 'finance_summary');
  assert.equal(p('am i overspending').type, 'finance_summary');
  assert.deepEqual(p("what's due this week"), { type: 'list_dues', range: 'week' });
  assert.deepEqual(p('upcoming payments this month'), { type: 'list_dues', range: 'month' });
  assert.equal(p('how much did I spend today').range, 'today');
  assert.equal(p('how much did i spend on food this month').category, 'Food');
  assert.equal(p('credit card spends').type, 'card_summary');
  assert.equal(p('how is my portfolio doing').type, 'portfolio');
  assert.equal(p('show my invoices').type, 'list_invoices');
  assert.deepEqual(p('set budget to 40k'), { type: 'set_budget', amount: 40000 });
  assert.deepEqual(p('my salary is 1.5 lakh'), { type: 'set_income', amount: 150000 });
  assert.deepEqual(p('add card ICICI Amazon limit 2 lakh due on 18th'), { type: 'add_card', name: 'ICICI Amazon', limit: 200000, dueDay: 18 });
  assert.deepEqual(p('add card HDFC Regalia ending 1234 limit 3 lakh due on 15th'), { type: 'add_card', name: 'HDFC Regalia', limit: 300000, dueDay: 15, last4: '1234' });
  assert.equal(p('add task buy milk'), null);
  assert.equal(p('remind me to call the bank in 20 minutes'), null);
});

test('helpers', () => {
  assert.equal(guessCategory('Swiggy dinner'), 'Food');
  assert.equal(findDue(fin(), 'car loan emi').item.id, 'o1');
  assert.equal(findDue(fin(), 'hdfc card bill').ref, 'card');
});

test('new monthly payments start from their next due date (no fake overdue)', async () => {
  const { nextMonthlyDate, monthKey } = await import('../js/finance.js');
  assert.equal(monthKey(nextMonthlyDate(10, NOW)), '2026-12'); // 10th already passed on 18 Nov
  assert.equal(monthKey(nextMonthlyDate(25, NOW)), '2026-11');
  const f = { ...emptyFinance(), obligations: [{ id: 'x', kind: 'sip', name: 'New SIP', amount: 5000, schedule: { type: 'monthly', day: 25 }, startMonth: '2026-11', paid: {} }] };
  assert.equal(overdueItems(f, NOW).length, 0);
});

test('monthly totals include an EMI added after its due date this month', () => {
  const f = { ...emptyFinance(), income: 100000, obligations: [{ id: 'e', kind: 'emi', name: 'Car', amount: 18500, schedule: { type: 'monthly', day: 10 }, startMonth: '2026-12', paid: {} }] };
  assert.equal(monthSummary(f, NOW).emi, 18500);
  assert.equal(overdueItems(f, NOW).length, 0);
});
