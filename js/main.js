// Entry point: show the sign-in screen until the user unlocks, then start the app.

import { isUnlocked, unlock, checkCredentials } from './auth.js';
import { avatarSVG } from './avatar.js';

const lockEl = document.getElementById('lock');
let started = false;

function start() {
  if (started) return;
  started = true;
  lockEl.hidden = true;
  document.body.classList.remove('locked');
  import('./app.js');
}

if (isUnlocked()) start();
else showLock();

function showLock() {
  document.body.classList.add('locked');
  lockEl.hidden = false;
  lockEl.querySelector('.lock-avatar').innerHTML = avatarSVG({ size: 120 });
  const form = lockEl.querySelector('form');
  const err = lockEl.querySelector('.lock-error');
  const btn = form.querySelector('button[type=submit]');
  let failures = 0;
  let blockedUntil = 0;

  if (!window.crypto?.subtle) {
    err.textContent = 'Sign-in needs a secure (https) connection. Open Baymax from its https:// link.';
    btn.disabled = true;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (Date.now() < blockedUntil) {
      err.textContent = `Too many tries. Wait ${Math.ceil((blockedUntil - Date.now()) / 1000)} seconds.`;
      return;
    }
    const user = form.elements.namedItem('user').value;
    const pass = form.elements.namedItem('pass').value;
    const remember = form.elements.namedItem('remember').checked;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    err.textContent = '';
    let ok = false;
    try { ok = await checkCredentials(user, pass); } catch { ok = false; }
    btn.disabled = false;
    btn.textContent = 'Sign in';
    if (ok) { unlock(remember); start(); return; }
    failures++;
    if (failures >= 5) { blockedUntil = Date.now() + 30000; failures = 0; }
    err.textContent = 'That email or password isn’t right.';
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    form.elements.namedItem('pass').select();
  });
}
