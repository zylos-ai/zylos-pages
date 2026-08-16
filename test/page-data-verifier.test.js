import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';
import { verifyPageDataMigration } from '../src/migrations/page-data-verifier.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'src/cli/verify-migration.js');
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT_ID = 'a'.repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createSchema(db, { constraints = true } = {}) {
  db.exec(`
    CREATE TABLE logical_pages (
      page_id TEXT ${constraints ? 'PRIMARY KEY' : ''},
      uri TEXT NOT NULL ${constraints ? 'UNIQUE' : ''},
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_ext TEXT NOT NULL,
      page_type TEXT NOT NULL,
      source_root_name TEXT,
      access_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifact_state (
      page_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
      ${constraints ? ', PRIMARY KEY (page_id, key)' : ''}
    );
    CREATE TABLE artifact_attachments (
      attachment_id TEXT ${constraints ? 'PRIMARY KEY' : ''},
      page_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function insertPage(db, pageId = PAGE_ID, uri = 'reports/clean') {
  db.prepare(`
    INSERT INTO logical_pages (
      page_id, uri, title, source_path, source_ext, page_type, source_root_name,
      access_mode, created_at, updated_at
    ) VALUES (?, ?, 'Report', '/isolated/report.md', '.md', 'markdown', 'content', 'private', 1, 1)
  `).run(pageId, uri);
}

function insertAttachment(db, overrides = {}) {
  const row = {
    attachmentId: ATTACHMENT_ID,
    pageId: PAGE_ID,
    itemKey: 'hero',
    originalFilename: 'hero.png',
    storedFilename: `${ATTACHMENT_ID}.png`,
    mimeType: 'image/png',
    sizeBytes: PNG.length,
    createdAt: 1,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO artifact_attachments (
      attachment_id, page_id, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    ) VALUES (
      @attachmentId, @pageId, @itemKey, @originalFilename,
      @storedFilename, @mimeType, @sizeBytes, @createdAt
    )
  `).run(row);
  return row;
}

function makeFixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-verify-data-'));
  const previousDataDir = process.env.PAGES_DATA_DIR;
  process.env.PAGES_DATA_DIR = dataDir;
  assertIsolatedPagesDataDir(dataDir);
  if (previousDataDir === undefined) delete process.env.PAGES_DATA_DIR;
  else process.env.PAGES_DATA_DIR = previousDataDir;

  const dbPath = path.join(dataDir, 'pages.db');
  const db = new Database(dbPath);
  createSchema(db, options);
  return {
    dataDir,
    dbPath,
    db,
    cleanup() {
      if (db.open) db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function writeAttachment(dataDir, row, bytes = PNG, directory = row.pageId) {
  const target = path.join(dataDir, 'attachments', directory, row.storedFilename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function byId(result, id) {
  const check = result.checks.find(item => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

test('a fully converged page_id migration passes without mutating data', t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  insertPage(fixture.db);
  fixture.db.prepare("INSERT INTO artifact_state VALUES (?, 'theme', '{\"dark\":true}', '2026-07-26T00:00:00Z')")
    .run(PAGE_ID);
  const attachment = insertAttachment(fixture.db);
  writeAttachment(fixture.dataDir, attachment);
  fixture.db.pragma('wal_checkpoint(TRUNCATE)');

  const before = fs.readFileSync(fixture.dbPath);
  const result = verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir });
  const after = fs.readFileSync(fixture.dbPath);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.counts, { pages: 1, stateRows: 1, attachmentRows: 1 });
  assert.deepEqual(after, before, 'the verifier must not change pages.db');
});

test('database duplicates and orphan page ids are reported as separate failures', t => {
  const fixture = makeFixture({ constraints: false });
  t.after(() => fixture.cleanup());
  insertPage(fixture.db);
  insertPage(fixture.db, PAGE_ID, 'reports/duplicate-id');
  insertPage(fixture.db, SECOND_PAGE_ID, 'reports/clean');
  fixture.db.exec(`
    INSERT INTO artifact_state VALUES ('missing-page', 'same', '{}', 'now');
    INSERT INTO artifact_state VALUES ('missing-page', 'same', '{}', 'now');
  `);
  insertAttachment(fixture.db, { pageId: 'missing-page' });
  insertAttachment(fixture.db, { attachmentId: 'b'.repeat(32), pageId: 'missing-page' });

  const result = verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir });

  assert.equal(result.ok, false);
  for (const id of [
    'logical_pages.unique_page_id',
    'logical_pages.unique_uri',
    'state.no_orphan_page_ids',
    'state.no_duplicate_keys',
    'attachments.no_orphan_page_ids',
    'attachments.no_duplicate_files',
  ]) assert.equal(byId(result, id).ok, false, id);
});

