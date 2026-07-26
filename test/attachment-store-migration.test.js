// The uri-keyed -> page_id-keyed migration, run against seeded rows.
//
// This exists because the migration has never executed over real data: the
// deployed `artifact_attachments` table holds zero rows, so shipping it proved
// only that it does not crash on an empty table. Every property that matters —
// rows re-keyed, directories carried across, orphans dropped *and* counted, the
// quota total inheriting the migrated bytes — was unverified. This file seeds
// the legacy shape and asserts the outcome.
//
// This is the migration's happy path only. What it does when interrupted, and
// what it does when a directory refuses to move, are pinned in
// attachment-store-migration-crash.test.js and
// attachment-store-migration-failure.test.js.
//
// Negative controls, both run rather than assumed:
//
//  * Suppressing the row restore (the `INSERT ... SELECT ... JOIN logical_pages`
//    that fills the re-keyed table) fails 3 of 6 — re-keying, byte total,
//    idempotent re-run — and leaves the file assertions green. The directory
//    pass reads the uri mapping, not the new rows, so metadata and bytes fail
//    independently of one another.
//  * Suppressing the `renameSync` fails 3 of 6, and the set is disjoint from
//    the first: the file-location assertion, the completion log line, and the
//    "legacy table is not left behind" assertion. The last two are not
//    collateral damage — a migration whose files did not move is required to
//    keep the uri mapping and to report itself incomplete, so a green run here
//    would mean it had retired a mapping it still needed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-migrate-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { getPagesDb } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-migrate-content-'));

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const attachmentsRoot = path.join(dataDir, 'attachments');

function legacyRow(artifact, itemKey, stored, sizeBytes, createdAt) {
  return {
    attachment_id: stored.slice(0, 32),
    artifact,
    item_key: itemKey,
    original_filename: `${stored}`,
    stored_filename: `${stored}.png`,
    mime_type: 'image/png',
    size_bytes: sizeBytes,
    created_at: createdAt,
  };
}

// Seed the pre-migration world: logical pages, a uri-keyed table, and files in
// directories named after the uri.
initPageStore();
const live = await makePage('migrate-live');

const rows = [
  legacyRow('migrate-live', 'k1', 'a'.repeat(32), 400, 1000),
  legacyRow('migrate-live', 'k1', 'b'.repeat(32), 600, 2000),
  // A page that no longer exists: its metadata is already unreachable.
  legacyRow('migrate-gone', 'k1', 'c'.repeat(32), 900, 3000),
];

const db = getPagesDb();
db.exec(`
  CREATE TABLE artifact_attachments (
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
const insertLegacy = db.prepare(`
  INSERT INTO artifact_attachments (
    attachment_id, artifact, item_key, original_filename,
    stored_filename, mime_type, size_bytes, created_at
  ) VALUES (
    @attachment_id, @artifact, @item_key, @original_filename,
    @stored_filename, @mime_type, @size_bytes, @created_at
  )
`);
for (const row of rows) {
  insertLegacy.run(row);
  await mkdir(path.join(attachmentsRoot, row.artifact), { recursive: true });
  await writeFile(path.join(attachmentsRoot, row.artifact, row.stored_filename), PNG);
}

// Capture the migration's own log line: "visible instead of silent" is a claim
// about output, so it is asserted on the output.
const logLines = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = chunk => {
  logLines.push(String(chunk));
  return true;
};
const { initAttachmentStore, listAttachments, pageByteTotal } =
  await import('../src/attachments/attachment-store.js');
try {
  initAttachmentStore();
} finally {
  process.stderr.write = realWrite;
}

const { resolveFinalPath } = await import('../src/attachments/storage.js');

test('rows for a live page are re-keyed onto its page_id', () => {
  const listed = listAttachments(live.pageId, 'k1');
  assert.equal(listed.length, 2);
  // Ordered created_at DESC, so the later row leads.
  assert.deepEqual(listed.map(a => a.sizeBytes), [600, 400]);
  for (const attachment of listed) {
    assert.equal(attachment.pageId, live.pageId);
  }
});

test('the migrated bytes are inside the page total, so the ceiling inherits them', () => {
  // The bug this migration answers was a fresh ceiling after every rename.
  // A total of 0 here would mean the ceiling reset all over again.
  assert.equal(pageByteTotal(live.pageId), 1000);
});

test('stored files move to the page_id directory and remain readable', () => {
  for (const stored of ['a'.repeat(32), 'b'.repeat(32)]) {
    const moved = resolveFinalPath(live.pageId, `${stored}.png`);
    assert.ok(fs.existsSync(moved), `expected ${stored}.png under the page_id directory`);
    assert.deepEqual(fs.readFileSync(moved), PNG);
  }
  assert.ok(!fs.existsSync(path.join(attachmentsRoot, 'migrate-live')), 'uri-named directory should be gone');
});

test('rows whose uri no longer resolves are dropped, and the loss is logged', () => {
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM artifact_attachments WHERE attachment_id = ?')
    .get('c'.repeat(32)).n;
  assert.equal(orphan, 0);

  const line = logLines.find(l => l.includes('attachment store migrated to page_id keys'));
  assert.ok(line, 'migration should log its outcome');
  const entry = JSON.parse(line);
  assert.equal(entry.droppedOrphanRows, 1);
  assert.equal(entry.movedDirectories, 1);
});

test('the legacy table is not left behind', () => {
  const leftover = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_attachments_by_uri'"
  ).get();
  assert.equal(leftover, undefined);
});

test('re-running the store initializer is a no-op, not a second migration', () => {
  initAttachmentStore();
  assert.equal(pageByteTotal(live.pageId), 1000);
  assert.equal(listAttachments(live.pageId, 'k1').length, 2);
});
