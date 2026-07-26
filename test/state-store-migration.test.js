// Legacy artifact names are only labels; the migration resolves them once to
// stable page ids, archives anything that cannot resolve, and retires the
// label-keyed snapshot only after both outcomes are proven.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-migrate-data-'));
const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-migrate-content-'));
process.env.PAGES_DATA_DIR = dataDir;
assertIsolatedPagesDataDir(dataDir);

const { getPagesDb, tableExists } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

initPageStore();
const sourcePath = path.join(contentDir, 'renovation-checklist.html');
await writeFile(sourcePath, '<!doctype html><h1>Renovation</h1>');
const page = registerLogicalPage({
  uri: 'renovation-checklist',
  title: 'Renovation checklist',
  sourcePath,
  component: 'content',
}, { externalFiles: { allowedSources: { content: contentDir } } });

const db = getPagesDb();
db.exec(`
  CREATE TABLE artifact_state (
    artifact TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (artifact, key)
  )
`);
const insert = db.prepare(`
  INSERT INTO artifact_state (artifact, key, value, updated_at)
  VALUES (?, ?, ?, ?)
`);
for (let index = 1; index <= 20; index += 1) {
  insert.run('renovation-checklist', `item-${String(index).padStart(2, '0')}`, JSON.stringify({ done: index % 2 === 0 }), `2026-07-26T00:00:${String(index).padStart(2, '0')}.000Z`);
}
insert.run('test-artifact', 'orphan-key', JSON.stringify({ preserved: true }), '2026-07-26T00:01:00.000Z');

const logLines = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = chunk => { logLines.push(String(chunk)); return true; };
const stateStore = await import('../src/state/state-store.js');
try {
  stateStore.initStateStore();
} finally {
  process.stderr.write = realWrite;
}

test('all 20 live rows are re-keyed to the registered page id', () => {
  const columns = db.prepare('PRAGMA table_info(artifact_state)').all().map(column => column.name);
  assert.deepEqual(columns, ['page_id', 'key', 'value', 'updated_at']);

  const rows = db.prepare('SELECT page_id, key FROM artifact_state ORDER BY key ASC').all();
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row.page_id === page.pageId));
  assert.deepEqual(stateStore.getStateValue(page.pageId, 'item-20'), {
    found: true,
    value: { done: true },
  });
});

test('the orphan is exported deterministically before it is removed from the live table', () => {
  const archive = JSON.parse(fs.readFileSync(stateStore.STATE_ORPHAN_ARCHIVE_PATH, 'utf8'));
  assert.deepEqual(archive, {
    format: 'zylos-pages/artifact-state-orphans-v1',
    rows: [{
      artifact: 'test-artifact',
      key: 'orphan-key',
      value: '{"preserved":true}',
      updatedAt: '2026-07-26T00:01:00.000Z',
    }],
  });
  assert.equal(fs.statSync(stateStore.STATE_ORPHAN_ARCHIVE_PATH).mode & 0o777, 0o600);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifact_state').get().n, 20);
});

test('the snapshot is retired only after the archive and live rows exist', () => {
  assert.equal(tableExists(db, 'artifact_state_by_uri'), false);
  const completion = logLines.find(line => line.includes('state store migrated to page_id keys'));
  assert.ok(completion);
  const entry = JSON.parse(completion);
  assert.equal(entry.restoredRows, 20);
  assert.equal(entry.orphanRows, 1);
  assert.equal(entry.archivedOrphanRows, 1);
});

test('a fresh store instance treats the completed migration as a no-op', async () => {
  const before = fs.readFileSync(stateStore.STATE_ORPHAN_ARCHIVE_PATH, 'utf8');
  const replay = await import('../src/state/state-store.js?replay=1');
  replay.initStateStore();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifact_state').get().n, 20);
  assert.equal(fs.readFileSync(stateStore.STATE_ORPHAN_ARCHIVE_PATH, 'utf8'), before);
  assert.equal(tableExists(db, 'artifact_state_by_uri'), false);
});

// Discriminating controls for review:
// - removing the INSERT...JOIN restore makes the 20-row assertion fail;
// - dropping the snapshot before archiveOrphanRows makes the archive assertion
//   fail under an interrupted run (covered directly in the crash test).
