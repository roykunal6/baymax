// POST /api/mail — Zoho Mail for Baymax (kunal.roy@thestralmedia.com).
// Only the signed-in Baymax user can call it: every request must carry their Supabase access
// token, which is checked with Supabase before anything touches the mailbox.
// The Zoho refresh token lives in the Supabase `secrets` table (server-only), never in the app,
// and it is stored encrypted with the user's mail key. The mail key is only on the user's unlocked
// devices and is sent with each request (x-baymax-mail-key); the server uses it in memory only.
// Without it, a copy of the database (or the server alone) cannot reach the mailbox.
//
// Env (Netlify → Site configuration → Environment variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, BAYMAX_USER_ID
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET   from Zoho API Console → Self Client (your main mailbox)
//   ZOHO_WEB_CLIENT_ID, ZOHO_WEB_CLIENT_SECRET  Server-based client (Multi-DC on) for "Add mailbox";
//                                        redirect URI https://<site>/api/mail/callback
//
// Mailboxes: "primary" is the Self Client one (secret zoho_refresh_token). Others added with Add mailbox
// are kept in secret zoho_mailboxes: one JSON list, encrypted with your mail key.
//   ZOHO_DC                              data centre: "in" (India, default), "com", "eu", "com.au", …
//
// Zoho Mail API reference: https://www.zoho.com/mail/help/api/

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const env = () => process.env;
const dc = () => env().ZOHO_DC || 'in';
const MAIL = () => `https://mail.zoho.${dc()}/api`;
const ACCOUNTS = () => `https://accounts.zoho.${dc()}`;

import { createHash, randomUUID } from 'node:crypto';
const SCOPES = 'ZohoMail.accounts.READ,ZohoMail.folders.ALL,ZohoMail.messages.ALL';
const redirectUri = (r) => { const u = String(r || ''); return /^https:\/\/[a-z0-9.-]+(:\d+)?\/api\/mail\/callback$/i.test(u) ? u : 'https://mybaymax.netlify.app/api/mail/callback'; };
import { sealWithMailKey, openWithMailKey } from '../../js/vault.js';
import { triageMessages, isPersonMessage } from '../../js/mailtriage.js';
const keyHash = (k) => createHash('sha256').update(String(k)).digest('hex');
// The mail key for the request being handled (each invocation handles one request at a time).
let reqKey = null;

// ---------------------------------------------------------------- helpers (exported for tests)
export function decodeEntities(s) {
  return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** '"Rebecca" <rebecca@x.com>, paula@x.com' (possibly HTML-escaped) → [{name, email}] */
export function parseAddresses(s) {
  const text = decodeEntities(s);
  if (!text || /^not provided$/i.test(text.trim())) return [];
  const out = [];
  const re = /(?:"?([^"<,]*?)"?\s*<([^>]+)>|([^\s,<>"]+@[^\s,<>"]+))/g;
  let m;
  while ((m = re.exec(text))) out.push({ name: (m[1] || '').trim(), email: (m[2] || m[3]).trim().toLowerCase() });
  return out;
}

export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const isEmail = (s) => /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(String(s).trim());
export function cleanRecipients(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
  const bad = arr.filter((x) => !isEmail(x));
  if (bad.length) throw Object.assign(new Error(`Not a valid email address: ${bad.join(', ')}`), { status: 400 });
  return arr.join(',');
}

/** Turn plain words into Zoho search syntax. Already-structured keys pass through. */
export function toSearchKey(q) {
  const t = String(q || '').trim();
  if (/^(entire|sender|from|to|subject|content|has|in|newMails)\b|::/.test(t)) return t;
  if (isEmail(t) || /^@?[\w-]+\.[\w.]+$/.test(t)) return `sender:${t.replace(/^@/, '')}`;
  return `entire:${t}`;
}

