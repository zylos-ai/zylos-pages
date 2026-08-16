import fs from 'node:fs';
import path from 'node:path';

const STATE_SNAPSHOT = 'artifact_state_by_uri';
const ATTACHMENT_SNAPSHOT = 'artifact_attachments_by_uri';
const STATE_ARCHIVE = path.join('migration-archive', 'artifact-state-orphans-v1.json');
const REQUIRED = {
  logical_pages: [
    'page_id', 'uri', 'title', 'source_path', 'source_ext', 'page_type', 'source_root_name',
    'access_mode', 'created_at', 'updated_at',
  ],
  artifact_state: ['page_id', 'key', 'value', 'updated_at'],
  artifact_attachments: [
    'attachment_id', 'page_id', 'item_key', 'original_filename',
    'stored_filename', 'mime_type', 'size_bytes', 'created_at',
  ],
};

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnsFor(db, table) {
  return tableExists(db, table) ? db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name) : [];
}

function addCheck(result, id, ok, details = {}) {
  const check = { id, ok, ...details };
  result.checks.push(check);
  if (!ok) result.failures.push(check);
  return check;
}

function duplicateRows(db, table, fields) {
  const projection = fields.join(', ');
  return db.prepare(`
    SELECT ${projection}, COUNT(*) AS count
    FROM ${table}
    GROUP BY ${projection}
    HAVING COUNT(*) > 1
    ORDER BY ${projection}
  `).all();
}

function orphanRows(db, table, identityField) {
  return db.prepare(`
    SELECT child.*
    FROM ${table} child
    LEFT JOIN logical_pages page ON page.page_id = child.page_id
    WHERE page.page_id IS NULL
    ORDER BY child.page_id, child.${identityField}
  `).all();
}

