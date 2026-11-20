// Cloud sync: every task, note, spend, EMI, invoice… is one row in Supabase's `records` table.
// Offline-first: the app always reads and writes local state; this module pushes local changes
// and applies remote ones (pull on start/focus/online + realtime updates).
//
// Pure helpers (collections, snapshot, diff, applyRow) are unit-tested in tests/sync.test.mjs;
// createSync() wires them to a Supabase client.

/** Lists that sync item-by-item. Each item must have a string `id`. */
export const COLLECTIONS = {
  tasks: { get: (s) => s.tasks, set: (s, v) => { s.tasks = v; } },
  notes: { get: (s) => s.notes, set: (s, v) => { s.notes = v; } },
  routines: { get: (s) => s.routines, set: (s, v) => { s.routines = v; } },
  habits: { get: (s) => s.habits, set: (s, v) => { s.habits = v; } },
  spends: { get: (s) => s.finance.spends, set: (s, v) => { s.finance.spends = v; } },
  credits: { get: (s) => s.finance.credits, set: (s, v) => { s.finance.credits = v; } },
  obligations: { get: (s) => s.finance.obligations, set: (s, v) => { s.finance.obligations = v; } },
  invoices: { get: (s) => s.finance.invoices, set: (s, v) => { s.finance.invoices = v; } },
  cards: { get: (s) => s.finance.cards, set: (s, v) => { s.finance.cards = v; } },
  holdings: { get: (s) => s.finance.holdings, set: (s, v) => { s.finance.holdings = v; } },
  bankinbox: { get: (s) => s.finance.bankInbox, set: (s, v) => { s.finance.bankInbox = v; } },
};

/** Single objects that sync as one row each. */
export const DOCS = {
  money: {
    get: (s) => ({ income: s.finance.income, budget: s.finance.budget, categoryBudgets: s.finance.categoryBudgets, remindDays: s.finance.remindDays, zerodha: s.finance.zerodha }),
    set: (s, v) => { Object.assign(s.finance, v); },
  },
  profile: { get: (s) => ({ name: s.settings.name }), set: (s, v) => { if (v && 'name' in v) s.settings.name = v.name; } },
};

// Fields that only matter on the device that set them.
const LOCAL_ONLY = new Set(['_firedStamp']);
const clean = (item) => JSON.parse(JSON.stringify(item, (k, v) => (LOCAL_ONLY.has(k) ? undefined : v)));

/** Small fast string hash (FNV-1a) so snapshots stay small in storage. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + str.length.toString(36);
}

/** Map of "coll:id" → hash of the item's JSON, for every synced item in `state`. */
export function snapshot(state) {
  const out = {};
  for (const [coll, c] of Object.entries(COLLECTIONS)) {
    for (const item of c.get(state) || []) if (item?.id) out[`${coll}:${item.id}`] = hash(JSON.stringify(clean(item)));
  }
  for (const [id, d] of Object.entries(DOCS)) out[`doc:${id}`] = hash(JSON.stringify(d.get(state)));
  return out;
}

/** Keys added/changed and removed between two snapshots. */
export function diff(prev, next) {
  const changed = [], removed = [];
  for (const [k, h] of Object.entries(next)) if (prev[k] !== h) changed.push(k);
  for (const k of Object.keys(prev)) if (!(k in next)) removed.push(k);
  return { changed, removed };
}

/** Current data for a "coll:id" key, or undefined if gone. */
export function readKey(state, key) {
  const [coll, id] = splitKey(key);
  if (coll === 'doc') return DOCS[id]?.get(state);
  return (COLLECTIONS[coll]?.get(state) || []).find((x) => x.id === id);
}

export function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Apply one remote row ({coll, id, data, deleted}) to state. Returns true if state changed. */
export function applyRow(state, row) {
  if (row.coll === 'doc') {
    const d = DOCS[row.id];
    if (!d || row.deleted || !row.data) return false;
    d.set(state, row.data);
    return true;
  }
  const c = COLLECTIONS[row.coll];
  if (!c) return false;
  const list = c.get(state) || [];
  const i = list.findIndex((x) => x.id === row.id);
  if (row.deleted) {
    if (i < 0) return false;
    c.set(state, list.filter((x) => x.id !== row.id));
    return true;
  }
  const local = i >= 0 ? list[i] : null;
  const merged = { ...row.data, id: row.id };
  if (local?._firedStamp) merged._firedStamp = local._firedStamp;
  if (i >= 0) list[i] = merged; else list.push(merged);
  c.set(state, list);
  return true;
}

/** True when a device has nothing of its own yet (only the starter routines and habits). */
export function isPristine(state) {
  const f = state.finance || {};
  const empty = (a) => !a || a.length === 0;
  return empty(state.tasks) && empty(state.notes) && empty(f.spends) && empty(f.obligations) && empty(f.invoices) &&
    empty(f.cards) && empty(f.holdings) && !(state.habits || []).some((h) => Object.keys(h.log || {}).length);
}