// ---------------------------------------------------------------- Supabase (auth + secrets)
async function verifyUser(req) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const r = await fetch(`${env().SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env().SUPABASE_ANON_KEY, authorization: auth } });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user?.id || user.id !== env().BAYMAX_USER_ID) return null;
  // Two-step sign-in: once turned on, a session that hasn't passed the code step can't use Mail.
  if ((user.factors || []).some((f) => f.status === 'verified') && jwtClaims(auth).aal !== 'aal2') return { ...user, needsCode: true };
  return user;
}
function jwtClaims(auth) {
  try { return JSON.parse(Buffer.from(auth.split(/\s+/)[1].split('.')[1], 'base64url').toString()); } catch { return {}; }
}

const svc = () => ({ apikey: env().SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env().SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' });
async function getSecret(name) {
  const r = await fetch(`${env().SUPABASE_URL}/rest/v1/secrets?name=eq.${encodeURIComponent(name)}&select=value`, { headers: svc() });
  if (!r.ok) throw new Error(`Couldn’t read settings (${r.status})`);
  const rows = await r.json();
  return rows[0]?.value || null;
}
async function setSecret(name, value) {
  const r = await fetch(`${env().SUPABASE_URL}/rest/v1/secrets?on_conflict=name`, {
    method: 'POST', headers: { ...svc(), prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ name, value, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error(`Couldn’t save settings (${r.status})`);
}
async function deleteSecret(name) {
  await fetch(`${env().SUPABASE_URL}/rest/v1/secrets?name=eq.${encodeURIComponent(name)}`, { method: 'DELETE', headers: svc() });
}

// ---------------------------------------------------------------- Zoho tokens + account
const caches = {};
const fresh = () => ({ token: null, exp: 0, keyHash: null, accountId: null, email: null, folders: null });
export function _resetCache(id) { if (id) caches[id] = fresh(); else for (const k of Object.keys(caches)) delete caches[k]; }
// The mailbox this request is about (one request at a time per server instance, like reqKey).
let reqBox = null;
const PRIMARY = () => ({ id: 'primary', client: 'self', accountsServer: ACCOUNTS(), mailBase: MAIL() });
const C = () => (caches[reqBox?.id || 'primary'] ||= fresh());
const clientFor = (box) => (box.client === 'web'
  ? { id: env().ZOHO_WEB_CLIENT_ID, secret: env().ZOHO_WEB_CLIENT_SECRET }
  : { id: env().ZOHO_CLIENT_ID, secret: env().ZOHO_CLIENT_SECRET });

/** Zoho's accounts servers per region; anything else is refused (the code exchange sends our client secret). */
export const ZOHO_ACCOUNTS = /^https:\/\/accounts\.(zoho\.(com|in|eu|com\.au|jp|uk|sa|com\.cn)|zohocloud\.ca)$/;

async function loadBoxes() {
  const raw = await getSecret('zoho_mailboxes');
  if (!raw) return [];
  try { return JSON.parse(await openWithMailKey(reqKey, raw)); } catch {
    throw Object.assign(new Error('This device’s keys don’t match. Lock and unlock Baymax again.'), { status: 403, code: 'bad_mail_key' });
  }
}
async function saveBoxes(list) {
  if (!list.length) return deleteSecret('zoho_mailboxes');
  await setSecret('zoho_mailboxes', await sealWithMailKey(reqKey, JSON.stringify(list)));
}
async function resolveBox(id) {
  if (!id || id === 'primary') return PRIMARY();
  const box = (await loadBoxes()).find((b) => b.id === id);
  if (!box) throw Object.assign(new Error('That mailbox isn’t connected any more.'), { status: 404, code: 'no_mailbox' });
  return box;
}

/** The refresh token, decrypted with this request's mail key. A wrong key is refused. Old plain tokens are encrypted now. */
async function refreshToken() {
  const stored = await getSecret('zoho_refresh_token');
  if (!stored) return null;
  if (!String(stored).startsWith('enc1:')) {
    await setSecret('zoho_refresh_token', await sealWithMailKey(reqKey, stored));
    return stored;
  }
  try { return await openWithMailKey(reqKey, stored); } catch {
    throw Object.assign(new Error('This device’s keys don’t match. Lock and unlock Baymax again.'), { status: 403, code: 'bad_mail_key' });
  }
}

async function accessToken() {
  // A token cached in this warm server instance is only reused for a request carrying the same mail key.
  const cache = C(), box = reqBox || PRIMARY();
  if (cache.token && cache.keyHash === keyHash(reqKey) && Date.now() < cache.exp - 60000) return cache.token;
  const refresh = box.id === 'primary' ? await refreshToken() : box.refresh;
  if (!refresh) throw Object.assign(new Error('Zoho Mail isn’t connected yet.'), { status: 409, code: 'not_connected' });
  const cl = clientFor(box);
  const body = new URLSearchParams({ refresh_token: refresh, grant_type: 'refresh_token', client_id: cl.id, client_secret: cl.secret });
  const r = await fetch(`${box.accountsServer}/oauth/v2/token`, { method: 'POST', body });
  const data = await r.json().catch(() => ({}));
  if (!data.access_token) throw Object.assign(new Error('Zoho refused the saved connection. Reconnect Zoho Mail in Baymax.'), { status: 409, code: 'not_connected' });
  cache.token = data.access_token;
  cache.keyHash = keyHash(reqKey);
  cache.exp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return cache.token;
}

async function zoho(path, { method = 'GET', query, body } = {}) {
  const url = new URL(`${(reqBox || PRIMARY()).mailBase}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method,
    headers: { authorization: `Zoho-oauthtoken ${await accessToken()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (data.status && data.status.code >= 400)) {
    const msg = data?.data?.moreInfo || data?.status?.description || `Zoho error ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status === 401 ? 409 : 502 });
  }
  return data.data;
}

