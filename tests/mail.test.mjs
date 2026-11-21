import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', BAYMAX_USER_ID: 'u1',
  ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csec', ZOHO_DC: 'in',
});
const mod = await import('../netlify/functions/mail.mjs');
const { default: handler, parseAddresses, htmlToText, toSearchKey, cleanRecipients, _resetCache } = mod;
const { b64, randomBytes, sealWithMailKey, openWithMailKey } = await import('../js/vault.js');
const MK = b64(randomBytes(32)), OTHER = b64(randomBytes(32));

let calls, secrets;
const ok = (data) => new Response(JSON.stringify({ status: { code: 200, description: 'success' }, data }), { status: 200 });
beforeEach(async () => {
  calls = []; secrets = { zoho_refresh_token: await sealWithMailKey(MK, 'rt-1') }; _resetCache();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u.href, method, headers: init.headers || {}, body });
    if (u.pathname === '/auth/v1/user') {
      const t = init.headers.authorization;
      if (t === 'Bearer good') return new Response(JSON.stringify({ id: 'u1', email: 'roy.kunal6@gmail.com' }));
      if (t.startsWith('Bearer mfa.')) return new Response(JSON.stringify({ id: 'u1', factors: [{ status: 'verified' }] }));
      return new Response('{}', { status: 401 });
    }
    if (u.pathname === '/rest/v1/secrets') {
      if (method === 'GET') { const n = u.searchParams.get('name').replace('eq.', ''); return new Response(JSON.stringify(secrets[n] ? [{ value: secrets[n] }] : [])); }
      if (method === 'POST') { for (const r of body) secrets[r.name] = r.value; return new Response(null, { status: 201 }); }
      if (method === 'DELETE') { delete secrets.zoho_refresh_token; return new Response(null, { status: 204 }); }
    }
    if (u.host === 'accounts.zoho.in' && u.pathname === '/oauth/v2/token') {
      if (body.grant_type === 'authorization_code') return new Response(JSON.stringify(body.code === 'good-code' ? { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } : { error: 'invalid_code' }));
      return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));
    }
    if (u.host === 'mail.zoho.in') {
      const p = u.pathname;
      if (p === '/api/accounts') return ok([{ accountId: '111', primaryEmailAddress: 'kunal.roy@thestralmedia.com' }]);
      if (p === '/api/accounts/111/folders') return ok([{ folderId: '9001', folderName: 'Inbox', folderType: 'Inbox', path: '/Inbox' }, { folderId: '9002', folderName: 'Sent', folderType: 'Sent', path: '/Sent' }]);
      if (p === '/api/accounts/111/messages/view') return ok([{ messageId: '5', folderId: '9001', subject: 'Invoice', fromAddress: 'ravi@client.com', sender: 'Ravi', toAddress: '&quot;Kunal&quot;&lt;kunal.roy@thestralmedia.com&gt;', ccAddress: 'Not Provided', summary: 'Please find', receivedTime: '1763600000000', status: '0', flagid: 'flag_not_set', hasAttachment: '1' }]);
      if (p.endsWith('/details')) return ok({ subject: 'Invoice', fromAddress: 'ravi@client.com', sender: 'Ravi', toAddress: '&quot;Kunal&quot;&lt;kunal.roy@thestralmedia.com&gt;, anil@client.com', ccAddress: 'meera@client.com', status: '0', receivedTime: '1763600000000' });
      if (p.endsWith('/content')) return ok({ messageId: '5', content: '<div>Hi Kunal,<br>Invoice attached.</div><p>Thanks</p>' });
      return ok({});
    }
    throw new Error('unexpected ' + u.href);
  };
});
const call = async (body, token = 'good', key = MK) => { return handler(new Request('https://x/api/mail', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'x-baymax-mail-key': key } : {}) }, body: JSON.stringify(body) })); };
const zohoCalls = () => calls.filter((c) => c.url.includes('mail.zoho.in'));

test('helpers', () => {
  assert.deepEqual(parseAddresses('&quot;Rebecca&quot;&lt;rebecca@zylker.com&gt;, Paula@Zylker.com'), [{ name: 'Rebecca', email: 'rebecca@zylker.com' }, { name: '', email: 'paula@zylker.com' }]);
  assert.deepEqual(parseAddresses('Not Provided'), []);
  assert.equal(htmlToText('<div>Hi<br>there</div><p>A &amp; B</p>'), 'Hi\nthere\nA & B');
  assert.equal(toSearchKey('ravi@client.com'), 'sender:ravi@client.com');
  assert.equal(toSearchKey('invoice november'), 'entire:invoice november');
  assert.equal(toSearchKey('subject:Bill::has:attachment'), 'subject:Bill::has:attachment');
  assert.throws(() => cleanRecipients('ravi'), /Not a valid email/);
});

test('refuses anyone who is not the signed-in Baymax user', async () => {
  const r = await call({ action: 'list' }, 'stranger');
  assert.equal(r.status, 401);
  assert.equal(zohoCalls().length, 0);
});

test('list inbox uses the refreshed token and Zoho-oauthtoken header', async () => {
  const r = await call({ action: 'list', folder: 'inbox', unread: true });
  const { messages } = await r.json();
  assert.equal(messages[0].from.email, 'ravi@client.com');
  assert.equal(messages[0].unread, true);
  assert.equal(messages[0].hasAttachment, true);
  const view = zohoCalls().find((c) => c.url.includes('/messages/view'));
  assert.equal(new URL(view.url).searchParams.get('folderId'), '9001');
  assert.equal(new URL(view.url).searchParams.get('status'), 'unread');
  assert.equal(view.headers.authorization, 'Zoho-oauthtoken at-1');
});

