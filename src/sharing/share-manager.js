// DB-backed share manager. Shares are keyed by page_id so links survive page
// moves and renames; callers pass uris (slugs) which are resolved at this
// boundary. Short links are the primary access model; long HMAC tokens are
// verified only for backwards compatibility.

import crypto from 'node:crypto';
import { addColumnIfMissing, getPagesDb } from '../db/pages-db.js';
import { getLogicalPage, getLogicalPageById, initPageStore } from '../pages/page-store.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';
import { verifySharePassword } from '../security/share-password-kdf.js';
import {
  buildSharePasswordCredential,
  encryptSharePassword,
  generateSharePassword,
  revealSharePassword as decryptStoredSharePassword,
} from './share-password-crypto.js';

const SECRET_BYTES = 32;
const TOKEN_ID_BYTES = 16;
const SHARE_ACCESS_BYTES = 32;
const SHARE_SESSION_MAX_AGE_SECONDS = 3600;
const SHARE_ASSET_MAX_AGE_MS = 3600_000;

// __Secure- (not __Host-) so the Path can be bound to the instance's mount
// prefix — __Host- mandates Path=/, which makes cookies collide between
// multiple pages instances on one host (issue #104).
export const SHARE_ACCESS_COOKIE_NAME = '__Secure-share_access';

// Clear-only. Shares moved to signed asset URLs in 0.7.0 (#73) and nothing has
// issued or read this cookie since; the name survives so login and logout can
// still expire copies left in browsers by earlier versions.
export const SHARE_SCOPE_COOKIE_NAME = '__Secure-share_scope';

// Host-wide cookie names used before path scoping; expired on login/logout so
// they don't linger until natural expiry.
export const LEGACY_SHARE_COOKIE_CLEAR_HEADERS = [
  '__Host-share_access=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  '__Host-share_scope=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
];

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
let _listAllShares;
let _insertShareSession;
let _getShareSession;
let _touchShareSession;
let _deleteShareSession;
let _deleteExpiredShareSessions;
let _updateShareAttachmentPermission;
let _deleteShareSessionsForToken;
let _replaceSharePassword;
let _clearSharePassword;
let _cleanupExpiredSharePasswords;
let _updateSharePasswordCiphertext;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function nowMs() {
  return Date.now();
}

function isTokenId(value) {
  return /^[a-f0-9]{32}$/.test(value || '');
}

// One expiry boundary for the whole share surface. `expires_at = 0` is
// permanent. The comparison is `>=`, not `>`, so it agrees with the SQL
// liveness predicate (`expires_at > ?`), which already treats a row whose
// expires_at equals now as no longer live. describeShare used the loose `>`
// and so called that exact row `active` while `shares --all` omitted it.
function hasExpired(expiresAt, now = nowMs()) {
  return expiresAt !== 0 && now >= expiresAt;
}

