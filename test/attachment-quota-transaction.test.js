// What the quota transaction actually guarantees, and against whom.
//
// The claim in attachment-store.js is that the ceiling is enforced in one
// transaction so a concurrent share-link upload cannot slip past a check made
// before the write. That claim was shipped untested, and it has two halves that
// hold for different reasons:
//
//   in-process   better-sqlite3 is synchronous, so nothing interleaves between
//                the read and the insert inside the transaction body. The
//                request path around it is async and does interleave, which is
//                why the pre-check in attachment-api.js is only a courtesy.
//   cross-process a second connection is a real possibility (a CLI run, a
//                second instance) and the transaction cannot exclude it by
//                being synchronous.
//
// The cases below are the in-process half. The last test documents what a
// *deferred* begin does across connections — it cannot promote a snapshot the
// other side has overtaken, so it fails closed rather than admitting an
// over-ceiling row. That is the property the store used to depend on, and it
// is worth keeping on the record because "it fails closed" is a much weaker
// and more honest statement than "it is serialized". The store no longer
// relies on it: it takes the write lock at BEGIN so the collision becomes a
// wait rather than a refusal, which is pinned against a second process in
// attachment-quota-contention.test.js. Either way the failure surfaces as a
// throw, not as {ok:false} — which is why the upload route unlinks the stored
// file in a catch and not only on a rejection.

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-quota-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');
const { initAttachmentStore, insertAttachmentWithinQuota, listAttachments, pageByteTotal } =
  await import('../src/attachments/attachment-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-quota-content-'));

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

initPageStore();
initAttachmentStore();

let seq = 0;
function record(pageId, sizeBytes, itemKey = 'k1') {
  seq += 1;
  const id = seq.toString(16).padStart(32, '0');
  return {
    attachmentId: id,
    pageId,
    itemKey,
    originalFilename: 'x.png',
    storedFilename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes,
    createdAt: 1000 + seq,
  };
}

const LIMITS = { maxPerItem: 3, maxArtifactBytes: 1000 };

test('an upload that starts under the ceiling cannot finish over it', async () => {
  // The distinguishing case for counting the incoming size. A `current >= max`
  // test would admit this row and land the page at 1400 of a 1000 ceiling.
  const page = await makePage('quota-incoming');
  assert.deepEqual(insertAttachmentWithinQuota(record(page.pageId, 900), LIMITS), { ok: true });
  assert.deepEqual(
    insertAttachmentWithinQuota(record(page.pageId, 500), LIMITS),
    { ok: false, reason: 'bytes' }
  );
  assert.equal(pageByteTotal(page.pageId), 900);
});

test('a rejected insert writes no row', async () => {
  const page = await makePage('quota-norow');
  insertAttachmentWithinQuota(record(page.pageId, 999), LIMITS);
  const rejected = record(page.pageId, 999);
  assert.equal(insertAttachmentWithinQuota(rejected, LIMITS).ok, false);
  const ids = listAttachments(page.pageId, 'k1').map(a => a.attachmentId);
  assert.ok(!ids.includes(rejected.attachmentId));
});

test('the per-item count ceiling is enforced before the byte ceiling', async () => {
  const page = await makePage('quota-count');
  for (let i = 0; i < LIMITS.maxPerItem; i += 1) {
    assert.equal(insertAttachmentWithinQuota(record(page.pageId, 1), LIMITS).ok, true);
  }
  assert.deepEqual(
    insertAttachmentWithinQuota(record(page.pageId, 1), LIMITS),
    { ok: false, reason: 'count' }
  );
});

test('ceilings are per page, so one page cannot spend another page\'s allowance', async () => {
  const a = await makePage('quota-page-a');
  const b = await makePage('quota-page-b');
  assert.equal(insertAttachmentWithinQuota(record(a.pageId, 900), LIMITS).ok, true);
  assert.equal(insertAttachmentWithinQuota(record(b.pageId, 900), LIMITS).ok, true);
  assert.equal(pageByteTotal(a.pageId), 900);
  assert.equal(pageByteTotal(b.pageId), 900);
});

// The cross-connection half. This drives raw SQLite on two connections in the
// exact statement order the transaction uses, because the interleaving cannot
// be injected into a synchronous transaction body from inside this process.
test('a competing connection cannot be overtaken by a deferred read-then-write', async () => {
  const page = await makePage('quota-race');
  const dbPath = path.join(dataDir, 'pages.db');
  const a = new Database(dbPath);
  const b = new Database(dbPath);
  a.pragma('journal_mode = WAL');

  const sumFor = conn => conn.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifact_attachments WHERE page_id = ?'
  );
  const insertFor = conn => conn.prepare(`
    INSERT INTO artifact_attachments (
      attachment_id, page_id, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    ) VALUES (
      @attachmentId, @pageId, @itemKey, @originalFilename,
      @storedFilename, @mimeType, @sizeBytes, @createdAt
    )
  `);

  try {
    // A opens a deferred transaction and reads the total: 0, so 600 fits.
    a.exec('BEGIN');
    assert.equal(sumFor(a).get(page.pageId).total, 0);

    // B commits 600 of the same page's allowance while A holds only a read.
    insertFor(b).run(record(page.pageId, 600));

    // A now tries to write against a snapshot that has been overtaken.
    let failure = null;
    try {
      insertFor(a).run(record(page.pageId, 600));
      a.exec('COMMIT');
    } catch (err) {
      failure = err;
      a.exec('ROLLBACK');
    }

    assert.ok(failure, 'the stale writer should not be allowed to commit');
    assert.match(String(failure.code), /^SQLITE_BUSY/);

    // Fails closed: the ceiling holds at B's row alone, not 1200 of 1000.
    assert.equal(sumFor(b).get(page.pageId).total, 600);
  } finally {
    a.close();
    b.close();
  }
});
