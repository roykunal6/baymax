import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../js/parser.js';
import { parseTime, parseDuration, parseClock } from '../js/timeparse.js';

// Wednesday 18 Nov 2026, 10:00 local time
const NOW = new Date(2026, 10, 18, 10, 0, 0);
const p = (s, extra = {}) => parseCommand(s, { now: NOW, ...extra });
const local = (iso) => { const d = new Date(iso); return [d.getDate(), d.getHours(), d.getMinutes()]; };

test('durations', () => {
  assert.equal(parseDuration('5 minutes'), 300);
  assert.equal(parseDuration('an hour'), 3600);
  assert.equal(parseDuration('half an hour'), 1800);
  assert.equal(parseDuration('1 hour and 30 minutes'), 5400);
  assert.equal(parseDuration('ten seconds'), 10);
  assert.equal(parseDuration('an hour and a half'), 5400);
});

test('clock', () => {
  assert.deepEqual([parseClock('9am').h, parseClock('9am').m], [9, 0]);
  assert.equal(parseClock('5:30 pm').h, 17);
  assert.equal(parseClock('12 am').h, 0);
  assert.equal(parseClock('noon').h, 12);
});

test('relative and absolute times', () => {
  assert.deepEqual(local(parseTime('in 20 minutes', NOW).date), [18, 10, 20]);
  assert.deepEqual(local(parseTime('tomorrow at 9am', NOW).date), [19, 9, 0]);
  assert.deepEqual(local(parseTime('tomorrow', NOW).date), [19, 9, 0]);
  assert.deepEqual(local(parseTime('at 5:30 pm', NOW).date), [18, 17, 30]);
  assert.deepEqual(local(parseTime('at 5', NOW).date), [18, 17, 0]);
  assert.deepEqual(local(parseTime('at 9am', NOW).date), [19, 9, 0]); // already past → tomorrow
  assert.deepEqual(local(parseTime('on friday at 3pm', NOW).date), [20, 15, 0]);
  assert.deepEqual(local(parseTime('tomorrow evening', NOW).date), [19, 18, 0]);
  assert.deepEqual(local(parseTime('this evening', NOW).date), [18, 18, 0]);
  assert.deepEqual(local(parseTime('at 3 tomorrow', NOW).date), [19, 15, 0]);
  assert.equal(parseTime('buy milk', NOW), null);
});

test('reminders', () => {
  let r = p('remind me to call Ravi in 20 minutes');
  assert.equal(r.type, 'remind'); assert.equal(r.title, 'call Ravi'); assert.deepEqual(local(r.due), [18, 10, 20]);
  r = p('Remind me tomorrow at 9am to send the invoice');
  assert.equal(r.title, 'send the invoice'); assert.deepEqual(local(r.due), [19, 9, 0]);
  r = p('remind me at 5 pm about the shipment docs');
  assert.equal(r.title, 'the shipment docs'); assert.deepEqual(local(r.due), [18, 17, 0]);
  r = p('remind me to pay rent');
  assert.equal(r.needsTime, true);
});

test('tasks', () => {
  let r = p('add task send FCL quote to Ravi tomorrow at 11');
  assert.equal(r.type, 'add_task'); assert.equal(r.title, 'send FCL quote to Ravi'); assert.deepEqual(local(r.due), [19, 11, 0]);
  r = p('Please add buy printer paper to my list');
  assert.equal(r.type, 'add_task'); assert.equal(r.title, 'buy printer paper'); assert.equal(r.due, null);
  assert.equal(p('I need to renew the insurance').title, 'renew the insurance');
  assert.deepEqual(p('what are my tasks today'), { type: 'list_tasks', filter: 'today' });
  assert.deepEqual(p('show my to do list'), { type: 'list_tasks', filter: 'open' });
  assert.deepEqual(p('mark buy milk as done'), { type: 'complete_task', query: 'buy milk' });
  assert.deepEqual(p('complete task buy milk'), { type: 'complete_task', query: 'buy milk' });
  assert.deepEqual(p('delete task buy milk'), { type: 'delete_task', query: 'buy milk' });
  assert.deepEqual(p('clear completed tasks'), { type: 'clear_completed' });
});

