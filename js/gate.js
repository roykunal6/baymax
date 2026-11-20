// Security after sign-in, in this order:
//   1. Two-step code, when two-step sign-in is on (Supabase MFA, authenticator app / TOTP).
//   2. Encryption keys: create them (first device), unlock them with the passphrase or recovery code
//      (new device), or load them from this device.
//   3. Screen lock: Face ID / Touch ID or the passphrase when Baymax opens or after time away.
// Screens render as a card in #lock (before the app starts, or when locked) or in the #secure dialog
// (Settings). Also: sign out (this device / everywhere) and forgetting a device whose session ended.

import {
  createKeyring, unlockWithPassphrase, unlockWithRecoveryCode, changePassphrase, newRecoveryCode,
  passphraseProblem, sealJSON, openJSON, b64, unb64, randomBytes,
} from './vault.js';
import { loadKeys, saveKeys, clearKeys, updateKeys } from './keystore.js';
import { avatarSVG } from './avatar.js';
import { cloud } from './cloud.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lockEl = () => document.getElementById('lock');
const LAST_ACTIVE = 'baymax:last-active';
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- screen renderer
function shake(form) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }

/**
 * Render one step as a card and wait for it.
 * spec: { title, text (trusted HTML), html (trusted HTML), fields: [{name, label, type, inputmode, placeholder}],
 *         submit, busy, alt: [{label, run(ui), style}], onSubmit(values, ui), ready(form, ui), avatar }
 * onSubmit returns a string to show as an error and stay, anything else to finish with that value.
 */
function screen(container, spec) {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'lock-card';
    form.autocomplete = 'off';
    form.noValidate = false;
    form.innerHTML = `
      ${spec.avatar ? `<div class="lock-avatar" aria-hidden="true">${avatarSVG({ size: 120 })}</div>` : ''}
      <h1>${esc(spec.title)}</h1>
      ${spec.text ? `<p class="muted">${spec.text}</p>` : ''}
      ${spec.html || ''}
      ${(spec.fields || []).map((f) => `<label>${esc(f.label)}<input name="${f.name}" type="${f.type || 'password'}" autocomplete="${f.autocomplete || 'off'}" autocapitalize="off" spellcheck="false" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.optional ? '' : 'required'}></label>`).join('')}
      <p class="lock-error" role="alert"></p>
      ${spec.submit ? `<button type="submit" class="btn primary block">${esc(spec.submit)}</button>` : ''}
      ${(spec.alt || []).map((a, i) => `<button type="button" class="${a.style === 'button' ? 'btn block' : a.style === 'primary' ? 'btn primary block' : 'link lock-forgot'}" data-alt="${i}">${esc(a.label)}</button>`).join('')}`;
    const err = form.querySelector('.lock-error');
    const submitBtn = form.querySelector('button[type=submit]');
    const ui = {
      form,
      error(m) { err.textContent = m || ''; if (m) shake(form); },
      busy(label) {
        form.querySelectorAll('button').forEach((b) => { b.disabled = !!label; });
        if (submitBtn) submitBtn.textContent = label || spec.submit;
      },
      done: resolve,
    };
    const values = () => Object.fromEntries([...form.querySelectorAll('input[name]')].map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      ui.error('');
      ui.busy(spec.busy || 'Working…');
      let r;
      try { r = await spec.onSubmit(values(), ui); } catch (x) { r = friendly(x); }
      ui.busy(null);
      if (typeof r === 'string') { ui.error(r); form.querySelector('input[type=password],input[type=text]')?.select?.(); return; }
      resolve(r);
    });
    form.querySelectorAll('[data-alt]').forEach((b) => b.addEventListener('click', async () => {
      const a = spec.alt[b.dataset.alt];
      ui.error('');
      try {
        const r = await a.run(ui);
        if (typeof r === 'string' && r.startsWith('!')) ui.error(r.slice(1));
        else if (r !== undefined) resolve(r);
      } catch (x) { ui.error(friendly(x)); }
    }));
    container.replaceChildren(form);
    spec.ready?.(form, ui);
    if (matchMedia('(pointer: fine)').matches) form.querySelector('input:not([type=checkbox])')?.focus();
  });
}

