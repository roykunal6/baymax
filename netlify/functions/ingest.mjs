// POST /api/ingest — receives bank/card alert emails from the Gmail Apps Script
// (tools/gmail-bank-alerts.gs), reads the transactions, and stores them in the user's synced
// "bankinbox" list. Baymax then turns each into a spend, or marks an EMI/SIP/card bill paid.
//
// End-to-end encryption: each transaction is encrypted with the user's public key (from their
// keyring) before it is stored. The server cannot read it back; only the user's devices can.
//
// Env (Netlify → Site configuration → Environment variables):
//   INGEST_SECRET              long random string; the Apps Script sends it in x-baymax-secret
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  server-only key (never in the app)
//   BAYMAX_USER_ID             the Supabase user id whose data this is
//   TRACKED_ACCOUNTS           optional, e.g. "axis:1234,hdfc:5678": only these accounts/cards are kept
//   SELF_NAMES                 optional, e.g. "kunal roy,roy kunal": transfers to/from you aren't spends or income

import { timingSafeEqual } from 'node:crypto';
import { parseAlert, isTrackedAccount, isSelfTransfer } from '../../js/bankparse.js';
import { sealForPublicKey } from '../../js/vault.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  // Switched off: spends now come from monthly statement uploads. Set BANK_ALERTS=on to re-enable.
  if (process.env.BANK_ALERTS !== 'on') return json(410, { error: 'Bank alerts are switched off in Baymax. Delete this Apps Script project or its trigger.' });
  const env = process.env;
  if (!env.INGEST_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.BAYMAX_USER_ID) {
    return json(503, { error: 'Bank alerts are not set up on the server yet' });
  }
  if (!sameSecret(req.headers.get('x-baymax-secret'), env.INGEST_SECRET)) return json(401, { error: 'Wrong secret' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Send JSON' }); }
  const messages = Array.isArray(body?.messages) ? body.messages.slice(0, 200) : [];
  const parsed = messages.map((m) => { try { return parseAlert(m); } catch { return null; } }).filter(Boolean);
  const txns = parsed.filter((t) => isTrackedAccount(t, env.TRACKED_ACCOUNTS))
    .map((t) => (isSelfTransfer(t, { selfNames: env.SELF_NAMES, accounts: env.TRACKED_ACCOUNTS }) ? { ...t, self: true } : t));
  const ignored = parsed.length - txns.length;
  if (!txns.length) return json(200, { received: messages.length, transactions: 0, ignored });

  const sb = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  let publicKey = null;
  const kr = await fetch(`${env.SUPABASE_URL}/rest/v1/records?user_id=eq.${encodeURIComponent(env.BAYMAX_USER_ID)}&coll=eq.doc&id=eq.keyring&select=data`, { headers: sb });
  if (!kr.ok) return json(502, { error: `Database unavailable (${kr.status})` });
  publicKey = (await kr.json())[0]?.data?.publicKey || null;

  const now = new Date().toISOString();
  const rows = await Promise.all(txns.map(async (t) => {
    const id = `gm-${t.id}`;
    const data = publicKey ? await sealForPublicKey(publicKey, { ...t, id }) : { ...t, id };
    return { user_id: env.BAYMAX_USER_ID, coll: 'bankinbox', id, data, deleted: false, updated_at: now };
  }));
  // ignore-duplicates: an alert already processed (and removed from the inbox) is never re-added.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/records?on_conflict=user_id,coll,id`, {
    method: 'POST',
    headers: {
      ...sb,
      'content-type': 'application/json',
      prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) return json(502, { error: `Database refused the alerts (${res.status})` });
  return json(200, { received: messages.length, transactions: txns.length, ignored, encrypted: !!publicKey });
};

export const config = { path: '/api/ingest' };
