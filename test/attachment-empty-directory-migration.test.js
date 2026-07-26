import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-empty-uri-data-'));
const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-empty-uri-content-'));
process.env.PAGES_DATA_DIR = dataDir;

const { getPagesDb, tableExists } = await import('../src/db/pages-db.js');
const { initPageStore, registerLogicalPage } = await import('../src/pages/page-store.js');
const { initStateStore } = await import('../src/state/state-store.js');
const { verifyPageDataMigration } = await import('../src/migrations/page-data-verifier.js');

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

initPageStore();
initStateStore();
const empty = await makePage('known-empty');
await makePage('known-nonempty');
await makePage('known-rmdir-failure');

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
  )
`);

const root = path.join(dataDir, 'attachments');
for (const directory of [
  'known-empty', 'known-nonempty', 'known-rmdir-failure',
  'unknown-empty', '.tmp', empty.pageId,
]) {
  await mkdir(path.join(root, directory), { recursive: true });
}
await writeFile(path.join(root, 'known-nonempty', 'must-survive.bin'), 'bytes');

const realRmdirSync = fs.rmdirSync;
const logs = [];
const realWrite = process.stderr.write.bind(process.stderr);
fs.rmdirSync = directory => {
  if (path.basename(directory) === 'known-rmdir-failure') {
    throw Object.assign(new Error('EACCES: injected rmdir refusal'), { code: 'EACCES' });
  }
  return realRmdirSync(directory);
};
process.stderr.write = chunk => { logs.push(String(chunk)); return true; };
try {
  const firstBoot = await import('../src/attachments/attachment-store.js?empty-uri-boot=1');
  firstBoot.initAttachmentStore();
} finally {
  fs.rmdirSync = realRmdirSync;
  process.stderr.write = realWrite;
}

const firstBoot = {
  emptyRemoved: !fs.existsSync(path.join(root, 'known-empty')),
  nonemptyPreserved: fs.readFileSync(path.join(root, 'known-nonempty', 'must-survive.bin'), 'utf8'),
  failedPreserved: fs.existsSync(path.join(root, 'known-rmdir-failure')),
  unknownPreserved: fs.existsSync(path.join(root, 'unknown-empty')),
  temporaryPreserved: fs.existsSync(path.join(root, '.tmp')),
  pageIdPreserved: fs.existsSync(path.join(root, empty.pageId)),
  snapshotKept: tableExists(db, 'artifact_attachments_by_uri'),
  errors: logs.filter(line => line.includes('empty legacy attachment directory could not be removed')),
};

const retry = await import('../src/attachments/attachment-store.js?empty-uri-boot=2');
retry.initAttachmentStore();
const retryFinished = {
  failedRemoved: !fs.existsSync(path.join(root, 'known-rmdir-failure')),
  snapshotRetired: !tableExists(db, 'artifact_attachments_by_uri'),
};

const blockedVerification = verifyPageDataMigration({ db, dataDir });
for (const directory of ['known-nonempty', 'unknown-empty', '.tmp', empty.pageId]) {
  fs.rmSync(path.join(root, directory), { recursive: true, force: true });
}
const cleanVerification = verifyPageDataMigration({ db, dataDir });

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

test('a registered uri with zero attachment rows loses only its empty legacy directory', () => {
  assert.equal(firstBoot.emptyRemoved, true);
  assert.equal(firstBoot.nonemptyPreserved, 'bytes');
  assert.equal(firstBoot.unknownPreserved, true);
  assert.equal(firstBoot.temporaryPreserved, true);
  assert.equal(firstBoot.pageIdPreserved, true);
});

test('a failed rmdir is logged, remains visible and is retried before snapshot retirement', () => {
  assert.equal(firstBoot.failedPreserved, true);
  assert.equal(firstBoot.snapshotKept, true);
  assert.equal(firstBoot.errors.length, 1);
  assert.match(firstBoot.errors[0], /known-rmdir-failure/);
  assert.equal(retryFinished.failedRemoved, true);
  assert.equal(retryFinished.snapshotRetired, true);
});

test('a nonempty known-uri directory is never deleted and still fails the verifier', () => {
  const check = blockedVerification.checks.find(item => item.id === 'attachments.no_legacy_uri_directories');
  assert.equal(check.ok, false);
  assert.deepEqual(check.directories, ['known-nonempty']);
  assert.ok(blockedVerification.failures.some(item => item.id === 'attachments.no_untracked_files'));
});

test('after safety fixtures are removed, the real zero-row migration shape passes verification', () => {
  assert.equal(cleanVerification.ok, true, JSON.stringify(cleanVerification.failures));
});
