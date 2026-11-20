import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, tableToTransactions, linesToTransactions, toBankTransactions } from '../js/statement.js';

test('CSV with separate withdrawal/deposit columns (savings account style)', () => {
  const csv = `HDFC BANK Ltd. Statement of account
Account No :XXXXXXXX5678

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/11/26,"SALARY THESTRAL MEDIA",0000123,01/11/26,,"1,50,000.00","1,62,000.00"
05/11/26,UPI-SWIGGY-swiggy@icici-ICIC0000001-432112345678-Food,0000432,05/11/26,450.00,,"1,61,550.00"
10/11/26,ACH D- TP ACH HDFC LTD-CAR LOAN,0000999,10/11/26,"18,500.00",,"1,43,050.00"
`;
  const t = tableToTransactions(parseCSV(csv));
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => [x.date, x.amount, x.type]), [['2026-11-01', 150000, 'credit'], ['2026-11-05', 450, 'debit'], ['2026-11-10', 18500, 'debit']]);
  const b = toBankTransactions(t);
  assert.equal(b[1].channel, 'upi');
  assert.equal(b[1].merchant, 'SWIGGY');
  assert.ok(b[0].id.startsWith('st-'));
  assert.notEqual(b[0].id, b[1].id);
});

test('single amount column with Dr/Cr (credit card style)', () => {
  const rows = [
    ['Transaction Date', 'Details', 'Amount (INR)', 'Dr/Cr'],
    ['18-Nov-2026', 'AMAZON PAY INDIA', '2,500.00', 'Dr'],
    ['15-Nov-2026', 'PAYMENT RECEIVED - THANK YOU', '34,500.00', 'Cr'],
  ];
  assert.deepEqual(tableToTransactions(rows).map((x) => [x.date, x.amount, x.type]), [['2026-11-18', 2500, 'debit'], ['2026-11-15', 34500, 'credit']]);
});

test('Excel serial dates and signed amounts', () => {
  const rows = [['Date', 'Description', 'Amount'], [46346, 'NETFLIX', -649], [46347, 'REFUND', 200]];
  assert.deepEqual(tableToTransactions(rows).map((x) => [x.date, x.amount, x.type]), [['2026-11-20', 649, 'debit'], ['2026-11-21', 200, 'credit']]);
  // All-positive amounts with no Dr/Cr = a card statement's list of spends.
  const card = [['Date', 'Description', 'Amount'], ['20/11/2026', 'SWIGGY', '650.00'], ['21/11/2026', 'UBER', '320.00']];
  assert.deepEqual(tableToTransactions(card).map((x) => x.type), ['debit', 'debit']);
});

test('PDF lines with running balance', () => {
  const lines = [
    'Statement of Account for 01-11-2026 to 30-11-2026',
    'Opening Balance 12,000.00',
    '01/11/2026 NEFT CR THESTRAL MEDIA 1,50,000.00 1,62,000.00',
    '05/11/2026 UPI/P2M/432112/SWIGGY 450.00 1,61,550.00',
    '20/11/2026 ATM CASH WDL 2,000.00 1,59,550.00',
    'Page 1 of 2',
  ];
  const t = linesToTransactions(lines);
  assert.deepEqual(t.map((x) => [x.date, x.amount, x.type]), [['2026-11-01', 150000, 'credit'], ['2026-11-05', 450, 'debit'], ['2026-11-20', 2000, 'debit']]);
  const b = toBankTransactions(t);
  assert.equal(b[2].channel, 'atm');
  assert.equal(b[1].merchant, 'SWIGGY');
});

test('PDF lines from a credit card statement (Dr/Cr markers, no balance)', () => {
  const lines = ['18 Nov 2026 SWIGGY BANGALORE 650.00 Dr', '15 Nov 2026 PAYMENT RECEIVED 34,500.00 Cr'];
  assert.deepEqual(linesToTransactions(lines).map((x) => [x.amount, x.type]), [[650, 'debit'], [34500, 'credit']]);
});
