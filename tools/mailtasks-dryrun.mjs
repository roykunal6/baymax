// Dry run of Email → tasks on exported Zoho data (read-only). Usage:
//   node tools/mailtasks-dryrun.mjs <dir with inbox.json [sent.json texts.json]> <your address> [days]
// inbox.json: Zoho messages/view output (fields incl. fromAddress, sender, toAddress, ccAddress, subject, summary, receivedTime).
// sent.json: [{threadId, subject, time, to: "a@x,b@y", cc: ""}]. texts.json: {messageId: html}.
import { readFileSync, existsSync } from 'node:fs';
import { triageMessages, isPersonMessage } from '../js/mailtriage.js';
import { parseAddresses, decodeEntities, htmlToText } from '../netlify/functions/mail.mjs';
const D = process.argv[2];
const raw = JSON.parse(readFileSync(`${D}/inbox.json`, 'utf8'));
const texts = existsSync(`${D}/texts.json`) ? JSON.parse(readFileSync(`${D}/texts.json`, 'utf8')) : {};
const ME = process.argv[3];
const inbox = raw.map((m) => {
  const from = parseAddresses(m.fromAddress)[0] || { email: decodeEntities(m.fromAddress) };
  return { messageId: String(m.messageId), folderId: String(m.folderId), threadId: m.threadId ? String(m.threadId) : null,
    from: { name: decodeEntities(m.sender) || from.name, email: from.email }, to: parseAddresses(m.toAddress), cc: parseAddresses(m.ccAddress),
    subject: decodeEntities(m.subject), summary: decodeEntities(m.summary), time: Number(m.receivedTime), text: texts[m.messageId] != null ? htmlToText(texts[m.messageId]) : null };
});
const now = Number(process.env.NOW || Date.now());
const DAYS = Number(process.argv[4] || 14);
const sent = existsSync(`${D}/sent.json`) ? JSON.parse(readFileSync(`${D}/sent.json`, 'utf8')).map((x) => ({ ...x, to: x.to.split(',').filter(Boolean).map((e) => ({ email: e.toLowerCase() })), cc: x.cc.split(',').filter(Boolean).map((e) => ({ email: e.toLowerCase() })) })) : [];
const recent = inbox.filter((m) => now - m.time < DAYS * 864e5);
const people = recent.filter((m) => isPersonMessage(m, ME));
console.log(`last ${DAYS} days: ${recent.length} emails, from people to you: ${people.length}`);
const skipped = recent.filter((m) => !isPersonMessage(m, ME));
const why = {};
for (const m of skipped) why[m.from.email.split('@')[1]] = (why[m.from.email.split('@')[1]] || 0) + 1;
console.log('skipped (by sender domain):', why);
console.log('PEOPLE:', people.map((m) => `${m.messageId} | ${m.from.email} | ${m.subject}`).join('\n  '));
const r = triageMessages({ inbox: recent, sent, me: ME, now, days: DAYS });
console.log('replied:', r.replied.length);
console.log('\nTASKS:'); for (const i of r.items) console.log(`  [${i.kind}] ${i.title}${i.due ? ' (due ' + new Date(i.due).toDateString() + ')' : ''}`);
