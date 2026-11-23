import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementDue, ensureStatementTask, noteStatementImported } from '../js/statements.js';

test('month-end statement reminder', () => {
  const st = { tasks: [], finance: {} };
  const mid = new Date(2026, 10, 15, 9);
  assert.equal(statementDue(st.finance, mid), null, 'not mid-month');
  assert.equal(statementDue(st.finance, new Date(2026, 10, 30, 9)).key, '2026-11', 'last day');
  assert.equal(statementDue(st.finance, new Date(2026, 11, 3, 9)).key, '2026-11', 'early next month');
  assert.equal(statementDue(st.finance, new Date(2026, 11, 12, 9)), null, 'gives up after the 10th');

  assert.equal(ensureStatementTask(st, mid), true);
  assert.equal(ensureStatementTask(st, mid), false, 'once a month');
  const t = st.tasks[0];
  assert.equal(t.id, 'stmt-2026-11');
  assert.equal(new Date(t.due).getDate(), 30);
  assert.equal(new Date(t.due).getHours(), 19);
  st.tasks = [];
  assert.equal(ensureStatementTask(st, mid), false, 'deleted reminder isn’t recreated the same month');

  st.tasks = [{ ...t }];
  const key = noteStatementImported(st, new Date(2026, 11, 2, 10));
  assert.equal(key, '2026-11');
  assert.equal(st.tasks[0].done, true);
  assert.equal(statementDue(st.finance, new Date(2026, 11, 3, 9)), null, 'card goes away once uploaded');
});