test('read returns text and marks as read', async () => {
  const r = await (await call({ action: 'read', folderId: '9001', messageId: '5' })).json();
  assert.equal(r.text, 'Hi Kunal,\nInvoice attached.\nThanks');
  assert.ok(zohoCalls().some((c) => c.url.endsWith('/updatemessage') && c.body.mode === 'markAsRead'));
});

test('send, reply-all, forward, archive, delete', async () => {
  await call({ action: 'send', to: 'ravi@client.com', subject: 'Hello', content: 'Hi' });
  let c = zohoCalls().find((x) => x.method === 'POST' && x.url.endsWith('/accounts/111/messages'));
  assert.deepEqual(c.body, { fromAddress: 'kunal.roy@thestralmedia.com', toAddress: 'ravi@client.com', subject: 'Hello', content: 'Hi', mailFormat: 'plaintext' });

  calls.length = 0;
  const rep = await (await call({ action: 'reply', folderId: '9001', messageId: '5', content: 'Thanks!', all: true })).json();
  c = zohoCalls().find((x) => x.method === 'POST' && x.url.endsWith('/messages/5'));
  assert.equal(c.body.action, 'reply');
  assert.equal(c.body.subject, 'Re: Invoice');
  assert.equal(rep.to, 'ravi@client.com,anil@client.com'); // never replies to yourself
  assert.equal(rep.cc, 'meera@client.com');

  calls.length = 0;
  await call({ action: 'forward', folderId: '9001', messageId: '5', to: 'ca@firm.com', content: 'FYI' });
  c = zohoCalls().find((x) => x.method === 'POST');
  assert.equal(c.body.subject, 'Fwd: Invoice');
  assert.match(c.body.content, /^FYI\n\n---------- Forwarded message ----------[\s\S]*Invoice attached/);

  calls.length = 0;
  await call({ action: 'update', mode: 'archiveMails', messageIds: ['5'] });
  assert.deepEqual(zohoCalls().find((x) => x.method === 'PUT').body, { mode: 'archiveMails', messageId: ['5'] });

  calls.length = 0;
  await call({ action: 'delete', folderId: '9001', messageId: '5' });
  c = zohoCalls().find((x) => x.method === 'DELETE');
  assert.match(c.url, /\/folders\/9001\/messages\/5\?expunge=false$/);
});

test('reply sends exactly the recipients edited on screen, including Bcc', async () => {
  await call({ action: 'reply', folderId: '9001', messageId: '5', content: 'Noted', all: true, to: 'ravi@client.com', cc: 'meera@client.com, boss@thestralmedia.com', bcc: 'archive@thestralmedia.com' });
  const c = zohoCalls().find((x) => x.method === 'POST' && x.url.endsWith('/messages/5'));
  assert.deepEqual([c.body.toAddress, c.body.ccAddress, c.body.bccAddress], ['ravi@client.com', 'meera@client.com,boss@thestralmedia.com', 'archive@thestralmedia.com']);
  const bad = await call({ action: 'reply', folderId: '9001', messageId: '5', content: 'x', to: 'not-an-email' });
  assert.equal(bad.status, 400);
});

test('connect exchanges the Self Client code and stores the refresh token server-side', async () => {
  secrets = {};
  let r = await call({ action: 'connect', code: 'expired' });
  assert.equal(r.status, 400);
  r = await (await call({ action: 'connect', code: 'good-code' })).json();
  assert.deepEqual(r, { connected: true, email: 'kunal.roy@thestralmedia.com' });
  assert.match(secrets.zoho_refresh_token, /^enc1:/, 'stored encrypted');
  assert.equal(await openWithMailKey(MK, secrets.zoho_refresh_token), 'rt-new');
  const ex = calls.find((x) => x.body?.grant_type === 'authorization_code');
  assert.deepEqual([ex.body.client_id, ex.body.client_secret], ['cid', 'csec']);
});

test('not connected → clear message', async () => {
  secrets = {};
  const r = await call({ action: 'list' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'not_connected');
});

test('mail key: required, must match, plain tokens get encrypted, cached token not reused with a wrong key', async () => {
  let r = await call({ action: 'list' }, 'good', null);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'locked');
  assert.equal(calls.filter((c) => c.url.includes('zoho')).length, 0);

  assert.equal((await call({ action: 'list' })).status, 200); // warms the access-token cache
  r = await call({ action: 'list' }, 'good', OTHER);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'bad_mail_key');

  secrets.zoho_refresh_token = 'rt-plain'; _resetCache();
  assert.equal((await call({ action: 'status' })).status, 200);
  assert.match(secrets.zoho_refresh_token, /^enc1:/);
  assert.equal(await openWithMailKey(MK, secrets.zoho_refresh_token), 'rt-plain');
});

test('two-step on: an aal1 session is refused, aal2 is allowed', async () => {
  const jwt = (aal) => `mfa.${Buffer.from(JSON.stringify({ aal })).toString('base64url')}.sig`;
  let r = await call({ action: 'list' }, jwt('aal1'));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'mfa_required');
  r = await call({ action: 'list' }, jwt('aal2'));
  assert.equal(r.status, 200);
});

test('triage reads emails without marking them read and returns task suggestions', async () => {
  const realNow = Date.now;
  Date.now = () => 1763600000000 + 86400000; // a day after the sample email
  let r;
  try { r = await (await call({ action: 'triage' })).json(); } finally { Date.now = realNow; }
  assert.ok(Array.isArray(r.items) && Array.isArray(r.replied) && Array.isArray(r.examined));
  assert.ok(calls.some((c) => /\/messages\/5\/content$/.test(c.url)), 'reads the text');
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'never marks as read');
  assert.ok(calls.some((c) => c.url.includes('folderId=9002')), 'checks Sent for replies');
});
