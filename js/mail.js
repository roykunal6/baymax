// Mail tab and email voice commands, backed by /api/mail (Zoho Mail via Netlify function).
// Sending and deleting always go through a screen you confirm.

import { cloud } from './cloud.js';
import { openSheet } from './sheet.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toast = () => {};

// ---------------------------------------------------------------- API
export async function mailApi(action, params = {}) {
  if (!cloud.client) throw Object.assign(new Error('Mail needs cloud sign-in, which isn’t set up yet.'), { code: 'no_cloud' });
  const { data } = await cloud.client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw Object.assign(new Error('Please sign in again.'), { code: 'signed_out' });
  let r;
  try {
    r = await fetch('/api/mail', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action, ...params }) });
  } catch {
    throw Object.assign(new Error('No internet connection.'), { code: 'offline' });
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `Mail error ${r.status}`), { code: body.code || r.status });
  return body;
}

// ---------------------------------------------------------------- view state
const view = { status: null, folder: 'inbox', unread: false, q: '', messages: [], loading: false, error: null, start: 1, more: false };
let el = null;
const FOLDERS = [['inbox', 'Inbox'], ['unread', 'Unread'], ['sent', 'Sent'], ['archive', 'Archive'], ['trash', 'Trash']];

const when = (t) => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export function initMail(container, toastFn) {
  el = container;
  toast = toastFn;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
}

export async function showMail() {
  if (!el) return;
  if (!view.status) await loadStatus();
  render();
  if (view.status?.connected && !view.messages.length && !view.loading) loadList();
}

async function loadStatus() {
  try { view.status = await mailApi('status'); view.error = null; } catch (e) { view.status = { connected: false }; view.error = e; }
}

async function loadList({ append = false } = {}) {
  view.loading = true;
  if (!append) { view.start = 1; }
  render();
  try {
    const limit = 25;
    const r = view.q
      ? await mailApi('search', { q: view.q, start: view.start, limit })
      : await mailApi('list', { folder: view.folder === 'unread' ? 'inbox' : view.folder, unread: view.folder === 'unread', start: view.start, limit });
    view.messages = append ? view.messages.concat(r.messages) : r.messages;
    view.more = r.messages.length === limit;
    view.error = null;
  } catch (e) { view.error = e; }
  view.loading = false;
  render();
}

function render() {
  if (!el) return;
  const s = view.status;
  const head = `<div class="page-head"><h1>Mail</h1>${s?.connected ? `<button class="btn primary small" data-act="compose">✎ Compose</button>` : ''}</div>`;
  if (!s) { el.innerHTML = `${head}<p class="empty">Loading…</p>`; return; }
  if (!s.connected) { el.innerHTML = head + setupCard(); return; }
  el.innerHTML = `${head}
    <p class="hint" style="margin-top:-8px">${esc(s.email || '')}</p>
    <form class="add-bar" data-form="search" role="search"><input name="q" type="search" placeholder="Search mail… e.g. ravi@client.com or invoice" value="${esc(view.q)}" autocomplete="off"><button class="btn">Search</button></form>
    <div class="chips">${FOLDERS.map(([k, l]) => `<button type="button" class="chip ${!view.q && view.folder === k ? 'on' : ''}" data-act="folder" data-f="${k}">${l}</button>`).join('')}
      ${view.q ? `<button type="button" class="chip on" data-act="clear-search">✕ “${esc(view.q)}”</button>` : ''}</div>
    ${view.error ? `<div class="alert bad"><i>⚠️</i><span>${esc(view.error.message)}</span></div>` : ''}
    <ul class="rows">${view.messages.map((m, i) => `<li class="row tap mail-row ${m.unread ? 'unread' : ''}" data-act="open" data-i="${i}">
      <div class="grow"><div class="mail-top"><span class="title">${m.unread ? '<i class="dot"></i>' : ''}${esc(m.from.name || m.from.email)}</span><span class="meta">${esc(when(m.time))}</span></div>
      <div class="mail-subject">${m.flagged ? '🚩 ' : ''}${m.hasAttachment ? '📎 ' : ''}${esc(m.subject)}</div>
      <div class="meta mail-summary">${esc(m.summary || '')}</div></div></li>`).join('')}</ul>
    ${view.loading ? '<p class="empty">Loading…</p>' : !view.messages.length ? `<p class="empty">${view.q ? 'No emails match.' : 'Nothing here.'}</p>` : ''}
    ${view.more && !view.loading ? '<button class="btn block" data-act="more" style="margin-top:12px">Load more</button>' : ''}`;
}