// Sessions, scope cookies and asset signatures carry a plain deadline with no
// permanent form, but they share the boundary rule so a share and the artifacts
// derived from it never disagree about whether "now" is past the deadline.
function isPastDeadline(deadline, now = nowMs()) {
  return now >= deadline;
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
  // logical_pages is created lazily by the page store, and one statement below
  // references it. Preparing that statement first would throw on a cold DB.
  initPageStore();
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
      revoked_at INTEGER,
      origin_uri TEXT,
      password_hash TEXT,
      password_ciphertext BLOB,
      password_nonce BLOB,
      password_key_id TEXT,
      was_password_protected INTEGER NOT NULL DEFAULT 0,
      credential_version INTEGER NOT NULL DEFAULT 0,
      password_set_at INTEGER,
      CHECK (
        (password_hash IS NULL AND password_ciphertext IS NULL AND password_nonce IS NULL AND password_key_id IS NULL)
        OR
        (password_hash IS NOT NULL AND password_ciphertext IS NOT NULL AND password_nonce IS NOT NULL AND password_key_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_shares_page_created ON shares(page_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS share_sessions (
      token_hash TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      credential_version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(token_id) REFERENCES shares(token_id)
    );
    CREATE INDEX IF NOT EXISTS idx_share_sessions_token_id ON share_sessions(token_id);
  `);

  // A share resolves its document through page_id while the page exists, so a
  // rename or move is followed automatically. origin_uri is the fallback for
  // the one case where that lookup can no longer work: the page was
  // unregistered, and the uri it had at that moment is stamped here (by
  // page-store) so the link is still answerable afterwards.
  addColumnIfMissing(db, 'shares', 'origin_uri', 'TEXT');
  addColumnIfMissing(db, 'shares', 'password_hash', 'TEXT');
  addColumnIfMissing(db, 'shares', 'password_ciphertext', 'BLOB');
  addColumnIfMissing(db, 'shares', 'password_nonce', 'BLOB');
  addColumnIfMissing(db, 'shares', 'password_key_id', 'TEXT');
  addColumnIfMissing(db, 'shares', 'was_password_protected', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'shares', 'credential_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'shares', 'password_set_at', 'INTEGER');
  addColumnIfMissing(db, 'share_sessions', 'credential_version', 'INTEGER NOT NULL DEFAULT 0');
  const malformedCredentialRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM shares
    WHERE
      ((password_hash IS NOT NULL) + (password_ciphertext IS NOT NULL) +
       (password_nonce IS NOT NULL) + (password_key_id IS NOT NULL)) NOT IN (0, 4)
      OR credential_version < 0
  `).get().count;
  if (malformedCredentialRows > 0) {
    throw Object.assign(new Error('Malformed share password credential tuple'), {
      code: 'password_custody_unavailable',
    });
  }

  _getMeta = db.prepare('SELECT value FROM share_meta WHERE key = ?');
  _setMeta = db.prepare('INSERT OR REPLACE INTO share_meta (key, value) VALUES (?, ?)');
  _insertShare = db.prepare(`
    INSERT OR IGNORE INTO shares (token_id, page_id, expires_at, created_at, can_write_attachments, revoked, revoked_at)
    VALUES (@tokenId, @pageId, @expiresAt, @createdAt, @canWriteAttachments, @revoked, @revokedAt)
  `);
  _getShare = db.prepare('SELECT * FROM shares WHERE token_id = ?');
  _revokeShare = db.prepare(`
    UPDATE shares SET
      revoked = 1,
      revoked_at = @now,
      was_password_protected = CASE WHEN password_hash IS NOT NULL THEN 1 ELSE was_password_protected END,
      password_hash = NULL,
      password_ciphertext = NULL,
      password_nonce = NULL,
      password_key_id = NULL,
      password_set_at = NULL
    WHERE token_id = @tokenId AND revoked = 0
  `);
  _revokeAllForPage = db.prepare(`
    UPDATE shares SET
      revoked = 1,
      revoked_at = @now,
      was_password_protected = CASE WHEN password_hash IS NOT NULL THEN 1 ELSE was_password_protected END,
      password_hash = NULL,
      password_ciphertext = NULL,
      password_nonce = NULL,
      password_key_id = NULL,
      password_set_at = NULL
    WHERE page_id = @pageId AND revoked = 0
  `);
  _listSharesForPage = db.prepare(`
    SELECT token_id, expires_at, created_at, can_write_attachments,
           password_hash IS NOT NULL AS password_protected, password_key_id
    FROM shares
    WHERE page_id = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)
    ORDER BY created_at DESC
  `);
  _listAllShares = db.prepare(`
    SELECT token_id, page_id, expires_at, created_at, can_write_attachments, origin_uri,
           password_hash IS NOT NULL AS password_protected, password_key_id
    FROM shares
    WHERE revoked = 0 AND (expires_at = 0 OR expires_at > ?)
    ORDER BY created_at DESC
  `);
  _insertShareSession = db.prepare(`
    INSERT OR REPLACE INTO share_sessions
      (token_hash, token_id, page_id, created_at, last_activity_at, expires_at, credential_version)
    SELECT @tokenHash, @tokenId, @pageId, @createdAt, @createdAt, @expiresAt, @credentialVersion
    FROM shares
    WHERE token_id = @tokenId
      AND page_id = @pageId
      AND credential_version = @credentialVersion
      AND revoked = 0
      AND (shares.expires_at = 0 OR shares.expires_at > @now)
      AND EXISTS (SELECT 1 FROM logical_pages WHERE logical_pages.page_id = shares.page_id)
  `);
  _getShareSession = db.prepare(`
    SELECT share_sessions.*, shares.expires_at AS share_expires_at, shares.revoked AS share_revoked
         , shares.can_write_attachments AS can_write_attachments
         , shares.credential_version AS share_credential_version
    FROM share_sessions
    JOIN shares ON shares.token_id = share_sessions.token_id
    WHERE share_sessions.token_hash = ?
  `);
  _touchShareSession = db.prepare('UPDATE share_sessions SET last_activity_at = ? WHERE token_hash = ?');
  _deleteShareSession = db.prepare('DELETE FROM share_sessions WHERE token_hash = ?');
  _deleteExpiredShareSessions = db.prepare('DELETE FROM share_sessions WHERE expires_at <= ?');
  _deleteShareSessionsForToken = db.prepare('DELETE FROM share_sessions WHERE token_id = ?');
  _replaceSharePassword = db.prepare(`
    UPDATE shares SET
      password_hash = @passwordHash,
      password_ciphertext = @passwordCiphertext,
      password_nonce = @passwordNonce,
      password_key_id = @passwordKeyId,
      was_password_protected = 1,
      credential_version = @nextCredentialVersion,
      password_set_at = @passwordSetAt
    WHERE token_id = @tokenId
      AND credential_version = @previousCredentialVersion
      AND revoked = 0
      AND (expires_at = 0 OR expires_at > @now)
      AND EXISTS (SELECT 1 FROM logical_pages WHERE logical_pages.page_id = shares.page_id)
  `);
  _clearSharePassword = db.prepare(`
    UPDATE shares SET
      password_hash = NULL,
      password_ciphertext = NULL,
      password_nonce = NULL,
      password_key_id = NULL,
      was_password_protected = 1,
      credential_version = credential_version + 1,
      password_set_at = NULL
    WHERE token_id = @tokenId
      AND password_hash IS NOT NULL
      AND revoked = 0
      AND (expires_at = 0 OR expires_at > @now)
      AND EXISTS (SELECT 1 FROM logical_pages WHERE logical_pages.page_id = shares.page_id)
  `);
  _cleanupExpiredSharePasswords = db.prepare(`
    UPDATE shares SET
      was_password_protected = CASE WHEN password_hash IS NOT NULL THEN 1 ELSE was_password_protected END,
      password_hash = NULL,
      password_ciphertext = NULL,
      password_nonce = NULL,
      password_key_id = NULL,
      password_set_at = NULL
    WHERE expires_at != 0 AND expires_at <= ? AND password_hash IS NOT NULL
  `);
  _updateSharePasswordCiphertext = db.prepare(`
    UPDATE shares SET
      password_ciphertext = @passwordCiphertext,
      password_nonce = @passwordNonce,
      password_key_id = @nextKeyId
    WHERE token_id = @tokenId
      AND credential_version = @credentialVersion
      AND password_key_id = @previousKeyId
      AND password_hash IS NOT NULL
  `);
  // The live-page requirement is part of the WHERE clause, not a check around
  // it. Checking afterwards means the row is already written by the time the
  // caller learns it should not have been: a tombstone passes revoked/expiry
  // (it is neither), gets mutated, and only then does the resolver notice the
  // page is gone and report "not found" over a write that happened. Tombstones
  // are an audit record; no live operation may touch them.
  _updateShareAttachmentPermission = db.prepare(`
    UPDATE shares
    SET can_write_attachments = ?
    WHERE token_id = ?
      AND revoked = 0
      AND (expires_at = 0 OR expires_at > ?)
      AND EXISTS (SELECT 1 FROM logical_pages WHERE logical_pages.page_id = shares.page_id)
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
  if (hasExpired(record.expires_at)) return null;
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
    passwordProtected: record.password_hash !== null,
    credentialVersion: record.credential_version,
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

function computeShareAssetHmac(uri, realPath, expiresAt, tokenId, credentialVersion, secret) {
  const generation = Number(credentialVersion);
  const generationSuffix = generation === 0 ? '' : `|${generation}`;
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${normalizeSlug(uri)}|${realPath}|${expiresAt}|${tokenId}${generationSuffix}`)
    .digest('hex');
}

function cookieMaxAge(tokenExpiresAt, maxAgeSeconds) {
  if (tokenExpiresAt === 0) return maxAgeSeconds;
  const remaining = Math.max(0, Math.floor((tokenExpiresAt - nowMs()) / 1000));
  return Math.max(0, Math.min(maxAgeSeconds, remaining));
}

export function createShare(slug, duration, options = {}) {
  initShareStore();
  const uri = pageUriFromSlug(slug);
  const page = getLogicalPage(uri);
  if (!page) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404 });
  }
  // Attachment writes are a per-token capability and are off unless the caller
  // asks for them explicitly. Only `true` grants it — a missing or truthy-ish
  // value is not an opt-in, because this flag is the sole thing standing
  // between "holds the link" and "can write to the page".
  const canWriteAttachments = options.canWriteAttachments === true;

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

