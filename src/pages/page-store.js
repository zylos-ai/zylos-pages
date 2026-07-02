import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPagesDb } from '../db/pages-db.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

const PAGE_EXTENSIONS = new Set(['.md', '.html']);

let initialized = false;
let db;

function nowMs() {
  return Date.now();
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return process.env.HOME;
  if (value.startsWith('~/')) return path.join(process.env.HOME, value.slice(2));
  return value;
}

function isInsideRoot(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function allowedSourceRoots(config) {
  const roots = [];
  for (const [name, root] of Object.entries(config.externalFiles?.allowedSources || {})) {
    if (typeof root === 'string' && root) {
      roots.push({ name, root: expandHome(root) });
    }
  }
  for (const [name, root] of Object.entries(config.sourceRegistry?.allowedSources || {})) {
    if (typeof root === 'string' && root) {
      roots.push({ name, root: expandHome(root) });
    }
  }
  return roots;
}

export class SourceValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceValidationError';
    this.code = code;
    this.statusCode = code === 'source_missing' ? 404 : 400;
  }
}

const LOGICAL_PAGES_COLUMNS = `
      page_id TEXT PRIMARY KEY,
      uri TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_ext TEXT NOT NULL,
      source_root_name TEXT,
      access_mode TEXT NOT NULL DEFAULT 'private' CHECK (access_mode IN ('private', 'shared')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
`;

// One-time migration from the legacy uri-keyed schema: rebuild the table with a
// stable page_id primary key, backfilling a uuid per existing row.
function migrateLogicalPagesToPageId() {
  const columns = db.prepare('PRAGMA table_info(logical_pages)').all().map(column => column.name);
  if (columns.length === 0 || columns.includes('page_id')) return;
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE logical_pages_next (${LOGICAL_PAGES_COLUMNS})`);
    const insert = db.prepare(`
      INSERT INTO logical_pages_next (page_id, uri, title, source_path, source_ext, source_root_name, access_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = db.prepare('SELECT * FROM logical_pages').all();
    for (const row of rows) {
      insert.run(crypto.randomUUID(), row.uri, row.title, row.source_path, row.source_ext,
        row.source_root_name, row.access_mode, row.created_at, row.updated_at);
    }
    db.exec('DROP TABLE logical_pages');
    db.exec('ALTER TABLE logical_pages_next RENAME TO logical_pages');
    return rows.length;
  });
  const count = migrate();
  logger.info('logical_pages migrated to page_id primary key', { rows: count });
}

function ensureAccessLogPageIdColumn() {
  const columns = db.prepare('PRAGMA table_info(access_logs)').all().map(column => column.name);
  if (!columns.includes('page_id')) {
    db.exec('ALTER TABLE access_logs ADD COLUMN page_id TEXT');
  }
}

export function initPageStore() {
  if (initialized) return;
  db = getPagesDb();
  migrateLogicalPagesToPageId();
  db.exec(`
    CREATE TABLE IF NOT EXISTS logical_pages (${LOGICAL_PAGES_COLUMNS});
    CREATE INDEX IF NOT EXISTS idx_logical_pages_title ON logical_pages(title);
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_uri TEXT,
      viewer_type TEXT NOT NULL,
      share_token_id TEXT,
      request_path TEXT,
      status INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_access_logs_page ON access_logs(page_uri, created_at DESC);
  `);
  ensureAccessLogPageIdColumn();
  initialized = true;
}

export function validateSourcePath(sourcePath, config, options = {}) {
  if (!sourcePath || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new SourceValidationError('source_missing', 'source must be an absolute path');
  }

  const originalExt = path.extname(sourcePath).toLowerCase();
  if (!PAGE_EXTENSIONS.has(originalExt)) {
    throw new SourceValidationError('source_not_allowed', 'source must be a .md or .html file');
  }

  let sourceRealPath;
  try {
    sourceRealPath = fs.realpathSync(sourcePath);
  } catch {
    throw new SourceValidationError('source_missing', 'source file does not exist');
  }

  const realExt = path.extname(sourceRealPath).toLowerCase();
  if (!PAGE_EXTENSIONS.has(realExt)) {
    throw new SourceValidationError('source_not_allowed', 'source must resolve to a .md or .html file');
  }

  const roots = allowedSourceRoots(config);
  if (roots.length === 0) {
    throw new SourceValidationError('source_outside_allowed_root', 'no allowed source roots are configured');
  }

  const component = options.component || options.rootName;
  const candidates = component ? roots.filter(root => root.name === component) : roots;
  if (component && candidates.length === 0) {
    throw new SourceValidationError('unknown_component', `component is not configured: ${component}`);
  }

  for (const candidate of candidates) {
    let rootRealPath;
    try {
      rootRealPath = fs.realpathSync(candidate.root);
    } catch {
      continue;
    }
    if (isInsideRoot(sourceRealPath, rootRealPath)) {
      return {
        sourceRealPath,
        sourceExt: realExt,
        sourceRootName: candidate.name,
        sourceRootRealPath: rootRealPath,
      };
    }
  }

  throw new SourceValidationError('source_outside_allowed_root', 'source is outside the configured allowed root');
}

