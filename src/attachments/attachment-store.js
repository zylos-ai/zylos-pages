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
import { getPagesDb } from '../db/pages-db.js';
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

// Rebuild a uri-keyed table into a page_id-keyed one. Rows whose uri no longer
// resolves to a page cannot be re-keyed — they belong to a page that is gone,
// so the metadata is already unreachable. They are dropped rather than carried
// as rows pointing at nothing, and the count is logged so the loss is visible
// instead of silent.
function migrateFromUriKeyedTable(db) {
  const columns = db.prepare('PRAGMA table_info(artifact_attachments)').all();
  if (columns.length === 0) return;
  if (!columns.some(column => column.name === 'artifact')) return;

  const orphaned = db.prepare(`
    SELECT COUNT(*) AS n FROM artifact_attachments
    WHERE artifact NOT IN (SELECT uri FROM logical_pages)
  `).get().n;

  db.exec(`
    ALTER TABLE artifact_attachments RENAME TO artifact_attachments_by_uri;
    CREATE TABLE artifact_attachments (
      attachment_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO artifact_attachments
      SELECT a.attachment_id, p.page_id, a.item_key, a.original_filename,
             a.stored_filename, a.mime_type, a.size_bytes, a.created_at
      FROM artifact_attachments_by_uri a
      JOIN logical_pages p ON p.uri = a.artifact;
  `);

  // Files live in a directory named after the key, so they move with it.
  const moved = [];
  const root = attachmentRoot();
  for (const { artifact, page_id: pageId } of db.prepare(`
    SELECT DISTINCT a.artifact, p.page_id
    FROM artifact_attachments_by_uri a
    JOIN logical_pages p ON p.uri = a.artifact
  `).all()) {
    const from = path.join(root, artifact);
    const to = path.join(root, pageId);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.renameSync(from, to);
      moved.push(artifact);
    } catch (err) {
      logger.error('attachment directory migration failed', { artifact, pageId, err: err.message });
    }
  }

  db.exec('DROP TABLE artifact_attachments_by_uri');
  logger.info('attachment store migrated to page_id keys', { movedDirectories: moved.length, droppedOrphanRows: orphaned });
}

export function initAttachmentStore() {
  if (initialized) return;

  const db = getPagesDb();
  // The migration joins logical_pages, which the page store creates lazily.
  initPageStore();
  migrateFromUriKeyedTable(db);

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
    );
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

export function insertAttachment(record) {
  ensureInitialized();
  _insertOne.run(record);
}

/**
 * Insert only if the page is still within both ceilings once this record is
 * counted. Returns `{ok:false, reason:'count'|'bytes'}` without writing when it
 * is not — the caller owns the file at that point and must remove it.
 */
export function insertAttachmentWithinQuota(record, limits) {
  ensureInitialized();
  return _insertWithinQuota(record, limits);
}

export function deleteAttachmentMetadata(pageId, attachmentId) {
  ensureInitialized();
  return _deleteOne.run(pageId, attachmentId).changes > 0;
}
