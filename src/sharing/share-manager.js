// DB-backed share manager. Shares are keyed by page_id so links survive page
// moves and renames; callers pass uris (slugs) which are resolved at this
// boundary. Short links are the primary access model; long HMAC tokens are
// verified only for backwards compatibility.

import crypto from 'node:crypto';
import { getPagesDb } from '../db/pages-db.js';
import { getLogicalPage, getLogicalPageById } from '../pages/page-store.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

const SECRET_BYTES = 32;
const TOKEN_ID_BYTES = 16;
const SHARE_ACCESS_BYTES = 32;
const SHARE_SESSION_MAX_AGE_SECONDS = 3600;
const SHARE_SCOPE_MAX_AGE_SECONDS = 3600;
const SHARE_ASSET_MAX_AGE_MS = 3600_000;

export const SHARE_ACCESS_COOKIE_NAME = '__Host-share_access';
export const SHARE_SCOPE_COOKIE_NAME = '__Host-share_scope';

const DURATION_MAP = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  permanent: 0,
};

let db;
let initialized = false;
let _getMeta;
let _setMeta;
let _insertShare;
let _getShare;
let _revokeShare;
let _revokeAllForPage;
let _listSharesForPage;
let _deleteExpiredShares;
let _insertShareSession;
let _getShareSession;
let _touchShareSession;
let _deleteShareSession;
let _deleteExpiredShareSessions;
let _updateShareAttachmentPermission;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function nowMs() {
  return Date.now();
}

function isTokenId(value) {
  return /^[a-f0-9]{32}$/.test(value || '');
}

// Legacy slug-keyed share rows are not convertible to page_id keys — drop them.
function dropSlugKeyedShareTables() {
  const hasSlugColumn = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'slug');
  const drops = [];
  if (hasSlugColumn('share_sessions')) drops.push('DROP TABLE share_sessions');
  if (hasSlugColumn('shares')) drops.push('DROP TABLE IF EXISTS share_sessions', 'DROP TABLE shares');
  if (drops.length === 0) return;
  db.exec([...new Set(drops)].join('; '));
  logger.info('legacy slug-keyed share tables dropped');
}

function initShareStore() {
  if (initialized) return;
  db = getPagesDb();
  dropSlugKeyedShareTables();
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      token_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      can_write_attachments INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shares_page_created ON shares(page_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS share_sessions (
      token_hash TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(token_id) REFERENCES shares(token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_share_sessions_token_id ON share_sessions(token_id);
  `);

  _getMeta = db.prepare('SELECT value FROM share_meta WHERE key = ?');
  _setMeta = db.prepare('INSERT OR REPLACE INTO share_meta (key, value) VALUES (?, ?)');
  _insertShare = db.prepare(`
    INSERT OR IGNORE INTO shares (token_id, page_id, expires_at, created_at, can_write_attachments, revoked, revoked_at)
    VALUES (@tokenId, @pageId, @expiresAt, @createdAt, @canWriteAttachments, @revoked, @revokedAt)
  `);
  _getShare = db.prepare('SELECT * FROM shares WHERE token_id = ?');
  _revokeShare = db.prepare('UPDATE shares SET revoked = 1, revoked_at = ? WHERE token_id = ? AND revoked = 0');
  _revokeAllForPage = db.prepare('UPDATE shares SET revoked = 1, revoked_at = ? WHERE page_id = ? AND revoked = 0');
  _listSharesForPage = db.prepare(`
    SELECT token_id, expires_at, created_at, can_write_attachments
    FROM shares
    WHERE page_id = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)
    ORDER BY created_at DESC
  `);
  _deleteExpiredShares = db.prepare('DELETE FROM shares WHERE expires_at != 0 AND expires_at <= ?');
  _insertShareSession = db.prepare(`
    INSERT OR REPLACE INTO share_sessions (token_hash, token_id, page_id, created_at, last_activity_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  _getShareSession = db.prepare(`
    SELECT share_sessions.*, shares.expires_at AS share_expires_at, shares.revoked AS share_revoked
         , shares.can_write_attachments AS can_write_attachments
    FROM share_sessions
    JOIN shares ON shares.token_id = share_sessions.token_id
    WHERE share_sessions.token_hash = ?
  `);
  _touchShareSession = db.prepare('UPDATE share_sessions SET last_activity_at = ? WHERE token_hash = ?');
  _deleteShareSession = db.prepare('DELETE FROM share_sessions WHERE token_hash = ?');
  _deleteExpiredShareSessions = db.prepare('DELETE FROM share_sessions WHERE expires_at <= ?');
  _updateShareAttachmentPermission = db.prepare(`
    UPDATE shares
    SET can_write_attachments = ?
    WHERE token_id = ?
      AND revoked = 0
      AND (expires_at = 0 OR expires_at > ?)
  `);

  if (!_getMeta.get('secret')?.value) {
    _setMeta.run('secret', crypto.randomBytes(SECRET_BYTES).toString('hex'));
  }
  initialized = true;
}

function getSecret() {
  initShareStore();
  let secret = _getMeta.get('secret')?.value;
  if (!secret) {
    secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    _setMeta.run('secret', secret);
  }
  return secret;
}

function pageUriFromSlug(slug) {
  const normalized = normalizeSlug(slug);
  return normalized.startsWith('p/') ? normalized.slice(2) : normalized;
}

// Resolve a share row to its page's current uri. Shares whose page row is gone
// resolve to null (the share 404s).
function activeShareRecord(tokenId) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const record = _getShare.get(tokenId);
  if (!record || record.revoked) return null;
  if (record.expires_at !== 0 && nowMs() > record.expires_at) return null;
  const page = getLogicalPageById(record.page_id);
  if (!page) return null;
  return {
    tokenId: record.token_id,
    pageId: record.page_id,
    uri: page.uri,
    slug: `p/${page.uri}`,
    expiresAt: record.expires_at,
    createdAt: record.created_at,
    canWriteAttachments: record.can_write_attachments === 1,
  };
}

function computeHmac(pageId, expiresAt, tokenId, secret) {
  const payload = `${pageId}:${expiresAt}:${tokenId}`;
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest();
}

function encodeToken(pageId, expiresAt, tokenId, hmac) {
  const raw = `${pageId}:${expiresAt}:${tokenId}:${hmac.toString('hex')}`;
  return Buffer.from(raw).toString('base64url');
}

function decodeToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = raw.split(':');
    if (parts.length < 4) return null;
    const hmacHex = parts.pop();
    const tokenId = parts.pop();
    const expiresAt = parts.pop();
    const pageId = parts.join(':');
    if (!pageId || !expiresAt || !tokenId || !hmacHex) return null;
    return { pageId, expiresAt: Number(expiresAt), tokenId, hmac: Buffer.from(hmacHex, 'hex') };
  } catch {
    return null;
  }
}