function validateProvidedSharePassword(password) {
  if (typeof password !== 'string') {
    throw Object.assign(new Error('Password is required'), { code: 'invalid_password', statusCode: 400 });
  }
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 8 || bytes > 1024) {
    throw Object.assign(new Error('Password must be between 8 and 1024 bytes'), {
      code: 'invalid_password',
      statusCode: 400,
    });
  }
  return password;
}

export async function createPasswordProtectedShare(slug, duration, options = {}, keyring, cryptoOptions = {}) {
  initShareStore();
  const uri = pageUriFromSlug(slug);
  const page = getLogicalPage(uri);
  if (!page) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404 });
  }
  const durationMs = DURATION_MAP[duration];
  if (durationMs === undefined) {
    throw Object.assign(new Error('Invalid duration. Use: 24h, 7d, 30d, or permanent'), { statusCode: 400 });
  }

  const password = options.password === undefined
    ? generateSharePassword()
    : validateProvidedSharePassword(options.password);
  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const createdAt = nowMs();
  const expiresAt = durationMs === 0 ? 0 : createdAt + durationMs;
  const canWriteAttachments = options.canWriteAttachments === true;
  const credentialVersion = 1;
  const credential = await buildSharePasswordCredential(password, {
    tokenId,
    pageId: page.pageId,
    credentialVersion,
  }, keyring, cryptoOptions);

  db.transaction(() => {
    const inserted = _insertShare.run({
      tokenId,
      pageId: page.pageId,
      expiresAt,
      createdAt,
      canWriteAttachments: canWriteAttachments ? 1 : 0,
      revoked: 0,
      revokedAt: null,
    });
    if (inserted.changes !== 1) throw new Error('Could not create protected share');
    const replaced = _replaceSharePassword.run({
      ...credential,
      tokenId,
      previousCredentialVersion: 0,
      nextCredentialVersion: credentialVersion,
      passwordSetAt: createdAt,
      now: createdAt,
    });
    if (replaced.changes !== 1) throw new Error('Could not protect share atomically');
  })();

  logger.info('protected share created', {
    pageId: page.pageId,
    uri: page.uri,
    tokenId,
    duration,
    expiresAt,
    canWriteAttachments,
  });
  const record = activeShareRecord(tokenId);
  return { ...record, token: legacyTokenFor(record), password };
}

