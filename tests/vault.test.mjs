import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeyring, unlockWithPassphrase, unlockWithRecoveryCode, changePassphrase, newRecoveryCode,
  sealJSON, openJSON, sealForPublicKey, sealWithMailKey, openWithMailKey, passphraseProblem, makeRecoveryCode,
} from '../js/vault.js';

const FAST = { rounds: 1000 }; // tests only; the app uses 600,000 rounds

test('create, seal, unlock on a second device with the passphrase', async () => {
  const { keyring, keys, recoveryCode } = await createKeyring('mango river 47 window', FAST);
  assert.match(recoveryCode, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/);
  const sealed = await sealJSON(keys.dek, { amount: 45250, note: 'ICICI home loan' });
  assert.equal(sealed.e, 1);
  assert.ok(!JSON.stringify(sealed).includes('ICICI'), 'nothing readable in the stored form');
  // The cloud only ever sees `keyring` and `sealed`. A new device unlocks with the passphrase:
  const { keys: k2 } = await unlockWithPassphrase(JSON.parse(JSON.stringify(keyring)), 'mango river 47 window');
  assert.deepEqual(await openJSON(k2, sealed), { amount: 45250, note: 'ICICI home loan' });
  assert.equal(k2.mailKey, keys.mailKey);
});

test('wrong passphrase / tampered data are rejected', async () => {
  const { keyring, keys } = await createKeyring('mango river 47 window', FAST);
  await assert.rejects(unlockWithPassphrase(keyring, 'mango river 47 windoW'), /wrong-passphrase/);
  const sealed = await sealJSON(keys.dek, { a: 1 });
  const tampered = { ...sealed, ct: sealed.ct.slice(0, -4) + (sealed.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  await assert.rejects(openJSON(keys, tampered));
});

test('recovery code unlocks, then a new passphrase and a new recovery code work', async () => {
  const { keyring, recoveryCode, keys } = await createKeyring('first passphrase 1', FAST);
  const sealed = await sealJSON(keys.dek, { x: 'secret' });
  const { dekRaw, keys: rk } = await unlockWithRecoveryCode(keyring, recoveryCode.toLowerCase().replace(/-/g, ' '));
  assert.deepEqual(await openJSON(rk, sealed), { x: 'secret' });
  await assert.rejects(unlockWithRecoveryCode(keyring, makeRecoveryCode()), /wrong-recovery-code/);
  const k2 = await changePassphrase(keyring, dekRaw, 'second passphrase 2', FAST);
  await assert.rejects(unlockWithPassphrase(k2, 'first passphrase 1'), /wrong-passphrase/);
  const { keys: k3 } = await unlockWithPassphrase(k2, 'second passphrase 2');
  assert.deepEqual(await openJSON(k3, sealed), { x: 'secret' }, 'data stays readable, nothing re-encrypted');
  const { recoveryCode: rc2, keyring: k4 } = await newRecoveryCode(k2, dekRaw, FAST);
  await assert.rejects(unlockWithRecoveryCode(k4, recoveryCode), /wrong-recovery-code/);
  await unlockWithRecoveryCode(k4, rc2);
});

test('server can encrypt bank alerts with only the public key; only the owner can read them', async () => {
  const { keyring, keys } = await createKeyring('mango river 47 window', FAST);
  const box = await sealForPublicKey(keyring.publicKey, { amount: 450, merchant: 'SWIGGY' });
  assert.equal(box.e, 2);
  assert.ok(!JSON.stringify(box).includes('SWIGGY'));
  assert.deepEqual(await openJSON(keys, box), { amount: 450, merchant: 'SWIGGY' });
  const other = await createKeyring('someone else entirely', FAST);
  await assert.rejects(openJSON(other.keys, box));
});

test('Zoho token sealed with the mail key; old plain tokens still readable', async () => {
  const { keys } = await createKeyring('mango river 47 window', FAST);
  const sealed = await sealWithMailKey(keys.mailKey, '1000.refresh-token');
  assert.match(sealed, /^enc1:/);
  assert.ok(!sealed.includes('refresh-token'));
  assert.equal(await openWithMailKey(keys.mailKey, sealed), '1000.refresh-token');
  assert.equal(await openWithMailKey(keys.mailKey, '1000.plain-old'), '1000.plain-old');
});

test('passphrase rules', () => {
  assert.match(passphraseProblem('short'), /12 characters/);
  assert.match(passphraseProblem('password1234567'), /Avoid/);
  assert.equal(passphraseProblem('mango river 47 window'), null);
});

test('real strength settings take about a second (600k rounds)', async () => {
  const t = Date.now();
  await createKeyring('mango river 47 window');
  const ms = Date.now() - t;
  assert.ok(ms < 15000, `took ${ms} ms`);
  console.log(`    keyring with 600k PBKDF2 rounds: ${ms} ms`);
});
