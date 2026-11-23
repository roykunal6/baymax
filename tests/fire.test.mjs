import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, parseAmountLoose, fireCorpus } from '../js/fire.js';

const start = new Date(2026, 10, 15);
const base = { corpus: 5698000, monthly: 140200, ret: 11, target: 1e8, start, boost: 65479, boostFrom: '2033-08' };

test('matches the FIRE dashboard: step-up 10% → 2039, flat → about 2041–42', () => {
  const step = project({ ...base, stepUp: 10 });
  assert.equal(step.date.getFullYear(), 2039);
  const flat = project(base);
  assert.ok([2041, 2042].includes(flat.date.getFullYear()), String(flat.date));
  const v2036 = step.yearly.find((y) => y.year === 2036).value;
  assert.ok(Math.abs(v2036 - 6.26e7) < 0.1e7, `2036 value ${v2036}`);
});

test('no target reached within 50 years → null date', () => {
  assert.equal(project({ corpus: 0, monthly: 0, target: 1e8, start }).date, null);
});

test('amounts in lakh / crore', () => {
  assert.equal(parseAmountLoose('29.87 lakh'), 2987000);
  assert.equal(parseAmountLoose('1.5 cr'), 15000000);
  assert.equal(parseAmountLoose('50,000'), 50000);
  assert.equal(parseAmountLoose('50k'), 50000);
  assert.equal(parseAmountLoose('abc'), 0);
});

test('corpus = live Zerodha + other assets', () => {
  const fin = { holdings: [{ type: 'mf', value: 2661122, invested: 2131542 }], fire: { assets: [{ name: 'Partner', amount: 2987000 }, { name: 'Vested', amount: 50000 }] } };
  assert.equal(Math.round(fireCorpus(fin).total), 5698122);
  assert.equal(fireCorpus({ ...fin, fire: { ...fin.fire, useZerodha: false } }).total, 3037000);
});