export function getActiveShare(tokenId) {
  return activeShareRecord(tokenId);
}

export function getActiveShareToken(tokenId) {
  const record = activeShareRecord(tokenId);
  if (!record) return null;
  return { ...record, token: legacyTokenFor(record) };
}

export function createShareAccessCookie(pageId, tokenId, tokenExpiresAt, cookiePath = '/', credentialVersion = 0) {
  initShareStore();
  const maxAge = cookieMaxAge(tokenExpiresAt, SHARE_SESSION_MAX_AGE_SECONDS);
  const token = crypto.randomBytes(SHARE_ACCESS_BYTES).toString('hex');
  const createdAt = nowMs();
  const expiresAt = createdAt + maxAge * 1000;
  const inserted = _insertShareSession.run({
    tokenHash: sha256(token),
    tokenId,
    pageId,
    createdAt,
    expiresAt,
    credentialVersion,
    now: createdAt,
  });
  if (inserted.changes === 0) return null;
  return {
    value: token,
    maxAge,
    header: `${SHARE_ACCESS_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=${maxAge}`,
  };
}

export function clearShareAccessCookieHeader(cookiePath = '/') {
  return `${SHARE_ACCESS_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`;
}

export function verifyShareAccessCookie(cookieValue, requestSlug) {
  initShareStore();
  if (!cookieValue || typeof cookieValue !== 'string') return { valid: false };
  const hash = sha256(cookieValue);
  const session = _getShareSession.get(hash);
  if (!session) return { valid: false };

  const current = nowMs();
  if (isPastDeadline(session.expires_at, current) ||
      session.share_revoked ||
      hasExpired(session.share_expires_at, current) ||
      session.credential_version !== session.share_credential_version) {
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
    credentialVersion: session.share_credential_version,
    viewerType: 'share',
    canWriteAttachments: session.can_write_attachments === 1,
  };
}

