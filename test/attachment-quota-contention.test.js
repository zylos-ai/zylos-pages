// What a share-link upload gets when a second connection holds the write lock.
//
// The reviewed implementation ran the quota transaction with better-sqlite3's
// default deferred `BEGIN`: it took no lock while reading the totals, so it
// could not promote its snapshot once another connection had the write lock.
// Which refusal arrives depends on the interleaving — `SQLITE_BUSY_SNAPSHOT`
// when the competitor committed inside the read window, plain `SQLITE_BUSY`
// when it still holds the lock, which is the case this file reproduces — and
// neither consults the busy handler, so `busy_timeout` does not apply and the
// call fails at once. Both arrived as untyped throws, which the upload route
// could only render as 500 / `internal_error`. The ceiling was never unsafe
// (both outcomes refuse rather than admit), but a public write path answering
// a routine lock collision with "internal error" is not a contract a caller
// can act on.
//
// Two things replace it, and both are pinned here against a real second
// process rather than two handles in this one:
//
//   the lock is taken up front  `BEGIN IMMEDIATE`, so contention becomes
//                               ordinary write contention, which the busy
//                               handler does cover — the second writer waits
//                               and then reads totals that include the first.
//   exhaustion has a contract   if the wait is not enough, the store raises a
//                               503 carrying `retryAfterSeconds` instead of an
//                               untyped error. Nothing is written, and the
//                               upload route unlinks the file it was holding,
//                               so retrying is safe advice rather than a shrug.
//
// A second process is the point. Two connections inside this process cannot
// demonstrate waiting: the transaction is synchronous, so a timer that would
// release the lock can never fire while it blocks.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-contention-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { getPagesDb } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');
const { initAttachmentStore, insertAttachmentWithinQuota, pageByteTotal } =
  await import('../src/attachments/attachment-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-contention-content-'));
const dbPath = path.join(dataDir, 'pages.db');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Holds a write transaction open for `HOLD_MS`, from its own process and its
// own connection, then commits. It sleeps synchronously: a timer would leave
// its event loop free, which is not what a competing writer looks like.
const HOLDER = `
const Database = require(${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))});
const { HOLD_DB, HOLD_MS, HOLD_ID, HOLD_PAGE, HOLD_SIZE } = process.env;
const db = new Database(HOLD_DB);
db.pragma('journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.prepare("INSERT INTO artifact_attachments (attachment_id, page_id, item_key, original_filename, stored_filename, mime_type, size_bytes, created_at) VALUES (?, ?, 'k1', 'held.png', ?, 'image/png', ?, 1)")
  .run(HOLD_ID, HOLD_PAGE, HOLD_ID + '.png', Number(HOLD_SIZE));
// writeSync rather than process.stdout.write: a piped stdout is buffered and
// the synchronous sleep below would hold the flush until after the lock was
// released, so the parent would "wait" for a lock nobody was holding.
require('fs').writeSync(1, 'holding\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(HOLD_MS));
db.exec('COMMIT');
db.close();
`;

// Resolves once the child actually holds the lock. The exit promise is handed
// back wrapped: returning it bare from an async function would make this
// function's own promise adopt it, and the caller would wait for the child to
// finish before running the very code that is supposed to contend with it.
async function holdWriteLock({ holdMs, attachmentId, pageId, sizeBytes }) {
  const child = spawn(process.execPath, ['-e', HOLDER], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      HOLD_DB: dbPath,
      HOLD_MS: String(holdMs),
      HOLD_ID: attachmentId,
      HOLD_PAGE: pageId,
      HOLD_SIZE: String(sizeBytes),
    },
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => {
      String(chunk).includes('holding') ? resolve() : reject(new Error(`unexpected: ${chunk}`));
    });
    child.once('error', reject);
  });
  return { exited };
}

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

let seq = 0;
function record(pageId, sizeBytes) {
  seq += 1;
  const id = `f${seq}`.padEnd(32, '0');
  return {
    attachmentId: id,
    pageId,
    itemKey: 'k1',
    originalFilename: 'x.png',
    storedFilename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes,
    createdAt: 1000 + seq,
  };
}

