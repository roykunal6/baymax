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

test('Console Excel with Equity, Mutual Funds and Combined sheets (different column orders)', () => {
  const eqHead = [null, 'Symbol', 'ISIN', 'Sector', 'Quantity Available', 'Quantity Discrepant', 'Quantity Long Term', 'Quantity Pledged (Margin)', 'Quantity Pledged (Loan)', 'Average Price', 'Previous Closing Price', 'Unrealized P&L', 'Unrealized P&L Pct.'];
  const mfHead = [null, 'Symbol', 'ISIN', 'Instrument Type', 'Quantity Available', 'Quantity Discrepant', 'Quantity Pledged (Margin)', 'Quantity Pledged (Loan)', 'Average Price', 'Previous Closing Price', 'Unrealized P&L', 'Unrealized P&L Pct.'];
  const coHead = [null, 'Symbol', 'ISIN', 'Sector', 'Instrument Type', 'Quantity Available', 'Quantity Discrepant', 'Quantity Long Term', 'Quantity Pledged (Margin)', 'Quantity Pledged (Loan)', 'Average Price', 'Previous Closing Price', 'Unrealized P&L', 'Unrealize P&L Pct.'];
  const rows = [
    [null, 'Client ID', 'GU0000'], [null, 'Equity Holdings Statement as on 2026-11-14'], [null, 'Invested Value', 363767.38], [null, ''],
    eqHead,
    [null, 'SBIN', 'INE062A01020', 'FINANCIAL SERVICES', 30, 0, 30, 0, 0, 194.3, 1080.5, 26586, 456.1],
    [null, 'NIFTYBEES', 'INF204KB14I2', 'ETF', 602, 0, 0, 0, 0, 271.19, 286.66, 9310.77, 5.7],
    [null, 'Client ID', 'GU0000'], [null, 'Mutual Funds Holdings Statement'], [null, 'Invested Value', 1767774.77], [null, ''],
    mfHead,
    [null, 'DSP ELSS TAX SAVER FUND - DIRECT PLAN', 'INF740K01OK1', 'Equity - ELSS', 3157.678, 0, 0, 0, 97.5039, 162.187, 204248.5509, 66.34],
    coHead,
    [null, 'SBIN', 'INE062A01020', 'FINANCIAL SERVICES', '-', 30, 0, 30, 0, 0, 194.3, 1080.5, 26586, 456.1],
    [null, 'DSP ELSS TAX SAVER FUND - DIRECT PLAN', 'INF740K01OK1', '-', 'Equity - ELSS', 3157.678, 0, '-', 0, 0, 97.5039, 162.187, 204248.5509, 66.34],
  ];
  const h = parseHoldings(rows);
  assert.equal(h.length, 3, 'Combined sheet duplicates skipped');
  assert.equal(h.find((x) => x.symbol === 'NIFTYBEES').type, 'equity', 'ETFs count with stocks, as on Console');
  const dsp = h.find((x) => x.type === 'mf');
  assert.equal(dsp.avg, 97.5);
  assert.equal(dsp.price, 162.19);
  assert.equal(Math.round(dsp.value), 512134);
  assert.equal(Math.round(dsp.pnl), 204249);
  assert.equal(Math.round(h.find((x) => x.symbol === 'SBIN').value), 32415);
});

test('two accounts uploaded together stay separate; a later upload replaces per account', async () => {
  const { clientIdOf, clientIdFromName, byOwner } = await import('../js/zerodha.js');
  const head = [null, 'Symbol', 'ISIN', 'Instrument Type', 'Quantity Available', 'Quantity Discrepant', 'Quantity Pledged (Margin)', 'Quantity Pledged (Loan)', 'Average Price', 'Previous Closing Price', 'Unrealized P&L', 'Unrealized P&L Pct.'];
  const file = (id, qty) => [[null, 'Client ID', id], [null, 'Mutual Funds Holdings Statement'], head,
    [null, 'KOTAK FLEXI CAP FUND - DIRECT PLAN', 'INF174K01LS2', 'Equity - Flexi Cap', qty, 0, 0, 0, 60, 100, qty * 40, 66]];
  assert.equal(clientIdOf(file('GU0001', 1)), 'GU0001');
  assert.equal(clientIdFromName('holdings-GJ0002.xlsx'), 'GJ0002');
  const a = parseHoldings(file('GU0001', 100)), b = parseHoldings(file('GJ0002', 50));
  let all = mergeHoldings([{ id: 'zh-old', type: 'mf', value: 1 }], [...a, ...b]);
  assert.equal(all.length, 2, 'same fund in both accounts kept twice; old owner-less upload replaced');
  assert.deepEqual(byOwner(all).map((o) => [o.owner, o.value]), [['GU0001', 10000], ['GJ0002', 5000]]);
  all = mergeHoldings(all, parseHoldings(file('GU0001', 200)));
  assert.deepEqual(byOwner(all).map((o) => [o.owner, o.value]), [['GU0001', 20000], ['GJ0002', 5000]], 'one account re-uploaded, the other kept');
});
