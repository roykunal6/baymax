// Executors for money and habit commands. Returns null for action types it doesn't handle.

import {
  state, save, addSpend, addObligation, addInvoice, addCard, setPaid, addHabit, toggleHabit, findHabit, habitStreak, logActivity,
} from './store.js';
import {
  inr, healthCheck, dueItems, addDays, KIND_LABEL, sumSpends, startOfWeek, findDue, invoiceLabel, invoiceStatus,
  parseDay, monthKey, ymd, daysBetween,
} from './finance.js';

const fin = () => state.finance;
const shortDate = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const methodName = (m) => (fin().cards.find((c) => c.id === m)?.name ? `${fin().cards.find((c) => c.id === m).name} card` : { upi: 'UPI', cash: 'cash', bank: 'bank' }[m] || m);
const whenText = (d) => { const n = daysBetween(new Date(), d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? `${-n} days ago` : `on ${shortDate(d)}`; };

const ASK = {
  task: 'Sure. What’s the task? You can add a time too, like “call Ravi tomorrow at 4”.',
  note: 'Okay, what should the note say?',
  spend: 'How much and on what? For example “450 on lunch with HDFC card”.',
  habit: 'Which habit should I track? For example “meditate 10 minutes”.',
  amount: 'How much is it?',
};

export async function executeMoney(a, ctx = {}) {
  switch (a.type) {
    case 'ask':
      ctx.setPending?.({ field: a.field, action: a.pendingAction });
      return { reply: ASK[a.field] || 'Could you tell me a bit more?' };

    // ---------------- habits
    case 'add_habit': {
      if (!a.name) return executeMoney({ type: 'ask', field: 'habit' }, ctx);
      const h = addHabit(a.name.replace(/^\w/, (c) => c.toUpperCase()));
      return { reply: `Tracking “${h.name}” daily. Say “done ${h.name.toLowerCase()}” when you’ve done it.` };
    }
    case 'list_habits': {
      if (!state.habits.length) return { reply: 'You’re not tracking any habits yet. Say “add habit …” to start one.' };
      const today = ymd(new Date());
      const done = state.habits.filter((h) => h.log[today]).length;
      return {
        reply: `${done} of ${state.habits.length} habits done today:`,
        items: state.habits.map((h) => `${h.log[today] ? '✓' : '○'} ${h.name}${habitStreak(h) ? ` · ${habitStreak(h)}-day streak` : ''}`),
      };
    }
    case 'habit_done': {
      const h = findHabit(a.query);
      if (!h) return null;
      toggleHabit(h.id, ymd(new Date()), true);
      const streak = habitStreak(h);
      return { reply: `Nice! “${h.name}” done today${streak > 1 ? `, that’s a ${streak}-day streak` : ''}.` };
    }

    // ---------------- spending
    case 'add_spend': {
      if (!(a.amount > 0)) return executeMoney({ type: 'ask', field: 'spend' }, ctx);
      addSpend(a);
      logActivity(`Spent ${inr(a.amount)} on ${a.note || a.category}`);
      const h = healthCheck(fin());
      const s = h.summary;
      let tail = '';
      if (s.budget > 0) tail = s.left >= 0 ? ` ${inr(s.left)} left in this month’s budget.` : ` You’re ${inr(-s.left)} over this month’s budget.`;
      return { reply: `Logged ${inr(a.amount)} on ${a.note || a.category} (${a.category}, ${methodName(a.method)}).${tail}` };
    }
    case 'spend_query': {
      const now = new Date();
      const start = a.range === 'today' ? now : a.range === 'week' ? startOfWeek(now) : new Date(now.getFullYear(), now.getMonth(), 1);
      const filter = (x) => (!a.card || x.method === a.card) && (!a.category || x.category === a.category);
      const total = sumSpends(fin(), start, now, filter);
      const label = { today: 'today', week: 'this week', month: 'this month' }[a.range];
      const what = [a.category && `on ${a.category.toLowerCase()}`, a.card && `with ${methodName(a.card)}`].filter(Boolean).join(' ');
      return { reply: `You’ve spent ${inr(total)} ${what ? what + ' ' : ''}${label}.` };
    }
    case 'card_summary': {
      if (!fin().cards.length) return { reply: 'No cards added yet. Add one in Money → Setup, or say “add card HDFC limit 2 lakh due on 15th”.' };
      const s = healthCheck(fin()).summary;
      return {
        reply: 'Credit card spends this month:',
        items: fin().cards.map((c) => `${c.name}: ${inr(s.byCard[c.id] || 0)}${c.limit ? ` of ${inr(c.limit)} limit` : ''}`),
      };
    }

    // ---------------- dues
    case 'add_obligation': {
      if (a.needsAmount || !(a.amount > 0)) {
        ctx.setPending?.({ field: 'amount', action: { ...a } });
        return { reply: `How much is the ${KIND_LABEL[a.kind]} for ${a.name}?` };
      }
      const o = addObligation(a);
      const when = o.schedule.type === 'monthly' ? `every month on the ${ordinal(o.schedule.day)}` : `on ${shortDate(parseDay(o.schedule.date))}`;
      return { reply: `Added ${KIND_LABEL[o.kind]} “${o.name}”, ${inr(o.amount)} ${when}${o.endMonth ? ` until ${monthName(o.endMonth)}` : ''}. I’ll remind you ${fin().remindDays} days before.` };
    }
    case 'mark_paid': {
      const match = findDue(fin(), a.query);
      if (!match) return { reply: `I couldn’t find a bill, EMI, SIP or card called “${a.query}”.` };
      const now = new Date();
      const due = dueItems(fin(), addDays(now, -60), addDays(now, 31))
        .filter((d) => d.ref === match.ref && d.id === match.item.id && !d.paid)[0];
      if (!due) return { reply: `“${match.item.name}” has nothing unpaid right now.` };
      setPaid(due.ref, due.id, due.key, true);
      logActivity(`Paid ${due.name} ${inr(due.amount)}`);
      return { reply: `Marked ${due.name} (${inr(due.amount)}, due ${whenText(due.date)}) as paid.` };
    }
    case 'list_dues': {
      const now = new Date();
      const end = a.range === 'month' ? new Date(now.getFullYear(), now.getMonth() + 1, 0) : addDays(now, 7);
      const overdue = dueItems(fin(), addDays(now, -60), addDays(now, -1)).filter((d) => !d.paid && d.direction !== 'in');
      const list = dueItems(fin(), now, end).filter((d) => !d.paid && d.direction !== 'in');
      const all = [...overdue, ...list];
      if (!all.length) return { reply: `Nothing due ${a.range === 'month' ? 'for the rest of this month' : 'in the next 7 days'}. 🎉` };
      const total = all.reduce((x, d) => x + d.amount, 0);
      return {
        reply: `${all.length} payment${all.length === 1 ? '' : 's'} due ${a.range === 'month' ? 'this month' : 'in the next 7 days'}, ${inr(total)} in total${overdue.length ? ` (${overdue.length} overdue)` : ''}:`,
        items: all.map((d) => `${KIND_LABEL[d.kind]} · ${d.name} · ${inr(d.amount)} · ${d.date < new Date(new Date().setHours(0, 0, 0, 0)) ? 'overdue, ' : ''}${whenText(d.date)}`),
        speakText: `${all.length} payments due, ${inr(total)} in total. ${all.slice(0, 3).map((d) => `${d.name}, ${inr(d.amount)}, ${whenText(d.date)}`).join('. ')}.`,
      };
    }
    case 'add_card': {
      const c = addCard(a);
      return { reply: `Added ${c.name} card${c.limit ? ` with a ${inr(c.limit)} limit` : ''}${c.dueDay ? `, bill due on the ${ordinal(c.dueDay)}` : ''}. Say “spent 500 on lunch with ${c.name}” to log spends on it.` };
    }

    // ---------------- invoices
    case 'add_invoice': {
      if (!(a.amount > 0)) return { reply: 'What’s the invoice amount? For example “Thestral invoice 45000 due next Friday”.' };
      const inv = addInvoice(a);
      return { reply: `Added invoice ${invoiceLabel(inv)} for ${inr(inv.amount)}, ${inv.direction === 'out' ? 'to pay' : 'to receive'} by ${shortDate(parseDay(inv.dueDate))}.` };
    }
    case 'invoice_paid': {
      const q = String(a.party || '').toLowerCase();
      const open = fin().invoices.filter((i) => !i.paidAt && (!q || i.party.toLowerCase().includes(q) || q.includes(i.party.toLowerCase())));
      const inv = open.find((i) => a.number && i.number.toLowerCase() === String(a.number).toLowerCase()) ||
        open.find((i) => a.amount && i.amount === a.amount) || open.sort((x, y) => String(x.dueDate).localeCompare(y.dueDate))[0];
      if (!inv) return { reply: `I couldn’t find an unpaid invoice for “${a.party}”.` };
      setPaid('invoice', inv.id, 'once', true);
      return { reply: `Marked ${invoiceLabel(inv)} (${inr(inv.amount)}) as ${inv.direction === 'out' ? 'paid' : 'received'}. 🎉` };
    }
    case 'list_invoices': {
      const open = fin().invoices.filter((i) => !i.paidAt).sort((x, y) => String(x.dueDate).localeCompare(y.dueDate));
      if (!open.length) return { reply: 'No unpaid invoices.' };
      const receive = open.filter((i) => i.direction !== 'out').reduce((x, i) => x + i.amount, 0);
      return {
        reply: `${open.length} unpaid invoice${open.length === 1 ? '' : 's'}${receive ? `, ${inr(receive)} to receive` : ''}:`,
        items: open.map((i) => `${invoiceLabel(i)} · ${inr(i.amount)} · ${invoiceStatus(i) === 'overdue' ? 'overdue since' : 'due'} ${shortDate(parseDay(i.dueDate))}${i.direction === 'out' ? ' · to pay' : ''}`),
      };
    }

    // ---------------- budget
    case 'set_budget': fin().budget = a.amount; save(); return { reply: `Monthly spending budget set to ${inr(a.amount)}.` };
    case 'set_income': fin().income = a.amount; save(); return { reply: `Monthly income set to ${inr(a.amount)}.` };
    case 'finance_summary': {
      const h = healthCheck(fin());
      const s = h.summary;
      const items = [
        `Spent ${inr(s.spent)}${s.budget ? ` of ${inr(s.budget)} budget` : ''}`,
        `EMIs ${inr(s.emi)} · SIPs ${inr(s.sip)} · Bills ${inr(s.bills)}`,
        s.income ? `Income ${inr(s.income)} · saving ${Math.round((s.savingsRate || 0) * 100)}%` : null,
        s.toReceive ? `To receive from invoices: ${inr(s.toReceive)}` : null,
        ...h.alerts.filter((x) => x.level !== 'info').slice(0, 4).map((x) => `${x.level === 'bad' ? '⚠️' : '•'} ${x.text}`),
      ].filter(Boolean);
      return { reply: `${h.label}. ${h.headline}`, items, speakText: `${h.label}. ${h.headline}` };
    }
    default:
      return null;
  }
}

/** Extra lines for the daily briefing: money status, payments due soon, habits. */
export function briefingExtras() {
  const h = healthCheck(fin());
  const now = new Date();
  const soon = dueItems(fin(), now, addDays(now, 3)).filter((d) => !d.paid && d.direction !== 'in');
  const parts = [];
  if (h.status !== 'setup') parts.push(`Money: ${h.label.toLowerCase()}. ${h.headline}`);
  if (soon.length) parts.push(`${soon.length} payment${soon.length === 1 ? '' : 's'} due in the next 3 days: ${soon.map((d) => `${d.name} ${inr(d.amount)}`).join(', ')}.`);
  const today = ymd(now);
  const left = state.habits.filter((x) => !x.log[today]);
  if (state.habits.length) parts.push(left.length ? `${left.length} habit${left.length === 1 ? '' : 's'} left today.` : 'All habits done today.');
  return parts.join(' ');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function monthName(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}
export { ordinal, monthKey };
