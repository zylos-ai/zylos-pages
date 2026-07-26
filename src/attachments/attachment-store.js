// Attachment metadata, keyed by the page's stable `page_id`.
//
// It used to be keyed by the artifact string in the request path, which is a
// page's *current* uri. That disagreed with everything else about a page: a
// share grant follows `page_id` precisely so a link survives a rename, so after
// a move the grant pointed at the page while its stored bytes stayed behind
// under the old name — invisible to listing and deletion, absent from the
// storage total, and therefore a fresh ceiling on every rename. One identity
// for the page, used by the grant, the listing, the quota and the files.

import fs from 'node:fs';
import path from 'node:path';
import { getPagesDb, tableExists } from '../db/pages-db.js';
import { initPageStore } from '../pages/page-store.js';
import { attachmentRoot } from './storage.js';
import { logger } from '../utils/logger.js';

let initialized = false;
let _listForItem;
let _getOne;
let _insertOne;
let _deleteOne;
let _pageBytes;
let _countForItem;
let _insertWithinQuota;

function mapRow(row) {
  return {
    attachmentId: row.attachment_id,
    pageId: row.page_id,
    itemKey: row.item_key,
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

const ATTACHMENTS_SCHEMA = `
  attachment_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
`;

// The uri-keyed table, kept under this name while the migration is in flight.
// It is the only place the uri -> page_id mapping survives once the live table
// has been re-keyed, so it is retired last and only against evidence.
const SNAPSHOT_TABLE = 'artifact_attachments_by_uri';

// Re-keying attachments spans a database and a filesystem, and no transaction
// covers both. What can be chosen is the order and what is left behind, so
// that every interruption lands in a state a later run can finish from:
//
//   1. relocate  directories move to their page id *first*. Interrupted here,
//                the metadata is still uri-keyed — the state this function
//                already knows how to start from.
//   2. rekey     one transaction snapshots the uri-keyed table and rebuilds
//                the live one keyed by page_id. SQLite rolls back a partial.
//   3. verify    look for bytes still sitting under an old name that a row now
//                expects under the new one.
//   4. settle    drop the snapshot only when step 3 finds nothing left.
//
// The order matters because the two possible leftovers are not equally bad.
// Bytes moved with metadata not yet re-keyed is recoverable: the mapping is
// still in the live table. Metadata re-keyed with bytes not yet moved is a
// permanent 404, and that is what the first implementation produced — it
// committed the rebuilt table, then moved directories, then dropped the
// mapping whether or not the moves had worked, and on the next start returned
// early because the table was already page_id-keyed. That state is reachable
// on any instance that ran the previous version, so step 1 also repairs it:
// the snapshot table left behind is a resume marker, not debris.
//
// Every step asks what is on disk rather than what it did last time, so
// running the whole thing twice changes nothing the first run finished.
function uriToPageIdMapping(db, table) {
  return db.prepare(`
    SELECT DISTINCT a.artifact AS artifact, p.page_id AS pageId
    FROM ${table} a
    JOIN logical_pages p ON p.uri = a.artifact
  `).all();
}

// Never overwrites: a name already present at the destination is the live one,
// and a migration is not allowed to decide that an existing file loses.
function mergeDirectory(from, to) {
  let leftBehind = 0;
  for (const entry of fs.readdirSync(from)) {
    const target = path.join(to, entry);
    if (fs.existsSync(target)) {
      leftBehind += 1;
      continue;
    }
    fs.renameSync(path.join(from, entry), target);
  }
  if (leftBehind === 0) fs.rmdirSync(from);
  return leftBehind;
}

function safeDirectoryForUri(root, uri) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(root, uri);
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

// A legacy directory can exist even when the legacy attachment table has no
// rows. The row-driven mapping below cannot see that shape, while the
// post-migration verifier deliberately can. Retire only directories whose
// names are registered page uris and which are empty at the instant rmdir
// runs. Unknown names, page_id directories, symlinks and anything containing
// bytes remain evidence for the verifier rather than becoming guessed-at data.
function removeEmptyLegacyUriDirectories(db) {
  const root = attachmentRoot();
  const pages = db.prepare('SELECT uri, page_id AS pageId FROM logical_pages ORDER BY uri').all();
  const pageIds = new Set(pages.map(page => page.pageId));
  const outcome = { removed: 0, preservedNonEmpty: 0, unresolved: [] };

  for (const { uri, pageId } of pages) {
    if (uri === pageId || pageIds.has(uri)) continue;
    const directory = safeDirectoryForUri(root, uri);
    if (!directory) continue;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory()) continue;
      if (fs.readdirSync(directory).length !== 0) {
        outcome.preservedNonEmpty += 1;
        continue;
      }
      fs.rmdirSync(directory);
      outcome.removed += 1;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      outcome.unresolved.push({ artifact: uri, pageId, err: err.message });
      logger.error('empty legacy attachment directory could not be removed', {
        artifact: uri, pageId, err: err.message,
      });
    }
  }
  return outcome;
}

