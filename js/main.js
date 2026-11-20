// Entry point: sign in, then start the app.
// With Supabase configured (js/config.js): real accounts checked by the server, plus cloud sync.
// Without it: the local lock screen (js/auth.js) and data stays on this device only.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { isUnlocked, unlock, checkCredentials } from './auth.js';
import { avatarSVG } from './avatar.js';
import { cloud } from './cloud.js';
import { openGate, forgetDevice } from './gate.js';
import { loadKeys } from './keystore.js';

const lockEl = document.getElementById('lock');
const form = lockEl.querySelector('form');
const err = lockEl.querySelector('.lock-error');
const btn = form.querySelector('button[type=submit]');
const field = (n) => form.elements.namedItem(n);
let started = false;

function start() {
  if (started) return;
  started = true;
  lockEl.hidden = true;
  document.body.classList.remove('locked');
  import('./app.js');
}

function showLock() {
  document.body.classList.add('locked');
  lockEl.hidden = false;
  lockEl.querySelector('.lock-avatar').innerHTML = avatarSVG({ size: 120 });
}

function shake() { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
function busy(on, label = 'Sign in') { btn.disabled = on; btn.textContent = on ? 'Checking…' : label; }

const useCloud = !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase?.createClient);

if (useCloud) bootCloud();
else bootLocal();

// ---------------------------------------------------------------- cloud (Supabase)
async function bootCloud() {
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'baymax:auth-session' },
  });
  cloud.client = client;

  let recovering = false;
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; showNewPasswordForm(client); }
    // Signed out here, or this session was ended from another device ("Sign out everywhere"):
    // erase this device's copy of the data and keys.
    if (event === 'SIGNED_OUT' && !cloud.signingOut) { cloud.signingOut = true; forgetDevice().finally(() => location.reload()); }
    if (session?.user) cloud.user = session.user;
  });

  const { data, error: sessionError } = await client.auth.getSession();
  if (data.session && !recovering && !location.hash.includes('type=recovery')) {
    cloud.user = data.session.user;
    await openGate(client, cloud.user);
    start();
    return;
  }
  // No session, but keys still here: the session was ended elsewhere while Baymax was closed.
  if (!data.session && !sessionError && (await loadKeys())) await forgetDevice();

  showLock();
  if (recovering) return;
  field('remember').closest('label').hidden = true; // the server keeps you signed in
  const forgot = lockEl.querySelector('.lock-forgot');
  forgot.hidden = false;

  forgot.addEventListener('click', async () => {
    const email = field('user').value.trim();
    if (!email) { err.textContent = 'Type your email first, then tap “Forgot password?”.'; field('user').focus(); return; }
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    err.textContent = error ? `Couldn’t send the reset email: ${error.message}` : 'Check your email for a link to set a new password.';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (recovering) return;
    busy(true);
    err.textContent = '';
    const { data: res, error } = await client.auth.signInWithPassword({ email: field('user').value.trim(), password: field('pass').value });
    busy(false);
    if (error) {
      err.textContent = /fetch|network/i.test(error.message) ? 'No internet connection. Connect and try again.' : 'That email or password isn’t right.';
      shake();
      field('pass').select();
      return;
    }
    cloud.user = res.user;
    await openGate(client, cloud.user);
    start();
  });
}

function showNewPasswordForm(client) {
  showLock();
  lockEl.querySelector('h1').textContent = 'Set a new password';
  lockEl.querySelector('.lock-card > p.muted').textContent = 'Choose a password with at least 8 characters.';
  field('user').closest('label').hidden = true;
  field('remember').closest('label').hidden = true;
  lockEl.querySelector('.lock-forgot').hidden = true;
  field('pass').autocomplete = 'new-password';
  btn.textContent = 'Save password';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const pass = field('pass').value;
    if (pass.length < 8) { err.textContent = 'Use at least 8 characters.'; shake(); return; }
    busy(true, 'Save password');
    const { error } = await client.auth.updateUser({ password: pass });
    busy(false, 'Save password');
    if (error) { err.textContent = error.message; shake(); return; }
    history.replaceState(null, '', location.pathname);
    const { data } = await client.auth.getSession();
    cloud.user = data.session?.user || null;
    if (cloud.user) await openGate(client, cloud.user);
    start();
  }, { capture: true });
}

// ---------------------------------------------------------------- local lock (no cloud)
function bootLocal() {
  if (isUnlocked()) { start(); return; }
  showLock();
  if (!window.crypto?.subtle) {
    err.textContent = 'Sign-in needs a secure (https) connection. Open Baymax from its https:// link.';
    btn.disabled = true;
    return;
  }
  let failures = 0;
  let blockedUntil = 0;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (Date.now() < blockedUntil) { err.textContent = `Too many tries. Wait ${Math.ceil((blockedUntil - Date.now()) / 1000)} seconds.`; return; }
    busy(true);
    err.textContent = '';
    let ok = false;
    try { ok = await checkCredentials(field('user').value, field('pass').value); } catch { ok = false; }
    busy(false);
    if (ok) { unlock(field('remember').checked); start(); return; }
    if (++failures >= 5) { blockedUntil = Date.now() + 30000; failures = 0; }
    err.textContent = 'That email or password isn’t right.';
    shake();
    field('pass').select();
  });
}