function legacyTokenFor(record) {
  const hmac = computeHmac(record.pageId, record.expiresAt, record.tokenId, getSecret());
  return encodeToken(record.pageId, record.expiresAt, record.tokenId, hmac);
}

function directoryScope(slug) {
  const normalized = normalizeSlug(slug);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function computeShareScopeHmac(directory, tokenId, expiresAt, secret) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${directory}:${tokenId}:${expiresAt}`)
    .digest('hex');
}

function computeShareAssetHmac(uri, realPath, expiresAt, tokenId, secret) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${normalizeSlug(uri)}|${realPath}|${expiresAt}|${tokenId}`)
    .digest('hex');
}

function isAssetWithinScope(assetPath, directory) {
  const normalizedAsset = normalizeSlug(assetPath);
  const assetDir = directoryScope(normalizedAsset);
  if (!directory) return assetDir === '';
  return assetDir === directory || assetDir.startsWith(`${directory}/`);
}

function cookieMaxAge(tokenExpiresAt, maxAgeSeconds) {
  if (tokenExpiresAt === 0) return maxAgeSeconds;
  const remaining = Math.max(0, Math.floor((tokenExpiresAt - nowMs()) / 1000));
  return Math.max(0, Math.min(maxAgeSeconds, remaining));
}

export function createShare(slug, duration, sharingConfig = {}, options = {}) {
  initShareStore();
  const uri = pageUriFromSlug(slug);
  const page = getLogicalPage(uri);
  if (!page) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404 });
  }
  const canWriteAttachments = false;

  if (duration === 'permanent' && !sharingConfig.allowPermanent) {
    throw Object.assign(new Error('Permanent shares are disabled'), { statusCode: 403 });
  }

  const durationMs = DURATION_MAP[duration];
  if (durationMs === undefined) {
    throw Object.assign(new Error('Invalid duration. Use: 24h, 7d, 30d, or permanent'), { statusCode: 400 });
  }

  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const createdAt = nowMs();
  const expiresAt = durationMs === 0 ? 0 : createdAt + durationMs;
  const record = { tokenId, pageId: page.pageId, expiresAt, createdAt, canWriteAttachments };

  _insertShare.run({
    tokenId,
    pageId: page.pageId,
    expiresAt,
    createdAt,
    canWriteAttachments: canWriteAttachments ? 1 : 0,
    revoked: 0,
    revokedAt: null,
  });

  logger.info('share created', { pageId: page.pageId, uri: page.uri, tokenId, duration, expiresAt, canWriteAttachments });
  return { token: legacyTokenFor(record), tokenId, pageId: page.pageId, expiresAt, canWriteAttachments };
}