function relocateAttachmentDirectories(mapping) {
  const root = attachmentRoot();
  const outcome = { moved: 0, alreadyAtPageId: 0, noBytesStored: 0, duplicatesLeftInPlace: 0, unresolved: [] };

  for (const { artifact, pageId } of mapping) {
    if (artifact === pageId) {
      outcome.alreadyAtPageId += 1;
      continue;
    }
    const from = path.join(root, artifact);
    const to = path.join(root, pageId);
    try {
      if (!fs.existsSync(from)) {
        // Already moved by an earlier run, or the page never stored anything.
        if (fs.existsSync(to)) outcome.alreadyAtPageId += 1;
        else outcome.noBytesStored += 1;
        continue;
      }
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        outcome.moved += 1;
        continue;
      }
      // Both exist: an earlier run moved part of this page, or the page has
      // written new attachments under its id since. Merge, do not clobber.
      outcome.duplicatesLeftInPlace += mergeDirectory(from, to);
      outcome.moved += 1;
    } catch (err) {
      // One directory that cannot move must not stop the others, and must not
      // be forgotten either: it keeps the snapshot table alive so the next
      // start tries again with the mapping still intact.
      outcome.unresolved.push({ artifact, pageId, err: err.message });
      logger.error('attachment directory could not be moved to its page id', {
        artifact, pageId, err: err.message,
      });
    }
  }
  return outcome;
}

// Bytes a row now expects under its page id, still sitting under the old name.
// Bytes missing from both places were missing before this started — recording
// them is right, blocking on them forever is not, since no later run can
// produce a file that does not exist.
function strandedBytes(db, mapping) {
  const root = attachmentRoot();
  const rowsFor = db.prepare('SELECT stored_filename FROM artifact_attachments WHERE page_id = ?');
  const stranded = [];
  for (const { artifact, pageId } of mapping) {
    if (artifact === pageId) continue;
    const legacyDir = path.join(root, artifact);
    if (!fs.existsSync(legacyDir)) continue;
    for (const { stored_filename: stored } of rowsFor.all(pageId)) {
      if (fs.existsSync(path.join(root, pageId, stored))) continue;
      if (fs.existsSync(path.join(legacyDir, stored))) stranded.push({ artifact, pageId, stored });
    }
  }
  return stranded;
}

// Rows whose uri no longer resolves to a page cannot be re-keyed — they belong
// to a page that is gone, so the metadata is already unreachable. They are
// dropped rather than carried as rows pointing at nothing, and the count is
// logged so the loss is visible rather than silent.
//
// `INSERT OR IGNORE` because this same statement serves two callers: the
// re-key, where the target is empty, and the repair of an instance whose
// previous run was interrupted between creating the table and filling it.
function restoreRowsFromSnapshot(db) {
  return db.prepare(`
    INSERT OR IGNORE INTO artifact_attachments (
      attachment_id, page_id, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    )
    SELECT a.attachment_id, p.page_id, a.item_key, a.original_filename,
           a.stored_filename, a.mime_type, a.size_bytes, a.created_at
    FROM ${SNAPSHOT_TABLE} a
    JOIN logical_pages p ON p.uri = a.artifact
  `).run().changes;
}

