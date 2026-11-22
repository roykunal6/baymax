// Turns inbox emails into tasks: calls to make, deadlines/reminders, people chasing you, and
// questions or requests you haven't replied to. Pure functions (no network); used by the
// /api/mail "triage" action and unit-tested in tests/mailtriage.test.mjs.

import { parseTime } from './timeparse.js';

const BULK_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|alerts?|newsletters?|news|mailer(-daemon)?|bounces?|postmaster|marketing|promo(tions)?|offers|deals|digest|updates|automated|system|calendar-notification)\b/i;
// Machine senders: order-update@, shipment-tracking@, auto-confirm@, txn-alerts@, e-statements@ …
const AUTO_LOCAL = /(^|[-_.])(orders?|order-?update|shipment|shipping|tracking|delivery|auto-?confirm|confirm(ation)?s?|receipts?|statements?|e-?statement|billing|invoices?|payments?|transactions?|txn|alerts?|notifications?|updates|otp|verify|verification|security|reminders?|tickets?|feedback|survey|welcome|hello|team)([-_.]|$)/i;
const BULK_DOMAIN = /(^|\.)(mailchimp|sendgrid|amazonses|mailgun|hubspot(email)?|substack|linkedin|facebookmail|twitter|quora|medium|zohocampaigns|zoho-campaigns|mcsv|rsgsv|cmail\d*|createsend|accounts\.google|google|apple|github|atlassian|slack|notion|calendly|amazon|flipkart|myntra|swiggy|zomato|uber|olacabs|paytm|phonepe|razorpay|cred|zerodha|groww|hdfcbank|icicibank|axisbank|bandhanbank|sbi|kotak|irctc|makemytrip|bookmyshow|bigbasket|blinkit|zepto|nykaa|ajio|netflix|spotify|youtube)\.(com|net|io|in|co\.in)$/i;
const BULK_TEXT = /\b(unsubscribe|view (this email )?in (your )?browser|manage (your )?(email )?preferences|you are receiving this|this is an? (automated|auto[- ]?generated|system[- ]generated)|auto[- ]?(populated|generated) (e-?mail|mail|message)|system[- ]generated|expect no response|(please )?do not reply( to this)?|this mailbox is not monitored|microsoft teams meeting|join with google meet|join zoom meeting)\b/i;
const INVITE_SUBJECT = /^\s*((updated )?invitation|accepted|declined|tentative(ly accepted)?|(event )?cancell?ed( event)?)\s*:/i;
const TRANSACTIONAL_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|ooo\b|.{0,60}\bshared (the |a )?(folder|file|document|spreadsheet|presentation|drive)\b|delivered|shipped|out for delivery|ordered|arriving|your order|order (confirmed|confirmation|#|no)|payment (received|successful|confirmation)|receipt|your receipt|transaction alert|otp|verification code|your (statement|e-?statement|bill) (is|for)|welcome to)\b/i;

export function normSubject(s) {
  return String(s || '').replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Drop quoted earlier messages and signatures so old text doesn't trigger tasks. */
export function freshText(text) {
  let t = String(text || '');
  const cut = t.search(/\n\s*(On .{3,120}wrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+\n\s*(Sent|Date):|-{5,}\s*Forwarded message)/i);
  if (cut > 0) t = t.slice(0, cut);
  // Same markers inside one line (previews flatten newlines). A forward that starts with them keeps its content.
  const inline = t.search(/\s(On \w{3}, .{3,100}? wrote:|From: .{2,120}? (Sent|Date): |-{2,}\s*Original Message)/i);
  if (inline > 20) t = t.slice(0, inline);
  t = t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const sig = t.search(/\n\s*(--\s*\n|(thanks|thank you|regards|best|cheers|warm regards|best regards)[,!.]?\s*\n)/i);
  if (sig > 0) t = t.slice(0, sig);
  return t.trim();
}

/** A real person writing to you (not a newsletter, notification or mass mailing). */
export function isPersonMessage(m, me) {
  const from = (m.from?.email || '').toLowerCase();
  const mine = String(me || '').toLowerCase();
  if (!from || from === mine) return false;
  const [local, domain = ''] = from.split('@');
  if (BULK_LOCAL.test(local) || AUTO_LOCAL.test(local) || /no-?reply|do-?not-?reply|outreach|mailer/i.test(local) || BULK_DOMAIN.test(domain) || /^zoho[a-z-]*\./i.test(domain)) return false;
  if (TRANSACTIONAL_SUBJECT.test(m.subject || '') || INVITE_SUBJECT.test(m.subject || '')) return false;
  if (BULK_TEXT.test(`${m.summary || ''}\n${m.text || ''}`)) return false;
  if (mine) {
    const addressed = [...(m.to || []), ...(m.cc || [])].some((x) => (x.email || '').toLowerCase() === mine);
    if (!addressed) return false; // sent to a list or Bcc'd
  }
  return true;
}

const CALL = /\b(call me|give me a (call|ring)|call (me )?back|ring me|(can|could|shall) we (get on|hop on|have|do|schedule|set up) a (quick )?(call|phone call|zoom|meet|teams call)|(schedule|set up|book) a (quick )?call|(quick|short) call|missed (your|my) call|tried calling|please call|call (him|her|them|us)|speak (on|over) (the )?phone|whatsapp call)\b/i;
const CHASE = /\b(following up|follow(ing)?[- ]up on|gentle reminder|friendly reminder|just checking in|checking in on|any updates?( on)?|circling back|bumping (this|this up)|awaiting your (reply|response|revert)|waiting (for|on) your (reply|response|revert|confirmation)|didn'?t hear back|haven'?t heard back|reminder:?\s*$)\b/i;
const DEADLINE = /\b(deadline|due (date|on|by)|by (eod|end of (the )?day|cob|close of business|tomorrow|today|tonight|(this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}(st|nd|rd|th)?( of)? [a-z]{3,9})|before (tomorrow|(this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))|remind(er)?|don'?t forget|scheduled for|meeting (on|at)|invit(e|ation) to)\b/i;
// A request needs a verb: "please find attached" isn't one, "please confirm" is.
const ASK = /(\?|\b((please|pls|kindly) (confirm|revert|share|send|review|approve|advise|check|update|provide|reply|respond|sign|look into|help|arrange|schedule|let (me|us) know|get back|clarify|process|release|clear|transfer|pay|forward|call)|could you|can you|would you|will you|let me know|lmk|need (you|your)|your (approval|confirmation|feedback|input|thoughts|review|sign[- ]?off)|revert (back )?(on|with)|awaiting your|request you to|requesting you|(would |will )?need your (help|inputs?|support|recommendations?)|requires? your|come ?back (to us |to me )?with|revert with|share (the |a |your )?(list|details|costing|quote|estimate|invoice|deck)|at the earliest|asap)\b)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "10th December 2026", "10 Dec", "Dec 10" → a date at 10:00 (next year if it's long past). */
export function explicitDate(text, now = new Date()) {
  const t = String(text).toLowerCase();
  let m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,? (\d{4}))?\b/);
  let day, mon, year;
  if (m) { day = +m[1]; mon = MONTHS.indexOf(m[2]); year = m[3] ? +m[3] : null; }
  else {
    m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/);
    if (!m) return null;
    mon = MONTHS.indexOf(m[1]); day = +m[2]; year = m[3] ? +m[3] : null;
  }
  if (day < 1 || day > 31) return null;
  const d = new Date(year || now.getFullYear(), mon, day, 10, 0, 0);
  if (!year && d < new Date(now.getTime() - 60 * 864e5)) d.setFullYear(d.getFullYear() + 1);
  return d;
}

function firstSentence(text, re) {
  const parts = String(text).split(/(?<=[.!?\n])\s+/);
  return parts.find((p) => re.test(p)) || '';
}

/**
 * Decide what (if anything) an email asks of you.
 * Returns {kind: 'call'|'followup'|'deadline'|'reply', due: ISO|null} or null.
 */
export function classify(m, now = new Date()) {
  const subject = m.subject || '';
  const body = freshText(m.text || m.summary || '');
  const all = `${subject}\n${body}`;
  if (CALL.test(all)) return { kind: 'call', due: null };
  if (CHASE.test(subject) || CHASE.test(body.slice(0, 600))) return { kind: 'followup', due: null };
  if (DEADLINE.test(all)) {
    const s = firstSentence(all, DEADLINE).replace(/\b(eod|end of (the )?day|cob|close of business)\b/i, 'today at 6pm');
    const explicit = explicitDate(s || all, now);
    const t = explicit ? { date: explicit } : s ? parseTime(s, now) : null;
    const due = t && t.date > new Date(now.getTime() - 864e5) ? t.date.toISOString() : null;
    return { kind: 'deadline', due };
  }
  const noLinks = (x) => x.replace(/https?:\/\/\S+|\S+@\S+/g, ' ');
  if (ASK.test(noLinks(subject)) || ASK.test(noLinks(body))) return { kind: 'reply', due: null };
  return null;
}

const shortSubject = (s) => { const t = String(s || '(no subject)').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim(); return t.length > 70 ? `${t.slice(0, 67)}…` : t; };
const ROLE = /^(partner|partners|info|contact|support|team|hello|admin|accounts?|finance|sales|office|enquiry|enquiries|helpdesk|care|hr|ops|operations)$/i;
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
/** "Ravi Mehta" → Ravi; sunil.kumar5@x.com → Sunil; partner@procol.in → Procol. */
export function firstName(m) {
  const n = (m.from?.name || '').replace(/["']/g, '').trim();
  if (n && !n.includes('@')) return n.split(/\s+/)[0];
  const [local = '', domain = ''] = (m.from?.email || '').toLowerCase().split('@');
  if (!local) return 'someone';
  if (ROLE.test(local)) return cap(domain.split('.')[0]);
  return cap(local.split(/[._\-\d]+/).filter(Boolean)[0] || local);
}

export function taskTitle(kind, m) {
  const who = firstName(m), sub = shortSubject(m.subject);
  if (kind === 'call') return `Call ${who} — ${sub}`;
  if (kind === 'followup') return `Reply to ${who} (they followed up) — ${sub}`;
  if (kind === 'deadline') return `${sub} — from ${who}`;
  return `Reply to ${who} — ${sub}`;
}

/** Did you reply after this message? Same thread, or same subject sent to the sender. */
export function hasReply(m, sent) {
  const subj = normSubject(m.subject);
  const from = (m.from?.email || '').toLowerCase();
  return sent.some((s) => {
    if ((s.time || 0) <= (m.time || 0)) return false;
    const toSender = [...(s.to || []), ...(s.cc || [])].some((x) => (x.email || '').toLowerCase() === from);
    const forward = /^\s*(fw|fwd)\s*:/i.test(s.subject || '');
    // Forwarding it to a colleague isn't answering the sender.
    if (forward && !toSender) return false;
    return (m.threadId && s.threadId && s.threadId === m.threadId) || (normSubject(s.subject) === subj && toSender);
  });
}

/**
 * inbox/sent: message summaries ({messageId, folderId, threadId, from, to, cc, subject, summary, text?, time}).
 * Returns {items: tasks to add, replied: messageIds you've answered, examined: ids that can be skipped next time}.
 * Unanswered questions only count once they're `minAgeHours` old (you may still be replying).
 */
export function triageMessages({ inbox, sent, me, now = Date.now(), days = 14, minAgeHours = 4 }) {
  const since = now - days * 864e5;
  const items = [], replied = [], examined = [];
  for (const m of inbox) {
    if (!m.time || m.time < since) continue;
    const answered = hasReply(m, sent);
    if (answered) replied.push(m.messageId);
    const oldEnough = now - m.time >= minAgeHours * 3600e3;
    if (!isPersonMessage(m, me)) { examined.push(m.messageId); continue; }
    const c = classify(m, new Date(now));
    if (!c) { if (oldEnough && m.text != null) examined.push(m.messageId); continue; }
    // Replies and follow-ups only matter while unanswered; calls and deadlines stand on their own.
    if ((c.kind === 'reply' || c.kind === 'followup') && (answered || !oldEnough)) { if (answered) examined.push(m.messageId); continue; }
    // A deadline you've already answered only stays if it has a date still ahead.
    if (c.kind === 'deadline' && answered && !(c.due && new Date(c.due).getTime() > now)) { examined.push(m.messageId); continue; }
    examined.push(m.messageId);
    // One task per conversation: keep the newest email.
    const same = items.findIndex((x) => x.threadId && x.threadId === m.threadId);
    if (same >= 0) { if (items[same].time >= m.time) continue; items.splice(same, 1); }
    items.push({
      messageId: m.messageId, folderId: m.folderId, threadId: m.threadId || null,
      kind: c.kind, due: c.due, title: taskTitle(c.kind, m),
      from: m.from, subject: m.subject || '(no subject)', time: m.time,
    });
  }
  return { items, replied, examined };
}
