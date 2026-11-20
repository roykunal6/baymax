// Sign-in lock for the app.
//
// This is a static site, so this is a lock screen, not server security: it keeps casual visitors
// out. The user's data never leaves their device either way. Neither the user id nor the password
// is stored in this file: only salted PBKDF2-SHA-256 fingerprints, so the public code doesn't reveal them.
// A password changed in Settings is stored (as a fingerprint) on that device only.

const ITERATIONS = 310000;
const DEFAULT_RECORD = {
  userSalt: 'fe3634a524e3c69dcf762561a55a2ad4',
  user: '87028c422ca9f593554a5e5ec454fd58f0d4816dbe7472b4704d4e22674846cb',
  passSalt: 'a34e2b3ea57da731792976241bf81f02',
  pass: 'f5ceef59a2a89002e63acf55fb37faa51d8eedae16ae30a16961976e24f9d53c',
};

const SESSION_KEY = 'baymax:session';
const OVERRIDE_KEY = 'baymax:auth';
const REMEMBER_DAYS = 30;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));

/** PBKDF2-SHA-256 fingerprint of `text`, as hex. */
export async function fingerprint(text, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(text), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return hex(bits);
}

/** Constant-time-ish comparison of two hex strings. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const normUser = (u) => String(u || '').trim().toLowerCase();

function storage(kind) { try { return kind === 'local' ? localStorage : sessionStorage; } catch { return null; } }

function currentRecord() {
  try {
    const o = JSON.parse(storage('local')?.getItem(OVERRIDE_KEY) || 'null');
    if (o?.pass && o?.passSalt) return { ...DEFAULT_RECORD, pass: o.pass, passSalt: o.passSalt };
  } catch { /* ignore */ }
  return DEFAULT_RECORD;
}

export async function checkCredentials(user, pass, record = currentRecord()) {
  const [u, p] = await Promise.all([fingerprint(normUser(user), record.userSalt), fingerprint(String(pass || ''), record.passSalt)]);
  return same(u, record.user) && same(p, record.pass);
}

export function isUnlocked(now = Date.now()) {
  for (const kind of ['session', 'local']) {
    try {
      const s = JSON.parse(storage(kind)?.getItem(SESSION_KEY) || 'null');
      if (s && s.until > now) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function unlock(remember) {
  const until = Date.now() + (remember ? REMEMBER_DAYS * 86400000 : 12 * 3600000);
  storage(remember ? 'local' : 'session')?.setItem(SESSION_KEY, JSON.stringify({ until }));
}

export function lock() {
  storage('local')?.removeItem(SESSION_KEY);
  storage('session')?.removeItem(SESSION_KEY);
}

/** Change the password on this device. Returns an error message, or null on success. */
export async function changePassword(current, next) {
  if (!(await fingerprintMatchesPass(current))) return 'Your current password is wrong.';
  if (String(next).length < 8) return 'Use at least 8 characters.';
  const passSalt = randomHex();
  const pass = await fingerprint(String(next), passSalt);
  storage('local')?.setItem(OVERRIDE_KEY, JSON.stringify({ pass, passSalt }));
  return null;
}

async function fingerprintMatchesPass(pass) {
  const r = currentRecord();
  return same(await fingerprint(String(pass || ''), r.passSalt), r.pass);
}

/** Forget a password changed on this device (back to the original one). */
export function resetPasswordOverride() { storage('local')?.removeItem(OVERRIDE_KEY); }
