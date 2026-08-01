import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySharePassword } from '../src/security/share-password-kdf.js';
import {
  buildSharePasswordCredential,
  revealSharePassword,
} from '../src/sharing/share-password-crypto.js';

const identity = {
  tokenId: 'a'.repeat(32),
  pageId: 'page-a',
  credentialVersion: 3,
};
const keyring = {
  activeKeyId: 'key-a',
  keys: new Map([['key-a', Buffer.alloc(32, 0x11)]]),
};

test('credential stores an independent verification hash and row-bound authenticated ciphertext', async () => {
  const credential = await buildSharePasswordCredential('share-secret', identity, keyring);
  assert.equal(await verifySharePassword('share-secret', credential.passwordHash), true);
  assert.equal(await verifySharePassword('wrong', credential.passwordHash), false);
  assert.equal(revealSharePassword(credential, identity, keyring), 'share-secret');

  for (const moved of [
    { ...identity, tokenId: 'b'.repeat(32) },
    { ...identity, pageId: 'page-b' },
    { ...identity, credentialVersion: 4 },
  ]) {
    assert.throws(
      () => revealSharePassword(credential, moved, keyring),
      error => error.code === 'password_decryption_failed',
    );
  }
});

test('wrong or missing custody key never silently decrypts', async () => {
  const credential = await buildSharePasswordCredential('share-secret', identity, keyring);
  const wrong = { activeKeyId: 'key-a', keys: new Map([['key-a', Buffer.alloc(32, 0x22)]]) };
  assert.throws(() => revealSharePassword(credential, identity, wrong), error => error.code === 'password_decryption_failed');
  assert.throws(
    () => revealSharePassword(credential, identity, { activeKeyId: 'key-b', keys: new Map() }),
    error => error.code === 'password_custody_unavailable',
  );
});
