import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, checkCredentials } from '../js/auth.js';

test('fingerprints are deterministic, salted and 256-bit', async () => {
  const a = await fingerprint('secret', 'salt-1', 1000);
  assert.equal(a, await fingerprint('secret', 'salt-1', 1000));
  assert.notEqual(a, await fingerprint('secret', 'salt-2', 1000));
  assert.equal(a.length, 64);
});

test('credentials are checked against fingerprints only', async () => {
  const userSalt = 'u-salt', passSalt = 'p-salt';
  const record = { userSalt, passSalt, user: await fingerprint('me@example.com', userSalt), pass: await fingerprint('Correct horse 1', passSalt) };
  assert.equal(await checkCredentials(' ME@example.com ', 'Correct horse 1', record), true);
  assert.equal(await checkCredentials('me@example.com', 'wrong', record), false);
  assert.equal(await checkCredentials('you@example.com', 'Correct horse 1', record), false);
});