const LIMITS = { maxPerItem: 50, maxArtifactBytes: 100000 };

initPageStore();
initAttachmentStore();
const db = getPagesDb();

// --- 1. The lock is waited for, and the totals it then reads include the
//        writer that held it. ------------------------------------------------

const waited = await makePage('contend-waits');
const HOLD_MS = 600;
const holder = await holdWriteLock({
  holdMs: HOLD_MS, attachmentId: 'h'.repeat(32), pageId: waited.pageId, sizeBytes: 400,
});
// Recorded rather than allowed to propagate: an implementation that refuses
// here should fail the assertions below with the reason, not abort the file
// during setup and report only that it crashed.
const startedAt = process.hrtime.bigint();
let admitted = null;
let refused = null;
try {
  admitted = insertAttachmentWithinQuota(record(waited.pageId, 100), LIMITS);
} catch (err) {
  refused = err;
}
const blockedForMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
await holder.exited;

const contended = { admitted, refused, blockedForMs, totalAfter: pageByteTotal(waited.pageId) };

// --- 2. When the wait is not enough, the failure has a contract. -------------

const exhausted = await makePage('contend-exhausted');
db.pragma('busy_timeout = 50');
const stubborn = await holdWriteLock({
  holdMs: 500, attachmentId: 'i'.repeat(32), pageId: exhausted.pageId, sizeBytes: 300,
});
let raised = null;
try {
  insertAttachmentWithinQuota(record(exhausted.pageId, 100), LIMITS);
} catch (err) {
  raised = err;
}
await stubborn.exited;
db.pragma('busy_timeout = 5000');

const rowsWritten = db
  .prepare('SELECT COUNT(*) AS n FROM artifact_attachments WHERE page_id = ?')
  .get(exhausted.pageId).n;

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

test('an upload waits for a competing connection instead of failing instantly', () => {
  assert.equal(
    contended.refused, null,
    `the insert should have waited for the lock, it threw ${contended.refused?.cause?.code ?? contended.refused?.code}`
  );
  assert.deepEqual(contended.admitted, { ok: true });
  assert.ok(
    contended.blockedForMs >= HOLD_MS * 0.5,
    `expected the insert to block on the busy handler, it returned after ${contended.blockedForMs}ms`
  );
});

test('the totals it decides against include the writer it waited for', () => {
  // 400 from the other process plus 100 from this one. A snapshot taken before
  // the wait would say 100, and the ceiling would be spendable twice over.
  assert.equal(contended.totalAfter, 500);
});

test('a wait that is not enough raises a documented refusal, not an internal error', () => {
  assert.ok(raised, 'the insert should not have succeeded while the lock was held');
  assert.equal(raised.statusCode, 503, 'an untyped throw here renders as 500 / internal_error');
  assert.equal(raised.retryAfterSeconds, 1);
  assert.match(String(raised.cause?.code), /^SQLITE_BUSY/);
});

test('a refused upload writes nothing, so retrying it is safe', () => {
  // One row: the one the holder committed. Uploads carry no idempotency key,
  // so "retry" is only honest advice if the refused attempt left no trace.
  assert.equal(rowsWritten, 1);
});

// ---------------------------------------------------------------------------
// Negative controls — run, not assumed. Recorded output is in the commit
// message.
//
//  * Reverting to the deferred begin (`_insertWithinQuota(record, limits)`
//    instead of `.immediate(...)`) fails the first two assertions, 2 pass /
//    2 fail: the insert returns in ~1ms with `SQLITE_BUSY` instead of waiting
//    out a 600ms lock under a 5000ms `busy_timeout`, and the total it would
//    have decided against is then 400 rather than 500. That is the reviewed
//    behaviour, and the timing is the evidence that the busy handler is not
//    involved.
//  * Removing the `asRetryableContention` translation fails only the third,
//    3 pass / 1 fail: the error still arrives and still writes nothing, but
//    with no status and no retry advice — a 500 to the caller.
// ---------------------------------------------------------------------------
