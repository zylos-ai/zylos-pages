// Share token manager — HMAC-signed stateless tokens with shares.json persistence
// Implements the agreed design: HMAC-SHA256(slug + expiresAt + tokenId, secret)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/config.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

const SHARES_PATH = path.join(DATA_DIR, 'shares.json');
const SECRET_BYTES = 32;
const TOKEN_ID_BYTES = 16;

// Duration presets → milliseconds
const DURATION_MAP = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  permanent: 0,
};

// In-memory state (loaded from disk)
let state = null;
let writeLock = false;

// --- Persistence ---

function loadState() {
  if (state) return state;
  try {
    if (fs.existsSync(SHARES_PATH)) {
      const raw = fs.readFileSync(SHARES_PATH, 'utf-8');
      state = JSON.parse(raw);
      // Ensure structure
      if (!state.secret || !state.shares) throw new Error('invalid');
    } else {
      state = {
        secret: crypto.randomBytes(SECRET_BYTES).toString('hex'),
        shares: {},
      };
      saveState();
    }
  } catch (err) {
    logger.warn('shares.json corrupted, reinitializing', { err: err.message });
    state = {
      secret: crypto.randomBytes(SECRET_BYTES).toString('hex'),
      shares: {},
    };
    saveState();
  }
  return state;
}

function saveState() {
  if (!state) return;
  if (writeLock) return; // skip concurrent writes; next mutation will flush
  writeLock = true;
  try {
    const tmp = SHARES_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SHARES_PATH);
    // Ensure final file permissions
    fs.chmodSync(SHARES_PATH, 0o600);
  } catch (err) {
    logger.error('failed to save shares.json', { err: err.message });
  } finally {
    writeLock = false;
  }
}

// --- HMAC Token ---

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
    // HMAC is the last part; slug may contain colons (unlikely but safe)
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

// --- Public API ---

/**
 * Create a share token for a document.
 * @param {string} slug - Document slug (will be normalized)
 * @param {string} duration - '24h' | '7d' | '30d' | 'permanent'
 * @param {object} sharingConfig - { allowPermanent }
 * @returns {{ token: string, tokenId: string, expiresAt: number }}
 */
export function createShare(slug, duration, sharingConfig = {}) {
  const s = loadState();
  const normalizedSlug = normalizeSlug(slug);

  if (duration === 'permanent' && !sharingConfig.allowPermanent) {
    throw Object.assign(new Error('Permanent shares are disabled'), { statusCode: 403 });
  }

  const durationMs = DURATION_MAP[duration];
  if (durationMs === undefined) {
    throw Object.assign(new Error('Invalid duration. Use: 24h, 7d, 30d, or permanent'), { statusCode: 400 });
  }

  const tokenId = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const expiresAt = durationMs === 0 ? 0 : Date.now() + durationMs;
  const hmac = computeHmac(normalizedSlug, expiresAt, tokenId, s.secret);
  const token = encodeToken(normalizedSlug, expiresAt, tokenId, hmac);

  // Store metadata (never store the full token)
  s.shares[tokenId] = {
    slug: normalizedSlug,
    expiresAt,
    createdAt: Date.now(),
    revoked: false,
  };
  saveState();

  logger.info('share created', { slug: normalizedSlug, tokenId, duration, expiresAt });

  return { token, tokenId, expiresAt };
}

/**
 * Verify a share token.
 * @param {string} token - The share token from query string
 * @param {string} requestSlug - The slug being accessed (will be normalized)
 * @returns {{ valid: boolean, slug?: string, viewerType?: string }}
 */