function friendly(x) {
  const m = String(x?.message || x || '');
  if (/fetch|network|offline|Failed to/i.test(m)) return 'No internet connection. Connect and try again.';
  return m || 'Something went wrong. Try again.';
}

function showLockLayer() {
  document.body.classList.add('locked');
  lockEl().hidden = false;
}
function hideLockLayer() {
  lockEl().hidden = true;
  document.body.classList.remove('locked');
}

/** Wrong-guess brake: after 5 wrong tries, wait 30 seconds (on top of ~1 s per try from key stretching). */
const brake = { fails: 0, until: 0 };
function braked() { return Date.now() < brake.until ? `Too many tries. Wait ${Math.ceil((brake.until - Date.now()) / 1000)} seconds.` : null; }
function wrong(msg) { if (++brake.fails >= 5) { brake.fails = 0; brake.until = Date.now() + 30000; } return msg; }
function right() { brake.fails = 0; }

// ---------------------------------------------------------------- keyring in the cloud
async function fetchKeyring(client) {
  const { data, error } = await client.from('records').select('data').eq('coll', 'doc').eq('id', 'keyring').maybeSingle();
  if (error) throw new Error(/JWT|auth|permission|policy/i.test(error.message) ? 'Your session needs a fresh sign-in.' : error.message);
  return data?.data || null;
}
async function insertKeyring(client, userId, keyring) {
  const { error } = await client.from('records').insert({ user_id: userId, coll: 'doc', id: 'keyring', data: keyring, deleted: false, updated_at: now() });
  if (error && (error.code === '23505' || /duplicate/i.test(error.message))) return false;
  if (error) throw new Error(error.message);
  return true;
}
async function saveKeyring(client, keyring) {
  const { error } = await client.from('records').update({ data: keyring, updated_at: now() }).eq('coll', 'doc').eq('id', 'keyring');
  if (error) throw new Error(error.message);
}
/** The newest keyring: from the cloud when online (passphrase may have changed on another device), else this device's copy. */
async function latestKeyring(dev) {
  try {
    const k = await fetchKeyring(cloud.client);
    if (k && JSON.stringify(k) !== JSON.stringify(dev.keyring)) { dev.keyring = k; await updateKeys({ keyring: k }); }
  } catch { /* offline: use this device's copy */ }
  return dev.keyring;
}

function deviceRecord(userId, keys, keyring, prev = {}) {
  return { ...prev, userId, dek: keys.dek, privateKey: keys.privateKey, mailKey: keys.mailKey, keyring };
}

/** For sync: seal before upload, open after download. */
export function cipherFor(keys) {
  return { seal: (v) => sealJSON(keys.dek, v), open: (d) => openJSON(keys, d), encrypted: true };
}

// ---------------------------------------------------------------- 1. two-step code
async function secondStep(client) {
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !(data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2')) return;
  const { data: f } = await client.auth.mfa.listFactors();
  const factor = (f?.totp || []).find((x) => x.status === 'verified');
  if (!factor) return;
  showLockLayer();
  await screen(lockEl(), {
    avatar: true,
    title: 'Two-step sign-in',
    text: 'Enter the 6-digit code from your authenticator app.',
    fields: [{ name: 'code', label: 'Code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' }],
    submit: 'Verify', busy: 'Checking…',
    alt: [{ label: 'Sign out', run: () => signOut({ reload: true }) }],
    onSubmit: async ({ code }) => {
      const b = braked(); if (b) return b;
      const { error: e } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\D/g, '') });
      if (e) return wrong(/fetch|network/i.test(e.message) ? friendly(e) : 'That code isn’t right. Codes change every 30 seconds.');
      right();
      return true;
    },
  });
}

// ---------------------------------------------------------------- 2. keys
const PASS_TIP = '<p class="hint">Use 4 random words and a number, e.g. “mango river 47 window”. Keep it different from your sign-in password, and save it in your password manager.</p>';