export function getActiveShare(tokenId) {
  return activeShareRecord(tokenId);
}

export function getActiveShareToken(tokenId) {
  const record = activeShareRecord(tokenId);
  if (!record) return null;
  return { ...record, token: legacyTokenFor(record) };
}

export function createShareAccessCookie(pageId, tokenId, tokenExpiresAt) {
  initShareStore();
  const maxAge = cookieMaxAge(tokenExpiresAt, SHARE_SESSION_MAX_AGE_SECONDS);
  const token = crypto.randomBytes(SHARE_ACCESS_BYTES).toString('hex');
  const createdAt = nowMs();
  const expiresAt = createdAt + maxAge * 1000;
  _insertShareSession.run(sha256(token), tokenId, pageId, createdAt, createdAt, expiresAt);
  return {
    value: token,
    maxAge,
    header: `${SHARE_ACCESS_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  };
}

export function clearShareAccessCookieHeader() {
  return `${SHARE_ACCESS_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function verifyShareAccessCookie(cookieValue, requestSlug) {
  initShareStore();
  if (!cookieValue || typeof cookieValue !== 'string') return { valid: false };
  const hash = sha256(cookieValue);
  const session = _getShareSession.get(hash);
  if (!session) return { valid: false };

  const current = nowMs();
  if (current > session.expires_at ||
      session.share_revoked ||
      (session.share_expires_at !== 0 && current > session.share_expires_at)) {
    _deleteShareSession.run(hash);
    return { valid: false };
  }

  // The session pins a page_id; access follows the page's *current* uri so
  // share links keep working after a move or rename.
  const page = getLogicalPageById(session.page_id);
  if (!page) return { valid: false };
  if (pageUriFromSlug(requestSlug) !== page.uri) return { valid: false };

  _touchShareSession.run(current, hash);
  return {
    valid: true,
    slug: `p/${page.uri}`,
    uri: page.uri,
    pageId: session.page_id,
    tokenId: session.token_id,
    expiresAt: session.share_expires_at,
    viewerType: 'share',
    canWriteAttachments: session.can_write_attachments === 1,
  };
}

export function verifyShare(token, requestSlug) {
  const decoded = decodeToken(token);
  if (!decoded) return { valid: false };

  if (decoded.expiresAt !== 0 && nowMs() > decoded.expiresAt) return { valid: false };
  if (!isTokenId(decoded.tokenId)) return { valid: false };

  const expected = computeHmac(decoded.pageId, decoded.expiresAt, decoded.tokenId, getSecret());
  if (expected.length !== decoded.hmac.length) return { valid: false };
  if (!crypto.timingSafeEqual(expected, decoded.hmac)) return { valid: false };

  const record = activeShareRecord(decoded.tokenId);
  if (!record) return { valid: false };
  if (record.pageId !== decoded.pageId || record.expiresAt !== decoded.expiresAt) return { valid: false };
  if (pageUriFromSlug(requestSlug) !== record.uri) return { valid: false };

  return {
    valid: true,
    slug: record.slug,
    uri: record.uri,
    pageId: record.pageId,
    tokenId: decoded.tokenId,
    expiresAt: decoded.expiresAt,
    viewerType: 'share',
    canWriteAttachments: record.canWriteAttachments === true,
  };
}

export function createShareScopeCookie(slug, tokenId, tokenExpiresAt) {
  const maxAge = cookieMaxAge(tokenExpiresAt, SHARE_SCOPE_MAX_AGE_SECONDS);
  const expiresAt = nowMs() + maxAge * 1000;
  const directory = directoryScope(slug);
  const hmac = computeShareScopeHmac(directory, tokenId, expiresAt, getSecret());
  const value = `${directory}:${tokenId}:${expiresAt}:${hmac}`;
  return {
    value,
    maxAge,
    header: `${SHARE_SCOPE_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  };
}

export function clearShareScopeCookieHeader() {
  return `${SHARE_SCOPE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function verifyShareScopeCookie(cookieValue, assetPath) {
  if (!cookieValue || typeof cookieValue !== 'string') return { valid: false };

  const parts = cookieValue.split(':');
  if (parts.length < 4) return { valid: false };
  const hmac = parts.pop();
  const expiresAtRaw = parts.pop();
  const tokenId = parts.pop();
  const directory = parts.join(':');
  const expiresAt = Number(expiresAtRaw);
  if (!isTokenId(tokenId) || !Number.isFinite(expiresAt) || !hmac) return { valid: false };
  if (nowMs() > expiresAt) return { valid: false };

  const expected = computeShareScopeHmac(directory, tokenId, expiresAt, getSecret());
  const actualBuffer = Buffer.from(hmac, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return { valid: false };
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return { valid: false };

  const record = activeShareRecord(tokenId);
  if (!record) return { valid: false };
  if (directoryScope(record.slug) !== directory) return { valid: false };

  try {
    if (!isAssetWithinScope(assetPath, directory)) return { valid: false };
  } catch {
    return { valid: false };
  }

  return { valid: true, directory, viewerType: 'share' };
}

export function shareAssetExpiresAt(shareExpiresAt) {
  const current = nowMs();
  const cap = current + SHARE_ASSET_MAX_AGE_MS;
  if (!shareExpiresAt || shareExpiresAt === 0) return cap;
  return Math.max(0, Math.min(cap, Number(shareExpiresAt)));
}

export function createShareAssetSignature({ uri, realPath, expiresAt, tokenId }) {
  if (!isTokenId(tokenId) || !Number.isFinite(Number(expiresAt))) {
    throw new Error('Invalid share asset signature input');
  }
  const hmac = computeShareAssetHmac(uri, realPath, Number(expiresAt), tokenId, getSecret());
  return `${tokenId}.${hmac}`;
}

export function verifyShareAssetSignature({ uri, realPath, expiresAt, tokenId, sig }) {
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp) || !sig || typeof sig !== 'string') {
    return { valid: false };
  }
  let actualSig = sig;
  let actualTokenId = tokenId;
  const dotIndex = sig.indexOf('.');
  if (dotIndex !== -1) {
    actualTokenId = sig.slice(0, dotIndex);
    actualSig = sig.slice(dotIndex + 1);
  }
  if (!isTokenId(actualTokenId)) return { valid: false };
  if (nowMs() > exp) return { valid: false };
  const record = activeShareRecord(actualTokenId);
  if (!record || record.uri !== pageUriFromSlug(uri)) return { valid: false };
  if (record.expiresAt !== 0 && exp > record.expiresAt) return { valid: false };

  const expected = computeShareAssetHmac(uri, realPath, exp, actualTokenId, getSecret());
  const actualBuffer = Buffer.from(actualSig, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return { valid: false };
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return { valid: false };
  return { valid: true, share: record };
}

export function revokeShare(tokenId) {
  if (!isTokenId(tokenId)) return false;
  initShareStore();
  const record = _getShare.get(tokenId);
  if (!record) return false;
  const result = _revokeShare.run(nowMs(), tokenId);
  if (result.changes > 0) {
    logger.info('share revoked', { tokenId, pageId: record.page_id });
  }
  return result.changes > 0;
}

export function revokeAllForSlug(slug) {
  initShareStore();
  const page = getLogicalPage(pageUriFromSlug(slug));
  if (!page) return 0;
  const result = _revokeAllForPage.run(nowMs(), page.pageId);
  if (result.changes > 0) {
    logger.info('shares revoked for page', { pageId: page.pageId, uri: page.uri, count: result.changes });
  }
  return result.changes;
}

export function updateShareAttachmentPermission(tokenId, canWriteAttachments) {
  if (!isTokenId(tokenId)) return null;
  if (canWriteAttachments === true) return null;
  initShareStore();
  const result = _updateShareAttachmentPermission.run(canWriteAttachments ? 1 : 0, tokenId, nowMs());
  if (result.changes === 0) return null;
  const updated = activeShareRecord(tokenId);
  if (updated) {
    logger.info('share attachment permission updated', {
      tokenId,
      slug: updated.slug,
      canWriteAttachments: updated.canWriteAttachments,
    });
  }
  return updated;
}

export function listSharesForSlug(slug) {
  initShareStore();
  const page = getLogicalPage(pageUriFromSlug(slug));
  if (!page) return [];
  return _listSharesForPage.all(page.pageId, nowMs()).map(record => ({
    tokenId: record.token_id,
    expiresAt: record.expires_at,
    createdAt: record.created_at,
    canWriteAttachments: record.can_write_attachments === 1,
  }));
}

export function cleanupShares() {
  initShareStore();
  const current = nowMs();
  const sessions = _deleteExpiredShareSessions.run(current).changes;
  const shares = _deleteExpiredShares.run(current).changes;
  if (sessions > 0 || shares > 0) {
    logger.info('shares cleanup', { removedShares: shares, removedSessions: sessions });
  }
}

export function getValidDurations() {
  return Object.keys(DURATION_MAP);
}