export function verifyShareAccessCookieForToken(cookieValue, tokenId) {
  initShareStore();
  if (!cookieValue || typeof cookieValue !== 'string' || !isTokenId(tokenId)) return { valid: false };
  const hash = sha256(cookieValue);
  const session = _getShareSession.get(hash);
  if (!session || session.token_id !== tokenId) return { valid: false };

  const current = nowMs();
  if (isPastDeadline(session.expires_at, current) ||
      session.share_revoked ||
      hasExpired(session.share_expires_at, current) ||
      session.credential_version !== session.share_credential_version) {
    _deleteShareSession.run(hash);
    return { valid: false };
  }
  const page = getLogicalPageById(session.page_id);
  if (!page) return { valid: false };
  _touchShareSession.run(current, hash);
  return {
    valid: true,
    slug: `p/${page.uri}`,
    uri: page.uri,
    pageId: session.page_id,
    tokenId: session.token_id,
    expiresAt: session.share_expires_at,
    credentialVersion: session.share_credential_version,
    viewerType: 'share',
    canWriteAttachments: session.can_write_attachments === 1,
  };
}

export function verifyShare(token, requestSlug) {
  const decoded = decodeToken(token);
  if (!decoded) return { valid: false };

  if (hasExpired(decoded.expiresAt)) return { valid: false };
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

export function clearShareScopeCookieHeader(cookiePath = '/') {
  return `${SHARE_SCOPE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath}; Max-Age=0`;
}

export function shareAssetExpiresAt(shareExpiresAt) {
  const current = nowMs();
  const cap = current + SHARE_ASSET_MAX_AGE_MS;
  if (!shareExpiresAt || shareExpiresAt === 0) return cap;
  return Math.max(0, Math.min(cap, Number(shareExpiresAt)));
}

export function createShareAssetSignature({ uri, realPath, expiresAt, tokenId, credentialVersion = 0 }) {
  const generation = Number(credentialVersion);
  if (!isTokenId(tokenId) || !Number.isFinite(Number(expiresAt)) ||
      !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Invalid share asset signature input');
  }
  const hmac = computeShareAssetHmac(uri, realPath, Number(expiresAt), tokenId, generation, getSecret());
  return generation === 0 ? `${tokenId}.${hmac}` : `${tokenId}.${generation}.${hmac}`;
}

export function verifyShareAssetSignature({ uri, realPath, expiresAt, tokenId, sig }) {
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp) || !sig || typeof sig !== 'string') {
    return { valid: false };
  }
  let actualTokenId = tokenId;
  let credentialVersion = 0;
  let actualSig = sig;
  const parts = sig.split('.');
  if (parts.length === 2) {
    [actualTokenId, actualSig] = parts;
  } else if (parts.length === 3) {
    actualTokenId = parts[0];
    credentialVersion = Number(parts[1]);
    actualSig = parts[2];
  } else if (parts.length !== 1) {
    return { valid: false };
  }
  if (!isTokenId(actualTokenId)) return { valid: false };
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 0) return { valid: false };
  if (isPastDeadline(exp)) return { valid: false };
  const record = activeShareRecord(actualTokenId);
  if (!record || record.uri !== pageUriFromSlug(uri)) return { valid: false };
  if (record.expiresAt !== 0 && exp > record.expiresAt) return { valid: false };
  if (record.credentialVersion !== credentialVersion) return { valid: false };
  if (credentialVersion === 0 && record.passwordProtected) return { valid: false };

  const expected = computeShareAssetHmac(uri, realPath, exp, actualTokenId, credentialVersion, getSecret());
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
  const result = db.transaction(() => {
    const changed = _revokeShare.run({ now: nowMs(), tokenId });
    if (changed.changes > 0) _deleteShareSessionsForToken.run(tokenId);
    return changed;
  })();
  if (result.changes > 0) {
    logger.info('share revoked', { tokenId, pageId: record.page_id });
  }
  return result.changes > 0;
}