async function setupKeys(client, user) {
  const L = lockEl();
  let made = null;
  const r = await screen(L, {
    avatar: true,
    title: 'Lock your data',
    text: 'Choose a passphrase. Everything Baymax saves to the cloud is encrypted on this device first, so only your passphrase can read it. Supabase, Netlify, and anyone who gets a copy of the database see only scrambled data.',
    html: PASS_TIP,
    fields: [{ name: 'p1', label: 'Passphrase (12+ characters)' }, { name: 'p2', label: 'Repeat passphrase' }],
    submit: 'Create my keys', busy: 'Creating keys…',
    alt: [{ label: 'Sign out', run: () => signOut({ reload: true }) }],
    onSubmit: async ({ p1, p2 }) => {
      const why = passphraseProblem(p1); if (why) return why;
      if (p1 !== p2) return 'The two passphrases don’t match.';
      made = await createKeyring(p1);
      return { exists: !(await insertKeyring(client, user.id, made.keyring)) };
    },
  });
  if (r.exists) return unlockKeys(client, user, await fetchKeyring(client)); // set up on another device meanwhile
  await showRecoveryCode(L, made.recoveryCode, 'Save your recovery code');
  const dev = deviceRecord(user.id, made.keys, made.keyring);
  await saveKeys(dev);
  return dev;
}

function showRecoveryCode(container, code, title) {
  return screen(container, {
    title,
    text: 'If you forget your passphrase, this code is the only other way to unlock your data. Save it in your password manager or print it. Baymax won’t show it again.',
    html: `<div class="recovery-code" aria-label="Recovery code">${esc(code)}</div>
      <button type="button" class="btn block" data-copy>Copy code</button>
      <label class="check"><input type="checkbox" name="saved"> I’ve saved my recovery code somewhere safe</label>`,
    submit: 'Continue',
    ready(form) {
      form.querySelector('[data-copy]').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select the code above and copy it'; }
      });
    },
    onSubmit: async ({ saved }) => (saved ? true : 'Tick the box once you’ve saved the code.'),
  });
}

async function unlockKeys(client, user, keyring) {
  const L = lockEl();
  for (;;) {
    const r = await screen(L, {
      avatar: true,
      title: 'Unlock your data',
      text: 'Enter your Baymax passphrase to decrypt your data on this device. You only need to do this once per device.',
      fields: [{ name: 'p', label: 'Passphrase' }],
      submit: 'Unlock', busy: 'Unlocking…',
      alt: [{ label: 'Forgot it? Use your recovery code', run: async () => 'recovery' }, { label: 'Sign out', run: () => signOut({ reload: true }) }],
      onSubmit: async ({ p }) => {
        const b = braked(); if (b) return b;
        try { const u = await unlockWithPassphrase(keyring, p); right(); return u; } catch { return wrong('That passphrase isn’t right.'); }
      },
    });
    if (r !== 'recovery') {
      const dev = deviceRecord(user.id, r.keys, keyring);
      await saveKeys(dev);
      return dev;
    }
    const rec = await screen(L, {
      title: 'Use your recovery code',
      text: 'Enter the 25-character code you saved when you set up encryption. Dashes and spaces don’t matter.',
      fields: [{ name: 'c', label: 'Recovery code', type: 'text', placeholder: 'ABCDE-FGHJK-…' }],
      submit: 'Unlock', busy: 'Unlocking…',
      alt: [{ label: 'Back', run: async () => 'back' }],
      onSubmit: async ({ c }) => {
        const b = braked(); if (b) return b;
        try { const u = await unlockWithRecoveryCode(keyring, c); right(); return u; } catch { return wrong('That recovery code isn’t right.'); }
      },
    });
    if (rec === 'back') continue;
    const newRing = await screen(L, {
      title: 'Choose a new passphrase',
      text: 'Your data is unlocked. Set a new passphrase for your devices. Your recovery code stays the same.',
      html: PASS_TIP,
      fields: [{ name: 'p1', label: 'New passphrase (12+ characters)' }, { name: 'p2', label: 'Repeat passphrase' }],
      submit: 'Save passphrase', busy: 'Saving…',
      onSubmit: async ({ p1, p2 }) => {
        const why = passphraseProblem(p1); if (why) return why;
        if (p1 !== p2) return 'The two passphrases don’t match.';
        const k = await changePassphrase(keyring, rec.dekRaw, p1);
        await saveKeyring(client, k);
        return k;
      },
    });
    const dev = deviceRecord(user.id, rec.keys, newRing);
    await saveKeys(dev);
    return dev;
  }
}

