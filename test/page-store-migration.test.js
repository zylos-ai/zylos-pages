import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-store-migration-'));
const dbPath = path.join(dataDir, 'pages.db');
const pageStoreUrl = new URL('../src/pages/page-store.js', import.meta.url).href;

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Pre-seed the DB with the legacy uri-keyed schema.
{
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE logical_pages (
      uri TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_ext TEXT NOT NULL,
      source_root_name TEXT,
      access_mode TEXT NOT NULL DEFAULT 'private' CHECK (access_mode IN ('private', 'shared')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_logical_pages_title ON logical_pages(title);
    CREATE TABLE access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_uri TEXT,
      viewer_type TEXT NOT NULL,
      share_token_id TEXT,
      request_path TEXT,
      status INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO logical_pages (uri, title, source_path, source_ext, source_root_name, access_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('reports/q3', 'Q3 Report', '/tmp/q3.md', '.md', 'reports', 'private', 1000, 2000);
  insert.run('top', 'Top Page', '/tmp/top.html', '.html', null, 'shared', 3000, 4000);
  db.prepare('INSERT INTO access_logs (page_uri, viewer_type, status, created_at) VALUES (?, ?, ?, ?)')
    .run('reports/q3', 'auth', 200, 5000);
  db.close();
}

function runInitPageStore() {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `const { initPageStore } = await import(${JSON.stringify(pageStoreUrl)}); initPageStore();`,
  ], { env: { ...process.env, PAGES_DATA_DIR: dataDir } });
}

test('initPageStore migrates uri-keyed logical_pages to page_id and is idempotent', () => {
  runInitPageStore();
  // Second startup must be a no-op on the already-migrated schema.
  runInitPageStore();

  const db = new Database(dbPath, { readonly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(logical_pages)').all();
    const pageIdColumn = columns.find(column => column.name === 'page_id');
    assert.ok(pageIdColumn, 'page_id column exists');
    assert.equal(pageIdColumn.pk, 1);

    const rows = db.prepare('SELECT * FROM logical_pages ORDER BY uri').all();
    assert.deepEqual(rows.map(row => row.uri), ['reports/q3', 'top']);
    for (const row of rows) {
      assert.match(row.page_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    assert.notEqual(rows[0].page_id, rows[1].page_id);

    const [q3, top] = rows;
    assert.equal(q3.title, 'Q3 Report');
    assert.equal(q3.source_path, '/tmp/q3.md');
    assert.equal(q3.source_root_name, 'reports');
    assert.equal(q3.access_mode, 'private');
    assert.equal(q3.created_at, 1000);
    assert.equal(q3.updated_at, 2000);
    assert.equal(top.access_mode, 'shared');

    // uri stays unique after migration.
    const uriIndexed = db.prepare(`SELECT COUNT(*) AS count FROM pragma_index_list('logical_pages') WHERE "unique" = 1`).get();
    assert.ok(uriIndexed.count >= 1);

    // access_logs gains a nullable page_id column; existing rows are preserved.
    const logColumns = db.prepare('PRAGMA table_info(access_logs)').all().map(column => column.name);
    assert.ok(logColumns.includes('page_id'));
    const log = db.prepare('SELECT * FROM access_logs').get();
    assert.equal(log.page_uri, 'reports/q3');
    assert.equal(log.page_id, null);
  } finally {
    db.close();
  }
});
