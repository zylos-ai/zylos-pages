import fs from 'node:fs';
import path from 'node:path';
import { getPagesDb, tableExists } from '../db/pages-db.js';
import { DATA_DIR } from '../lib/config.js';
import { initPageStore } from '../pages/page-store.js';
import { logger } from '../utils/logger.js';

let initialized = false;
let _getAll;
let _getOne;
let _setOne;
let _deleteOne;
let _countKeys;
let _pageBytes;
let _setWithinQuota;

const STATE_SCHEMA = `
  page_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (page_id, key)
`;

const SNAPSHOT_TABLE = 'artifact_state_by_uri';
export const STATE_ORPHAN_ARCHIVE_PATH = path.join(
  DATA_DIR,
  'migration-archive',
  'artifact-state-orphans-v1.json'
);

function parseStoredValue(row) {
  return JSON.parse(row.value);
}

function canonicalOrphanArchive(rows) {
  return `${JSON.stringify({
    format: 'zylos-pages/artifact-state-orphans-v1',
    rows: rows.map(row => ({
      artifact: row.artifact,
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    })),
  }, null, 2)}\n`;
}

// The archive is the only retained copy of rows that cannot resolve to a
// logical page. Write and fsync it before retiring the database snapshot; an
// interrupted run can therefore always retry from either the snapshot or a
// complete archive, never from a half-written file.
function archiveOrphanRows(rows) {
  if (rows.length === 0) return { archived: 0, path: null };

  const body = canonicalOrphanArchive(rows);
  fs.mkdirSync(path.dirname(STATE_ORPHAN_ARCHIVE_PATH), { recursive: true, mode: 0o700 });

  if (fs.existsSync(STATE_ORPHAN_ARCHIVE_PATH)) {
    const existing = fs.readFileSync(STATE_ORPHAN_ARCHIVE_PATH, 'utf8');
    if (existing !== body) {
      throw new Error(`state orphan archive already exists with different content: ${STATE_ORPHAN_ARCHIVE_PATH}`);
    }
    return { archived: rows.length, path: STATE_ORPHAN_ARCHIVE_PATH };
  }

  const temporary = `${STATE_ORPHAN_ARCHIVE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, STATE_ORPHAN_ARCHIVE_PATH);

    // Persist the directory entry before the snapshot that backs it is
    // dropped. Some filesystems otherwise acknowledge rename before it is
    // durable across a machine crash.
    const dirFd = fs.openSync(path.dirname(STATE_ORPHAN_ARCHIVE_PATH), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw err;
  }

  return { archived: rows.length, path: STATE_ORPHAN_ARCHIVE_PATH };
}

function restoreRowsFromSnapshot(db) {
  return db.prepare(`
    INSERT OR IGNORE INTO artifact_state (page_id, key, value, updated_at)
    SELECT p.page_id, s.key, s.value, s.updated_at
    FROM ${SNAPSHOT_TABLE} s
    JOIN logical_pages p ON p.uri = s.artifact
  `).run().changes;
}

// Re-key the legacy (artifact, key) table onto the stable page identity. The
// snapshot is a resume marker: it survives every interruption until all live
// rows are present and every orphan has a durable export.
function migrateToPageIdKeys(db) {
  const columns = db.prepare('PRAGMA table_info(artifact_state)').all();
  const liveTableIsUriKeyed = columns.some(column => column.name === 'artifact');
  const resuming = tableExists(db, SNAPSHOT_TABLE);
  if (!liveTableIsUriKeyed && !resuming) return;

  if (liveTableIsUriKeyed) {
    if (resuming) {
      throw new Error('state migration found both a legacy live table and an existing snapshot');
    }
    db.transaction(() => {
      db.exec(`ALTER TABLE artifact_state RENAME TO ${SNAPSHOT_TABLE}`);
      db.exec(`CREATE TABLE artifact_state (${STATE_SCHEMA})`);
    })();
  }

  const orphans = db.prepare(`
    SELECT artifact, key, value, updated_at
    FROM ${SNAPSHOT_TABLE}
    WHERE artifact NOT IN (SELECT uri FROM logical_pages)
    ORDER BY artifact ASC, key ASC
  `).all();

  let archive;
  try {
    archive = archiveOrphanRows(orphans);
  } catch (err) {
    // Valid rows can still be restored and served. Keep the snapshot so a
    // later start can retry the archive rather than turning one filesystem
    // failure into either data loss or a total Pages outage.
    restoreRowsFromSnapshot(db);
    logger.error('state store migration incomplete, uri snapshot kept for the next start', {
      orphanRows: orphans.length,
      err: err.message,
    });
    return;
  }

  const restoredRows = db.transaction(() => restoreRowsFromSnapshot(db))();
  const missingLiveRows = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ${SNAPSHOT_TABLE} s
    JOIN logical_pages p ON p.uri = s.artifact
    LEFT JOIN artifact_state live ON live.page_id = p.page_id AND live.key = s.key
    WHERE live.page_id IS NULL
  `).get().n;

  if (missingLiveRows !== 0) {
    logger.error('state store migration incomplete, uri snapshot kept for the next start', {
      restoredRows,
      orphanRows: orphans.length,
      archivedOrphanRows: archive.archived,
      missingLiveRows,
    });
    return;
  }

  db.exec(`DROP TABLE ${SNAPSHOT_TABLE}`);
  logger.info('state store migrated to page_id keys', {
    restoredRows,
    orphanRows: orphans.length,
    archivedOrphanRows: archive.archived,
    orphanArchivePath: archive.path,
  });
}

