import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-share-legacy-'));
process.env.PAGES_DATA_DIR = dataDir;

const legacySecret = '11'.repeat(32);
const legacyTokenId = 'a'.repeat(32);
const legacySlug = 'legacy/page';
const legacyExpiresAt = Date.now() + 86_400_000;
const legacyCreatedAt = Date.now() - 1000;

function legacyToken(slug, expiresAt, tokenId, secret) {
  const payload = `${slug}:${expiresAt}:${tokenId}`;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

const legacyJson = JSON.stringify({
  secret: legacySecret,
  shares: {
    [legacyTokenId]: {
      slug: legacySlug,
      expiresAt: legacyExpiresAt,
      createdAt: legacyCreatedAt,
      revoked: false,
    },
  },
}, null, 2);

await writeFile(path.join(dataDir, 'shares.json'), legacyJson, { mode: 0o600 });

const {
  createShare,
  getActiveShare,
  verifyShare,
} = await import('../src/sharing/share-manager.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('legacy shares.json imports into DB and is no longer active write storage', async () => {
  assert.deepEqual(getActiveShare(legacyTokenId), {
    tokenId: legacyTokenId,
    slug: legacySlug,
    expiresAt: legacyExpiresAt,
    createdAt: legacyCreatedAt,
  });

  const token = legacyToken(legacySlug, legacyExpiresAt, legacyTokenId, legacySecret);
  assert.deepEqual(verifyShare(token, legacySlug), {
    valid: true,
    slug: legacySlug,
    tokenId: legacyTokenId,
    expiresAt: legacyExpiresAt,
    viewerType: 'share',
  });

  createShare('new/page', '24h', { allowPermanent: false });
  assert.equal(await readFile(path.join(dataDir, 'shares.json'), 'utf8'), legacyJson);
});