export function registerLogicalPage({ uri, title, sourcePath, component, accessMode = 'private' }, config) {
  initPageStore();
  const normalizedUri = normalizeSlug(uri);
  if (!normalizedUri) {
    throw new SourceValidationError('invalid_uri', 'uri must be a non-empty logical path');
  }
  if (!title || typeof title !== 'string') {
    throw new SourceValidationError('invalid_title', 'title is required');
  }
  if (!['private', 'shared'].includes(accessMode)) {
    throw new SourceValidationError('invalid_access_mode', 'access_mode must be private or shared');
  }

  const validated = validateSourcePath(sourcePath, config, { component });
  const current = nowMs();
  db.prepare(`
    INSERT INTO logical_pages (page_id, uri, title, source_path, source_ext, source_root_name, access_mode, created_at, updated_at)
    VALUES (@pageId, @uri, @title, @sourcePath, @sourceExt, @sourceRootName, @accessMode, @createdAt, @updatedAt)
    ON CONFLICT(uri) DO UPDATE SET
      title = excluded.title,
      source_path = excluded.source_path,
      source_ext = excluded.source_ext,
      source_root_name = excluded.source_root_name,
      access_mode = excluded.access_mode,
      updated_at = excluded.updated_at
  `).run({
    pageId: crypto.randomUUID(),
    uri: normalizedUri,
    title: title.trim(),
    sourcePath: validated.sourceRealPath,
    sourceExt: validated.sourceExt,
    sourceRootName: validated.sourceRootName,
    accessMode,
    createdAt: current,
    updatedAt: current,
  });

  logger.info('logical page registered', { uri: normalizedUri, sourcePath: validated.sourceRealPath });
  return getLogicalPage(normalizedUri);
}

function mapPageRecord(record) {
  if (!record) return null;
  return {
    pageId: record.page_id,
    uri: record.uri,
    title: record.title,
    sourcePath: record.source_path,
    sourceExt: record.source_ext,
    sourceRootName: record.source_root_name,
    accessMode: record.access_mode,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function getLogicalPage(uri) {
  initPageStore();
  const normalizedUri = normalizeSlug(uri);
  return mapPageRecord(db.prepare('SELECT * FROM logical_pages WHERE uri = ?').get(normalizedUri));
}

export function getLogicalPageById(pageId) {
  if (!pageId || typeof pageId !== 'string') return null;
  initPageStore();
  return mapPageRecord(db.prepare('SELECT * FROM logical_pages WHERE page_id = ?').get(pageId));
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function unregisterLogicalPageRecord(page) {
  if (!page) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404, code: 'page_missing' });
  }
  initPageStore();
  const remove = db.transaction(() => {
    const removedSessions = tableExists('share_sessions')
      ? db.prepare('DELETE FROM share_sessions WHERE page_id = ?').run(page.pageId).changes
      : 0;
    const removedShares = tableExists('shares')
      ? db.prepare('DELETE FROM shares WHERE page_id = ?').run(page.pageId).changes
      : 0;
    const removedPages = db.prepare('DELETE FROM logical_pages WHERE page_id = ?').run(page.pageId).changes;
    return { removedSessions, removedShares, removedPages };
  });
  const result = remove();
  if (result.removedPages === 0) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404, code: 'page_missing' });
  }
  logger.info('logical page unregistered', {
    pageId: page.pageId,
    uri: page.uri,
    removedShares: result.removedShares,
    removedSessions: result.removedSessions,
  });
  return {
    page,
    removedShares: result.removedShares,
    removedSessions: result.removedSessions,
  };
}

export function unregisterLogicalPage(uri) {
  initPageStore();
  const normalizedUri = normalizeSlug(uri);
  const page = getLogicalPage(normalizedUri);
  return unregisterLogicalPageRecord(page);
}

