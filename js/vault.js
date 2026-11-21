// End-to-end encryption for Baymax's cloud data. Uses only Web Crypto (browser and Node 18+).
//
// Keys
//   DEK      random AES-256-GCM key that encrypts every synced record.
//   KEK      derived from your passphrase (PBKDF2-SHA-256, 600k rounds); wraps the DEK.
//   Recovery derived from a random recovery code; wraps the DEK a second time.
//   Inbox    RSA-OAEP-2048 key pair. The server encrypts new bank alerts with the public key;
//            only your devices (holding the private key, itself encrypted with the DEK) can read them.
//   Mail key random 32 bytes (encrypted with the DEK). The server keeps the Zoho token encrypted
//            with it and only decrypts it in memory when your device sends the mail key.
//
// The keyring (all wrapped keys + public key) is stored in the cloud so a new device can unlock
// with the passphrase. Nothing in it is usable without the passphrase or recovery code.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ROUNDS = 600000;

// ---------------------------------------------------------------- encoding
export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** 25 characters from an unambiguous alphabet, grouped: ABCD-EFGH-…  (~125 bits). */
export function makeRecoveryCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(25);
  const chars = [...bytes].map((b) => A[b % A.length]).join('');
  return chars.match(/.{5}/g).join('-');
}
export const normaliseRecoveryCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------- primitives
async function kekFrom(secret, salt, rounds) {
  const base = await subtle().importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function aesEncrypt(key, bytes) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}
async function aesDecrypt(key, box) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)));
}

export const importDek = (raw, extractable = false) => subtle().importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);

/** Encrypt any JSON value with the DEK → {e:1, iv, ct}. */
export async function sealJSON(dek, value) {
  return { e: 1, ...(await aesEncrypt(dek, enc.encode(JSON.stringify(value)))) };
}

/** Decrypt a sealed value. Inbox items ({e:2}) need the private key. Plain values pass through. */
export async function openJSON(keys, data) {
  if (!data || typeof data !== 'object' || !('e' in data)) return data; // not encrypted (legacy)
  if (data.e === 1) return JSON.parse(dec.decode(await aesDecrypt(keys.dek, data)));
  if (data.e === 2) {
    const raw = await subtle().decrypt({ name: 'RSA-OAEP' }, keys.privateKey, unb64(data.k));
    const aes = await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    return JSON.parse(dec.decode(await aesDecrypt(aes, data)));
  }
  throw new Error('Unknown encryption format');
}