function setupCard() {
  const e = view.error;
  if (e?.code === 'no_cloud' || e?.code === 'not_configured' || e?.code === 'signed_out') {
    return `<div class="card"><h3>Mail isn’t set up yet</h3><p class="hint" style="margin:0">${esc(e.message)}</p></div>`;
  }
  if (e && e.code !== 'not_connected' && !/connected/i.test(e.message)) {
    return `<div class="card"><h3>Couldn’t reach Zoho Mail</h3><p class="hint">${esc(e.message)}</p><button class="btn" data-act="retry">Try again</button></div>`;
  }
  const dc = view.status?.dc || 'in';
  return `<div class="card form-grid">
    <h3>Connect Zoho Mail</h3>
    <ol class="steps">
      <li>Open <a href="https://api-console.zoho.${esc(dc)}" target="_blank" rel="noopener">api-console.zoho.${esc(dc)}</a> and sign in as <b>kunal.roy@thestralmedia.com</b>.</li>
      <li>Open your <b>Self Client</b> → <b>Generate Code</b> tab.</li>
      <li>Scope: <code class="copy">ZohoMail.accounts.READ,ZohoMail.folders.ALL,ZohoMail.messages.ALL</code></li>
      <li>Time duration: <b>10 minutes</b>, description “Baymax”, then <b>Create</b> and choose your mail account.</li>
      <li>Copy the code and paste it here within 10 minutes.</li>
    </ol>
    <form data-form="connect" class="form-grid"><label>Code from Zoho<input name="code" autocomplete="off" required placeholder="1000.xxxx…"></label>
    ${e && e.code !== 'not_connected' ? `<p class="alert bad">${esc(e.message)}</p>` : ''}
    <button class="btn primary block">Connect</button></form></div>`;
}

async function onSubmit(e) {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  if (f.dataset.form === 'search') { view.q = f.elements.namedItem('q').value.trim(); loadList(); }
  if (f.dataset.form === 'connect') {
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      view.status = await mailApi('connect', { code: f.elements.namedItem('code').value });
      view.error = null;
      toast(`Connected ${view.status.email}`);
      loadList();
    } catch (err) { view.error = err; render(); }
  }
}

function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'folder') { view.folder = t.dataset.f; view.q = ''; loadList(); }
  if (act === 'clear-search') { view.q = ''; loadList(); }
  if (act === 'more') { view.start += 25; loadList({ append: true }); }
  if (act === 'retry') { view.status = null; showMail(); }
  if (act === 'compose') compose();
  if (act === 'open') openMessage(view.messages[+t.dataset.i]);
}

// ---------------------------------------------------------------- reading
export async function openMessage(m) {
  const dlg = $('#mail-dialog');
  const body = $('#mail-body');
  body.innerHTML = `<h2>${esc(m.subject)}</h2><p class="empty">Loading…</p>`;
  dlg.showModal();
  try {
    const r = await mailApi('read', { folderId: m.folderId, messageId: m.messageId });
    const msg = r.message;
    m.unread = false;
    const people = (list) => list.map((x) => esc(x.name ? `${x.name} <${x.email}>` : x.email)).join(', ');
    body.innerHTML = `
      <h2>${esc(msg.subject)}</h2>
      <div class="mail-meta">
        <div><b>${esc(msg.from.name || msg.from.email)}</b> <span class="muted">&lt;${esc(msg.from.email)}&gt;</span></div>
        <div class="muted">To ${people(msg.to) || '—'}${msg.cc.length ? ` · Cc ${people(msg.cc)}` : ''}</div>
        <div class="muted">${msg.time ? new Date(msg.time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''}${msg.hasAttachment ? ' · 📎 has attachments (open in Zoho to download)' : ''}</div>
      </div>
      <div class="mail-actions">
        <button class="btn small" data-m="reply">↩ Reply</button><button class="btn small" data-m="replyall">↩ Reply all</button>
        <button class="btn small" data-m="forward">↪ Forward</button><button class="btn small" data-m="archive">Archive</button>
        <button class="btn small" data-m="unread">Mark unread</button><button class="btn small" data-m="flag">🚩 Flag</button>
        <button class="btn small danger" data-m="delete">Delete</button>
      </div>
      <div class="mail-text">${linkify(esc(r.text))}</div>
      ${r.html ? '<button class="link" data-m="formatted">Show original formatting</button><div id="mail-html"></div>' : ''}`;
    body.onclick = (ev) => {
      const b = ev.target.closest('[data-m]');
      if (b) messageAction(b.dataset.m, msg, r, b);
    };
    render();
  } catch (e) {
    body.innerHTML = `<h2>${esc(m.subject)}</h2><div class="alert bad"><span>${esc(e.message)}</span></div>`;
  }
}