export function unregisterLogicalPageById(pageId) {
  initPageStore();
  return unregisterLogicalPageRecord(getLogicalPageById(pageId));
}

function validatedUpdateUri(rawUri) {
  let normalized;
  try {
    normalized = normalizeSlug(String(rawUri));
  } catch {
    throw new SourceValidationError('invalid_uri', 'uri must be a valid URL path');
  }
  const segments = normalized.split('/');
  if (!normalized || normalized.includes('\\') || segments.includes('..') || segments.includes('.')) {
    throw new SourceValidationError('invalid_uri', 'uri must be a non-empty relative pages path');
  }
  return normalized;
}

// Move (uri) and/or rename (title) a page. Source files never move — only the
// logical uri and title change; the page_id stays stable.
export function updateLogicalPage(pageId, { uri, title } = {}) {
  initPageStore();
  const existing = getLogicalPageById(pageId);
  if (!existing) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404, code: 'page_missing' });
  }

  let nextUri = existing.uri;
  if (uri !== undefined) {
    nextUri = validatedUpdateUri(uri);
    if (nextUri !== existing.uri) {
      const conflict = db.prepare('SELECT page_id FROM logical_pages WHERE uri = ? AND page_id != ?').get(nextUri, pageId);
      if (conflict) {
        throw Object.assign(new Error(`uri already in use: ${nextUri}`), { statusCode: 409, code: 'uri_conflict' });
      }
    }
  }

  let nextTitle = existing.title;
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      throw new SourceValidationError('invalid_title', 'title must be a non-empty string');
    }
    nextTitle = title.trim();
  }

  if (uri === undefined && title === undefined) {
    throw Object.assign(new Error('nothing to update: provide uri and/or title'), { statusCode: 400, code: 'invalid_update' });
  }

  db.prepare('UPDATE logical_pages SET uri = ?, title = ?, updated_at = ? WHERE page_id = ?')
    .run(nextUri, nextTitle, nowMs(), pageId);
  logger.info('logical page updated', { pageId, uri: nextUri, previousUri: existing.uri, title: nextTitle });
  return getLogicalPageById(pageId);
}

export function searchLogicalPages(query = '') {
  initPageStore();
  const trimmed = String(query || '').trim();
  const rows = trimmed
    ? db.prepare(`
        SELECT * FROM logical_pages
        WHERE title LIKE ?
        ORDER BY updated_at DESC
        LIMIT 100
      `).all(`%${trimmed.replace(/[%_]/g, char => `\\${char}`)}%`)
    : db.prepare('SELECT * FROM logical_pages ORDER BY updated_at DESC LIMIT 100').all();
  return rows.map(mapPageRecord);
}

export function listLogicalPagesForNavigation() {
  initPageStore();
  const rows = db.prepare(`
    SELECT * FROM logical_pages
    ORDER BY uri ASC
  `).all();
  return rows.map(record => ({
    slug: `p/${record.uri}`,
    title: record.title,
    description: '',
    date: new Date(record.updated_at).toISOString().split('T')[0],
    tags: [],
    type: record.source_ext === '.html' ? 'html' : 'markdown',
  }));
}

export function recordAccessLog({ pageId = null, pageUri, viewerType = 'auth', shareTokenId = null, requestPath = '', status = 200 }) {
  initPageStore();
  db.prepare(`
    INSERT INTO access_logs (page_id, page_uri, viewer_type, share_token_id, request_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(pageId || null, pageUri || null, viewerType, shareTokenId, requestPath, status, nowMs());
}

export function pruneAccessLogs({ maxAgeDays = 30, maxRows = 10000 } = {}) {
  initPageStore();
  const current = nowMs();
  const minCreatedAt = current - Math.max(1, Number(maxAgeDays) || 30) * 24 * 60 * 60 * 1000;
  const ageDeleted = db.prepare('DELETE FROM access_logs WHERE created_at < ?').run(minCreatedAt).changes;
  const count = db.prepare('SELECT COUNT(*) AS count FROM access_logs').get().count;
  let rowDeleted = 0;
  const limit = Math.max(100, Number(maxRows) || 10000);
  if (count > limit) {
    rowDeleted = db.prepare(`
      DELETE FROM access_logs
      WHERE id IN (
        SELECT id FROM access_logs ORDER BY created_at ASC LIMIT ?
      )
    `).run(count - limit).changes;
  }
  if (ageDeleted > 0 || rowDeleted > 0) {
    logger.info('access logs pruned', { ageDeleted, rowDeleted });
  }
  return { ageDeleted, rowDeleted };
}