// ---------------------------------------------------------------- 3. screen lock
const lockMinutes = (dev) => Number(dev?.lock?.minutes ?? 5);
function lastActive() { try { return Number(localStorage.getItem(LAST_ACTIVE)) || 0; } catch { return 0; } }
function touch() { try { localStorage.setItem(LAST_ACTIVE, String(Date.now())); } catch { /* ignore */ } }
function shouldLock(dev) { return !!dev?.lock?.on && Date.now() - lastActive() >= lockMinutes(dev) * 60000; }

export const platformAuthAvailable = async () => {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
};

/** Register Face ID / Touch ID / Windows Hello for this device. Returns the credential id. */
async function registerBiometric(email) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Baymax', id: location.hostname },
      user: { id: randomBytes(16), name: email || 'baymax', displayName: 'Baymax screen lock' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
    },
  });
  return b64(cred.rawId);
}
async function verifyBiometric(credId) {
  const a = await navigator.credentials.get({
    publicKey: { challenge: randomBytes(32), allowCredentials: [{ type: 'public-key', id: unb64(credId) }], userVerification: 'required', timeout: 60000 },
  });
  return !!a;
}

let locked = false;
async function lockScreen(dev) {
  if (locked) return;
  locked = true;
  showLockLayer();
  const bio = dev.lock?.credId;
  await screen(lockEl(), {
    avatar: true,
    title: 'Baymax is locked',
    text: bio ? 'Unlock with Face ID / Touch ID, or your passphrase.' : 'Enter your passphrase to continue.',
    fields: [{ name: 'p', label: 'Passphrase', optional: !!bio }],
    submit: 'Unlock with passphrase', busy: 'Checking…',
    alt: [
      ...(bio ? [{ label: 'Unlock with Face ID / Touch ID', style: 'primary', run: async () => ((await verifyBiometric(bio).catch(() => false)) ? true : '!That didn’t work. Try again or use your passphrase.') }] : []),
      { label: 'Sign out', run: () => signOut({ reload: true }) },
    ],
    onSubmit: async ({ p }) => {
      if (!p) return 'Enter your passphrase.';
      const b = braked(); if (b) return b;
      // The newest keyring when online, so a passphrase changed on another device takes effect here too.
      try { await unlockWithPassphrase(await latestKeyring(dev), p); right(); return true; } catch { return wrong('That passphrase isn’t right.'); }
    },
  });
  touch();
  hideLockLayer();
  locked = false;
}

let watching = false;
function watchScreenLock() {
  if (watching) return;
  watching = true;
  let t = 0;
  const activity = () => { if (!locked && Date.now() - t > 5000) { t = Date.now(); touch(); } };
  addEventListener('pointerdown', activity, { passive: true });
  addEventListener('keydown', activity, { passive: true });
  const check = async () => { const dev = await loadKeys(); if (shouldLock(dev)) lockScreen(dev); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (!locked) touch(); } else check(); });
  setInterval(() => { if (!document.hidden && !locked) loadKeys().then((dev) => { if (dev?.lock?.on && Date.now() - lastActive() >= Math.max(lockMinutes(dev), 5) * 60000) lockScreen(dev); }); }, 30000);
}

// ---------------------------------------------------------------- entry point
/**
 * Run after Supabase sign-in, before the app starts. Resolves with this device's keys
 * ({dek, privateKey, mailKey, keyring, lock}) once everything is unlocked.
 */
