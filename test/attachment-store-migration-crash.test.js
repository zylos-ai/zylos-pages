// Resuming the uri -> page_id migration from a state a crash left behind.
//
// The first implementation of this migration committed the re-keyed table,
// then moved the directories, then dropped the uri mapping unconditionally,
// and on the next start returned early because the table was already
// page_id-keyed. A crash in the gap therefore produced metadata pointing at a
// directory that did not exist, with the only mapping that could have repaired
// it already gone: a permanent 404 that no restart could clear.
//
// These fixtures do not kill a process. They construct the exact database and
// filesystem state each interruption leaves — which is deterministic and is
// what a restart actually sees — and then start the store against it. Each
// scenario runs to completion and records its observations before the next one
// begins, so the assertions below read a settled world rather than racing the
// one being rebuilt underneath them. (Registering tests between top-level
// awaits lets the runner fire its `after` hook, and delete the fixture
// directory, while later scenarios are still being set up.)
//
// Negative controls, run rather than assumed, are recorded at the bottom.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-crash-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { getPagesDb, tableExists } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');
const { resolveFinalPath } = await import('../src/attachments/storage.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-crash-content-'));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const attachmentsRoot = path.join(dataDir, 'attachments');
const db = getPagesDb();

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

const SNAPSHOT_COLUMNS = `
  attachment_id TEXT PRIMARY KEY,
  artifact TEXT NOT NULL,
  item_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
`;

// The uri-keyed table under the name an interrupted migration parked it at.
function seedSnapshotTable(rows) {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_attachments_by_uri (${SNAPSHOT_COLUMNS})`);
  // OR REPLACE so that seeding never fails on a snapshot a previous scenario
  // left in place. A fixture that throws during setup reports "the file
  // crashed", which is the least informative way for a negative control to
  // fail; these scenarios should fail on their assertions or not at all.
  const insert = db.prepare(`
    INSERT OR REPLACE INTO artifact_attachments_by_uri (
      attachment_id, artifact, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    ) VALUES (@attachmentId, @artifact, @itemKey, @originalFilename,
              @storedFilename, @mimeType, @sizeBytes, @createdAt)
  `);
  for (const row of rows) insert.run(row);
}

function seedLiveRow(row, pageId) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_attachments (
      attachment_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO artifact_attachments (
      attachment_id, page_id, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    ) VALUES (@attachmentId, @pageId, @itemKey, @originalFilename,
              @storedFilename, @mimeType, @sizeBytes, @createdAt)
  `).run({ ...row, pageId });
}

function legacyRow(artifact, stored, sizeBytes) {
  return {
    attachmentId: stored,
    artifact,
    itemKey: 'k1',
    originalFilename: 'photo.png',
    storedFilename: `${stored}.png`,
    mimeType: 'image/png',
    sizeBytes,
    createdAt: 1000,
  };
}

async function seedLegacyFile(artifact, storedFilename) {
  await mkdir(path.join(attachmentsRoot, artifact), { recursive: true });
  await writeFile(path.join(attachmentsRoot, artifact, storedFilename), PNG);
}

// A fresh module instance is a fresh process as far as this migration is
// concerned: module state resets, the database file does not.
let boots = 0;
const logLines = [];
async function boot() {
  boots += 1;
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { logLines.push(String(chunk)); return true; };
  try {
    const mod = await import(`../src/attachments/attachment-store.js?boot=${boots}`);
    mod.initAttachmentStore();
    return mod;
  } finally {
    process.stderr.write = realWrite;
  }
}

