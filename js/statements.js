// Month-end reminder to upload bank / card statements (Money → Import statement).
// A task "Upload bank statements for <month>" is due on the last day of each month at 7 PM, and a
// card stays on Home until a statement is imported (then the task ticks itself off).

const pad = (n) => String(n).padStart(2, '0');
export const monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
const monthName = (key) => new Date(`${key}-01T00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

/**
 * Which month's statements are due now, if any: from the last day of a month until the 10th of the
 * next, unless a statement was imported after that month ended.
 */
export function statementDue(fin, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  let key = null;
  if (now.getDate() === lastDay(y, m)) key = monthKeyOf(now);
  else if (now.getDate() <= 10) key = monthKeyOf(new Date(y, m - 1, 1));
  if (!key) return null;
  const done = (fin.statementUploads || {})[key];
  return done ? null : { key, label: monthName(key) };
}

/** Make sure this month's reminder task exists (once per month, even if you delete it). */
export function ensureStatementTask(state, now = new Date()) {
  const f = state.finance;
  const key = monthKeyOf(now);
  f.stmtTaskMonths = f.stmtTaskMonths || [];
  if (f.stmtTaskMonths.includes(key)) return false;
  const id = `stmt-${key}`;
  if (!state.tasks.some((t) => t.id === id)) {
    const due = new Date(now.getFullYear(), now.getMonth(), lastDay(now.getFullYear(), now.getMonth()), 19, 0, 0);
    state.tasks.push({
      id, title: `🏦 Upload bank statements for ${monthName(key)}`, due: due.toISOString(), done: false, notified: false, isTimer: false,
      createdAt: now.toISOString(), note: 'Money → Spends → Import statement: Axis savings, HDFC credit card, ICICI loan, Bandhan',
    });
  }
  f.stmtTaskMonths = [...f.stmtTaskMonths, key].slice(-24);
  return true;
}

/** After a statement import: remember it, and tick off the reminder for the month it covers. */
export function noteStatementImported(state, now = new Date()) {
  const f = state.finance;
  // On the 1st–10th you're importing last month's statement; otherwise this month's.
  const key = now.getDate() <= 10 ? monthKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)) : monthKeyOf(now);
  f.statementUploads = { ...(f.statementUploads || {}), [key]: now.toISOString() };
  for (const t of state.tasks) if (t.id === `stmt-${key}` && !t.done) { t.done = true; t.doneAt = now.toISOString(); }
  return key;
}