export function revokeAllForSlug(slug) {
  initShareStore();
  const page = getLogicalPage(pageUriFromSlug(slug));
  if (!page) return 0;
  const result = db.transaction(() => {
    const tokenIds = db.prepare('SELECT token_id FROM shares WHERE page_id = ? AND revoked = 0').all(page.pageId);
    const changed = _revokeAllForPage.run({ now: nowMs(), pageId: page.pageId });
    for (const row of tokenIds) _deleteShareSessionsForToken.run(row.token_id);
    return changed;
  })();
  if (result.changes > 0) {
    logger.info('shares revoked for page', { pageId: page.pageId, uri: page.uri, count: result.changes });
  }
  return result.changes;
}

// Toggling the capability on an existing token. The UPDATE statement carries
// the liveness predicate, so a revoked, expired or tombstoned token cannot be
// upgraded — the grant only ever lands on a share that could serve the page
// anyway.
export function updateShareAttachmentPermission(tokenId, canWriteAttachments) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const result = _updateShareAttachmentPermission.run(canWriteAttachments === true ? 1 : 0, tokenId, nowMs());
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
    passwordProtected: record.password_protected === 1,
  }));
}

// Every live share on this instance, across all pages. `listSharesForSlug`
// answers "what links exist for this page?"; auditing an instance asks the
// inverse and had no answer before this. Same liveness predicate as that
// function: revoked = 0 AND (permanent OR not yet expired).
//
// Tombstones are excluded on top of that predicate. A share whose page was
// unregistered cannot serve anything, so listing it would overstate what this
// box exposes — which is the one question this function exists to answer.
// `share-info` is where those rows remain visible.
export function listAllShares() {
  initShareStore();
  return _listAllShares.all(nowMs())
    .map(record => ({ record, page: getLogicalPageById(record.page_id) }))
    .filter(({ page }) => page !== null)
    .map(({ record, page }) => ({
      tokenId: record.token_id,
      pageId: record.page_id,
      uri: page.uri,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
      canWriteAttachments: record.can_write_attachments === 1,
      passwordProtected: record.password_protected === 1,
    }));
}

// Accepts either a bare token id or the whole share URL someone pasted, since
// what people actually hold is the link, not the id inside it.
export function tokenIdFromInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const candidate = raw.includes('/') ? raw.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() : raw;
  return isTokenId(candidate) ? candidate : null;
}

function durationLabel(createdAt, expiresAt) {
  if (expiresAt === 0) return 'permanent';
  const span = expiresAt - createdAt;
  const match = Object.entries(DURATION_MAP).find(([, ms]) => ms !== 0 && ms === span);
  return match ? match[0] : `${Math.round(span / (60 * 60 * 1000))}h`;
}

