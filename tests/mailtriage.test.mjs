import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triageMessages, classify, freshText, isPersonMessage, hasReply } from '../js/mailtriage.js';
import { applyTriage } from '../js/mailtasks.js';

const ME = 'kunal.roy@thestralmedia.com';
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime(); // Wed 18 Nov 2026, noon
const H = 3600e3;
let n = 0;
const msg = (o) => ({
  messageId: String(++n), folderId: '9001', threadId: o.threadId || `t${n}`,
  from: { name: o.name || 'Ravi Mehta', email: o.email || 'ravi@client.com' },
  to: o.to || [{ email: ME }], cc: o.cc || [], subject: o.subject || 'Hello', summary: o.summary || '', text: o.text ?? null,
  time: NOW - (o.ago ?? 6) * H,
});

test('classifies calls, follow-ups, deadlines and questions', () => {
  const now = new Date(NOW);
  assert.equal(classify({ subject: 'Quick one', text: 'Can you give me a call when free?' }, now).kind, 'call');
  assert.equal(classify({ subject: 'Re: Proposal', text: 'Just following up on the proposal I sent last week.' }, now).kind, 'followup');
  const d = classify({ subject: 'GST documents', text: 'Please share the GST documents by Friday.' }, now);
  assert.equal(d.kind, 'deadline');
  assert.equal(new Date(d.due).getDate(), 20);
  assert.equal(classify({ subject: 'Rates', text: 'What are your rates for a 3 month retainer?' }, now).kind, 'reply');
  assert.equal(classify({ subject: 'FYI', text: 'Sharing the deck from today. No action needed.' }, now), null);
});

test('ignores quoted text and signatures', () => {
  const t = freshText('Thanks, all good.\n\nOn Mon, 16 Nov 2026 Ravi wrote:\n> Can you call me tomorrow?');
  assert.equal(t, 'Thanks, all good.');
  assert.equal(classify({ subject: 'Re: plan', text: 'Thanks, all good.\n\nOn Mon, 16 Nov 2026 Ravi wrote:\n> Can you call me tomorrow?' }), null);
});

test('only real people writing to you', () => {
  assert.equal(isPersonMessage(msg({ email: 'noreply@zoho.com' }), ME), false);
  assert.equal(isPersonMessage(msg({ email: 'news@brand.com' }), ME), false);
  assert.equal(isPersonMessage(msg({ summary: 'Big sale! Unsubscribe here' }), ME), false);
  assert.equal(isPersonMessage(msg({ to: [{ email: 'all@client.com' }] }), ME), false, 'list mail / Bcc');
  assert.equal(isPersonMessage(msg({ email: ME }), ME), false, 'your own');
  assert.equal(isPersonMessage(msg({}), ME), true);
  assert.equal(isPersonMessage(msg({ to: [{ email: 'x@y.com' }], cc: [{ email: ME }] }), ME), true);
});

test('triage: unanswered questions become tasks after 4 hours; answered ones don’t', () => {
  const q1 = msg({ subject: 'Rates?', text: 'Could you send your rates?', ago: 30 });
  const q2 = msg({ subject: 'Timeline', text: 'Can you confirm the timeline?', ago: 30, name: 'Meera Shah', email: 'meera@client.com' });
  const fresh = msg({ subject: 'Logo', text: 'Can you share the logo files?', ago: 1 });
  const call = msg({ subject: 'Call', text: 'Please call me back today.', ago: 1, name: 'Anil' , email: 'anil@x.in' });
  const promo = msg({ email: 'offers@shop.com', subject: 'Can you believe these deals?', ago: 20 });
  const old = msg({ subject: 'Old', text: 'Can you check?', ago: 24 * 20 });
  const sent = [{ threadId: q2.threadId, subject: 'Re: Timeline', to: [{ email: 'meera@client.com' }], time: q2.time + H }];
  const r = triageMessages({ inbox: [q1, q2, fresh, call, promo, old], sent, me: ME, now: NOW });
  assert.deepEqual(r.items.map((i) => i.title), ['Reply to Ravi — Rates?', 'Call Anil — Call']);
  assert.deepEqual(r.replied, [q2.messageId]);
  assert.ok(r.examined.includes(promo.messageId));
  assert.ok(!r.examined.includes(fresh.messageId), 'too new: look again later');
});

test('reply detection by subject + recipient when threads differ', () => {
  const m = msg({ subject: 'Invoice 42', threadId: null });
  assert.equal(hasReply(m, [{ subject: 'RE: Invoice 42', to: [{ email: 'ravi@client.com' }], time: m.time + 1 }]), true);
  assert.equal(hasReply(m, [{ subject: 'RE: Invoice 42', to: [{ email: 'other@x.com' }], time: m.time + 1 }]), false);
  assert.equal(hasReply(m, [{ subject: 'RE: Invoice 42', to: [{ email: 'ravi@client.com' }], time: m.time - 1 }]), false);
});

test('applyTriage: adds once, never re-adds a deleted task, ticks off replied ones', () => {
  const st = { tasks: [], mailTriage: { on: true, seen: {} } };
  const item = { messageId: '77', folderId: '9001', kind: 'reply', title: 'Reply to Ravi — Rates?', due: null, from: { name: 'Ravi' }, subject: 'Rates?' };
  let out = applyTriage(st, { items: [item], replied: [], examined: ['77', '78'] }, NOW);
  assert.equal(out.added.length, 1);
  assert.equal(st.tasks[0].id, 'mail-77');
  assert.equal(applyTriage(st, { items: [item] }, NOW).added.length, 0, 'no duplicate');
  out = applyTriage(st, { items: [], replied: ['77'] }, NOW);
  assert.equal(st.tasks[0].done, true);
  assert.equal(st.tasks[0].autoDone, 'replied');
  st.tasks = []; // deleted by you
  assert.equal(applyTriage(st, { items: [item] }, NOW).added.length, 0, 'deleted stays deleted');
});
