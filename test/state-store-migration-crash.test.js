// A filesystem failure must not turn an orphan cleanup into data loss. The
// store remains available for resolved pages, retains its URI snapshot, and a
// later boot completes once the archive path is writable.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-crash-data-'));
const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-crash-content-'));
process.env.PAGES_DATA_DIR = dataDir;
assertIsolatedPagesDataDir(dataDir);

const { getPagesDb, tableExists } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

initPageStore();
const sourcePath = path.join(contentDir, 'resume-state.html');
await writeFile(sourcePath, '<!doctype html><h1>Resume</h1>');
const page = registerLogicalPage({
  uri: 'resume-state',
  title: 'Resume state',
  sourcePath,
  component: 'content',
}, { externalFiles: { allowedSources: { content: contentDir } } });

const db = getPagesDb();
db.exec(`
  CREATE TABLE artifact_state_by_uri (
    artifact TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (artifact, key)
  );
  CREATE TABLE artifact_state (
    page_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (page_id, key)
  );
`);
const insertSnapshot = db.prepare(`
  INSERT INTO artifact_state_by_uri (artifact, key, value, updated_at)
  VALUES (?, ?, ?, ?)
`);
insertSnapshot.run('resume-state', 'already-live', '"snapshot-old"', '2026-07-26T00:00:00.000Z');
insertSnapshot.run('resume-state', 'restore-me', '"restored"', '2026-07-26T00:00:01.000Z');
insertSnapshot.run('orphan-after-crash', 'keep-me', '{"important":true}', '2026-07-26T00:00:02.000Z');
db.prepare(`
  INSERT INTO artifact_state (page_id, key, value, updated_at)
  VALUES (?, 'already-live', '"newer-live"', '2026-07-26T00:00:03.000Z')
`).run(page.pageId);

// A directory at the final file path makes the archive write fail without
// touching any real user data. This is the exact gate before snapshot cleanup.
const archivePath = path.join(dataDir, 'migration-archive', 'artifact-state-orphans-v1.json');
await mkdir(archivePath, { recursive: true });

const logLines = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = chunk => { logLines.push(String(chunk)); return true; };
const firstBoot = await import('../src/state/state-store.js?boot=1');
try {
  firstBoot.initStateStore();
} finally {
  process.stderr.write = realWrite;
}

const afterFailure = {
  snapshotKept: tableExists(db, 'artifact_state_by_uri'),
  alreadyLive: firstBoot.getStateValue(page.pageId, 'already-live'),
  restored: firstBoot.getStateValue(page.pageId, 'restore-me'),
  incompleteLogs: logLines.filter(line => line.includes('state store migration incomplete')),
};

// Clear only the deliberately-created blocking fixture, then simulate the next
// process start. The database snapshot is the recovery input.
await rm(archivePath, { recursive: true, force: true });
const secondBoot = await import('../src/state/state-store.js?boot=2');
secondBoot.initStateStore();

test('a failed orphan export keeps the URI snapshot and still restores live rows', () => {
  assert.equal(afterFailure.snapshotKept, true);
  assert.deepEqual(afterFailure.alreadyLive, { found: true, value: 'newer-live' });
  assert.deepEqual(afterFailure.restored, { found: true, value: 'restored' });
  assert.equal(afterFailure.incompleteLogs.length, 1);
});

test('the next boot archives the orphan and retires the snapshot', () => {
  assert.equal(tableExists(db, 'artifact_state_by_uri'), false);
  assert.deepEqual(secondBoot.getStateValue(page.pageId, 'already-live'), { found: true, value: 'newer-live' });
  assert.deepEqual(secondBoot.getStateValue(page.pageId, 'restore-me'), { found: true, value: 'restored' });

  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.deepEqual(archive.rows, [{
    artifact: 'orphan-after-crash',
    key: 'keep-me',
    value: '{"important":true}',
    updatedAt: '2026-07-26T00:00:02.000Z',
  }]);
});

// Negative control: dropping artifact_state_by_uri in the export-error branch
// makes the first assertion fail and leaves the second boot unable to create
// the archive. INSERT OR REPLACE instead of OR IGNORE also fails by replacing
// "newer-live" with stale snapshot content.