// Answers "here is a link — which document is it, and is it still live?".
// Unlike listSharesForSlug/listAllShares this deliberately ignores liveness:
// the whole point is to resolve links that are already expired, revoked, or
// pointed at a document that no longer exists.
export function describeShare(input) {
  const tokenId = tokenIdFromInput(input);
  if (!tokenId) return null;
  initShareStore();
  const record = _getShare.get(tokenId);
  if (!record) return null;
  const page = getLogicalPageById(record.page_id);
  const documentDeleted = page === null;
  const expired = hasExpired(record.expires_at);
  // Precedence, strongest claim first:
  //   revoked          — the deliberate act, and the only reversible one
  //   document_deleted — there is no longer anything to serve
  //   expired          — the clock ran out
  // A deleted document outranks expiry because it says something about the
  // content rather than the calendar. Every underlying fact is returned
  // alongside, so nothing here hides state from a caller that wants it all.
  let status = 'active';
  if (record.revoked) status = 'revoked';
  else if (documentDeleted) status = 'document_deleted';
  else if (expired) status = 'expired';
  return {
    tokenId: record.token_id,
    pageId: record.page_id,
    // The page's current uri while it exists (so renames are followed), and
    // the uri stamped at unregister once it does not. Null only for rows that
    // predate the stamp and whose page is already gone.
    uri: page ? page.uri : (record.origin_uri ?? null),
    status,
    documentDeleted,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
    duration: durationLabel(record.created_at, record.expires_at),
    canWriteAttachments: record.can_write_attachments === 1,
    passwordProtected: record.password_hash !== null,
    wasPasswordProtected: record.was_password_protected === 1,
    credentialVersion: record.credential_version,
    passwordSetAt: record.password_set_at,
  };
}

function credentialFromRecord(record) {
  if (!record?.password_hash || !record.password_ciphertext || !record.password_nonce || !record.password_key_id) return null;
  return {
    passwordHash: record.password_hash,
    passwordCiphertext: Buffer.from(record.password_ciphertext),
    passwordNonce: Buffer.from(record.password_nonce),
    passwordKeyId: record.password_key_id,
  };
}

export async function setSharePassword(tokenId, password, keyring, options = {}) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const initial = _getShare.get(tokenId);
  const page = initial ? getLogicalPageById(initial.page_id) : null;
  if (!initial || !page || initial.revoked || hasExpired(initial.expires_at)) return null;
  const previousCredentialVersion = initial.credential_version;
  const nextCredentialVersion = previousCredentialVersion + 1;
  const credential = await buildSharePasswordCredential(password, {
    tokenId,
    pageId: initial.page_id,
    credentialVersion: nextCredentialVersion,
  }, keyring, options);
  const passwordSetAt = nowMs();
  const changed = db.transaction(() => {
    const result = _replaceSharePassword.run({
      ...credential,
      tokenId,
      previousCredentialVersion,
      nextCredentialVersion,
      passwordSetAt,
      now: passwordSetAt,
    });
    if (result.changes > 0) _deleteShareSessionsForToken.run(tokenId);
    return result.changes;
  })();
  if (changed === 0) {
    throw Object.assign(new Error('Share changed while password protection was being prepared'), {
      code: 'credential_conflict',
      statusCode: 409,
    });
  }
  return activeShareRecord(tokenId);
}

export function disableSharePassword(tokenId) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const changed = db.transaction(() => {
    const result = _clearSharePassword.run({ tokenId, now: nowMs() });
    if (result.changes > 0) _deleteShareSessionsForToken.run(tokenId);
    return result.changes;
  })();
  return changed > 0 ? activeShareRecord(tokenId) : null;
}

