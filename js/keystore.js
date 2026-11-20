// Keeps this device's unlocked keys in IndexedDB. The data key and private key are stored as
// non-extractable CryptoKeys: the browser can use them, but no script can read their bytes.

const DB = 'baymax-vault';
const STORE = 'keys';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(out?.result ?? out); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}

/** {dek, privateKey, mailKey, keyring, userId} or null */
export async function loadKeys() {
  try {
    return await new Promise((res, rej) => {
      open().then((db) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get('device');
        r.onsuccess = () => { db.close(); res(r.result || null); };
        r.onerror = () => { db.close(); rej(r.error); };
      }, rej);
    });
  } catch { return null; }
}

export async function saveKeys(record) {
  return tx('readwrite', (s) => s.put(record, 'device'));
}

export async function clearKeys() {
  try { await tx('readwrite', (s) => s.delete('device')); } catch { /* ignore */ }
}

/** Device-only settings stored next to the keys (Face ID credential id, auto-lock minutes). */
export async function updateKeys(patch) {
  const cur = (await loadKeys()) || {};
  await saveKeys({ ...cur, ...patch });
}
