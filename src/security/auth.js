// Authentication middleware for zylos-pages
// Uses scrypt (Node built-in) for password hashing, with brute-force protection.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG_PATH } from '../lib/config.js';
import { logger } from '../utils/logger.js';

const AUTH_USERNAME = 'pages';
const SCRYPT_KEYLEN = 64;

// Brute-force protection: per-IP failure tracking
const failedAttempts = new Map(); // ip -> { count, firstFailAt }
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;      // 1 minute window
const LOCKOUT_MS = 600_000;    // 10 minute lockout

/**
 * Hash a plaintext password with scrypt.
 * @returns {string} format: "scrypt:<salt_hex>:<hash_hex>"
 */
export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a plaintext password against a scrypt hash.
 */
function verifyPassword(plaintext, stored) {
  if (!stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Check if a stored password is plaintext (not hashed).
 */
function isPlaintext(password) {
  return typeof password === 'string' && !password.startsWith('scrypt:');
}

/**
 * Migrate plaintext password to scrypt hash in config.json.
 */
export function migratePasswordIfNeeded(authConfig) {
  if (!authConfig.password || !isPlaintext(authConfig.password)) return;

  const plaintext = authConfig.password;
  const hashed = hashPassword(plaintext);

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config.auth.password = hashed;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    authConfig.password = hashed;
    console.log('[pages] Auth: migrated plaintext password to scrypt hash');
  } catch (err) {
    console.error('[pages] Auth: failed to migrate password:', err.message);
  }
}

/**
 * Check brute-force lockout for an IP.
 * @returns {boolean} true if IP is locked out
 */
function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;

  const now = Date.now();

  // If in lockout period
  if (record.count >= MAX_FAILURES) {
    if (now - record.firstFailAt < LOCKOUT_MS) {
      return true;
    }
    // Lockout expired, reset
    failedAttempts.delete(ip);
    return false;
  }

  // If window expired, reset
  if (now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }

  return false;
}

/**
 * Record a failed auth attempt.
 */
function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);

  if (!record || now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstFailAt: now });
  } else {
    record.count++;
  }
}

/**
 * Clear failure record on success.
 */
function clearFailures(ip) {
  failedAttempts.delete(ip);
}

/**
 * Create a Basic Auth middleware.
 * @param {object} authConfig - { enabled: boolean, password: string|null }
 * @returns Express middleware
 */
export function createAuth(authConfig) {
  // Auto-migrate plaintext passwords on startup
  migratePasswordIfNeeded(authConfig);

  return (req, res, next) => {
    // Skip if auth disabled or no password configured
    if (!authConfig.enabled || !authConfig.password) {
      return next();
    }

    // Skip auth for static assets
    if (req.path.startsWith('/_assets')) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // Check brute-force lockout
    if (isLockedOut(ip)) {
      logger.warn('auth blocked', { ip, reason: 'lockout' });
      return res.status(429).send('Too many failed attempts. Try again later.');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Zylos Pages"');
      return res.status(401).send('Authentication required');
    }

    let decoded;
    try {
      decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    } catch {
      recordFailure(ip);
      logger.warn('auth failed', { ip, reason: 'invalid_encoding' });
      res.setHeader('WWW-Authenticate', 'Basic realm="Zylos Pages"');
      return res.status(401).send('Invalid credentials');
    }

    const colonIdx = decoded.indexOf(':');
    const username = colonIdx >= 0 ? decoded.slice(0, colonIdx) : '';
    const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;

    // Verify fixed username
    if (username !== AUTH_USERNAME) {
      recordFailure(ip);
      logger.warn('auth failed', { ip, reason: 'invalid_username' });
      res.setHeader('WWW-Authenticate', 'Basic realm="Zylos Pages"');
      return res.status(401).send('Invalid credentials');
    }

    // Verify password
    if (!verifyPassword(password, authConfig.password)) {
      recordFailure(ip);
      logger.warn('auth failed', { ip, reason: 'invalid_password' });
      res.setHeader('WWW-Authenticate', 'Basic realm="Zylos Pages"');
      return res.status(401).send('Invalid credentials');
    }

    clearFailures(ip);
    next();
  };
}
