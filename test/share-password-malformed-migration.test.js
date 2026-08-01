import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-malformed-'));
process.env.PAGES_DATA_DIR = dataDir;
{
  const db = new Database(path.join(dataDir, 'pages.db'));
  db.exec(`
    CREATE TABLE logical_pages (
      page_id TEXT PRIMARY KEY, uri TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      source_path TEXT NOT NULL, source_ext TEXT NOT NULL, source_root_name TEXT,
      access_mode TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE shares (
      token_id TEXT PRIMARY KEY, page_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, can_write_attachments INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, origin_uri TEXT,
      password_hash TEXT, password_ciphertext BLOB, password_nonce BLOB, password_key_id TEXT,
      credential_version INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('a'.repeat(32), 'page-a', 0, 1, 0, 0, null, null, 'partial-hash', null, null, null, 1);
  db.close();
}

const { describeShare } = await import('../src/sharing/share-manager.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('a partial credential tuple in an upgraded database fails closed', () => {
  assert.throws(
    () => describeShare('a'.repeat(32)),
    error => error.code === 'password_custody_unavailable' && /Malformed/.test(error.message),
  );
});
