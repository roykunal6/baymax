import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoldings, mergeHoldings, portfolioSummary, uploadDue } from '../js/zerodha.js';

test('Console equity holdings (Excel export layout)', () => {
  const rows = [
    ['Equity Holdings Statement as on 2026-11-20'], ['Client ID', 'AB1234'], [],
    ['Symbol', 'ISIN', 'Sector', 'Quantity Available', 'Quantity Discrepant', 'Quantity Long Term', 'Quantity Pledged (Margin)', 'Quantity Pledged (Loan)', 'Average Price', 'Previous Closing Price', 'Unrealized P&L', 'Unrealized P&L Pct.'],
    ['INFY', 'INE009A01021', 'IT', 10, 0, 10, 0, 0, 1400, 1850.5, 4505, 32.18],
    ['HDFCBANK', 'INE040A01034', 'BANKING', 20, 0, 20, 0, 0, 1600, 1720, 2400, 7.5],
  ];
  const h = parseHoldings(rows);
  assert.equal(h.length, 2);
  assert.deepEqual([h[0].symbol, h[0].type, h[0].qty, h[0].invested, h[0].value, h[0].pnl], ['INFY', 'equity', 10, 14000, 18505, 4505]);
});

test('Kite holdings CSV layout and mutual funds', () => {
  const kite = [['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Cur. val', 'P&L', 'Net chg.', 'Day chg.'], ['TCS', '5', '3,200.00', '4,100.00', '20,500.00', '4,500.00', '28.1%', '0.5%']];
  const k = parseHoldings(kite);
  assert.deepEqual([k[0].symbol, k[0].value, k[0].invested, k[0].pnl], ['TCS', 20500, 16000, 4500]);
  const mf = [['Symbol', 'ISIN', 'Quantity Available', 'Average Price', 'Previous Closing Price', 'Unrealized P&L'],
    ['AXIS BLUECHIP FUND - DIRECT PLAN', 'INF846K01DP8', '1234.567', '45.10', '58.20', '16172.83']];
  const m = parseHoldings(mf);
  assert.equal(m[0].type, 'mf');
  assert.equal(Math.round(m[0].value), 71852);
});

test('merging an equity file keeps funds; summary and weekly reminder', () => {
  const cur = [{ id: 'a', type: 'equity', value: 100, invested: 80 }, { id: 'b', type: 'mf', value: 200, invested: 150 }];
  const merged = mergeHoldings(cur, [{ id: 'c', type: 'equity', value: 300, invested: 250 }]);
  assert.deepEqual(merged.map((h) => h.id), ['b', 'c']);
  const s = portfolioSummary(merged);
  assert.deepEqual([s.value, s.invested, s.pnl, s.mf.value, s.equity.count], [500, 400, 100, 200, 1]);
  const sunday10 = new Date(2026, 10, 22, 10, 30);
  assert.equal(uploadDue(new Date(2026, 10, 18).toISOString(), sunday10), true);
  assert.equal(uploadDue(new Date(2026, 10, 22, 9).toISOString(), sunday10), false);
  assert.equal(uploadDue(new Date(2026, 10, 10).toISOString(), new Date(2026, 10, 19)), true);
  assert.equal(uploadDue(null), true);
});
