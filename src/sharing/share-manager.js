// DB-backed share manager. Short links are the primary access model; legacy
// long HMAC tokens are verified only for backwards compatibility.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPagesDb } from '../db/pages-db.js';
import { DATA_DIR } from '../lib/config.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

const SHARES_PATH = path.join(DATA_DIR, 'shares.json');
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
let _revokeAllForSlug;
let _listSharesForSlug;
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

function initShareStore() {
  if (initialized) return;
  db = getPagesDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      token_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      can_write_attachments INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shares_slug_created ON shares(slug, created_at DESC);
    CREATE TABLE IF NOT EXISTS share_sessions (
      token_hash TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(token_id) REFERENCES shares(token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_share_sessions_token_id ON share_sessions(token_id);
  `);
  ensureSharePermissionColumn();

  _getMeta = db.prepare('SELECT value FROM share_meta WHERE key = ?');
  _setMeta = db.prepare('INSERT OR REPLACE INTO share_meta (key, value) VALUES (?, ?)');
  _insertShare = db.prepare(`
    INSERT OR IGNORE INTO shares (token_id, slug, expires_at, created_at, can_write_attachments, revoked, revoked_at)
    VALUES (@tokenId, @slug, @expiresAt, @createdAt, @canWriteAttachments, @revoked, @revokedAt)
  `);
  _getShare = db.prepare('SELECT * FROM shares WHERE token_id = ?');
  _revokeShare = db.prepare('UPDATE shares SET revoked = 1, revoked_at = ? WHERE token_id = ? AND revoked = 0');
  _revokeAllForSlug = db.prepare('UPDATE shares SET revoked = 1, revoked_at = ? WHERE slug = ? AND revoked = 0');
  _listSharesForSlug = db.prepare(`
    SELECT token_id, expires_at, created_at, can_write_attachments
    FROM shares
    WHERE slug = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)
    ORDER BY created_at DESC
  `);
  _deleteExpiredShares = db.prepare('DELETE FROM shares WHERE expires_at != 0 AND expires_at <= ?');
  _insertShareSession = db.prepare(`
    INSERT OR REPLACE INTO share_sessions (token_hash, token_id, slug, created_at, last_activity_at, expires_at)
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

  importLegacySharesJson();
  initialized = true;
}

function ensureSharePermissionColumn() {
  const columns = db.prepare('PRAGMA table_info(shares)').all().map(column => column.name);
  if (!columns.includes('can_write_attachments')) {
    db.exec('ALTER TABLE shares ADD COLUMN can_write_attachments INTEGER NOT NULL DEFAULT 0');
  }
}

function readLegacyState() {
  try {
    if (!fs.existsSync(SHARES_PATH)) return null;
    const raw = fs.readFileSync(SHARES_PATH, 'utf-8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || !state.secret || !state.shares) return null;
    return state;
  } catch (err) {
    logger.warn('legacy shares.json unreadable, skipping import', { err: err.message });
    return null;
  }
}

function importLegacySharesJson() {
  const imported = _getMeta.get('legacy_shares_json_imported')?.value;
  const legacy = readLegacyState();

  if (!_getMeta.get('secret')?.value) {
    const secret = legacy?.secret || crypto.randomBytes(SECRET_BYTES).toString('hex');
    _setMeta.run('secret', secret);
  }

  if (imported || !legacy) return;

  const insertMany = db.transaction((shares) => {
    for (const [tokenId, record] of Object.entries(shares)) {
      if (!isTokenId(tokenId) || !record || typeof record !== 'object') continue;
      try {
        _insertShare.run({
          tokenId,
          slug: normalizeSlug(record.slug),
          expiresAt: Number(record.expiresAt) || 0,
          createdAt: Number(record.createdAt) || nowMs(),
          canWriteAttachments: 0,
          revoked: record.revoked ? 1 : 0,
          revokedAt: record.revokedAt ? Number(record.revokedAt) : null,
        });
      } catch (err) {
        logger.warn('legacy share skipped during import', { tokenId, err: err.message });
      }
    }
    _setMeta.run('legacy_shares_json_imported', String(nowMs()));
  });

  insertMany(legacy.shares);
  logger.info('legacy shares.json imported into DB', { count: Object.keys(legacy.shares).length });
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

function activeShareRecord(tokenId) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const record = _getShare.get(tokenId);
  if (!record || record.revoked) return null;
  if (record.expires_at !== 0 && nowMs() > record.expires_at) return null;
  return {
    tokenId: record.token_id,
    slug: record.slug,
    expiresAt: record.expires_at,
    createdAt: record.created_at,
    canWriteAttachments: record.can_write_attachments === 1,
  };
}

function computeHmac(slug, expiresAt, tokenId, secret) {
  const payload = `${slug}:${expiresAt}:${tokenId}`;
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest();
}

function encodeToken(slug, expiresAt, tokenId, hmac) {
  const raw = `${slug}:${expiresAt}:${tokenId}:${hmac.toString('hex')}`;
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
    const slug = parts.join(':');
    if (!slug || !expiresAt || !tokenId || !hmacHex) return null;
    return { slug, expiresAt: Number(expiresAt), tokenId, hmac: Buffer.from(hmacHex, 'hex') };
  } catch {
    return null;
  }
}

function legacyTokenFor(record) {
  const hmac = computeHmac(record.slug, record.expiresAt, record.tokenId, getSecret());
  return encodeToken(record.slug, record.expiresAt, record.tokenId, hmac);
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
  const normalizedSlug = normalizeSlug(slug);
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
  const record = { tokenId, slug: normalizedSlug, expiresAt, createdAt, canWriteAttachments };

  _insertShare.run({
    tokenId,
    slug: normalizedSlug,
    expiresAt,
    createdAt,
    canWriteAttachments: canWriteAttachments ? 1 : 0,
    revoked: 0,
    revokedAt: null,
  });

  logger.info('share created', { slug: normalizedSlug, tokenId, duration, expiresAt, canWriteAttachments });
  return { token: legacyTokenFor(record), tokenId, expiresAt, canWriteAttachments };
}

export function getActiveShare(tokenId) {
  return activeShareRecord(tokenId);
}

export function getActiveShareToken(tokenId) {
  const record = activeShareRecord(tokenId);
  if (!record) return null;
  return { ...record, token: legacyTokenFor(record) };
}

export function createShareAccessCookie(slug, tokenId, tokenExpiresAt) {
  initShareStore();
  const maxAge = cookieMaxAge(tokenExpiresAt, SHARE_SESSION_MAX_AGE_SECONDS);
  const token = crypto.randomBytes(SHARE_ACCESS_BYTES).toString('hex');
  const createdAt = nowMs();
  const expiresAt = createdAt + maxAge * 1000;
  _insertShareSession.run(sha256(token), tokenId, normalizeSlug(slug), createdAt, createdAt, expiresAt);
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

  const normalizedRequest = normalizeSlug(requestSlug);
  if (normalizeSlug(session.slug) !== normalizedRequest) return { valid: false };

  _touchShareSession.run(current, hash);
  return {
    valid: true,
    slug: session.slug,
    tokenId: session.token_id,
    expiresAt: session.share_expires_at,
    viewerType: 'share',
    canWriteAttachments: session.can_write_attachments === 1,
  };
}

export function verifyShare(token, requestSlug) {
  const decoded = decodeToken(token);
  if (!decoded) return { valid: false };

  const normalizedRequest = normalizeSlug(requestSlug);
  const normalizedToken = normalizeSlug(decoded.slug);
  if (normalizedToken !== normalizedRequest) return { valid: false };
  if (decoded.expiresAt !== 0 && nowMs() > decoded.expiresAt) return { valid: false };
  if (!isTokenId(decoded.tokenId)) return { valid: false };

  const expected = computeHmac(normalizedToken, decoded.expiresAt, decoded.tokenId, getSecret());
  if (expected.length !== decoded.hmac.length) return { valid: false };
  if (!crypto.timingSafeEqual(expected, decoded.hmac)) return { valid: false };

  const record = activeShareRecord(decoded.tokenId);
  if (!record) return { valid: false };
  if (record.slug !== normalizedToken || record.expiresAt !== decoded.expiresAt) return { valid: false };

  return {
    valid: true,
    slug: normalizedToken,
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
  if (!record || normalizeSlug(record.slug) !== normalizeSlug(uri)) return { valid: false };
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
    logger.info('share revoked', { tokenId, slug: record.slug });
  }
  return result.changes > 0;
}

export function revokeAllForSlug(slug) {
  initShareStore();
  const normalizedSlug = normalizeSlug(slug);
  const result = _revokeAllForSlug.run(nowMs(), normalizedSlug);
  if (result.changes > 0) {
    logger.info('shares revoked for slug', { slug: normalizedSlug, count: result.changes });
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
  const normalizedSlug = normalizeSlug(slug);
  return _listSharesForSlug.all(normalizedSlug, nowMs()).map(record => ({
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
