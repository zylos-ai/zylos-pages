import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSharePasswordKeyring,
  loadSharePasswordKeyring,
  retireSharePasswordKey,
  rotateSharePasswordKeyring,
} from '../src/sharing/share-password-keyring.js';

test('keyring creation and rotation use a versioned 0600 atomic envelope', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-keyring-'));
  const keyFile = path.join(directory, 'share-password-keys.json');
  try {
    const initial = createSharePasswordKeyring(keyFile, { keyId: 'key-a', key: Buffer.alloc(32, 0x11) });
    assert.equal(initial.formatVersion, 1);
    assert.equal(initial.activeKeyId, 'key-a');
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

    const rotated = rotateSharePasswordKeyring(keyFile, { keyId: 'key-b', key: Buffer.alloc(32, 0x22) });
    assert.equal(rotated.activeKeyId, 'key-b');
    assert.deepEqual([...rotated.keys.keys()], ['key-a', 'key-b']);
    assert.deepEqual(fs.readdirSync(directory), ['share-password-keys.json']);

    assert.throws(() => retireSharePasswordKey(keyFile, 'key-a', ['key-a']), /referenced/);
    const retired = retireSharePasswordKey(keyFile, 'key-a', []);
    assert.deepEqual([...retired.keys.keys()], ['key-b']);
    assert.throws(() => retireSharePasswordKey(keyFile, 'key-b', []), /active/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keyring parsing fails closed on unknown versions, malformed keys and broad permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-keyring-invalid-'));
  try {
    const keyFile = path.join(directory, 'keys.json');
    fs.writeFileSync(keyFile, JSON.stringify({
      formatVersion: 99,
      activeKeyId: 'key-a',
      keys: { 'key-a': Buffer.alloc(32).toString('base64url') },
    }), { mode: 0o600 });
    assert.throws(() => loadSharePasswordKeyring(keyFile), error => error.code === 'password_custody_unavailable');

    fs.writeFileSync(keyFile, JSON.stringify({
      formatVersion: 1,
      activeKeyId: 'key-a',
      keys: { 'key-a': Buffer.alloc(31).toString('base64url') },
    }), { mode: 0o600 });
    assert.throws(() => loadSharePasswordKeyring(keyFile), error => error.code === 'password_custody_unavailable');

    fs.writeFileSync(keyFile, JSON.stringify({
      formatVersion: 1,
      activeKeyId: 'key-a',
      keys: { 'key-a': Buffer.alloc(32).toString('base64url') },
    }), { mode: 0o600 });
    fs.chmodSync(keyFile, 0o644);
    assert.throws(() => loadSharePasswordKeyring(keyFile), error => error.code === 'password_custody_unavailable');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