async function account() {
  const cache = C();
  if (cache.accountId) return cache;
  const list = await zoho('/accounts');
  const acc = (list || [])[0];
  if (!acc) throw new Error('No Zoho Mail account found.');
  cache.accountId = acc.accountId;
  cache.email = acc.primaryEmailAddress || acc.mailboxAddress || acc.emailAddress?.find((e) => e.isPrimary)?.mailId;
  return cache;
}

async function folders() {
  const cache = C();
  if (cache.folders) return cache.folders;
  const { accountId } = await account();
  cache.folders = (await zoho(`/accounts/${accountId}/folders`)).map((f) => ({ folderId: String(f.folderId), name: f.folderName, type: f.folderType, path: f.path }));
  return cache.folders;
}

async function folderId(nameOrId) {
  if (!nameOrId) nameOrId = 'inbox';
  if (/^\d+$/.test(String(nameOrId))) return String(nameOrId);
  const want = String(nameOrId).toLowerCase();
  const f = (await folders()).find((x) => (x.type || '').toLowerCase() === want || (x.name || '').toLowerCase() === want);
  if (!f) throw Object.assign(new Error(`No folder called “${nameOrId}”.`), { status: 404 });
  return f.folderId;
}

function summarise(m) {
  const from = parseAddresses(m.fromAddress)[0] || { email: decodeEntities(m.fromAddress), name: '' };
  return {
    messageId: String(m.messageId), folderId: String(m.folderId), threadId: m.threadId ? String(m.threadId) : null,
    from: { name: decodeEntities(m.sender) || from.name, email: from.email },
    to: parseAddresses(m.toAddress), cc: parseAddresses(m.ccAddress),
    subject: decodeEntities(m.subject) || '(no subject)', summary: decodeEntities(m.summary),
    time: Number(m.receivedTime || m.receivedtime || m.sentDateInGMT) || null,
    unread: String(m.status) === '0' || m.status === 'unread',
    flagged: m.flagid && !/flag_not_set|^0$/.test(String(m.flagid)),
    hasAttachment: String(m.hasAttachment) === '1' || m.hasAttachment === 1,
  };
}