/** Server side: encrypt a value for the owner using only their public key → {e:2, k, iv, ct}. */
export async function sealForPublicKey(publicKeySpkiB64, value) {
  const pub = await subtle().importKey('spki', unb64(publicKeySpkiB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const raw = randomBytes(32);
  const aes = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const box = await aesEncrypt(aes, enc.encode(JSON.stringify(value)));
  const k = await subtle().encrypt({ name: 'RSA-OAEP' }, pub, raw);
  return { e: 2, k: b64(k), ...box };
}

// ---------------------------------------------------------------- keyring
/**
 * Create a new keyring. Returns { keyring (store in the cloud), keys (keep on device), recoveryCode (show once) }.
 */
export async function createKeyring(passphrase, { rounds = PBKDF2_ROUNDS } = {}) {
  const dekRaw = randomBytes(32);
  const dek = await importDek(dekRaw);
  const recoveryCode = makeRecoveryCode();
  const salt = randomBytes(16), rsalt = randomBytes(16);
  const [kek, rkek] = await Promise.all([kekFrom(passphrase, salt, rounds), kekFrom(normaliseRecoveryCode(recoveryCode), rsalt, rounds)]);
  const pair = await subtle().generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const [spki, pkcs8] = await Promise.all([subtle().exportKey('spki', pair.publicKey), subtle().exportKey('pkcs8', pair.privateKey)]);
  const mailKey = randomBytes(32);
  const keyring = {
    v: 1, created: new Date().toISOString(),
    kdf: { alg: 'PBKDF2-SHA256', rounds, salt: b64(salt) },
    dek: await aesEncrypt(kek, dekRaw),
    recovery: { rounds, salt: b64(rsalt), dek: await aesEncrypt(rkek, dekRaw) },
    publicKey: b64(spki),
    privateKey: await aesEncrypt(dek, new Uint8Array(pkcs8)),
    mailKey: await aesEncrypt(dek, mailKey),
  };
  return { keyring, recoveryCode, keys: await keysFromDekRaw(keyring, dekRaw) };
}

async function keysFromDekRaw(keyring, dekRaw) {
  const dek = await importDek(dekRaw);
  const pkcs8 = await aesDecrypt(dek, keyring.privateKey);
  const privateKey = await subtle().importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const mailKey = b64(await aesDecrypt(dek, keyring.mailKey));
  return { dek, privateKey, mailKey };
}

/** Unlock with the passphrase. Throws 'wrong-passphrase' if it doesn't match. */
export async function unlockWithPassphrase(keyring, passphrase) {
  const kek = await kekFrom(passphrase, unb64(keyring.kdf.salt), keyring.kdf.rounds);
  let dekRaw;
  try { dekRaw = await aesDecrypt(kek, keyring.dek); } catch { throw new Error('wrong-passphrase'); }
  return { keys: await keysFromDekRaw(keyring, dekRaw), dekRaw };
}

/** Unlock with the recovery code. Throws 'wrong-recovery-code'. */
export async function unlockWithRecoveryCode(keyring, code) {
  const r = keyring.recovery;
  const kek = await kekFrom(normaliseRecoveryCode(code), unb64(r.salt), r.rounds);
  let dekRaw;
  try { dekRaw = await aesDecrypt(kek, r.dek); } catch { throw new Error('wrong-recovery-code'); }
  return { keys: await keysFromDekRaw(keyring, dekRaw), dekRaw };
}

/** New passphrase for the same data (nothing is re-encrypted). Returns the updated keyring. */
export async function changePassphrase(keyring, dekRaw, newPassphrase, { rounds = PBKDF2_ROUNDS } = {}) {
  const salt = randomBytes(16);
  const kek = await kekFrom(newPassphrase, salt, rounds);
  return { ...keyring, kdf: { alg: 'PBKDF2-SHA256', rounds, salt: b64(salt) }, dek: await aesEncrypt(kek, dekRaw), updated: new Date().toISOString() };
}

/** A fresh recovery code (the old one stops working). */
export async function newRecoveryCode(keyring, dekRaw, { rounds = PBKDF2_ROUNDS } = {}) {
  const recoveryCode = makeRecoveryCode();
  const rsalt = randomBytes(16);
  const rkek = await kekFrom(normaliseRecoveryCode(recoveryCode), rsalt, rounds);
  return { recoveryCode, keyring: { ...keyring, recovery: { rounds, salt: b64(rsalt), dek: await aesEncrypt(rkek, dekRaw) }, updated: new Date().toISOString() } };
}

/** Passphrase rules: at least 12 characters, not all one character class of a dictionary word. */
export function passphraseProblem(p) {
  const s = String(p || '');
  if (s.length < 12) return 'Use at least 12 characters. A few random words work well, e.g. “mango river 47 window”.';
  if (/^(.)\1+$/.test(s)) return 'That passphrase is too predictable.';
  if (/^(password|baymax|qwerty|123456|thestral)/i.test(s.replace(/\s/g, ''))) return 'Avoid common words like “password” or “baymax” at the start.';
  return null;
}

// ---------------------------------------------------------------- server-side helpers (Zoho token)
/** Encrypt a short secret (e.g. Zoho refresh token) with the mail key → "enc1:iv:ct". */
export async function sealWithMailKey(mailKeyB64, text) {
  const key = await subtle().importKey('raw', unb64(mailKeyB64), 'AES-GCM', false, ['encrypt']);
  const box = await aesEncrypt(key, enc.encode(text));
  return `enc1:${box.iv}:${box.ct}`;
}
export async function openWithMailKey(mailKeyB64, sealed) {
  if (!String(sealed).startsWith('enc1:')) return sealed; // stored before encryption was turned on
  const [, iv, ct] = String(sealed).split(':');
  const key = await subtle().importKey('raw', unb64(mailKeyB64), 'AES-GCM', false, ['decrypt']);
  return dec.decode(await aesDecrypt(key, { iv, ct }));
}
