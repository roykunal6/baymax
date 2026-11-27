import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, save, undo, markUserAction, onUndoable, describeChange, addTask, removeTask } from '../js/store.js';

test('undo puts back the last changes you made, in order', () => {
  const labels = [];
  onUndoable((s) => labels.push(s.label));
  markUserAction();
  const t = addTask({ title: 'Call Ravi' });
  markUserAction();
  removeTask(t.id);
  assert.deepEqual(labels.slice(-2), ['Added task “Call Ravi”', 'Deleted task “Call Ravi”']);
  assert.equal(undo().label, 'Deleted task “Call Ravi”');
  assert.ok(state.tasks.some((x) => x.id === t.id), 'task is back');
  assert.equal(undo().label, 'Added task “Call Ravi”');
  assert.ok(!state.tasks.some((x) => x.id === t.id), 'and gone again');
});

test('sync from other devices and background saves are not undo steps', () => {
  while (undo()) { /* empty the stack */ }
  state.tasks.push({ id: 'remote1', title: 'from phone' });
  save({ remote: true });
  assert.equal(undo(), null);
});

test('describes bulk changes', () => {
  const a = JSON.stringify({ finance: { spends: [{ id: 1, amount: 5 }, { id: 2, amount: 6 }] } });
  const b = JSON.stringify({ finance: { spends: [] } });
  assert.equal(describeChange(a, b), 'Deleted 2 spends');
});

test('everything saved after one tap is a single undo step', () => {
  while (undo()) { /* empty */ }
  const n = state.tasks.length;
  markUserAction();
  addTask({ title: 'Mine' });
  addTask({ title: 'Background job' }); // same tap, e.g. a reminder created right after
  const step = undo();
  assert.equal(step.label, 'Added 2 tasks');
  assert.equal(state.tasks.length, n);
  assert.equal(undo(), null);
});