function migrateToPageIdKeys(db) {
  const columns = db.prepare('PRAGMA table_info(artifact_attachments)').all();
  const liveTableIsUriKeyed = columns.some(column => column.name === 'artifact');
  const resuming = tableExists(db, SNAPSHOT_TABLE);
  if (!liveTableIsUriKeyed && !resuming) return;

  // The mapping lives in whichever table still carries the uri.
  const mapping = uriToPageIdMapping(db, liveTableIsUriKeyed ? 'artifact_attachments' : SNAPSHOT_TABLE);

  // Step 1 — remove rowless empty legacy directories, then move bytes. Both
  // operations happen before the re-key so an interruption remains resumable.
  const emptyDirectories = removeEmptyLegacyUriDirectories(db);
  const relocation = relocateAttachmentDirectories(mapping);

  // Step 2 — one transaction, or none of it.
  let restored = 0;
  let orphaned = 0;
  if (liveTableIsUriKeyed) {
    orphaned = db.prepare(`
      SELECT COUNT(*) AS n FROM artifact_attachments
      WHERE artifact NOT IN (SELECT uri FROM logical_pages)
    `).get().n;
    db.transaction(() => {
      db.exec(`ALTER TABLE artifact_attachments RENAME TO ${SNAPSHOT_TABLE}`);
      db.exec(`CREATE TABLE artifact_attachments (${ATTACHMENTS_SCHEMA})`);
      restored = restoreRowsFromSnapshot(db);
    })();
  } else {
    // Resuming: the live table exists but may be missing rows if the previous
    // run was interrupted before or during its insert.
    orphaned = db.prepare(`
      SELECT COUNT(*) AS n FROM ${SNAPSHOT_TABLE}
      WHERE artifact NOT IN (SELECT uri FROM logical_pages)
    `).get().n;
    restored = db.transaction(() => restoreRowsFromSnapshot(db))();
  }

  // Step 3 — evidence, not optimism.
  const stranded = strandedBytes(db, mapping);
  const summary = {
    movedDirectories: relocation.moved,
    removedEmptyLegacyDirectories: emptyDirectories.removed,
    preservedNonEmptyLegacyDirectories: emptyDirectories.preservedNonEmpty,
    alreadyAtPageId: relocation.alreadyAtPageId,
    pagesWithNoStoredBytes: relocation.noBytesStored,
    duplicatesLeftInPlace: relocation.duplicatesLeftInPlace,
    restoredRows: restored,
    droppedOrphanRows: orphaned,
  };

  // Step 4 — retire the mapping only once nothing needs it.
  if (emptyDirectories.unresolved.length === 0
      && relocation.unresolved.length === 0 && stranded.length === 0) {
    db.exec(`DROP TABLE IF EXISTS ${SNAPSHOT_TABLE}`);
    logger.info('attachment store migrated to page_id keys', summary);
    return;
  }

  logger.error('attachment store migration incomplete, uri mapping kept for the next start', {
    ...summary,
    unresolvedDirectories: emptyDirectories.unresolved.length + relocation.unresolved.length,
    strandedFiles: stranded.length,
    firstUnresolved: emptyDirectories.unresolved[0] ?? relocation.unresolved[0] ?? null,
  });
}

