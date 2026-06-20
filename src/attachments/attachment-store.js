import { getPagesDb } from '../db/pages-db.js';

let initialized = false;
let _listForItem;
let _getOne;
let _insertOne;
let _deleteOne;

function mapRow(row) {
  return {
    attachmentId: row.attachment_id,
    artifact: row.artifact,
    itemKey: row.item_key,
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

export function initAttachmentStore() {
  if (initialized) return;

  const db = getPagesDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_attachments (
      attachment_id TEXT PRIMARY KEY,
      artifact TEXT NOT NULL,
      item_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_attachments_artifact_key_created
      ON artifact_attachments(artifact, item_key, created_at DESC);
  `);

  _listForItem = db.prepare(`
    SELECT * FROM artifact_attachments
    WHERE artifact = ? AND item_key = ?
    ORDER BY created_at DESC, attachment_id DESC
  `);
  _getOne = db.prepare(`
    SELECT * FROM artifact_attachments
    WHERE artifact = ? AND attachment_id = ?
  `);
  _insertOne = db.prepare(`
    INSERT INTO artifact_attachments (
      attachment_id, artifact, item_key, original_filename,
      stored_filename, mime_type, size_bytes, created_at
    )
    VALUES (
      @attachmentId, @artifact, @itemKey, @originalFilename,
      @storedFilename, @mimeType, @sizeBytes, @createdAt
    )
  `);
  _deleteOne = db.prepare(`
    DELETE FROM artifact_attachments
    WHERE artifact = ? AND attachment_id = ?
  `);

  initialized = true;
}

function ensureInitialized() {
  if (!initialized) initAttachmentStore();
}

export function listAttachments(artifact, itemKey) {
  ensureInitialized();
  return _listForItem.all(artifact, itemKey).map(mapRow);
}

export function getAttachment(artifact, attachmentId) {
  ensureInitialized();
  const row = _getOne.get(artifact, attachmentId);
  return row ? mapRow(row) : null;
}

export function insertAttachment(record) {
  ensureInitialized();
  _insertOne.run(record);
}

export function deleteAttachmentMetadata(artifact, attachmentId) {
  ensureInitialized();
  return _deleteOne.run(artifact, attachmentId).changes > 0;
}