function linkify(s) {
  return s.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.length > 60 ? u.slice(0, 57) + '…' : u}</a>`);
}

async function messageAction(kind, msg, r, btn) {
  const dlg = $('#mail-dialog');
  const done = (m) => { toast(m); dlg.close(); view.messages = view.messages.filter((x) => x.messageId !== msg.messageId || ['unread', 'flag'].includes(kind)); render(); };
  try {
    if (kind === 'reply' || kind === 'replyall') { dlg.close(); return replySheet(msg, kind === 'replyall'); }
    if (kind === 'forward') { dlg.close(); return forwardSheet(msg); }
    if (kind === 'formatted') {
      // Sandboxed, scripts and remote content (tracking pixels) blocked.
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'">`;
      $('#mail-html').innerHTML = `<iframe class="mail-frame" sandbox="" title="Original email"></iframe>`;
      $('#mail-html iframe').srcdoc = csp + r.html;
      btn.remove();
      return;
    }
    if (kind === 'archive') { await mailApi('update', { mode: 'archiveMails', messageIds: [msg.messageId] }); return done('Archived'); }
    if (kind === 'unread') { await mailApi('update', { mode: 'markAsUnread', messageIds: [msg.messageId] }); const m = view.messages.find((x) => x.messageId === msg.messageId); if (m) m.unread = true; return done('Marked unread'); }
    if (kind === 'flag') { await mailApi('update', { mode: 'setFlag', messageIds: [msg.messageId], flag: 'important' }); const m = view.messages.find((x) => x.messageId === msg.messageId); if (m) m.flagged = true; return done('Flagged'); }
    if (kind === 'delete') {
      if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Delete'; }, 3500); return; }
      await mailApi('delete', { folderId: msg.folderId, messageId: msg.messageId });
      return done('Moved to Trash');
    }
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- writing (always confirmed on screen)
function sendSheet({ title, values, fields, onSend }) {
  let sending = false;
  openSheet({
    title, values, fields, saveLabel: 'Send',
    onSave: (v) => {
      if (sending) return 'Sending…';
      sending = true;
      onSend(v).then(() => { document.getElementById('sheet').close(); toast('Sent ✓'); })
        .catch((e) => { sending = false; const box = document.querySelector('#sheet .sheet-error'); if (box) box.textContent = e.message; });
      return 'Sending…';
    },
  });
}

export function compose(prefill = {}) {
  sendSheet({
    title: 'New email', values: prefill,
    fields: [
      ...recipientFields,
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'content', label: 'Message', type: 'textarea', rows: 8 },
    ],
    onSend: (v) => mailApi('send', v),
  });
}

/** Who a reply goes to: the sender, plus (reply all) everyone on To and Cc, never yourself. */
export function replyRecipients(msg, all, myEmail = '') {
  const me = String(myEmail || '').toLowerCase();
  const not = (e) => e && e.toLowerCase() !== me;
  const to = [...new Set([msg.from.email, ...(all ? msg.to.map((x) => x.email) : [])].filter(not))];
  const cc = all ? [...new Set(msg.cc.map((x) => x.email).filter((e) => not(e) && !to.includes(e)))] : [];
  return { to: to.join(', '), cc: cc.join(', ') };
}

const recipientFields = [
  { key: 'to', label: 'To', type: 'text', required: true, placeholder: 'name@example.com, …' },
  { key: 'cc', label: 'Cc', type: 'text', placeholder: 'Optional' },
  { key: 'bcc', label: 'Bcc', type: 'text', placeholder: 'Optional' },
];

