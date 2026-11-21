import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals for the sync module.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

const { createSync, snapshot, diff, applyRow, isPristine } = await import('../js/sync.js');

/** In-memory stand-in for Supabase: one table, realtime fan-out, server timestamps. */
function fakeCloud() {
  const rows = new Map();
  let clock = 0;
  const listeners = new Set();
  const client = () => ({
    from() {
      return {
        upsert(list) {
          for (const r of list) {
            const row = { ...r, server_at: new Date(Date.UTC(2026, 10, 20, 12, 0, ++clock)).toISOString() };
            rows.set(`${r.coll}:${r.id}`, row);
            for (const fn of listeners) fn({ new: row });
          }
          return Promise.resolve({ error: null });
        },
        select(_cols, opts) {
          const q = {
            _gt: null, _range: [0, 999],
            order() { return q; }, range(a, b) { q._range = [a, b]; return q; }, gt(_c, v) { q._gt = v; return q; }, neq(_c, v) { q._neq = v; return q; },
            then(res, rej) {
              const all = [...rows.values()].filter((r) => (!q._gt || r.server_at > q._gt) && (!q._neq || r.id !== q._neq)).sort((a, b) => a.server_at.localeCompare(b.server_at));
              const out = opts?.head ? { count: all.length, error: null } : { data: all.slice(q._range[0], q._range[1] + 1), error: null };
              return Promise.resolve(out).then(res, rej);
            },
          };
          return q;
        },
      };
    },
    channel() {
      const ch = { on(_e, _f, fn) { ch.fn = fn; return ch; }, subscribe(cb) { listeners.add(ch.fn); cb?.('SUBSCRIBED'); return ch; } };
      return ch;
    },
    removeChannel() {},
  });
  return { rows, client };
}

const blank = () => ({
  tasks: [], notes: [], routines: [{ id: 'r-' + Math.random(), name: 'Morning briefing', actions: [] }],
  habits: [{ id: 'h-' + Math.random(), name: 'Drink water', log: {} }], history: [], log: [],
  settings: { name: '' },
  finance: { income: 0, budget: 0, categoryBudgets: {}, remindDays: 2, spends: [], credits: [], cards: [], obligations: [], invoices: [], holdings: [], bankInbox: [], zerodha: {} },
});

function device(cloud, state, key) {
  let remoteHits = 0;
  const sync = createSync({ client: cloud.client(), userId: 'u1', state, persist: () => {}, onRemote: () => { remoteHits++; }, metaKey: key });
  return { state, sync, remote: () => remoteHits };
}

test('snapshot/diff/applyRow basics', () => {
  const s = blank();
  const a = snapshot(s);
  s.tasks.push({ id: 't1', title: 'x' });
  const d = diff(a, snapshot(s));
  assert.deepEqual(d.changed, ['tasks:t1']);
  assert.equal(applyRow(s, { coll: 'tasks', id: 't1', deleted: true }), true);
  assert.equal(s.tasks.length, 0);
  assert.equal(applyRow(s, { coll: 'doc', id: 'money', data: { income: 5 } }), true);
  assert.equal(s.finance.income, 5);
  assert.equal(isPristine(blank()), true);
});

test('two devices stay in sync, new device does not duplicate starter items', async () => {
  const cloud = fakeCloud();
  // Phone already has real data.
  const phoneState = blank();
  phoneState.tasks.push({ id: 't1', title: 'Call Ravi' });
  phoneState.finance.spends.push({ id: 's1', amount: 450, note: 'lunch', date: '2026-11-20' });
  phoneState.finance.budget = 40000;
  const phone = device(cloud, phoneState, 'meta-phone');
  await phone.sync.start();
  assert.ok(cloud.rows.has('tasks:t1') && cloud.rows.has('spends:s1') && cloud.rows.has('doc:money'));

  // Desktop signs in for the first time.
  const desk = device(cloud, blank(), 'meta-desk');
  await desk.sync.start();
  assert.deepEqual(desk.state.tasks.map((t) => t.title), ['Call Ravi']);
  assert.equal(desk.state.finance.spends[0].amount, 450);
  assert.equal(desk.state.finance.budget, 40000);
  assert.equal(desk.state.habits.length, 1, 'only the phone’s habit, not a duplicate starter');
  assert.equal(desk.state.routines.length, 1);

  // Desktop adds a note → phone receives it in real time.
  desk.state.notes.push({ id: 'n1', text: 'Container lands Friday' });
  desk.sync.noteLocalChange();
  await desk.sync.push();
  assert.deepEqual(phone.state.notes.map((n) => n.text), ['Container lands Friday']);

  // Phone completes the task and deletes the spend → desktop follows.
  phone.state.tasks[0].done = true;
  phone.state.finance.spends = [];
  phone.sync.noteLocalChange();
  await phone.sync.push();
  assert.equal(desk.state.tasks[0].done, true);
  assert.equal(desk.state.finance.spends.length, 0);
  assert.equal(phone.sync.pending(), 0);
  assert.equal(desk.sync.pending(), 0);
});