export async function openGate(client, user) {
  await secondStep(client);
  let dev = await loadKeys();
  if (dev && dev.userId !== user.id) { await clearKeys(); dev = null; }
  if (!dev?.dek) {
    showLockLayer();
    let keyring;
    for (;;) {
      try { keyring = await fetchKeyring(client); break; } catch (e) {
        await screen(lockEl(), { avatar: true, title: 'Can’t reach Baymax’s cloud', text: esc(friendly(e)), submit: 'Try again', onSubmit: async () => true, alt: [{ label: 'Sign out', run: () => signOut({ reload: true }) }] });
      }
    }
    dev = keyring ? await unlockKeys(client, user, keyring) : await setupKeys(client, user);
    touch(); // just proved who you are
  } else if (shouldLock(dev)) {
    await lockScreen(dev);
  }
  hideLockLayer();
  watchScreenLock();
  cloud.keys = dev;
  return dev;
}

// ---------------------------------------------------------------- sign out / forget this device
/** Remove everything Baymax keeps on this device: data, sync state, keys. */
export async function forgetDevice() {
  try { cloud.offSave?.(); cloud.sync?.stop(); } catch { /* ignore */ }
  await clearKeys();
  try {
    for (const k of Object.keys(localStorage)) if (/^(voice-assistant|baymax)/.test(k)) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch { /* ignore */ }
}

/** Sign out this device (or every device). Unsynced changes are sent first when possible. */
export async function signOut({ everywhere = false, reload = false } = {}) {
  try { if (cloud.sync && cloud.sync.pending()) await Promise.race([cloud.sync.push(), new Promise((r) => setTimeout(r, 4000))]); } catch { /* ignore */ }
  cloud.signingOut = true;
  try { await cloud.client?.auth.signOut({ scope: everywhere ? 'global' : 'local' }); } catch { /* ignore */ }
  await forgetDevice();
  if (reload) location.reload();
}

// ---------------------------------------------------------------- Settings → Privacy & security
function dialog() {
  let d = document.getElementById('secure');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'secure';
    d.className = 'sheet secure';
    d.innerHTML = '<div class="secure-body"></div>';
    document.body.append(d);
  }
  return d;
}
/** Run screens inside the settings dialog; closes it afterwards. */
async function inDialog(fn) {
  const d = dialog();
  const body = d.querySelector('.secure-body');
  if (!d.open) d.showModal();
  try { return await fn(body); } finally { d.close(); body.replaceChildren(); }
}
const cancel = { label: 'Cancel', run: async () => 'cancel' };

async function changePassphraseFlow(toast) {
  const dev = cloud.keys;
  const r = await inDialog((body) => screen(body, {
    title: 'Change passphrase',
    text: 'Your data stays as it is; only the key that unlocks it changes. Other devices keep working.',
    html: PASS_TIP,
    fields: [{ name: 'cur', label: 'Current passphrase' }, { name: 'p1', label: 'New passphrase (12+ characters)' }, { name: 'p2', label: 'Repeat new passphrase' }],
    submit: 'Change passphrase', busy: 'Saving…', alt: [cancel],
    onSubmit: async ({ cur, p1, p2 }) => {
      const b = braked(); if (b) return b;
      const why = passphraseProblem(p1); if (why) return why;
      if (p1 !== p2) return 'The two new passphrases don’t match.';
      const ring = await fetchKeyring(cloud.client);
      let u;
      try { u = await unlockWithPassphrase(ring, cur); right(); } catch { return wrong('Your current passphrase isn’t right.'); }
      const k = await changePassphrase(ring, u.dekRaw, p1);
      await saveKeyring(cloud.client, k);
      dev.keyring = k;
      await updateKeys({ keyring: k });
      return { ok: true };
    },
  }));
  if (r?.ok) toast('Passphrase changed');
}

