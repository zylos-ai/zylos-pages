import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-store-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-content-'));
const custodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-custody-'));
process.env.PAGES_DATA_DIR = dataDir;

const {
  cleanupShares,
  createShare,
  createShareAccessCookie,
  disableSharePassword,
  getReferencedSharePasswordKeyIds,
  reencryptSharePasswordCredentials,
  revealActiveSharePassword,
  revokeShare,
  setSharePassword,
  verifyActiveSharePassword,
  verifyShareAccessCookie,
} = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage, unregisterLogicalPageById } = await import('../src/pages/page-store.js');
const {
  createSharePasswordKeyring,
  loadSharePasswordKeyring,
  retireSharePasswordKey,
  rotateSharePasswordKeyring,
} = await import('../src/sharing/share-password-keyring.js');

const config = { externalFiles: { allowedSources: { content: contentDir } } };
function register(uri) {
  const source = path.join(contentDir, `${uri.replaceAll('/', '-')}.md`);
  fs.writeFileSync(source, '# protected\n');
  return registerLogicalPage({ uri, title: uri, sourcePath: source, component: 'content' }, config);
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.rmSync(custodyDir, { recursive: true, force: true });
});

test('credential lifecycle binds sessions, preserves hash-only verification, rotates custody, and wipes terminal secrets', async () => {
  const keyFile = path.join(custodyDir, 'keys.json');
  let keyring = createSharePasswordKeyring(keyFile, { keyId: 'key-a', key: Buffer.alloc(32, 0x11) });
  const page = register('protected/main');
  const share = createShare(page.uri, '24h', { canWriteAttachments: true });

  const protectedShare = await setSharePassword(share.tokenId, 'first-secret', keyring);
  assert.equal(protectedShare.passwordProtected, true);
  assert.equal(protectedShare.credentialVersion, 1);
  assert.equal(await verifyActiveSharePassword(share.tokenId, 'first-secret').then(result => result.valid), true);
  assert.equal(revealActiveSharePassword(share.tokenId, keyring), 'first-secret');

  const session = createShareAccessCookie(page.pageId, share.tokenId, share.expiresAt, '/', protectedShare.credentialVersion);
  assert.equal(verifyShareAccessCookie(session.value, page.uri).valid, true);

  const rotatedShare = await setSharePassword(share.tokenId, 'second-secret', keyring);
  assert.equal(rotatedShare.credentialVersion, 2);
  assert.equal(verifyShareAccessCookie(session.value, page.uri).valid, false, 'old-generation session must fail');
  assert.equal(createShareAccessCookie(page.pageId, share.tokenId, share.expiresAt, '/', protectedShare.credentialVersion), null,
    'a paused old-generation proof must not mint a session after rotation');
  assert.equal(await verifyActiveSharePassword(share.tokenId, 'first-secret').then(result => result.valid), false);
  assert.equal(await verifyActiveSharePassword(share.tokenId, 'second-secret').then(result => result.valid), true);

  const backupPath = `${keyFile}.backup`;
  fs.renameSync(keyFile, backupPath);
  assert.throws(() => loadSharePasswordKeyring(keyFile), error => error.code === 'password_custody_unavailable');
  assert.equal(await verifyActiveSharePassword(share.tokenId, 'second-secret').then(result => result.valid), true,
    'DB/hash-only restore must retain viewer verification');
  fs.renameSync(backupPath, keyFile);
  keyring = loadSharePasswordKeyring(keyFile);
  assert.equal(revealActiveSharePassword(share.tokenId, keyring), 'second-secret',
    'DB plus restored keyring must retain reveal');

  keyring = rotateSharePasswordKeyring(keyFile, { keyId: 'key-b', key: Buffer.alloc(32, 0x22) });
  assert.equal(reencryptSharePasswordCredentials(keyring, { batchSize: 1 }), 1);
  assert.deepEqual(getReferencedSharePasswordKeyIds(), ['key-b']);
  assert.equal(revealActiveSharePassword(share.tokenId, keyring), 'second-secret');
  keyring = retireSharePasswordKey(keyFile, 'key-a', getReferencedSharePasswordKeyIds());
  assert.deepEqual([...keyring.keys.keys()], ['key-b']);

  const disabled = disableSharePassword(share.tokenId);
  assert.equal(disabled.passwordProtected, false);
  assert.equal(disabled.credentialVersion, 3);
  let row = getPagesDb().prepare('SELECT * FROM shares WHERE token_id = ?').get(share.tokenId);
  for (const field of ['password_hash', 'password_ciphertext', 'password_nonce', 'password_key_id', 'password_set_at']) {
    assert.equal(row[field], null, `disable must clear ${field}`);
  }
  assert.equal(row.was_password_protected, 1);

  const revokedShare = createShare(page.uri, '24h');
  await setSharePassword(revokedShare.tokenId, 'revoke-secret', keyring);
  assert.equal(revokeShare(revokedShare.tokenId), true);
  row = getPagesDb().prepare('SELECT * FROM shares WHERE token_id = ?').get(revokedShare.tokenId);
  assert.equal(row.password_hash, null);
  assert.equal(row.password_set_at, null);
  assert.equal(row.was_password_protected, 1);

  const expiredShare = createShare(page.uri, '24h');
  await setSharePassword(expiredShare.tokenId, 'expiry-secret', keyring);
  getPagesDb().prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?').run(Date.now() - 1, expiredShare.tokenId);
  cleanupShares();
  row = getPagesDb().prepare('SELECT * FROM shares WHERE token_id = ?').get(expiredShare.tokenId);
  assert.equal(row.password_hash, null);
  assert.equal(row.password_set_at, null);
  assert.equal(row.was_password_protected, 1);

  const deletedPage = register('protected/deleted');
  const deletedShare = createShare(deletedPage.uri, '24h');
  await setSharePassword(deletedShare.tokenId, 'deleted-secret', keyring);
  unregisterLogicalPageById(deletedPage.pageId);
  row = getPagesDb().prepare('SELECT * FROM shares WHERE token_id = ?').get(deletedShare.tokenId);
  assert.equal(row.password_hash, null);
  assert.equal(row.password_set_at, null);
  assert.equal(row.was_password_protected, 1);
});