export function verifyShare(token, requestSlug) {
  const s = loadState();
  const decoded = decodeToken(token);
  if (!decoded) return { valid: false };

  const normalizedRequest = normalizeSlug(requestSlug);
  const normalizedToken = normalizeSlug(decoded.slug);

  // Slug must match
  if (normalizedToken !== normalizedRequest) {
    return { valid: false };
  }

  // Check expiration
  if (decoded.expiresAt !== 0 && Date.now() > decoded.expiresAt) {
    return { valid: false };
  }

  // Recompute HMAC and timing-safe compare
  const expected = computeHmac(normalizedToken, decoded.expiresAt, decoded.tokenId, s.secret);
  if (expected.length !== decoded.hmac.length) return { valid: false };
  if (!crypto.timingSafeEqual(expected, decoded.hmac)) {
    return { valid: false };
  }

  // Check revocation and record consistency
  const record = s.shares[decoded.tokenId];
  if (record) {
    if (record.revoked) return { valid: false };
    // Cross-check: record fields must match token claims
    if (record.slug !== normalizedToken || record.expiresAt !== decoded.expiresAt) {
      return { valid: false };
    }
  }
  // Note: if record is missing (e.g. never existed), the HMAC is still valid.
  // This is the "stateless" path — only revocation requires the record.

  return { valid: true, slug: normalizedToken, viewerType: 'share' };
}

/**
 * Revoke a specific share by tokenId.
 * @param {string} tokenId
 * @returns {boolean} true if found and revoked
 */
export function revokeShare(tokenId) {
  const s = loadState();
  const record = s.shares[tokenId];
  if (!record) return false;
  record.revoked = true;
  record.revokedAt = Date.now();
  saveState();
  logger.info('share revoked', { tokenId, slug: record.slug });
  return true;
}

/**
 * Revoke all active shares for a slug.
 * @param {string} slug
 * @returns {number} count of revoked shares
 */
export function revokeAllForSlug(slug) {
  const s = loadState();
  const normalizedSlug = normalizeSlug(slug);
  let count = 0;
  const now = Date.now();
  for (const [id, record] of Object.entries(s.shares)) {
    if (record.slug === normalizedSlug && !record.revoked) {
      record.revoked = true;
      record.revokedAt = now;
      count++;
    }
  }
  if (count > 0) {
    saveState();
    logger.info('shares revoked for slug', { slug: normalizedSlug, count });
  }
  return count;
}

/**
 * List active (non-revoked, non-expired) shares for a slug.
 * Returns metadata only — never the full token.
 * @param {string} slug
 * @returns {Array<{ tokenId, expiresAt, createdAt }>}
 */
export function listSharesForSlug(slug) {
  const s = loadState();
  const normalizedSlug = normalizeSlug(slug);
  const now = Date.now();
  const result = [];

  for (const [tokenId, record] of Object.entries(s.shares)) {
    if (record.slug !== normalizedSlug) continue;
    if (record.revoked) continue;
    if (record.expiresAt !== 0 && now > record.expiresAt) continue;
    result.push({
      tokenId,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
  }

  // Sort newest first
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

/**
 * Clean up share records that are safe to remove.
 * Called periodically (hourly).
 *
 * IMPORTANT: Revoked records are tombstones — they MUST be kept until the
 * token's natural expiry to prevent "resurrection" (HMAC is still valid
 * without the tombstone). Only delete:
 * - Expired records (revoked or not) — token is naturally invalid
 * - Revoked permanent tokens older than 90 days — tombstone retention limit
 */
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function cleanupShares() {
  const s = loadState();
  const now = Date.now();
  let removed = 0;

  for (const [tokenId, record] of Object.entries(s.shares)) {
    const expired = record.expiresAt !== 0 && now > record.expiresAt;

    if (expired) {
      // Token naturally expired — safe to remove regardless of revocation
      delete s.shares[tokenId];
      removed++;
    } else if (record.revoked && record.expiresAt === 0) {
      // Revoked permanent token — keep tombstone for 90 days, then remove
      const revokedAge = now - (record.revokedAt || record.createdAt);
      if (revokedAge > TOMBSTONE_RETENTION_MS) {
        delete s.shares[tokenId];
        removed++;
      }
    }
    // Revoked non-permanent tokens: keep tombstone until natural expiry
  }

  if (removed > 0) {
    saveState();
    logger.info('shares cleanup', { removed });
  }
}

/**
 * Get the valid duration keys.
 */
export function getValidDurations() {
  return Object.keys(DURATION_MAP);
}