// ---------------------------------------------------------------- actions
const actions = {
  async status() {
    const boxes = await loadBoxes();
    const list = [];
    if (await refreshToken()) {
      reqBox = PRIMARY();
      try { list.push({ id: 'primary', email: (await account()).email }); } catch (e) { list.push({ id: 'primary', email: null, error: e.message }); }
    }
    for (const b of boxes) list.push({ id: b.id, email: b.email });
    reqBox = null;
    const canAdd = !!(env().ZOHO_WEB_CLIENT_ID && env().ZOHO_WEB_CLIENT_SECRET);
    if (!list.length) return { connected: false, dc: dc(), mailboxes: [], canAdd };
    return { connected: true, email: list[0].email, dc: dc(), mailboxes: list, canAdd };
  },

  /** Add mailbox, step 1: where to send you to sign in to Zoho. `state` is checked by the app on return. */
  async addStart({ state, redirect }) {
    if (!env().ZOHO_WEB_CLIENT_ID || !env().ZOHO_WEB_CLIENT_SECRET) throw Object.assign(new Error('Adding mailboxes isn’t set up on the server yet (ZOHO_WEB_CLIENT_ID / ZOHO_WEB_CLIENT_SECRET).'), { status: 503, code: 'web_not_configured' });
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(state || ''))) throw Object.assign(new Error('Bad request'), { status: 400 });
    // Start at the client's home data centre; Zoho sends each account on to its own region.
    const u = new URL(`${ACCOUNTS()}/oauth/v2/auth`);
    u.search = new URLSearchParams({ scope: SCOPES, client_id: env().ZOHO_WEB_CLIENT_ID, response_type: 'code', access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri(redirect), state }).toString();
    return { url: u.href };
  },

  /** Add mailbox, step 2: exchange the code Zoho sent back; store the mailbox encrypted. */
  async addFinish({ code, accountsServer, redirect }) {
    const server = String(accountsServer || 'https://accounts.zoho.com').replace(/\/+$/, '');
    if (!ZOHO_ACCOUNTS.test(server)) throw Object.assign(new Error('Unexpected Zoho sign-in server.'), { status: 400 });
    if (!code) throw Object.assign(new Error('Zoho didn’t send a code. Try Add mailbox again.'), { status: 400 });
    const body = new URLSearchParams({ code: String(code), grant_type: 'authorization_code', client_id: env().ZOHO_WEB_CLIENT_ID, client_secret: env().ZOHO_WEB_CLIENT_SECRET, redirect_uri: redirectUri(redirect) });
    const r = await fetch(`${server}/oauth/v2/token`, { method: 'POST', body });
    const data = await r.json().catch(() => ({}));
    if (!data.refresh_token) throw Object.assign(new Error(data.error === 'invalid_code' ? 'That sign-in expired. Tap Add mailbox again.' : `Zoho said: ${data.error || r.status}`), { status: 400 });
    const box = { id: `mb-${randomUUID().slice(0, 8)}`, client: 'web', accountsServer: server, mailBase: `${server.replace('://accounts.', '://mail.')}/api`, refresh: data.refresh_token };
    reqBox = box;
    Object.assign(C(), { token: data.access_token, keyHash: keyHash(reqKey), exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    box.email = (await account()).email;
    // The old main connection goes if it's this same mailbox, or if Zoho no longer accepts it.
    if (await getSecret('zoho_refresh_token')) {
      reqBox = PRIMARY();
      let drop = false;
      try { drop = ((await account()).email || '').toLowerCase() === (box.email || '').toLowerCase(); } catch (e) { drop = e.code === 'not_connected'; }
      if (drop) { await deleteSecret('zoho_refresh_token'); _resetCache('primary'); }
      reqBox = box;
    }
    const boxes = (await loadBoxes()).filter((b) => (b.email || '').toLowerCase() !== (box.email || '').toLowerCase());
    boxes.push(box);
    await saveBoxes(boxes);
    return { mailbox: { id: box.id, email: box.email } };
  },

  /** Disconnect one mailbox (Zoho is told to forget Baymax's access). */
  async removeMailbox({ mailbox }) {
    if (!mailbox || mailbox === 'primary') { reqBox = PRIMARY(); return actions.disconnect(); }
    const boxes = await loadBoxes();
    const box = boxes.find((b) => b.id === mailbox);
    if (box) await fetch(`${box.accountsServer}/oauth/v2/token/revoke?token=${encodeURIComponent(box.refresh)}`, { method: 'POST' }).catch(() => {});
    await saveBoxes(boxes.filter((b) => b.id !== mailbox));
    _resetCache(mailbox);
    return { removed: true };
  },

  /** Exchange a Self Client grant code for a refresh token and save it. */
  async connect({ code }) {
    if (!code) throw Object.assign(new Error('Paste the code from Zoho’s Self Client.'), { status: 400 });
    const body = new URLSearchParams({ code: String(code).trim(), grant_type: 'authorization_code', client_id: env().ZOHO_CLIENT_ID, client_secret: env().ZOHO_CLIENT_SECRET });
    const r = await fetch(`${ACCOUNTS()}/oauth/v2/token`, { method: 'POST', body });
    const data = await r.json().catch(() => ({}));
    if (!data.refresh_token) {
      const why = data.error === 'invalid_code' ? 'That code has expired or was already used. Generate a new one (codes last a few minutes).' : `Zoho said: ${data.error || r.status}`;
      throw Object.assign(new Error(why), { status: 400 });
    }
    await setSecret('zoho_refresh_token', await sealWithMailKey(reqKey, data.refresh_token));
    _resetCache('primary');
    Object.assign(C(), { token: data.access_token, keyHash: keyHash(reqKey), exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    const a = await account();
    return { connected: true, email: a.email };
  },

  async disconnect() {
    const refresh = await refreshToken().catch(() => null);
    if (refresh) await fetch(`${ACCOUNTS()}/oauth/v2/token/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
    await deleteSecret('zoho_refresh_token');
    _resetCache('primary');
    return { connected: false };
  },

  async folders() { return { folders: await folders() }; },

  async list({ folder = 'inbox', unread = false, start = 1, limit = 25 }) {
    const { accountId } = await account();
    const fid = await folderId(folder);
    const data = await zoho(`/accounts/${accountId}/messages/view`, { query: { folderId: fid, start, limit: Math.min(Number(limit) || 25, 100), status: unread ? 'unread' : 'all', sortorder: false } });
    return { messages: (data || []).map(summarise) };
  },

  async search({ q, start = 1, limit = 25 }) {
    const { accountId } = await account();
    const data = await zoho(`/accounts/${accountId}/messages/search`, { query: { searchKey: toSearchKey(q), start, limit: Math.min(Number(limit) || 25, 100), receivedTime: Date.now() } });
    return { messages: (data || []).map(summarise) };
  },

  async read({ folderId: fid, messageId, markRead = true }) {
    const { accountId } = await account();
    const base = `/accounts/${accountId}/folders/${fid}/messages/${messageId}`;
    const [details, content] = await Promise.all([zoho(`${base}/details`), zoho(`${base}/content`)]);
    if (markRead) await zoho(`/accounts/${accountId}/updatemessage`, { method: 'PUT', body: { mode: 'markAsRead', messageId: [messageId] } }).catch(() => {});
    const html = content?.content || '';
    return { message: { ...summarise({ ...details, messageId, folderId: fid }), unread: false }, html, text: htmlToText(html) };
  },

  async send({ to, cc, bcc, subject = '', content = '' }) {
    const { accountId, email } = await account();
    const body = { fromAddress: email, toAddress: cleanRecipients(to), subject, content: String(content), mailFormat: 'plaintext' };
    if (cc) body.ccAddress = cleanRecipients(cc);
    if (bcc) body.bccAddress = cleanRecipients(bcc);
    if (!body.toAddress) throw Object.assign(new Error('Add at least one recipient.'), { status: 400 });
    await zoho(`/accounts/${accountId}/messages`, { method: 'POST', body });
    return { sent: true };
  },

  /** Reply. If to/cc/bcc are given (as edited on screen) they are used exactly; otherwise they're
   *  worked out from the original: the sender, plus for reply-all everyone on To and Cc, never yourself. */
  async reply({ messageId, folderId: fid, content = '', all = false, to: toIn, cc: ccIn, bcc: bccIn }) {
    const { accountId, email } = await account();
    const details = summarise({ ...(await zoho(`/accounts/${accountId}/folders/${fid}/messages/${messageId}/details`)), messageId, folderId: fid });
    const me = (email || '').toLowerCase();
    let to = [details.from.email, ...(all ? details.to.map((x) => x.email) : [])].filter((e) => e && e !== me);
    let cc = all ? details.cc.map((x) => x.email).filter((e) => e !== me && !to.includes(e)) : [];
    if (toIn !== undefined) to = cleanRecipients(toIn).split(',').filter(Boolean);
    if (ccIn !== undefined) cc = cleanRecipients(ccIn).split(',').filter(Boolean);
    if (!to.length) throw Object.assign(new Error('Add at least one recipient.'), { status: 400 });
    const subject = /^re:/i.test(details.subject) ? details.subject : `Re: ${details.subject}`;
    const body = { fromAddress: email, toAddress: [...new Set(to)].join(','), subject, content: String(content), mailFormat: 'plaintext', action: 'reply' };
    if (cc.length) body.ccAddress = [...new Set(cc)].join(',');
    if (bccIn) body.bccAddress = cleanRecipients(bccIn);
    await zoho(`/accounts/${accountId}/messages/${messageId}`, { method: 'POST', body });
    return { sent: true, to: body.toAddress, cc: body.ccAddress || '' };
  },

  /** Forward: a new email with the original text quoted (attachments are not forwarded). */
  async forward({ messageId, folderId: fid, to, cc, bcc, content = '' }) {
    const { accountId, email } = await account();
    const base = `/accounts/${accountId}/folders/${fid}/messages/${messageId}`;
    const [d, c] = await Promise.all([zoho(`${base}/details`), zoho(`${base}/content`)]);
    const m = summarise({ ...d, messageId, folderId: fid });
    const quoted = `\n\n---------- Forwarded message ----------\nFrom: ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}\nDate: ${m.time ? new Date(m.time).toUTCString() : ''}\nSubject: ${m.subject}\nTo: ${m.to.map((x) => x.email).join(', ')}\n\n${htmlToText(c?.content || '')}`;
    const body = { fromAddress: email, toAddress: cleanRecipients(to), subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, content: String(content) + quoted, mailFormat: 'plaintext' };
    if (cc) body.ccAddress = cleanRecipients(cc);
    if (bcc) body.bccAddress = cleanRecipients(bcc);
    await zoho(`/accounts/${accountId}/messages`, { method: 'POST', body });
    return { sent: true };
  },

  /** mode: markAsRead | markAsUnread | archiveMails | moveMessage | setFlag */
  async update({ mode, messageIds, destination, flag = 'important' }) {
    const allowed = ['markAsRead', 'markAsUnread', 'archiveMails', 'moveMessage', 'setFlag'];
    if (!allowed.includes(mode)) throw Object.assign(new Error('Unknown change'), { status: 400 });
    const { accountId } = await account();
    const body = { mode, messageId: (Array.isArray(messageIds) ? messageIds : [messageIds]).map(String) };
    if (mode === 'moveMessage') body.destfolderId = await folderId(destination);
    if (mode === 'setFlag') body.flagid = ['info', 'important', 'followup', 'flag_not_set'].includes(flag) ? flag : 'important';
    await zoho(`/accounts/${accountId}/updatemessage`, { method: 'PUT', body });
    return { ok: true };
  },

  /** Emails that need something from you → task suggestions. Reads text without marking anything read.
   *  skip: message ids already handled (their text isn't fetched again). */
  async triage({ days = 14, skip = [] }) {
    const { accountId, email } = await account();
    const [inboxId, sentId] = await Promise.all([folderId('inbox'), folderId('sent')]);
    const view = (fid) => zoho(`/accounts/${accountId}/messages/view`, { query: { folderId: fid, start: 1, limit: 100, status: 'all', sortorder: false } });
    const [inRaw, sentRaw] = await Promise.all([view(inboxId), view(sentId)]);
    const since = Date.now() - Math.min(Number(days) || 14, 60) * 864e5;
    const inbox = (inRaw || []).map(summarise).filter((m) => m.time && m.time >= since);
    const sent = (sentRaw || []).map(summarise);
    const done = new Set((Array.isArray(skip) ? skip : []).map(String));
    const toRead = inbox.filter((m) => !done.has(m.messageId) && isPersonMessage(m, email)).slice(0, 15);
    await Promise.all(toRead.map(async (m) => {
      try { m.text = htmlToText((await zoho(`/accounts/${accountId}/folders/${m.folderId}/messages/${m.messageId}/content`))?.content || '').slice(0, 6000); } catch { /* use the summary */ }
    }));
    const people = inbox.filter((m) => isPersonMessage(m, email)).length;
    return { ...triageMessages({ inbox, sent, me: email, days }), stats: { mailbox: email, checked: inbox.length, fromPeople: people, ignored: inbox.length - people } };
  },

  /** Moves to Trash (Zoho keeps it there; nothing is permanently deleted). */
  async delete({ folderId: fid, messageId }) {
    const { accountId } = await account();
    await zoho(`/accounts/${accountId}/folders/${fid}/messages/${messageId}`, { method: 'DELETE', query: { expunge: false } });
    return { deleted: true };
  },
};

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY || !e.SUPABASE_SERVICE_ROLE_KEY || !e.BAYMAX_USER_ID || !e.ZOHO_CLIENT_ID || !e.ZOHO_CLIENT_SECRET) {
    return json(503, { error: 'Zoho Mail isn’t set up on the server yet.', code: 'not_configured' });
  }
  const user = await verifyUser(req);
  if (!user) return json(401, { error: 'Please sign in to Baymax again.' });
  if (user.needsCode) return json(401, { error: 'Enter your two-step code to use Mail. Close and reopen Baymax.', code: 'mfa_required' });
  const mk = req.headers.get('x-baymax-mail-key') || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(mk)) return json(403, { error: 'Unlock Baymax to use Mail.', code: 'locked' });
  reqKey = mk;
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Send JSON' }); }
  const fn = actions[body?.action];
  if (!fn) return json(400, { error: 'Unknown action' });
  try {
    const global = ['status', 'addStart', 'addFinish', 'removeMailbox', 'connect', 'disconnect'];
    reqBox = global.includes(body.action) ? PRIMARY() : await resolveBox(body.mailbox);
    const out = await fn(body);
    return json(200, body.mailbox && !global.includes(body.action) ? { ...out, mailbox: reqBox.id } : out);
  } catch (err) {
    return json(err.status || 500, { error: err.message || 'Something went wrong', code: err.code });
  } finally {
    reqKey = null;
    reqBox = null;
  }
};

export const config = { path: '/api/mail' };