test('notes, timer, web, email', () => {
  assert.deepEqual(p('note: container MSKU4471 lands Friday'), { type: 'add_note', text: 'container MSKU4471 lands Friday' });
  assert.deepEqual(p('take a note the client prefers WhatsApp'), { type: 'add_note', text: 'the client prefers WhatsApp' });
  assert.deepEqual(p('read my notes'), { type: 'list_notes' });
  assert.deepEqual(p('set a timer for 5 minutes'), { type: 'timer', seconds: 300 });
  assert.deepEqual(p('10 minute timer'), { type: 'timer', seconds: 600 });
  assert.deepEqual(p('open gmail'), { type: 'open', url: 'https://mail.google.com' });
  assert.deepEqual(p('open teamglobal dot in'), { type: 'open', url: 'https://teamglobal.in' });
  assert.deepEqual(p('search for freight rates Mumbai to Dubai'), { type: 'search', query: 'freight rates mumbai to dubai' });
  assert.deepEqual(p('email ravi@example.com about invoice saying please share by Friday'),
    { type: 'email', to: 'ravi@example.com', subject: 'invoice', body: 'please share by Friday' });
});

test('meta + routines', () => {
  assert.equal(p('what time is it').type, 'time');
  assert.equal(p("what's the date").type, 'date');
  assert.equal(p("what's my day").type, 'briefing');
  assert.equal(p('help').type, 'help');
  const routines = [{ id: 'r1', name: 'Morning routine', phrases: ['good morning assistant', 'start my day'] }];
  assert.deepEqual(p('run morning routine', { routines }), { type: 'run_routine', id: 'r1', name: 'Morning routine' });
  assert.equal(p('Start my day!', { routines }).id, 'r1');
  assert.equal(p('gibberish blorp').type, 'unknown');
});

test('wake word "Baymax"', () => {
  assert.equal(p('Hey Baymax, add task call the bank').title, 'call the bank');
  assert.equal(p('Baymax what time is it').type, 'time');
  assert.equal(p('hi baymax').type, 'greet');
  assert.equal(p('Baymax').type, 'greet');
});

test('follow-ups, habits and money routing', () => {
  assert.deepEqual(p('Add task'), { type: 'ask', field: 'task' });
  assert.deepEqual(p('add a task'), { type: 'ask', field: 'task' });
  assert.deepEqual(p('take a note'), { type: 'ask', field: 'note' });
  assert.deepEqual(p('add habit meditate 10 minutes'), { type: 'add_habit', name: 'meditate 10 minutes' });
  assert.equal(p('spent 450 on lunch').type, 'add_spend');
  assert.equal(p('remind me to pay rent tomorrow at 10am').type, 'remind');
  assert.equal(p('add task pay rent tomorrow').type, 'add_task');
  assert.equal(p("what's due this week").type, 'list_dues');
});

test('email voice commands', () => {
  assert.deepEqual(p('check my email'), { type: 'mail_check' });
  assert.deepEqual(p('any new emails?'), { type: 'mail_check' });
  assert.deepEqual(p("what's in my inbox"), { type: 'mail_check' });
  assert.deepEqual(p('any emails from Ravi'), { type: 'mail_search', q: 'ravi', from: true });
  assert.deepEqual(p('search my email for invoice november'), { type: 'mail_search', q: 'invoice november' });
  assert.deepEqual(p('read the latest email from Ravi'), { type: 'mail_read', who: 'ravi' });
  assert.deepEqual(p('Reply to Ravi saying I will send it by Friday'), { type: 'mail_reply', who: 'Ravi', text: 'I will send it by Friday', all: false });
  assert.deepEqual(p('reply all to the last email from Meera saying approved'), { type: 'mail_reply', who: 'Meera', text: 'approved', all: true });
  assert.equal(p('email ravi@example.com about invoice saying please share').type, 'email');
  assert.equal(p('read my notes').type, 'list_notes');
});