function storedAt(pageId, storedFilename) {
  const file = path.join(attachmentsRoot, pageId, storedFilename);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

initPageStore();

// ---------------------------------------------------------------------------
// Scenario 1 — the exact state the previous implementation left behind:
// metadata re-keyed and committed, files never moved, backup table present.
// ---------------------------------------------------------------------------

const crashed = await makePage('crash-committed');
const crashedRow = legacyRow('crash-committed', 'a'.repeat(32), 700);
seedSnapshotTable([crashedRow]);
seedLiveRow(crashedRow, crashed.pageId);
await seedLegacyFile('crash-committed', crashedRow.storedFilename);

const afterCrash = await boot();
const committed = {
  bytesAtPageId: storedAt(crashed.pageId, crashedRow.storedFilename),
  legacyDirGone: !fs.existsSync(path.join(attachmentsRoot, 'crash-committed')),
  listed: afterCrash.listAttachments(crashed.pageId, 'k1'),
  total: afterCrash.pageByteTotal(crashed.pageId),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
  // The path the file route actually serves from. Asserting the row exists
  // proves nothing about the 404 — the reviewed defect left the row intact and
  // the bytes unreachable, so the read path is the thing to check.
  servedFileExists: fs.existsSync(resolveFinalPath(crashed.pageId, crashedRow.storedFilename)),
};

// ---------------------------------------------------------------------------
// Scenario 2 — interrupted earlier: the old table was renamed away but the new
// one was never filled, so the rows exist only in the snapshot.
// ---------------------------------------------------------------------------

const halfway = await makePage('crash-halfway');
const halfwayRow = legacyRow('crash-halfway', 'b'.repeat(32), 300);
seedSnapshotTable([halfwayRow]);
await seedLegacyFile('crash-halfway', halfwayRow.storedFilename);

const afterHalfway = await boot();
const restored = {
  listed: afterHalfway.listAttachments(halfway.pageId, 'k1'),
  total: afterHalfway.pageByteTotal(halfway.pageId),
  bytesAtPageId: storedAt(halfway.pageId, halfwayRow.storedFilename),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
};

// Replaying the same snapshot: the restore is keyed by attachment id and
// ignores rows that already landed, which is what makes an interrupted run
// safe to simply repeat rather than reason about.
seedSnapshotTable([halfwayRow]);
const afterReplay = await boot();
const replayed = {
  listed: afterReplay.listAttachments(halfway.pageId, 'k1'),
  total: afterReplay.pageByteTotal(halfway.pageId),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
};

// ---------------------------------------------------------------------------
// Scenario 3 — bytes already missing before the migration began. No later run
// can produce a file that does not exist, so blocking on one would mean never
// finishing; it is recorded and the migration settles.
// ---------------------------------------------------------------------------

const missing = await makePage('crash-missing-bytes');
seedSnapshotTable([legacyRow('crash-missing-bytes', 'c'.repeat(32), 100)]);
// Deliberately no file seeded, under either name.

const afterMissing = await boot();
const withoutBytes = {
  listed: afterMissing.listAttachments(missing.pageId, 'k1'),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
};

const completions = logLines.filter(line => line.includes('attachment store migrated to page_id keys'));
const incompletes = logLines.filter(line => line.includes('migration incomplete'));

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

test('a start after the metadata committed and the files did not moves the files', () => {
  assert.deepEqual(committed.bytesAtPageId, PNG, 'the bytes should be under the page id the row names');
  assert.ok(committed.legacyDirGone, 'the uri-named directory should be gone once its contents moved');
});

test('the repaired page reads normally instead of 404ing forever', () => {
  assert.equal(committed.listed.length, 1);
  assert.equal(committed.listed[0].storedFilename, crashedRow.storedFilename);
  assert.equal(committed.total, 700);
  assert.ok(
    committed.servedFileExists,
    'the file route resolves page_id/stored_filename — a row without bytes there is the permanent 404'
  );
});

test('the uri mapping is retired only after the files it describes have moved', () => {
  assert.ok(committed.snapshotRetired);
});

test('rows lost between renaming the old table and filling the new one are restored', () => {
  assert.equal(restored.listed.length, 1, 'the row should be recovered from the snapshot');
  assert.equal(restored.listed[0].sizeBytes, 300);
  assert.equal(restored.total, 300);
  assert.deepEqual(restored.bytesAtPageId, PNG);
  assert.ok(restored.snapshotRetired);
});

test('replaying a snapshot that already landed does not duplicate its rows', () => {
  assert.equal(replayed.listed.length, 1);
  assert.equal(replayed.total, 300);
  assert.ok(replayed.snapshotRetired);
});

test('a file missing from both locations is recorded but does not stall the migration', () => {
  assert.equal(withoutBytes.listed.length, 1, 'the row still migrates');
  assert.ok(
    withoutBytes.snapshotRetired,
    'the migration should settle rather than retry an impossible move on every start'
  );
});

test('every resumed start reported its outcome', () => {
  assert.ok(completions.length >= 4, 'each resumed start should log a completion line');
  assert.equal(incompletes.length, 0, 'none of these fixtures should report an incomplete migration');
});

// ---------------------------------------------------------------------------
// Negative controls — run against this file, not assumed. The recorded output
// is in the commit message.
//
//  * Restoring the previous early return (`if (!liveTableIsUriKeyed) return`)
//    reproduces the reviewed defect and fails every assertion here, 0 pass /
//    7 fail: the files stay under the uri name, the row is never restored,
//    and the snapshot table is never dropped.
//  * Removing the `INSERT OR IGNORE` restore from the resume path fails 3 of
//    7 — the row-recovery assertions — and leaves the three file-recovery
//    assertions green. Rows and bytes are recovered by separate mechanisms
//    and fail independently of one another.
//  * Dropping the snapshot unconditionally instead of only after verification
//    leaves this file green: it removes the mapping the retry depends on, and
//    that is pinned in attachment-store-migration-failure.test.js instead, on
//    purpose — no single file here should be able to claim both halves of
//    "recoverable".
// ---------------------------------------------------------------------------
