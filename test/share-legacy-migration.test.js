import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-share-legacy-'));
process.env.PAGES_DATA_DIR = dataDir;

const legacySecret = '11'.repeat(32);
const legacyTokenId = 'a'.repeat(32);
const legacySlug = 'legacy/page';
const legacyExpiresAt = Date.now() + 86_400_000;
const legacyCreatedAt = Date.now() - 1000;

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

// Pre-seed the DB with the legacy slug-keyed schema and rows.
{
  const db = new Database(path.join(dataDir, 'pages.db'));
  db.exec(`
    CREATE TABLE share_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE shares (
      token_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      can_write_attachments INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
    CREATE TABLE share_sessions (
      token_hash TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO share_meta (key, value) VALUES (?, ?)').run('secret', legacySecret);
  db.prepare('INSERT INTO shares (token_id, slug, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run('b'.repeat(32), legacySlug, legacyExpiresAt, legacyCreatedAt);
  db.prepare('INSERT INTO share_sessions (token_hash, token_id, slug, created_at, last_activity_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('hash', 'b'.repeat(32), legacySlug, legacyCreatedAt, legacyCreatedAt, legacyExpiresAt);
  db.close();
}

const { createShare, getActiveShare, listSharesForSlug } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('slug-keyed share rows are dropped and legacy shares.json is ignored', async () => {
  // Trigger share store init and confirm the legacy rows are gone.
  assert.equal(getActiveShare('b'.repeat(32)), null);
  assert.equal(getActiveShare(legacyTokenId), null);

  const db = getPagesDb();
  assert.deepEqual(
    db.prepare('PRAGMA table_info(shares)').all().map(column => column.name).includes('page_id'),
    true,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shares').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_sessions').get().count, 0);

  // The secret bootstrapped in share_meta is preserved.
  assert.equal(db.prepare('SELECT value FROM share_meta WHERE key = ?').get('secret').value, legacySecret);

  // shares.json is never imported: no rows appear for its token and the file is untouched.
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-share-legacy-content-'));
  try {
    await writeFile(path.join(contentDir, 'new-page.md'), '# New page\n');
    const page = registerLogicalPage({
      uri: 'new/page',
      title: 'New page',
      sourcePath: path.join(contentDir, 'new-page.md'),
      component: 'content',
    }, { externalFiles: { allowedSources: { content: contentDir } } });

    const share = createShare('new/page', '24h', { allowPermanent: false });
    assert.equal(share.pageId, page.pageId);
    assert.deepEqual(listSharesForSlug('new/page').map(entry => entry.tokenId), [share.tokenId]);
    assert.equal(getActiveShare(legacyTokenId), null);
    assert.equal(await readFile(path.join(dataDir, 'shares.json'), 'utf8'), legacyJson);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});