test('offline edits upload when back online, and pull catches up missed changes', async () => {
  const cloud = fakeCloud();
  const a = device(cloud, blank(), 'meta-a');
  const b = device(cloud, blank(), 'meta-b');
  await a.sync.start();
  await b.sync.start();
  navigator.onLine = false;
  a.state.tasks.push({ id: 'off', title: 'Written offline' });
  a.sync.noteLocalChange();
  await a.sync.push(); // no-op offline
  assert.equal(a.sync.pending(), 1);
  navigator.onLine = true;
  await a.sync.push();
  assert.equal(a.sync.pending(), 0);
  assert.ok(b.state.tasks.some((t) => t.title === 'Written offline'));
});

test('end-to-end encrypted sync: cloud holds only ciphertext, old plaintext is replaced', async () => {
  const { createKeyring, unlockWithPassphrase, sealJSON, openJSON } = await import('../js/vault.js');
  const cloud = fakeCloud();
  // Before encryption: a readable row already in the cloud.
  cloud.rows.set('notes:old', { user_id: 'u1', coll: 'notes', id: 'old', data: { id: 'old', text: 'readable before' }, deleted: false, updated_at: '2026-11-01T00:00:00.000Z', server_at: '2026-11-01T00:00:00.000Z' });
  const { keyring, keys } = await createKeyring('mango river 47 window', { rounds: 1000 });
  const cipherFor = (k) => ({ seal: (v) => sealJSON(k.dek, v), open: (d) => openJSON(k, d), encrypted: true });

  const phoneState = blank();
  phoneState.finance.spends.push({ id: 's9', amount: 45250, note: 'ICICI home loan', date: '2026-11-05' });
  const phone = createSync({ client: cloud.client(), userId: 'u1', state: phoneState, persist: () => {}, onRemote: () => {}, metaKey: 'meta-enc-phone', cipher: cipherFor(keys) });
  await phone.start();
  await phone.push();
  const stored = JSON.stringify([...cloud.rows.values()].map((r) => r.data));
  assert.ok(!stored.includes('ICICI') && !stored.includes('45250') && !stored.includes('readable before'), 'no readable data left in the cloud');
  assert.ok([...cloud.rows.values()].every((r) => r.deleted || r.data?.e === 1));
  assert.ok(phoneState.notes.some((n) => n.text === 'readable before'), 'old note still on the phone, now encrypted in the cloud');

  // Desktop unlocks with the passphrase and reads everything.
  const { keys: deskKeys } = await unlockWithPassphrase(keyring, 'mango river 47 window');
  const deskState = blank();
  const desk = createSync({ client: cloud.client(), userId: 'u1', state: deskState, persist: () => {}, onRemote: () => {}, metaKey: 'meta-enc-desk', cipher: cipherFor(deskKeys) });
  await desk.start();
  assert.equal(deskState.finance.spends[0].note, 'ICICI home loan');

  // Someone with the wrong key sees nothing usable (rows are skipped, not crashing).
  const { keys: wrong } = await createKeyring('a totally different one', { rounds: 1000 });
  const thief = blank();
  const t = createSync({ client: cloud.client(), userId: 'u1', state: thief, persist: () => {}, onRemote: () => {}, metaKey: 'meta-enc-thief', cipher: cipherFor(wrong) });
  await t.pull();
  assert.equal(thief.finance.spends.length, 0);
});