// ---------------------------------------------------------------- wiring
const META_KEY = 'baymax:sync';
function loadMeta(key) {
  try { return { cursor: null, snap: null, dirty: {}, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { cursor: null, snap: null, dirty: {} }; }
}
export function resetSyncMeta() { try { localStorage.removeItem(META_KEY); } catch { /* ignore */ } }

/**
 * @param {{client: any, userId: string, state: object, persist: () => void, onRemote: () => void, onStatus?: (s: string) => void}} o
 * persist: write state to local storage without triggering another sync.
 */
export function createSync({ client, userId, state, persist, onRemote, onStatus = () => {}, metaKey = META_KEY }) {
  const meta = loadMeta(metaKey);
  const saveMeta = (m) => { try { localStorage.setItem(metaKey, JSON.stringify(m)); } catch { /* ignore */ } };
  // First run on this device: everything local is new to the server.
  if (!meta.snap) meta.snap = {};
  let pushTimer = null, pushing = false, pulling = false, channel = null;

  /** Call after every local save. Marks changed items as needing upload. */
  function noteLocalChange() {
    const next = snapshot(state);
    const { changed, removed } = diff(meta.snap, next);
    const now = new Date().toISOString();
    for (const k of changed) meta.dirty[k] = { at: now };
    for (const k of removed) meta.dirty[k] = { at: now, deleted: true };
    meta.snap = next;
    saveMeta(meta);
    if (changed.length || removed.length) schedulePush();
  }

  function schedulePush(delay = 600) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay);
  }

  async function push() {
    if (pushing || !navigator.onLine) return;
    const keys = Object.keys(meta.dirty);
    if (!keys.length) return;
    pushing = true;
    onStatus('syncing');
    try {
      for (let i = 0; i < keys.length; i += 200) {
        const batch = keys.slice(i, i + 200);
        const rows = batch.map((k) => {
          const [coll, id] = splitKey(k);
          const d = meta.dirty[k];
          const data = d.deleted ? null : readKey(state, k);
          return { user_id: userId, coll, id, data: data ? clean(data) : null, deleted: !!d.deleted || !data, updated_at: d.at };
        });
        const { error } = await client.from('records').upsert(rows, { onConflict: 'user_id,coll,id' });
        if (error) throw error;
        for (const k of batch) if (meta.dirty[k] && rows.find((r) => `${r.coll}:${r.id}` === k)?.updated_at === meta.dirty[k].at) delete meta.dirty[k];
      }
      saveMeta(meta);
      onStatus('synced');
    } catch (e) {
      onStatus('offline');
      console.warn('Sync push failed', e);
      setTimeout(() => schedulePush(0), 15000);
    } finally {
      pushing = false;
      if (Object.keys(meta.dirty).length) schedulePush(1500);
    }
  }

  /** Apply remote rows; local edits not yet uploaded win if they are newer. */
  function applyRemoteRows(rows) {
    let changed = false;
    for (const row of rows) {
      const key = `${row.coll}:${row.id}`;
      const pending = meta.dirty[key];
      if (pending && pending.at >= row.updated_at) continue;
      if (pending) delete meta.dirty[key];
      if (applyRow(state, row)) {
        changed = true;
        // Remember the applied version as "already in sync" so it isn't uploaded back.
        const item = readKey(state, key);
        if (item) meta.snap[key] = hash(JSON.stringify(row.coll === 'doc' ? item : clean(item))); else delete meta.snap[key];
      }
      if (row.server_at && (!meta.cursor || row.server_at > meta.cursor)) meta.cursor = row.server_at;
    }
    if (changed) {
      persist();
      onRemote();
    }
    saveMeta(meta);
    return changed;
  }

  async function pull() {
    if (pulling || !navigator.onLine) return;
    pulling = true;
    onStatus('syncing');
    try {
      // 5 s overlap: rows from transactions committed slightly out of order are not missed.
      const since = meta.cursor ? new Date(new Date(meta.cursor).getTime() - 5000).toISOString() : null;
      let from = 0;
      for (;;) {
        let q = client.from('records').select('coll,id,data,deleted,updated_at,server_at').order('server_at', { ascending: true }).range(from, from + 999);
        if (since) q = q.gt('server_at', since);
        const { data, error } = await q;
        if (error) throw error;
        applyRemoteRows(data || []);
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      onStatus(Object.keys(meta.dirty).length ? 'syncing' : 'synced');
    } catch (e) {
      onStatus('offline');
      console.warn('Sync pull failed', e);
    } finally {
      pulling = false;
    }
  }

  function subscribe() {
    channel = client.channel('records-' + userId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `user_id=eq.${userId}` }, (p) => {
        if (p.new && p.new.coll) applyRemoteRows([p.new]);
      })
      .subscribe((status) => { if (status === 'SUBSCRIBED') pull(); });
  }

  async function start() {
    if (!meta.initialized) {
      // New device: if the cloud already has data and this device only has the starter examples,
      // drop the examples so they don't arrive as duplicates on the other devices.
      try {
        const { count } = await client.from('records').select('id', { count: 'exact', head: true });
        if (count > 0 && isPristine(state)) { state.routines = []; state.habits = []; persist(); }
        meta.initialized = true;
        saveMeta(meta);
      } catch { /* offline: try again next start */ }
    }
    // Take the cloud's version first, then upload only what is new or edited on this device.
    await pull();
    noteLocalChange();
    await push();
    subscribe();
    globalThis.addEventListener?.('online', () => { pull(); push(); });
    globalThis.document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pull(); push(); } });
  }

  function stop() { if (channel) client.removeChannel(channel); clearTimeout(pushTimer); }

  return { start, stop, noteLocalChange, pull, push, pending: () => Object.keys(meta.dirty).length };
}
