import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-migration-'));
process.env.PAGES_DATA_DIR = dataDir;
const dbPath = path.join(dataDir, 'pages.db');
const pageId = 'legacy-page-id';
const tokenId = 'a'.repeat(32);

{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE logical_pages (
      page_id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      source_path TEXT NOT NULL, source_ext TEXT NOT NULL, source_root_name TEXT,
      access_mode TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE shares (
      token_id TEXT PRIMARY KEY, page_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, can_write_attachments INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, origin_uri TEXT
    );
    CREATE TABLE share_sessions (
      token_hash TEXT PRIMARY KEY, token_id TEXT NOT NULL, page_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO logical_pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pageId, 'legacy/page', 'Legacy', '/tmp/legacy.md', '.md', null, 'private', 1, 1);
  db.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tokenId, pageId, 0, 1, 0, 0, null, null);
  db.prepare('INSERT INTO share_sessions VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-hash', tokenId, pageId, 1, 1, Date.now() + 60_000);
  db.close();
}

const { describeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('additive migration preserves existing shares and sessions as unprotected generation zero', () => {
  const share = describeShare(tokenId);
  assert.equal(share.status, 'active');
  assert.equal(share.passwordProtected, false);
  assert.equal(share.credentialVersion, 0);

  const db = getPagesDb();
  const row = db.prepare('SELECT * FROM shares WHERE token_id = ?').get(tokenId);
  assert.equal(row.password_hash, null);
  assert.equal(row.was_password_protected, 0);
  assert.equal(row.credential_version, 0);
  const session = db.prepare('SELECT * FROM share_sessions WHERE token_hash = ?').get('legacy-hash');
  assert.equal(session.credential_version, 0);
});
