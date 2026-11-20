import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlert, findDate } from '../js/bankparse.js';

const p = (subject, body, from = 'alerts@bank.example') => parseAlert({ id: 'm1', from, subject, body, date: '2026-11-20T09:00:00Z' });

test('dates', () => {
  assert.equal(findDate('on 20-11-26'), '2026-11-20');
  assert.equal(findDate('on 2026-11-20:12:30'), '2026-11-20');
  assert.equal(findDate('on 20-Nov-26'), '2026-11-20');
  assert.equal(findDate('on 18 November 2026'), '2026-11-18');
  assert.equal(findDate('on Nov 18, 2026'), '2026-11-18');
});

test('credit card spends', () => {
  let t = p('Alert : Update on your HDFC Bank Credit Card', 'Dear Card Member, Rs.450.00 spent on HDFC Bank Card x1234 at SWIGGY on 2026-11-20:12:30:22. Not you? Call 18002586161', 'alerts@hdfcbank.net');
  assert.deepEqual([t.amount, t.type, t.merchant, t.last4, t.bank, t.date, t.channel], [450, 'debit', 'SWIGGY', '1234', 'HDFC Bank', '2026-11-20', 'credit card']);
  t = p('Transaction alert for your ICICI Bank Credit Card', 'INR 2,500.00 spent using ICICI Bank Card XX9876 on 20-Nov-26 on AMAZON PAY IN. Avl Limit: INR 1,20,000.00', 'credit_cards@icicibank.com');
  assert.deepEqual([t.amount, t.type, t.last4, t.bank, t.date], [2500, 'debit', '9876', 'ICICI Bank', '2026-11-20']);
  t = p('Your American Express Card', 'Alert: You’ve spent INR 5,200.00 on your American Express Card ending 1003 at TAJ HOTELS on 18 November 2026 at 08:30 PM IST', 'americanexpress@welcome.americanexpress.com');
  assert.deepEqual([t.amount, t.merchant, t.last4, t.bank, t.date], [5200, 'TAJ HOTELS', '1003', 'Amex', '2026-11-18']);
});

test('UPI and bank debits', () => {
  let t = p('You have done a UPI txn', 'Dear Customer, Rs.1200.00 has been debited from account **5678 to VPA uber@axisbank UBER INDIA on 20-11-26. Your UPI transaction reference number is 432112345678.', 'alerts@hdfcbank.net');
  assert.deepEqual([t.amount, t.type, t.merchant, t.last4, t.channel, t.ref], [1200, 'debit', 'uber@axisbank', '5678', 'upi', '432112345678']);
  t = p('Debit transaction alert', 'INR 32000.00 debited A/c no. XX4321 20-11-2026 14:05:11 UPI/P2M/432112/FLIPKART', 'alerts@axisbank.com');
  assert.deepEqual([t.amount, t.type, t.merchant, t.last4, t.bank], [32000, 'debit', 'FLIPKART', '4321', 'Axis Bank']);
});

test('credits: salary, refunds, card bill payments', () => {
  let t = p('Credit alert', 'Your A/C XXXXX1234 Credited INR 1,50,000.00 on 01/11/26 -Deposit by transfer from THESTRAL MEDIA.', 'donotreply.sbiatm@alerts.sbi.co.in');
  assert.deepEqual([t.amount, t.type, t.last4, t.bank, t.date], [150000, 'credit', '1234', 'SBI', '2026-11-01']);
  t = p('Refund processed', 'Rs.799.00 refunded to your Kotak Credit Card xx2222 from MYNTRA on 19-11-2026', 'creditcardalerts@kotak.com');
  assert.deepEqual([t.amount, t.type, t.last4], [799, 'credit', '2222']);
  t = p('Payment received', 'Payment of Rs.34,500.00 received on your HDFC Bank Credit Card ending 1234 on 15-11-2026. Thank you.', 'alerts@hdfcbank.net');
  assert.deepEqual([t.amount, t.type, t.last4], [34500, 'credit', '1234']);
});

test('ignores things that are not transactions', () => {
  assert.equal(p('OTP for transaction', 'Your OTP for transaction of Rs 500.00 at AMAZON is 123456. Do not share.'), null);
  assert.equal(p('Payment due reminder', 'Your credit card payment of Rs 34,500 is due on 15 Dec 2026. Minimum amount due Rs 1,725.'), null);
  assert.equal(p('Statement', 'Your HDFC Bank Credit Card statement is ready. Total due Rs 34,500.'), null);
  assert.equal(p('Exclusive offer', 'Get cashback offer of Rs 500 on your next purchase. Apply now!'), null);
  assert.equal(p('Hello', 'No money here.'), null);
});