export function initStateStore() {
  if (initialized) return;

  const db = getPagesDb();
  initPageStore();
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_state (${STATE_SCHEMA})`);
  migrateToPageIdKeys(db);

  _getAll = db.prepare('SELECT key, value FROM artifact_state WHERE page_id = ? ORDER BY key ASC');
  _getOne = db.prepare('SELECT value FROM artifact_state WHERE page_id = ? AND key = ?');
  _setOne = db.prepare(`
    INSERT OR REPLACE INTO artifact_state (page_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  _deleteOne = db.prepare('DELETE FROM artifact_state WHERE page_id = ? AND key = ?');
  _countKeys = db.prepare('SELECT COUNT(*) AS n FROM artifact_state WHERE page_id = ?');
  _pageBytes = db.prepare(`
    SELECT COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS total
    FROM artifact_state
    WHERE page_id = ?
  `);
  _setWithinQuota = db.transaction((pageId, key, encoded, limits) => {
    const existing = _getOne.get(pageId, key);
    if (!existing && _countKeys.get(pageId).n >= limits.maxKeysPerPage) {
      return { ok: false, reason: 'keys' };
    }
    const existingBytes = existing ? Buffer.byteLength(existing.value, 'utf8') : 0;
    const incomingBytes = Buffer.byteLength(encoded, 'utf8');
    if (_pageBytes.get(pageId).total - existingBytes + incomingBytes > limits.maxPageBytes) {
      return { ok: false, reason: 'bytes' };
    }
    _setOne.run(pageId, key, encoded, new Date().toISOString());
    return { ok: true, existing: Boolean(existing), incomingBytes };
  });
  initialized = true;
}

function ensureInitialized() {
  if (!initialized) initStateStore();
}

const RETRY_AFTER_SECONDS = 1;

function asRetryableContention(err) {
  if (!String(err?.code || '').startsWith('SQLITE_BUSY')) return err;
  return Object.assign(new Error('The state store is busy, please retry'), {
    statusCode: 503,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    cause: err,
  });
}

export function getArtifactState(pageId) {
  ensureInitialized();
  const state = {};
  for (const row of _getAll.all(pageId)) {
    state[row.key] = parseStoredValue(row);
  }
  return state;
}

export function getStateValue(pageId, key) {
  ensureInitialized();
  const row = _getOne.get(pageId, key);
  if (!row) return { found: false };
  return { found: true, value: parseStoredValue(row) };
}

export function setStateValue(pageId, key, value) {
  ensureInitialized();
  try {
    _setOne.run(pageId, key, JSON.stringify(value), new Date().toISOString());
  } catch (err) {
    throw asRetryableContention(err);
  }
}

// The share ceiling and write are one BEGIN IMMEDIATE transaction. Concurrent
// share writers therefore serialize before reading totals; owner writes use
// setStateValue() and intentionally bypass these governance ceilings.
export function setStateValueWithinQuota(pageId, key, value, limits) {
  ensureInitialized();
  try {
    return _setWithinQuota.immediate(pageId, key, JSON.stringify(value), limits);
  } catch (err) {
    throw asRetryableContention(err);
  }
}

export function deleteStateValue(pageId, key) {
  ensureInitialized();
  try {
    return _deleteOne.run(pageId, key).changes > 0;
  } catch (err) {
    throw asRetryableContention(err);
  }
}