test('attachment metadata and filesystem divergence are discriminated', t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  insertPage(fixture.db);
  insertPage(fixture.db, SECOND_PAGE_ID, 'reports/second');

  const missing = insertAttachment(fixture.db);
  const wrongSize = insertAttachment(fixture.db, {
    attachmentId: 'b'.repeat(32),
    pageId: SECOND_PAGE_ID,
    storedFilename: `${'b'.repeat(32)}.png`,
    sizeBytes: 999,
  });
  writeAttachment(fixture.dataDir, wrongSize);
  const wrongName = insertAttachment(fixture.db, {
    attachmentId: 'c'.repeat(32),
    pageId: SECOND_PAGE_ID,
    storedFilename: `${'c'.repeat(32)}.jpg`,
    mimeType: 'image/png',
  });
  writeAttachment(fixture.dataDir, wrongName);
  fs.mkdirSync(path.join(fixture.dataDir, 'attachments', 'reports', 'clean'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dataDir, 'attachments', SECOND_PAGE_ID, 'untracked.bin'), 'x');
  fs.mkdirSync(path.join(fixture.dataDir, 'attachments', 'deleted-page'), { recursive: true });

  const result = verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir });

  assert.equal(byId(result, 'attachments.files_present').rows[0].attachmentId, missing.attachmentId);
  assert.equal(byId(result, 'attachments.file_sizes_match').rows[0].attachmentId, wrongSize.attachmentId);
  assert.equal(byId(result, 'attachments.stored_names_match').rows[0].attachmentId, wrongName.attachmentId);
  assert.deepEqual(byId(result, 'attachments.no_legacy_uri_directories').directories, ['reports/clean']);
  assert.deepEqual(byId(result, 'attachments.no_unknown_directories').directories, ['deleted-page']);
  assert.ok(byId(result, 'attachments.no_untracked_files').files.includes(`${SECOND_PAGE_ID}/untracked.bin`));
});

function createStateSnapshot(db, rows) {
  db.exec(`
    CREATE TABLE artifact_state_by_uri (
      artifact TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (artifact, key)
    )
  `);
  const insert = db.prepare('INSERT INTO artifact_state_by_uri VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.artifact, row.key, row.value, row.updatedAt);
}

function writeStateArchive(dataDir, rows) {
  const target = path.join(dataDir, 'migration-archive', 'artifact-state-orphans-v1.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    format: 'zylos-pages/artifact-state-orphans-v1', rows,
  }, null, 2)}\n`);
  return target;
}

test('a shrunk current orphan set is classified as the archive-superset crash state', t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  insertPage(fixture.db, PAGE_ID, 'revived-uri');
  const rows = [
    { artifact: 'still-orphan', key: 'a', value: '1', updatedAt: 't1' },
    { artifact: 'revived-uri', key: 'b', value: '2', updatedAt: 't2' },
  ];
  createStateSnapshot(fixture.db, rows);
  writeStateArchive(fixture.dataDir, rows);

  const result = verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir });
  const detail = byId(result, 'state.snapshot_retired').stateSnapshot;

  assert.equal(result.ok, false);
  assert.equal(detail.classification, 'state_snapshot_archive_superset');
  assert.equal(detail.currentOrphanRows, 1);
  assert.equal(detail.archive.rows, 2);
  assert.equal(detail.missingLiveRows.length, 1);
  assert.match(detail.guidance, /do not DROP/i);
});

test('invalid and conflicting state archives cannot pass silently', async t => {
  await t.test('invalid archive', () => {
    const fixture = makeFixture();
    try {
      insertPage(fixture.db);
      createStateSnapshot(fixture.db, [{ artifact: 'gone', key: 'a', value: '1', updatedAt: 't1' }]);
      const archive = writeStateArchive(fixture.dataDir, []);
      fs.writeFileSync(archive, '{not-json');
      const detail = byId(
        verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir }),
        'state.snapshot_retired'
      ).stateSnapshot;
      assert.equal(detail.classification, 'state_snapshot_archive_invalid');
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('archive conflict', () => {
    const fixture = makeFixture();
    try {
      insertPage(fixture.db);
      createStateSnapshot(fixture.db, [{ artifact: 'gone', key: 'a', value: '1', updatedAt: 't1' }]);
      writeStateArchive(fixture.dataDir, [{ artifact: 'different', key: 'a', value: '1', updatedAt: 't1' }]);
      const detail = byId(
        verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir }),
        'state.snapshot_retired'
      ).stateSnapshot;
      assert.equal(detail.classification, 'state_snapshot_archive_conflict');
    } finally {
      fixture.cleanup();
    }
  });
});

test('residual attachment snapshot and impossible-sentinel control both fail closed', t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  insertPage(fixture.db);
  fixture.db.exec(`
    CREATE TABLE artifact_attachments_by_uri (
      attachment_id TEXT PRIMARY KEY,
      artifact TEXT NOT NULL,
      item_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const sentinel = PAGE_ID;

  const result = verifyPageDataMigration({ db: fixture.db, dataDir: fixture.dataDir, sentinel });

  assert.equal(byId(result, 'attachments.snapshot_retired').ok, false);
  assert.equal(byId(result, 'attachments.snapshot_retired').attachmentSnapshot.rows, 0);
  assert.equal(byId(result, 'negative_control.nonexistent_page_is_empty').ok, false);
  assert.equal(result.negativeControl.counts.logicalPages, 1);
});

test('CLI emits JSON, returns 0/1 correctly, and leaves database bytes unchanged', t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  insertPage(fixture.db);
  fixture.db.pragma('wal_checkpoint(TRUNCATE)');
  fixture.db.close();
  const before = fs.readFileSync(fixture.dbPath);

  const clean = spawnSync(process.execPath, [cliPath, '--json'], {
    cwd: repoRoot,
    env: { ...process.env, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  const cleanResult = JSON.parse(clean.stdout);
  assert.equal(cleanResult.ok, true);
  assert.equal(cleanResult.command, 'verify-migration');
  assert.deepEqual(fs.readFileSync(fixture.dbPath), before);

  const writable = new Database(fixture.dbPath);
  writable.exec('DROP TABLE artifact_state');
  writable.close();
  const failed = spawnSync(process.execPath, [cliPath, '--json'], {
    cwd: repoRoot,
    env: { ...process.env, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).failures[0].id, 'schema.artifact_state');
});
