// A directory that cannot be moved, and what the migration is allowed to do
// about it.
//
// The reviewed implementation logged a failed `renameSync` and carried on to
// drop the uri mapping regardless, which made the failure permanent: nothing
// afterwards knew which directory those bytes had belonged to. Two properties
// replace that, and this file pins both.
//
//   ordering    bytes move before any metadata is re-keyed. Interrupted or
//               refused at that point, the database is still uri-keyed, which
//               is a state a later start can finish from. The reverse order is
//               what produced rows pointing at directories that do not exist.
//   retention   a move that fails keeps the snapshot table, so the next start
//               retries with the mapping intact instead of guessing.
//
// The ordering assertion is made from inside `renameSync` itself, at the only
// moment where the claim is falsifiable: it reads the live table's shape while
// the file is being moved. An implementation that re-keyed first would record
// `artifact` already gone.
//
// All fixture setup happens before the first `test()` call — registering tests
// between top-level awaits lets the runner fire its `after` hook and delete the
// fixture directory mid-scenario.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-movefail-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { getPagesDb, tableExists } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-movefail-content-'));

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

function liveTableIsUriKeyed() {
  return db.prepare('PRAGMA table_info(artifact_attachments)').all().some(c => c.name === 'artifact');
}

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

function logEntries(needle) {
  return logLines.filter(line => line.includes(needle)).map(line => JSON.parse(line));
}

initPageStore();

const movable = await makePage('move-ok');
const blocked = await makePage('move-blocked');

// The pre-migration world: a uri-keyed table and directories named after uris.
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
  )
`);
const insertLegacy = db.prepare(`
  INSERT INTO artifact_attachments (
    attachment_id, artifact, item_key, original_filename,
    stored_filename, mime_type, size_bytes, created_at
  ) VALUES (@id, @artifact, 'k1', 'photo.png', @stored, 'image/png', @size, 1000)
`);

const FILES = [
  { artifact: 'move-ok', id: 'a'.repeat(32), size: 500 },
  { artifact: 'move-blocked', id: 'd'.repeat(32), size: 800 },
];
for (const file of FILES) {
  insertLegacy.run({ ...file, stored: `${file.id}.png` });
  await mkdir(path.join(attachmentsRoot, file.artifact), { recursive: true });
  await writeFile(path.join(attachmentsRoot, file.artifact, `${file.id}.png`), PNG);
}

// ---------------------------------------------------------------------------
// First start: one directory refuses to move.
// ---------------------------------------------------------------------------

const orderingEvidence = [];
const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  orderingEvidence.push({ from: path.basename(from), liveTableIsUriKeyed: liveTableIsUriKeyed() });
  if (path.basename(from) === 'move-blocked') {
    throw Object.assign(new Error("EACCES: permission denied, rename '" + from + "'"), { code: 'EACCES' });
  }
  return realRenameSync(from, to);
};

let afterFailure;
try {
  afterFailure = await boot();
} finally {
  fs.renameSync = realRenameSync;
}

const firstStart = {
  ordering: orderingEvidence.slice(),
  snapshotKept: tableExists(db, 'artifact_attachments_by_uri'),
  movedBytes: fs.existsSync(path.join(attachmentsRoot, movable.pageId, `${FILES[0].id}.png`)),
  blockedBytesStillUnderUri: fs.existsSync(path.join(attachmentsRoot, 'move-blocked', `${FILES[1].id}.png`)),
  blockedBytesAtPageId: fs.existsSync(path.join(attachmentsRoot, blocked.pageId, `${FILES[1].id}.png`)),
  // The store still has to come up: refusing to start would turn one
  // unmovable directory into a total outage.
  movableListed: afterFailure.listAttachments(movable.pageId, 'k1').length,
  blockedListed: afterFailure.listAttachments(blocked.pageId, 'k1').length,
  incomplete: logEntries('migration incomplete'),
  completed: logEntries('attachment store migrated to page_id keys'),
};

// ---------------------------------------------------------------------------
// Second start: nothing blocking it now. This is the property the previous
// implementation could not have — the mapping it needs still exists.
// ---------------------------------------------------------------------------

const afterRetry = await boot();
const secondStart = {
  blockedBytesAtPageId: fs.existsSync(path.join(attachmentsRoot, blocked.pageId, `${FILES[1].id}.png`)),
  legacyDirGone: !fs.existsSync(path.join(attachmentsRoot, 'move-blocked')),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
  total: afterRetry.pageByteTotal(blocked.pageId),
  completed: logEntries('attachment store migrated to page_id keys'),
};

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

test('bytes are moved while the metadata is still keyed by uri', () => {
  assert.equal(firstStart.ordering.length, 2, 'both directories should have been attempted');
  for (const attempt of firstStart.ordering) {
    assert.equal(
      attempt.liveTableIsUriKeyed, true,
      `${attempt.from} moved after the table was re-keyed — a crash there strands metadata`
    );
  }
});

test('one directory that cannot move does not stop the others', () => {
  assert.ok(firstStart.movedBytes, 'the movable page should have been migrated');
  assert.ok(firstStart.blockedBytesStillUnderUri, 'the blocked page keeps its bytes where they are');
  assert.ok(!firstStart.blockedBytesAtPageId);
});

test('the store still starts, so one unmovable directory is not an outage', () => {
  assert.equal(firstStart.movableListed, 1);
  assert.equal(firstStart.blockedListed, 1, 'metadata migrates even for the page whose bytes did not');
});

test('a failed move keeps the uri mapping instead of retiring it', () => {
  assert.ok(firstStart.snapshotKept, 'the snapshot table is the only surviving uri -> page_id mapping');
  assert.equal(firstStart.completed.length, 0, 'an incomplete migration must not report completion');
  assert.equal(firstStart.incomplete.length, 1);
  assert.equal(firstStart.incomplete[0].level, 'error');
  assert.equal(firstStart.incomplete[0].unresolvedDirectories, 1);
  assert.equal(firstStart.incomplete[0].strandedFiles, 1);
  assert.equal(firstStart.incomplete[0].firstUnresolved.artifact, 'move-blocked');
});

test('the next start finishes the migration the failed one left open', () => {
  assert.ok(secondStart.blockedBytesAtPageId, 'the retry should move the bytes it could not move before');
  assert.ok(secondStart.legacyDirGone);
  assert.equal(secondStart.total, 800, 'the recovered page carries its bytes into the ceiling');
  assert.ok(secondStart.snapshotRetired, 'only now is the mapping no longer needed');
  assert.equal(secondStart.completed.length, 1);
});

// ---------------------------------------------------------------------------
// Negative controls — run against this file. Recorded output is in the commit
// message.
//
//  * Retiring the snapshot unconditionally (the reviewed behaviour: log the
//    failed rename, drop the mapping anyway) fails exactly the retention and
//    the retry assertions, 3 pass / 2 fail. With no mapping left the second
//    start has nothing to resume from and the bytes stay under the uri name
//    forever — the irreversibility the review called out. The ordering and
//    "one failure does not stop the others" assertions stay green, so the two
//    properties fail independently.
//  * Moving the directories after the re-key instead of before fails the
//    ordering assertion and only that one, 4 pass / 1 fail.
// ---------------------------------------------------------------------------