async function newRecoveryFlow(toast) {
  const dev = cloud.keys;
  await inDialog(async (body) => {
    const r = await screen(body, {
      title: 'New recovery code',
      text: 'Your old recovery code will stop working. Enter your passphrase to continue.',
      fields: [{ name: 'p', label: 'Passphrase' }],
      submit: 'Make a new code', busy: 'Working…', alt: [cancel],
      onSubmit: async ({ p }) => {
        const b = braked(); if (b) return b;
        const ring = await fetchKeyring(cloud.client);
        let u;
        try { u = await unlockWithPassphrase(ring, p); right(); } catch { return wrong('That passphrase isn’t right.'); }
        const made = await newRecoveryCode(ring, u.dekRaw);
        await saveKeyring(cloud.client, made.keyring);
        dev.keyring = made.keyring;
        await updateKeys({ keyring: made.keyring });
        return { code: made.recoveryCode };
      },
    });
    if (r === 'cancel') return;
    await showRecoveryCode(body, r.code, 'Your new recovery code');
    toast('New recovery code saved');
  });
}

async function mfaFactors() {
  const { data, error } = await cloud.client.auth.mfa.listFactors();
  if (error) throw error;
  return data;
}

async function enableTwoStep(toast) {
  const f = await mfaFactors();
  for (const x of (f.all || []).filter((x) => x.status !== 'verified')) await cloud.client.auth.mfa.unenroll({ factorId: x.id }).catch(() => {});
  const { data, error } = await cloud.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Baymax ${new Date().toISOString().slice(0, 10)}`, issuer: 'Baymax' });
  if (error) throw error;
  const qr = data.totp.qr_code;
  const r = await inDialog((body) => screen(body, {
    title: 'Turn on two-step sign-in',
    text: 'Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or iPhone Passwords), then enter the 6-digit code it shows.',
    html: `<div class="qr">${/^data:image\//.test(qr) ? `<img alt="QR code for your authenticator app" src="${esc(qr)}">` : ''}</div>
      <p class="hint">Can’t scan? Enter this key in the app: <code class="secret-key">${esc(data.totp.secret)}</code></p>`,
    fields: [{ name: 'code', label: 'Code from the app', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' }],
    submit: 'Turn on', busy: 'Checking…', alt: [cancel],
    onSubmit: async ({ code }) => {
      const { error: e } = await cloud.client.auth.mfa.challengeAndVerify({ factorId: data.id, code: code.replace(/\D/g, '') });
      return e ? 'That code isn’t right. Check the time on your phone and try the newest code.' : { ok: true };
    },
  }));
  if (!r?.ok) { await cloud.client.auth.mfa.unenroll({ factorId: data.id }).catch(() => {}); return; }
  toast('Two-step sign-in is on. Other devices will ask for a code next time they open Baymax.');
}

async function disableTwoStep(toast) {
  const f = await mfaFactors();
  const factor = (f.totp || []).find((x) => x.status === 'verified');
  if (!factor) return;
  const r = await inDialog((body) => screen(body, {
    title: 'Turn off two-step sign-in',
    text: 'Enter a code from your authenticator app to confirm. Your account will then only need your password.',
    fields: [{ name: 'code', label: 'Code from the app', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code' }],
    submit: 'Turn off', busy: 'Checking…', alt: [cancel],
    onSubmit: async ({ code }) => {
      const { error: e } = await cloud.client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\D/g, '') });
      if (e) return 'That code isn’t right.';
      const { error: u } = await cloud.client.auth.mfa.unenroll({ factorId: factor.id });
      return u ? u.message : { ok: true };
    },
  }));
  if (r?.ok) toast('Two-step sign-in is off');
}

/** Change screen-lock settings, always starting from what's saved (never a stale copy). */
async function setLock(patch) {
  const cur = (await loadKeys()) || {};
  const lock = { ...(cur.lock || {}), ...patch };
  for (const k of Object.keys(lock)) if (lock[k] === undefined) delete lock[k];
  await updateKeys({ lock });
  if (cloud.keys) cloud.keys.lock = lock;
}

const MINUTES = [[0, 'Immediately'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [60, 'After 1 hour']];

/** Render the Privacy & security card. */
export async function renderSecurity(el, toast) {
  if (!el || !cloud.client || !cloud.keys) { if (el) el.closest('.card').hidden = true; return; }
  const dev = (await loadKeys()) || cloud.keys;
  let twoStep = null;
  try { twoStep = ((await mfaFactors()).totp || []).some((x) => x.status === 'verified'); } catch { /* offline */ }
  const bioOK = await platformAuthAvailable();
  const lock = dev.lock || {};
  el.innerHTML = `
    <p class="hint"><strong>End-to-end encryption is on.</strong> Your data is encrypted on this device before it syncs; the cloud only stores scrambled data. Bank alerts are encrypted by the server with your public key, and your Zoho connection only works with a key from your unlocked devices.</p>
    <div class="btn-row">
      <button class="btn" type="button" data-sec="pass">Change passphrase</button>
      <button class="btn" type="button" data-sec="recovery">New recovery code</button>
    </div>
    <h4>Two-step sign-in</h4>
    <p class="hint">${twoStep === null ? 'Connect to the internet to see this setting.' : twoStep ? 'On. Signing in on a new device needs your password and a code from your authenticator app. The database refuses access without it.' : 'Off. Turn it on so a stolen password alone can’t open your account.'}</p>
    ${twoStep === null ? '' : `<button class="btn ${twoStep ? '' : 'primary'}" type="button" data-sec="${twoStep ? 'mfa-off' : 'mfa-on'}">${twoStep ? 'Turn off' : 'Turn on two-step sign-in'}</button>`}
    <h4>Screen lock</h4>
    <label class="check"><input type="checkbox" data-sec="lock-on" ${lock.on ? 'checked' : ''}> Lock Baymax when I’m away</label>
    <label>Lock <select data-sec="lock-min" ${lock.on ? '' : 'disabled'}>${MINUTES.map(([v, l]) => `<option value="${v}" ${Number(lock.minutes ?? 5) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${bioOK ? `<label class="check"><input type="checkbox" data-sec="bio" ${lock.credId ? 'checked' : ''} ${lock.on ? '' : 'disabled'}> Unlock with Face ID / Touch ID</label>` : '<p class="hint">Face ID / Touch ID isn’t available in this browser; you’ll unlock with your passphrase.</p>'}
    <h4>Devices</h4>
    <p class="hint">Lost a phone or laptop? Sign out everywhere. Each device erases its copy of your data and keys as soon as it notices (within about 15 minutes), and has to sign in, pass two-step and enter your passphrase again.</p>
    <button class="btn danger" type="button" data-sec="everywhere">Sign out everywhere</button>`;

  const q = (k) => el.querySelector(`[data-sec="${k}"]`);
  const run = (fn) => async () => { try { await fn(toast); } catch (e) { toast(friendly(e)); } renderSecurity(el, toast); };
  q('pass').onclick = run(changePassphraseFlow);
  q('recovery').onclick = run(newRecoveryFlow);
  if (q('mfa-on')) q('mfa-on').onclick = run(enableTwoStep);
  if (q('mfa-off')) q('mfa-off').onclick = run(disableTwoStep);
  q('lock-on').onchange = async (e) => {
    await setLock({ on: e.target.checked, minutes: Number(q('lock-min').value) });
    touch();
    toast(e.target.checked ? 'Screen lock on' : 'Screen lock off');
    renderSecurity(el, toast);
  };
  q('lock-min').onchange = async (e) => { await setLock({ minutes: Number(e.target.value) }); toast('Saved'); };
  if (q('bio')) q('bio').onchange = async (e) => {
    if (e.target.checked) {
      try {
        const credId = await registerBiometric(cloud.user?.email);
        await setLock({ credId });
        toast('Face ID / Touch ID unlock is on');
      } catch { toast('Face ID / Touch ID wasn’t set up'); }
    } else {
      await setLock({ credId: undefined });
    }
    renderSecurity(el, toast);
  };
  const everywhere = q('everywhere');
  everywhere.onclick = async () => {
    if (everywhere.dataset.armed !== '1') {
      everywhere.dataset.armed = '1';
      everywhere.textContent = 'Tap again to sign out every device';
      setTimeout(() => { everywhere.dataset.armed = ''; everywhere.textContent = 'Sign out everywhere'; }, 4000);
      return;
    }
    everywhere.disabled = true;
    await signOut({ everywhere: true, reload: true });
  };
}