function isValidPageId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safePathInside(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(resolvedRoot, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
}

function isValidArchiveRow(row) {
  return row && typeof row.artifact === 'string' && typeof row.key === 'string'
    && typeof row.value === 'string' && typeof row.updatedAt === 'string';
}

function stateArchiveRows(dataDir) {
  const archivePath = path.join(dataDir, STATE_ARCHIVE);
  if (!fs.existsSync(archivePath)) return { path: archivePath, exists: false, rows: [], error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    if (parsed?.format !== 'zylos-pages/artifact-state-orphans-v1' || !Array.isArray(parsed.rows)
        || !parsed.rows.every(isValidArchiveRow)) {
      throw new Error('unexpected archive format');
    }
    return { path: archivePath, exists: true, rows: parsed.rows, error: null };
  } catch (err) {
    return { path: archivePath, exists: true, rows: [], error: err.message };
  }
}

function stateRowIdentity(row) {
  return JSON.stringify([row.artifact, row.key, row.value, row.updated_at ?? row.updatedAt]);
}

function classifyStateSnapshot(db, dataDir) {
  if (!tableExists(db, STATE_SNAPSHOT)) return null;

  const rows = db.prepare(`
    SELECT artifact, key, value, updated_at
    FROM ${STATE_SNAPSHOT}
    ORDER BY artifact, key
  `).all();
  const knownUris = new Set(db.prepare('SELECT uri FROM logical_pages').all().map(row => row.uri));
  const currentOrphans = rows.filter(row => !knownUris.has(row.artifact));
  const missingLive = db.prepare(`
    SELECT snapshot.artifact, snapshot.key, page.page_id AS pageId
    FROM ${STATE_SNAPSHOT} snapshot
    JOIN logical_pages page ON page.uri = snapshot.artifact
    LEFT JOIN artifact_state live ON live.page_id = page.page_id AND live.key = snapshot.key
    WHERE live.page_id IS NULL
    ORDER BY snapshot.artifact, snapshot.key
  `).all();
  const archive = stateArchiveRows(dataDir);
  let classification = 'state_snapshot_present';
  if (archive.error) {
    classification = 'state_snapshot_archive_invalid';
  } else if (archive.exists) {
    const archiveIdentities = archive.rows.map(stateRowIdentity);
    const currentIdentities = currentOrphans.map(stateRowIdentity);
    const archived = new Set(archiveIdentities);
    const current = new Set(currentIdentities);
    const archiveHasDuplicates = archived.size !== archiveIdentities.length;
    const currentHasDuplicates = current.size !== currentIdentities.length;
    const archiveCoversCurrent = [...current].every(identity => archived.has(identity));
    if (archiveHasDuplicates || currentHasDuplicates || !archiveCoversCurrent) {
      classification = 'state_snapshot_archive_conflict';
    } else if (archived.size > current.size) {
      // A crash after archive rename+fsync but before snapshot retirement can
      // land here if one of the formerly-orphan URIs is registered meanwhile.
      // The archive is still the evidence for the original snapshot; replacing
      // it with the smaller current set would silently discard that history.
      classification = 'state_snapshot_archive_superset';
    } else {
      classification = 'state_snapshot_matches_archive';
    }
  }

  return {
    classification,
    snapshotRows: rows.length,
    currentOrphanRows: currentOrphans.length,
    missingLiveRows: missingLive,
    archive: {
      path: archive.path,
      exists: archive.exists,
      rows: archive.rows.length,
      error: archive.error,
    },
    guidance: 'Preserve artifact_state_by_uri as retry evidence; do not DROP it manually.',
  };
}

function attachmentSnapshotDetails(db) {
  if (!tableExists(db, ATTACHMENT_SNAPSHOT)) return null;
  const columns = columnsFor(db, ATTACHMENT_SNAPSHOT);
  const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM ${ATTACHMENT_SNAPSHOT}`).get().n;
  return {
    table: ATTACHMENT_SNAPSHOT,
    columns,
    rows: rowCount,
    guidance: 'Preserve artifact_attachments_by_uri as retry evidence; do not DROP it manually.',
  };
}

function attachmentFiles(db, dataDir, pages) {
  const root = path.join(dataDir, 'attachments');
  const knownPageIds = new Set(pages.map(page => page.pageId));
  const knownUris = new Set(pages.map(page => page.uri));
  const rows = db.prepare(`
    SELECT attachment_id AS attachmentId, page_id AS pageId,
           stored_filename AS storedFilename, mime_type AS mimeType,
           size_bytes AS sizeBytes
    FROM artifact_attachments
    ORDER BY page_id, attachment_id
  `).all();
  const referenced = new Set(rows.map(row => `${row.pageId}/${row.storedFilename}`));
  const missing = [];
  const sizeMismatches = [];
  const nameMismatches = [];
  const extensionForMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  for (const row of rows) {
    const extension = extensionForMime[row.mimeType];
    const expected = extension ? `${row.attachmentId}.${extension}` : null;
    if (row.storedFilename !== expected) nameMismatches.push({ ...row, expectedStoredFilename: expected });
    const filePath = isValidPageId(row.pageId) && row.storedFilename === expected
      ? safePathInside(root, row.pageId, row.storedFilename)
      : null;
    let stat;
    if (filePath) {
      try {
        stat = fs.lstatSync(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (!stat?.isFile()) {
      missing.push(row);
    } else if (stat.size !== row.sizeBytes) {
      sizeMismatches.push({ ...row, actualSizeBytes: stat.size });
    }
  }

  const legacyDirectories = [...knownUris]
    .filter(uri => {
      if (knownPageIds.has(uri)) return false;
      const candidate = safePathInside(root, uri);
      if (!candidate) return false;
      try {
        return fs.lstatSync(candidate).isDirectory();
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    })
    .sort();
  const unknownDirectories = [];
  const untrackedFiles = [];
  const temporaryFiles = [];

  function collectUntracked(directoryPath, relativeDirectory) {
    for (const file of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const relative = `${relativeDirectory}/${file.name}`;
      if (file.isDirectory()) collectUntracked(path.join(directoryPath, file.name), relative);
      else if (!file.isFile() || !referenced.has(relative)) untrackedFiles.push(relative);
    }
  }

  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        untrackedFiles.push(entry.name);
        continue;
      }
      const directory = entry.name;
      const directoryPath = path.join(root, directory);
      if (directory === '.tmp') {
        temporaryFiles.push(...fs.readdirSync(directoryPath).map(name => `.tmp/${name}`));
        continue;
      }
      if (!knownPageIds.has(directory)) {
        const containsLegacyUri = legacyDirectories.some(uri => uri === directory || uri.startsWith(`${directory}/`));
        if (!containsLegacyUri) unknownDirectories.push(directory);
      }
      collectUntracked(directoryPath, directory);
    }
  }
  return {
    root, rows, missing, sizeMismatches, nameMismatches,
    legacyDirectories, unknownDirectories, untrackedFiles, temporaryFiles,
  };
}

export function verifyPageDataMigration({
  db,
  dataDir,
  sentinel = '\0zylos-pages-migration-verifier-must-not-exist\0',
}) {
  const result = {
    ok: true,
    status: 'passed',
    checks: [],
    failures: [],
    warnings: [],
    counts: {},
    negativeControl: { sentinel },
  };

  for (const [table, requiredColumns] of Object.entries(REQUIRED)) {
    const columns = columnsFor(db, table);
    const legacyColumns = columns.filter(column => column === 'artifact');
    addCheck(result, `schema.${table}`,
      requiredColumns.every(column => columns.includes(column)) && legacyColumns.length === 0,
      { columns, requiredColumns, legacyColumns });
  }
  if (result.failures.some(check => check.id.startsWith('schema.'))) {
    result.ok = false;
    result.status = 'failed';
    return result;
  }

  const pages = db.prepare('SELECT page_id AS pageId, uri FROM logical_pages ORDER BY page_id').all();
  result.counts.pages = pages.length;
  result.counts.stateRows = db.prepare('SELECT COUNT(*) AS n FROM artifact_state').get().n;
  result.counts.attachmentRows = db.prepare('SELECT COUNT(*) AS n FROM artifact_attachments').get().n;

  const pageIdDuplicates = duplicateRows(db, 'logical_pages', ['page_id']);
  const uriDuplicates = duplicateRows(db, 'logical_pages', ['uri']);
  const invalidPageIds = pages.filter(page => !isValidPageId(page.pageId));
  addCheck(result, 'logical_pages.unique_page_id', pageIdDuplicates.length === 0, { rows: pageIdDuplicates });
  addCheck(result, 'logical_pages.unique_uri', uriDuplicates.length === 0, { rows: uriDuplicates });
  addCheck(result, 'logical_pages.valid_page_ids', invalidPageIds.length === 0, { rows: invalidPageIds });

  const stateOrphans = orphanRows(db, 'artifact_state', 'key');
  const stateDuplicates = duplicateRows(db, 'artifact_state', ['page_id', 'key']);
  addCheck(result, 'state.no_orphan_page_ids', stateOrphans.length === 0, { rows: stateOrphans });
  addCheck(result, 'state.no_duplicate_keys', stateDuplicates.length === 0, { rows: stateDuplicates });

  const attachmentOrphans = orphanRows(db, 'artifact_attachments', 'attachment_id');
  const attachmentIdDuplicates = duplicateRows(db, 'artifact_attachments', ['attachment_id']);
  const attachmentFileDuplicates = duplicateRows(db, 'artifact_attachments', ['page_id', 'stored_filename']);
  addCheck(result, 'attachments.no_orphan_page_ids', attachmentOrphans.length === 0, { rows: attachmentOrphans });
  addCheck(result, 'attachments.no_duplicate_ids', attachmentIdDuplicates.length === 0, { rows: attachmentIdDuplicates });
  addCheck(result, 'attachments.no_duplicate_files', attachmentFileDuplicates.length === 0, { rows: attachmentFileDuplicates });

  const stateSnapshot = classifyStateSnapshot(db, dataDir);
  addCheck(result, 'state.snapshot_retired', stateSnapshot === null, stateSnapshot ? { stateSnapshot } : {});
  const attachmentSnapshot = attachmentSnapshotDetails(db);
  addCheck(result, 'attachments.snapshot_retired', attachmentSnapshot === null,
    attachmentSnapshot ? { attachmentSnapshot } : {});

  const files = attachmentFiles(db, dataDir, pages);
  addCheck(result, 'attachments.files_present', files.missing.length === 0, { rows: files.missing });
  addCheck(result, 'attachments.file_sizes_match', files.sizeMismatches.length === 0, { rows: files.sizeMismatches });
  addCheck(result, 'attachments.stored_names_match', files.nameMismatches.length === 0, { rows: files.nameMismatches });
  addCheck(result, 'attachments.no_legacy_uri_directories', files.legacyDirectories.length === 0,
    { directories: files.legacyDirectories });
  addCheck(result, 'attachments.no_unknown_directories', files.unknownDirectories.length === 0,
    { directories: files.unknownDirectories });
  addCheck(result, 'attachments.no_untracked_files', files.untrackedFiles.length === 0,
    { files: files.untrackedFiles });
  if (files.temporaryFiles.length > 0) {
    result.warnings.push({ id: 'attachments.temporary_files_present', files: files.temporaryFiles });
  }

  const sentinelCounts = {
    logicalPages: db.prepare('SELECT COUNT(*) AS n FROM logical_pages WHERE page_id = ? OR uri = ?')
      .get(sentinel, sentinel).n,
    stateRows: db.prepare('SELECT COUNT(*) AS n FROM artifact_state WHERE page_id = ?').get(sentinel).n,
    attachmentRows: db.prepare('SELECT COUNT(*) AS n FROM artifact_attachments WHERE page_id = ?').get(sentinel).n,
  };
  result.negativeControl = { sentinel, counts: sentinelCounts };
  addCheck(result, 'negative_control.nonexistent_page_is_empty',
    Object.values(sentinelCounts).every(count => count === 0), { sentinel, counts: sentinelCounts });

  result.ok = result.failures.length === 0;
  result.status = result.ok ? 'passed' : 'failed';
  return result;
}