export function initAttachmentStore() {
  if (initialized) return;

  const db = getPagesDb();
  // The migration joins logical_pages, which the page store creates lazily.
  initPageStore();

  // Created before the migration as well as after it. A run interrupted
  // between renaming the old table and creating the new one leaves no live
  // table at all, and the repair path needs somewhere to put the rows back.
  // Harmless when the uri-keyed table still holds the name.
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_attachments (${ATTACHMENTS_SCHEMA})`);
  migrateToPageIdKeys(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_attachments (${ATTACHMENTS_SCHEMA});
    CREATE INDEX IF NOT EXISTS idx_artifact_attachments_page_key_created
      ON artifact_attachments(page_id, item_key, created_at DESC);
  `);

  _listForItem = db.prepare(`
    SELECT * FROM artifact_attachments
    WHERE page_id = ? AND item_key = ?
    ORDER BY created_at DESC, attachment_id DESC
  `);
  _getOne = db.prepare(`
    SELECT * FROM artifact_attachments
    WHERE page_id = ? AND attachment_id = ?
  `);
  _insertOne = db.prepare(`
    INSERT INTO artifact_attachments (
      attachment_id, page_id, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    )
    VALUES (
      @attachmentId, @pageId, @itemKey, @originalFilename,
      @storedFilename, @mimeType, @sizeBytes, @createdAt
    )
  `);
  _deleteOne = db.prepare(`
    DELETE FROM artifact_attachments
    WHERE page_id = ? AND attachment_id = ?
  `);
  // COALESCE because SUM over no rows is NULL, and a page with nothing stored
  // is the common case for the caller that asks this.
  _pageBytes = db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS total
    FROM artifact_attachments
    WHERE page_id = ?
  `);
  _countForItem = db.prepare(`
    SELECT COUNT(*) AS n FROM artifact_attachments
    WHERE page_id = ? AND item_key = ?
  `);

  // The ceilings are decided and the row is written in one transaction. Read
  // the totals first and insert afterwards and the limit is advisory: two
  // uploads that both pass the read before either writes are both admitted,
  // which is exactly the interleaving an unauthenticated link holder can
  // produce at will. The incoming size is part of the comparison for the same
  // reason — `current >= max` lets anything that starts under the line finish
  // over it by up to one whole maxFileSizeBytes.
  //
  // Run with `BEGIN IMMEDIATE` (see the call site) rather than the default
  // deferred begin. A deferred transaction that reads and then writes takes no
  // lock until the write, so it cannot promote its snapshot once another
  // connection has the write lock — `SQLITE_BUSY_SNAPSHOT` when that
  // connection committed inside the read window, plain `SQLITE_BUSY` when it
  // still holds the lock. Neither refusal goes through the busy handler, so
  // `busy_timeout` is not consulted and the call fails at once (measured: a
  // deferred begin returns in ~1ms against a competitor holding the lock for
  // 600ms, with `busy_timeout` set to 5000). Both arrived as untyped throws,
  // which the route could only render as 500 / `internal_error`.
  //
  // Taking the write lock at BEGIN turns that into ordinary write contention,
  // which the busy handler does cover: the second writer waits for the first
  // to commit and then reads totals that already include it. The ceiling was
  // never unsafe either way — both outcomes refuse rather than admit — but
  // only one of them is a contract a caller can act on.
  _insertWithinQuota = db.transaction((record, limits) => {
    if (_countForItem.get(record.pageId, record.itemKey).n >= limits.maxPerItem) {
      return { ok: false, reason: 'count' };
    }
    if (_pageBytes.get(record.pageId).total + record.sizeBytes > limits.maxArtifactBytes) {
      return { ok: false, reason: 'bytes' };
    }
    _insertOne.run(record);
    return { ok: true };
  });

  initialized = true;
}

function ensureInitialized() {
  if (!initialized) initAttachmentStore();
}

export function listAttachments(pageId, itemKey) {
  ensureInitialized();
  return _listForItem.all(pageId, itemKey).map(mapRow);
}

export function getAttachment(pageId, attachmentId) {
  ensureInitialized();
  const row = _getOne.get(pageId, attachmentId);
  return row ? mapRow(row) : null;
}

// Bytes currently stored against one page. Used as a storage ceiling for
// share-link writers; see src/routes/attachment-api.js.
export function pageByteTotal(pageId) {
  ensureInitialized();
  return _pageBytes.get(pageId)?.total ?? 0;
}

export function countAttachments(pageId, itemKey) {
  ensureInitialized();
  return _countForItem.get(pageId, itemKey).n;
}

// Write contention is a transient condition with a correct client response,
// and the one thing it must never become is an untyped throw — the routes turn
// those into 500 / `internal_error`, which tells a caller nothing and, on this
// route, is indistinguishable from a bug. Retrying is safe here specifically:
// a refused transaction rolls back completely and the upload route unlinks the
// file it was holding, so there is no partial state for a second attempt to
// collide with. 503 rather than 429 because 429 already means something else
// on this route — the share link's own write allowance — and a client that
// learns to back off should not have to guess which of the two it hit.
const RETRY_AFTER_SECONDS = 1;

function asRetryableContention(err) {
  if (!String(err?.code || '').startsWith('SQLITE_BUSY')) return err;
  return Object.assign(new Error('The attachment store is busy, please retry'), {
    statusCode: 503,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    cause: err,
  });
}

export function insertAttachment(record) {
  ensureInitialized();
  try {
    _insertOne.run(record);
  } catch (err) {
    throw asRetryableContention(err);
  }
}

/**
 * Insert only if the page is still within both ceilings once this record is
 * counted. Returns `{ok:false, reason:'count'|'bytes'}` without writing when it
 * is not — the caller owns the file at that point and must remove it.
 *
 * Throws a `statusCode: 503` error carrying `retryAfterSeconds` when the write
 * lock cannot be acquired within `busy_timeout`. Nothing is written in that
 * case either, and the caller's existing catch removes the file, so a retry
 * starts from a clean slate.
 */
export function insertAttachmentWithinQuota(record, limits) {
  ensureInitialized();
  try {
    return _insertWithinQuota.immediate(record, limits);
  } catch (err) {
    throw asRetryableContention(err);
  }
}

export function deleteAttachmentMetadata(pageId, attachmentId) {
  ensureInitialized();
  return _deleteOne.run(pageId, attachmentId).changes > 0;
}