export function replySheet(msg, all = false, text = '') {
  const r = replyRecipients(msg, all, view.status?.email);
  sendSheet({
    title: all ? 'Reply all' : 'Reply',
    values: { ...r, bcc: '', subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`, content: text },
    fields: [
      ...recipientFields,
      { key: 'subject', label: 'Subject', type: 'text', readonly: true },
      { key: 'content', label: 'Your reply', type: 'textarea', rows: 8, required: true },
    ],
    onSend: (v) => mailApi('reply', { folderId: msg.folderId, messageId: msg.messageId, content: v.content, all, to: v.to, cc: v.cc, bcc: v.bcc }),
  });
}

function forwardSheet(msg) {
  sendSheet({
    title: 'Forward', values: { subject: `Fwd: ${msg.subject}` },
    fields: [
      ...recipientFields,
      { key: 'subject', label: 'Subject', type: 'text', readonly: true },
      { key: 'content', label: 'Add a note (optional)', type: 'textarea', rows: 4 },
    ],
    onSend: (v) => mailApi('forward', { folderId: msg.folderId, messageId: msg.messageId, to: v.to, cc: v.cc, bcc: v.bcc, content: v.content }),
  });
}

// ---------------------------------------------------------------- voice
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

async function latestFrom(who) {
  const q = isEmail(who) ? `sender:${who}` : `sender:${who}`;
  let r = await mailApi('search', { q, limit: 5 });
  if (!r.messages.length && !isEmail(who)) r = await mailApi('search', { q: `entire:${who}`, limit: 5 });
  return r.messages[0] || null;
}

/** Find someone's address from recent mail when you say a name instead of an email. */
async function resolveAddress(who) {
  if (isEmail(who)) return who;
  const m = await latestFrom(who).catch(() => null);
  return m ? m.from.email : '';
}

const readOut = (list) => list.slice(0, 5).map((m) => `${m.from.name || m.from.email}: ${m.subject}`);

/** Voice command executor for mail actions. Returns a chat reply, or null if not a mail action. */
export async function executeMail(a) {
  if (!['mail_check', 'mail_search', 'mail_reply', 'mail_read', 'email'].includes(a.type)) return null;
  if (a.type === 'email' && !cloud.client) return null; // fall back to a draft in your mail app
  try {
    if (a.type === 'mail_check') {
      const r = await mailApi('list', { folder: 'inbox', unread: true, limit: 10 });
      if (!r.messages.length) return { reply: 'No unread emails. Inbox zero! 🎉' };
      return { reply: `You have ${r.messages.length}${r.messages.length === 10 ? '+' : ''} unread email${r.messages.length === 1 ? '' : 's'}:`, items: readOut(r.messages), speakText: `You have ${r.messages.length} unread email${r.messages.length === 1 ? '' : 's'}. ${readOut(r.messages).slice(0, 3).join('. ')}.` };
    }
    if (a.type === 'mail_search') {
      const r = await mailApi('search', { q: isEmail(a.q) ? a.q : a.from ? `sender:${a.q}` : a.q, limit: 10 });
      if (!r.messages.length) return { reply: `No emails found for “${a.q}”.` };
      return { reply: `Found ${r.messages.length} email${r.messages.length === 1 ? '' : 's'}:`, items: r.messages.slice(0, 8).map((m) => `${when(m.time)} · ${m.from.name || m.from.email}: ${m.subject}`) };
    }
    if (a.type === 'mail_read') {
      const m = await latestFrom(a.who);
      if (!m) return { reply: `I couldn’t find an email from ${a.who}.` };
      const r = await mailApi('read', { folderId: m.folderId, messageId: m.messageId });
      const text = r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text;
      return { reply: `Latest from ${m.from.name || m.from.email}: “${m.subject}”.\n\n${text}`, speakText: `Latest from ${m.from.name || m.from.email}, ${m.subject}. ${text.slice(0, 400)}` };
    }
    if (a.type === 'mail_reply') {
      const m = await latestFrom(a.who);
      if (!m) return { reply: `I couldn’t find an email from ${a.who} to reply to.` };
      replySheet(m, !!a.all, a.text || '');
      return { reply: `Here’s your reply to ${m.from.name || m.from.email} about “${m.subject}”. Check it and tap Send.` };
    }
    if (a.type === 'email') {
      const to = await resolveAddress(a.to);
      compose({ to, subject: a.subject || '', content: a.body || '' });
      return { reply: to ? `I’ve drafted the email to ${to}. Check it and tap Send.` : `I couldn’t find an address for ${a.to}. Add it and tap Send.` };
    }
  } catch (e) {
    if (a.type === 'email' && ['no_cloud', 'not_configured', 'not_connected', 409, 503].includes(e.code)) return null;
    return { reply: `Mail: ${e.message}` };
  }
  return null;
}