export async function verifyActiveSharePassword(tokenId, password) {
  if (!isTokenId(tokenId)) return { valid: false };
  initShareStore();
  const record = _getShare.get(tokenId);
  const page = record ? getLogicalPageById(record.page_id) : null;
  if (!record || !page || record.revoked || hasExpired(record.expires_at) || !record.password_hash) return { valid: false };
  const credentialVersion = record.credential_version;
  const valid = await verifySharePassword(password, record.password_hash);
  return valid ? {
    valid: true,
    tokenId,
    pageId: record.page_id,
    credentialVersion,
    expiresAt: record.expires_at,
    canWriteAttachments: record.can_write_attachments === 1,
  } : { valid: false };
}

export function revealActiveSharePassword(tokenId, keyring) {
  if (!isTokenId(tokenId)) return null;
  initShareStore();
  const record = _getShare.get(tokenId);
  const page = record ? getLogicalPageById(record.page_id) : null;
  const credential = credentialFromRecord(record);
  if (!record || !page || record.revoked || hasExpired(record.expires_at) || !credential) return null;
  return decryptStoredSharePassword(credential, {
    tokenId,
    pageId: record.page_id,
    credentialVersion: record.credential_version,
  }, keyring);
}

export function getReferencedSharePasswordKeyIds() {
  initShareStore();
  return db.prepare(`
    SELECT DISTINCT password_key_id AS key_id
    FROM shares
    WHERE password_hash IS NOT NULL AND password_key_id IS NOT NULL
    ORDER BY password_key_id
  `).all().map(row => row.key_id);
}

export function reencryptSharePasswordCredentials(keyring, { batchSize = 100 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1000) throw new TypeError('Invalid batch size');
  initShareStore();
  const nextKeyId = keyring?.activeKeyId;
  const nextMasterKey = keyring?.keys?.get(nextKeyId);
  if (!nextMasterKey) throw Object.assign(new Error('Active share password key is unavailable'), {
    code: 'password_custody_unavailable',
  });
  let updated = 0;
  while (true) {
    const rows = db.prepare(`
      SELECT * FROM shares
      WHERE password_hash IS NOT NULL AND password_key_id != ?
      ORDER BY token_id
      LIMIT ?
    `).all(nextKeyId, batchSize);
    if (rows.length === 0) break;
    const replacements = rows.map(record => {
      const credential = credentialFromRecord(record);
      const password = decryptStoredSharePassword(credential, {
        tokenId: record.token_id,
        pageId: record.page_id,
        credentialVersion: record.credential_version,
      }, keyring);
      const encrypted = encryptSharePassword(password, {
        tokenId: record.token_id,
        pageId: record.page_id,
        credentialVersion: record.credential_version,
        keyId: nextKeyId,
      }, nextMasterKey);
      return { record, encrypted };
    });
    const changed = db.transaction(() => replacements.reduce((count, { record, encrypted }) => count +
      _updateSharePasswordCiphertext.run({
        tokenId: record.token_id,
        credentialVersion: record.credential_version,
        previousKeyId: record.password_key_id,
        nextKeyId,
        passwordCiphertext: encrypted.ciphertext,
        passwordNonce: encrypted.nonce,
      }).changes, 0))();
    if (changed !== replacements.length) {
      throw Object.assign(new Error('Share password credentials changed during key rotation'), {
        code: 'credential_conflict',
      });
    }
    updated += changed;
  }
  return updated;
}

// Sessions only. Share rows are never deleted — not on expiry, and not when
// the page is unregistered (page-store stamps them with the page's uri and
// leaves them as tombstones). An expired or orphaned row is the sole record
// that a link existed at all, and deleting it means "someone hands you an old
// link, which document was it?" has no answer. Sessions are the opposite —
// transient browser state, worth nothing after expiry, and the thing that
// could otherwise still open an unregistered page.
export function cleanupShares() {
  initShareStore();
  const current = nowMs();
  const passwords = _cleanupExpiredSharePasswords.run(current).changes;
  const sessions = _deleteExpiredShareSessions.run(current).changes;
  if (passwords > 0) {
    logger.info('expired share password cleanup', { clearedPasswords: passwords });
  }
  if (sessions > 0) {
    logger.info('share sessions cleanup', { removedSessions: sessions });
  }
}

export function getValidDurations() {
  return Object.keys(DURATION_MAP);
}
