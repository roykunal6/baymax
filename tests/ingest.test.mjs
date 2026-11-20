import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.INGEST_SECRET = 'test-secret-123';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.BAYMAX_USER_ID = 'user-1';
const { default: handler } = await import('../netlify/functions/ingest.mjs');

const calls = [];
let keyring = null;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('id=eq.keyring')) return new Response(JSON.stringify(keyring ? [{ data: keyring }] : []));
  calls.push({ url, init });
  return new Response(null, { status: 201 });
};
const post = (body, secret = 'test-secret-123') => handler(new Request('https://x/api/ingest', { method: 'POST', headers: { 'x-baymax-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('rejects a wrong secret', async () => {
  const r = await post({ messages: [] }, 'nope');
  assert.equal(r.status, 401);
});

test('stores parsed transactions, ignores non-transactions, never revives processed ones', async () => {
  calls.length = 0;
  const r = await post({ messages: [
    { id: 'a1', from: 'alerts@hdfcbank.net', subject: 'Alert', body: 'Rs.450.00 spent on HDFC Bank Card x1234 at SWIGGY on 2026-11-20', date: '2026-11-20T10:00:00Z' },
    { id: 'a2', from: 'alerts@hdfcbank.net', subject: 'OTP', body: 'Your OTP for transaction of Rs 500 is 123456' },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { received: 2, transactions: 1, encrypted: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/records\?on_conflict=user_id,coll,id$/);
  assert.match(calls[0].init.headers.prefer, /ignore-duplicates/);
  const rows = JSON.parse(calls[0].init.body);
  assert.deepEqual([rows[0].user_id, rows[0].coll, rows[0].id, rows[0].data.amount, rows[0].data.merchant], ['user-1', 'bankinbox', 'gm-a1', 450, 'SWIGGY']);
});

test('with a keyring, alerts are stored encrypted for the owner only', async () => {
  const { createKeyring, openJSON } = await import('../js/vault.js');
  const k = await createKeyring('mango river 47 window', { rounds: 1000 });
  keyring = k.keyring;
  calls.length = 0;
  const r = await post({ messages: [{ id: 'b1', from: 'alerts@hdfcbank.net', subject: 'Alert', body: 'Rs.450.00 spent on HDFC Bank Card x1234 at SWIGGY on 2026-11-20', date: '2026-11-20T10:00:00Z' }] });
  assert.equal((await r.json()).encrypted, true);
  const row = JSON.parse(calls[0].init.body)[0];
  assert.equal(row.data.e, 2);
  assert.ok(!calls[0].init.body.includes('SWIGGY'));
  const t = await openJSON(k.keys, row.data);
  assert.deepEqual([t.id, t.amount, t.merchant], ['gm-b1', 450, 'SWIGGY']);
  keyring = null;
});
