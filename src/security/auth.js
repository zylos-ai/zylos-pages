// Cookie-based session authentication for zylos-pages
// Implements CocoClaw's 9-point security checklist.
// Sessions are persisted in SQLite — survives service restarts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { getPagesDb } from '../db/pages-db.js';
import { CONFIG_PATH } from '../lib/config.js';
import { logger } from '../utils/logger.js';
import {
  SHARE_ACCESS_COOKIE_NAME,
  SHARE_SCOPE_COOKIE_NAME,
  clearShareAccessCookieHeader,
  clearShareScopeCookieHeader,
  createShareAccessCookie,
  createShareScopeCookie,
  verifyShare,
  verifyShareAccessCookie,
  verifyShareScopeCookie,
} from '../sharing/share-manager.js';
import { browserBaseFromRequest, browserPath, browserRoot, isPathWithinBase } from '../lib/browser-base.js';
import { isAssetExtension } from '../utils/mime.js';
import path from 'node:path';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = '__Host-zylos_pages_session';
const SESSION_ABSOLUTE_MS = 86_400_000;      // 24 hours
const SESSION_IDLE_MS = 3_600_000;            // 60 minutes
const REMEMBER_ABSOLUTE_MS = 30 * 86_400_000; // 30 days
const REMEMBER_IDLE_MS = 7 * 86_400_000;      // 7 days
const CLEANUP_INTERVAL_MS = 300_000;          // 5 minutes

// --- SQLite session store ---

let db;
let _insertSession;
let _getSession;
let _touchSession;
let _deleteSession;
let _cleanExpired;

function initSessionStore() {
  db = getPagesDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      remember INTEGER NOT NULL DEFAULT 0
    )
  `);
  _insertSession = db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token_hash, created_at, last_activity_at, remember) VALUES (?, ?, ?, ?)'
  );
  _getSession = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?');
  _touchSession = db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE token_hash = ?');
  _deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?');
  _cleanExpired = db.prepare(
    'DELETE FROM auth_sessions WHERE (remember = 0 AND (created_at < ? OR last_activity_at < ?)) OR (remember = 1 AND (created_at < ? OR last_activity_at < ?))'
  );
  logger.info('session store initialized');
}

// Brute-force protection (in-memory — transient by design)
const failedAttempts = new Map();
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 600_000;
let globalFailures = { count: 0, resetAt: Date.now() + 60_000 };
const GLOBAL_MAX_PER_MIN = 30;

// Periodic session cleanup
const cleanupTimer = setInterval(() => {
  if (!db) return;
  const now = Date.now();
  try {
    _cleanExpired.run(
      now - SESSION_ABSOLUTE_MS,
      now - SESSION_IDLE_MS,
      now - REMEMBER_ABSOLUTE_MS,
      now - REMEMBER_IDLE_MS
    );
  } catch { /* db may be closed during shutdown */ }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

// --- Password hashing ---

export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(plaintext, stored) {
  try {
    if (!stored.startsWith('scrypt:')) return false;
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function isPlaintext(password) {
  return typeof password === 'string' && !password.startsWith('scrypt:');
}

export function migratePasswordIfNeeded(authConfig) {
  if (!authConfig.password || !isPlaintext(authConfig.password)) return;
  const hashed = hashPassword(authConfig.password);
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

// --- Session management ---

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function createSession(remember = false) {
  const token = crypto.randomBytes(64).toString('hex');
  const hash = sha256(token);
  const now = Date.now();
  _insertSession.run(hash, now, now, remember ? 1 : 0);
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const hash = sha256(token);
  const session = _getSession.get(hash);
  if (!session) return false;
  const now = Date.now();
  const absoluteMs = session.remember ? REMEMBER_ABSOLUTE_MS : SESSION_ABSOLUTE_MS;
  const idleMs = session.remember ? REMEMBER_IDLE_MS : SESSION_IDLE_MS;
  if (now - session.created_at > absoluteMs ||
      now - session.last_activity_at > idleMs) {
    _deleteSession.run(hash);
    return false;
  }
  _touchSession.run(now, hash);
  return true;
}

function destroySession(token) {
  if (!token) return;
  _deleteSession.run(sha256(token));
}

// --- Cookie helpers ---

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

function getSessionCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

function getShareScopeCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SHARE_SCOPE_COOKIE_NAME] || null;
}

function getShareAccessCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SHARE_ACCESS_COOKIE_NAME] || null;
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie]);
  } else {
    res.setHeader('Set-Cookie', [current, cookie]);
  }
}

function setSessionCookie(res, token, remember = false) {
  const maxAge = remember ? 30 * 86400 : 86400;
  appendSetCookie(res,
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  appendSetCookie(res,
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

function clearShareScopeCookie(res) {
  appendSetCookie(res, clearShareScopeCookieHeader());
}

function clearShareAccessCookie(res) {
  appendSetCookie(res, clearShareAccessCookieHeader());
}

function setShareScopeCookie(res, slug, tokenId, tokenExpiresAt) {
  const cookie = createShareScopeCookie(slug, tokenId, tokenExpiresAt);
  appendSetCookie(res, cookie.header);
}

function setShareAccessCookie(res, slug, tokenId, tokenExpiresAt) {
  const cookie = createShareAccessCookie(slug, tokenId, tokenExpiresAt);
  appendSetCookie(res, cookie.header);
}

function acceptShareViewer(res, result, options = {}) {
  res.locals.viewerType = 'share';
  res.locals.authenticated = false;
  res.locals.shareSlug = result.slug;
  res.locals.shareCanWriteAttachments = result.canWriteAttachments === true;
  if (options.refreshAccessCookie) {
    setShareAccessCookie(res, result.slug, result.tokenId, result.expiresAt);
  }
  if (options.refreshScopeCookie) {
    setShareScopeCookie(res, result.slug, result.tokenId, result.expiresAt);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// --- Brute-force protection ---

function getClientIp(req) {
  const remoteIp = req.socket.remoteAddress || '';
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp;
}

function isAssetPath(requestPath) {
  return isAssetExtension(path.extname(requestPath).toLowerCase());
}

function isAttachmentApi(req) {
  return req.path.startsWith('/api/attachments/');
}

function artifactFromApiPath(requestPath) {
  return requestPath.split('/')[3];
}

function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;
  const now = Date.now();
  if (record.count >= MAX_FAILURES) {
    if (now - record.firstFailAt < LOCKOUT_MS) return true;
    failedAttempts.delete(ip);
    return false;
  }
  if (now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return false;
}

function isGlobalLimited() {
  const now = Date.now();
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 0, resetAt: now + 60_000 };
  }
  return globalFailures.count >= GLOBAL_MAX_PER_MIN;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip);
  if (!record || now - record.firstFailAt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstFailAt: now });
  } else {
    record.count++;
  }
  if (now > globalFailures.resetAt) {
    globalFailures = { count: 1, resetAt: now + 60_000 };
  } else {
    globalFailures.count++;
  }
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

// --- Redirect safety ---

function isSafeRedirect(path, baseUrl = '') {
  return isPathWithinBase(path, baseUrl);
}

// --- Login page template ---
const LOGIN_ASSET_VERSION = Date.now();

function loginPageHtml(baseUrl, error, next) {
  const nextParam = next && isSafeRedirect(next, baseUrl) ? next : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Zylos Pages</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${LOGIN_ASSET_VERSION}">
  <script src="${baseUrl}/_assets/theme.js?v=${LOGIN_ASSET_VERSION}"></script>
  <style>
    body { min-height: 100vh; }
    .login-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .login-card {
      width: 100%;
      max-width: 380px;
      border: 1px solid var(--color-border);
      border-radius: 14px;
      padding: 36px 32px;
      background: var(--color-bg);
      box-shadow: 0 8px 28px rgba(27, 31, 36, 0.10);
    }
    .login-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      margin-bottom: 26px;
    }
    .login-brand img {
      width: 48px;
      height: 48px;
      border-radius: 12px;
    }
    .login-card h1 {
      font-size: 1.3em;
      margin: 0;
      text-align: center;
    }
    .login-sub {
      margin: 0;
      font-size: 13px;
      color: var(--color-text-secondary);
      text-align: center;
    }
    .login-field { margin-bottom: 16px; }
    .login-card label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text);
      margin-bottom: 6px;
    }
    .login-card input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-bg);
      color: var(--color-text);
      box-sizing: border-box;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .login-card input[type="password"]:focus {
      outline: none;
      border-color: var(--color-link);
      box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.18);
    }
    .login-card .remember-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--color-text-secondary);
    }
    .login-card .remember-row input[type="checkbox"] { margin: 0; }
    .login-card .remember-row label { margin: 0; font-weight: 400; color: var(--color-text-secondary); }
    .login-card button {
      width: 100%;
      padding: 11px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      background: var(--color-link);
      color: #fff;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .login-card button:hover { background: var(--color-link-hover); }
    .login-error {
      background: rgba(207, 34, 46, 0.1);
      border: 1px solid rgba(207, 34, 46, 0.25);
      color: var(--color-danger, #cf222e);
      font-size: 13px;
      text-align: center;
      padding: 9px 12px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="login-brand">
        <img src="${baseUrl}/_assets/logo.png" alt="" onerror="this.style.display='none'">
        <h1>Zylos Pages</h1>
        <p class="login-sub">Sign in to the admin console</p>
      </div>
      ${error ? `<p class="login-error">${error}</p>` : ''}
      <form method="POST" action="${baseUrl}/login">
        <div class="login-field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" autofocus required>
        </div>
        <div class="remember-row">
          <input type="checkbox" id="remember" name="remember" value="on">
          <label for="remember">Remember me on this device</label>
        </div>
        ${nextParam ? `<input type="hidden" name="next" value="${nextParam.replace(/"/g, '&quot;')}">` : ''}
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// --- Main exports ---

/**
 * Set up cookie-based session auth on an Express app.
 * @param {Express} app
 * @param {object} authConfig - { enabled, password }
 * Browser-visible paths are derived from X-Forwarded-Prefix when Caddy strips
 * /pages before proxying; direct localhost access uses root-relative URLs.
 */
export function setupAuth(app, authConfig, sharingConfig = { enabled: true }) {
  if (authConfig.enabled && authConfig.password) {
    initSessionStore();
  }
  migratePasswordIfNeeded(authConfig);

  const loginPath = '/login';
  const logoutPath = '/logout';

  // Parse URL-encoded bodies for login form
  function parseLoginBody(req, res, next) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        req.body = Object.fromEntries(new URLSearchParams(body));
        next();
      });
    } else {
      next();
    }
  }

  app.use(loginPath, parseLoginBody);

  // GET /login — show login page
  function loginGet(req, res) {
    const browserBase = browserBaseFromRequest(req);
    if (validateSession(getSessionCookie(req))) {
      return res.redirect(browserRoot(browserBase));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.send(loginPageHtml(browserBase, null, req.query.next));
  }

  app.get(loginPath, loginGet);

  // POST /login — authenticate
  function loginPost(req, res) {
    const browserBase = browserBaseFromRequest(req);
    const ip = getClientIp(req);

    if (isLockedOut(ip) || isGlobalLimited()) {
      logger.warn('auth blocked', { ip, reason: 'lockout' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).send(loginPageHtml(browserBase, 'Too many attempts. Try again later.', req.body?.next));
    }

    const password = req.body?.password || '';

    if (!verifyPassword(password, authConfig.password)) {
      recordFailure(ip);
      logger.warn('auth failed', { ip, reason: 'invalid_password' });
      res.setHeader('Cache-Control', 'no-store');
      return res.send(loginPageHtml(browserBase, 'Incorrect password.', req.body?.next));
    }

    // Success — always issue new token (prevents session fixation)
    clearFailures(ip);
    const remember = req.body?.remember === 'on';
    const token = createSession(remember);
    setSessionCookie(res, token, remember);
    clearShareAccessCookie(res);
    clearShareScopeCookie(res);

    const next = req.body?.next;
    const redirectTo = (next && isSafeRedirect(next, browserBase)) ? next : browserRoot(browserBase);
    res.redirect(302, redirectTo);
  }

  app.post(loginPath, loginPost);

  // POST /logout — same-host CSRF protection
  function logoutPost(req, res) {
    const expectedHost = req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    function extractHost(urlOrOrigin) {
      try {
        return new URL(urlOrOrigin).host;
      } catch {
        return null;
      }
    }

    if (origin) {
      if (extractHost(origin) !== expectedHost) {
        return res.status(403).send('Forbidden');
      }
    } else if (referer) {
      if (extractHost(referer) !== expectedHost) {
        return res.status(403).send('Forbidden');
      }
    } else {
      return res.status(403).send('Forbidden');
    }

    destroySession(getSessionCookie(req));
    clearSessionCookie(res);
    clearShareAccessCookie(res);
    const browserBase = browserBaseFromRequest(req);
    res.redirect(302, `${browserPath(browserBase, 'login')}?next=${encodeURIComponent(browserRoot(browserBase))}`);
  }

  app.post(logoutPath, logoutPost);

  // Auth middleware — protect all other routes
  app.use((req, res, next) => {
    const browserBase = browserBaseFromRequest(req);
    if (!authConfig.enabled || !authConfig.password) return next();

    const shortShareEnabled = sharingConfig?.enabled !== false;
    if (req.path.startsWith('/_assets')
        || (shortShareEnabled && /^\/s\/[a-f0-9]{32}$/.test(req.path))
        || req.path === loginPath || req.path === logoutPath) {
      return next();
    }

    // Share access session bypass for pages and raw HTML artifacts.
    if ((req.method === 'GET' || req.method === 'HEAD')
        && !req.path.startsWith('/api/')
        && !isAssetPath(req.path)
        && req.path !== '/') {
      const slug = req.path.slice(1);
      const result = verifyShareAccessCookie(getShareAccessCookie(req), slug);
      if (result.valid) {
        acceptShareViewer(res, result, { refreshScopeCookie: true });
        return next();
      }
    }

    // Legacy long-token bypass. This is retained only for old links; new share
    // creation and short-link access no longer expose or require this URL shape.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.query.token
        && !req.path.startsWith('/api/')
        && !isAssetPath(req.path)
        && req.path !== '/') {
      const slug = req.path.slice(1);
      const result = verifyShare(req.query.token, slug);
      if (result.valid) {
        acceptShareViewer(res, result, { refreshAccessCookie: true, refreshScopeCookie: true });
        return next();
      }
      logger.info('share token invalid', { path: req.path, ip: getClientIp(req) });
    }

    if (req.path.startsWith('/api/state/') || isAttachmentApi(req)) {
      const artifact = artifactFromApiPath(req.path);
      let result = { valid: false };
      try {
        if (artifact) result = verifyShareAccessCookie(getShareAccessCookie(req), artifact);
      } catch { /* malformed encoding — treat as invalid */ }
      if (result.valid) {
        acceptShareViewer(res, result);
        return next();
      }
    }

    if (req.query.token && (req.path.startsWith('/api/state/') || isAttachmentApi(req))) {
      const artifact = artifactFromApiPath(req.path);
      let result = { valid: false };
      try {
        if (artifact) result = verifyShare(req.query.token, artifact);
      } catch { /* malformed encoding — treat as invalid */ }
      if (result.valid) {
        acceptShareViewer(res, result);
        return next();
      }
      logger.info('api share token invalid', { path: req.path, ip: getClientIp(req) });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && isAssetPath(req.path)) {
      const result = verifyShareScopeCookie(getShareScopeCookie(req), req.path.slice(1));
      if (result.valid) {
        res.locals.viewerType = 'share';
        res.locals.authenticated = false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return next();
      }
      logger.info('asset share-scope cookie invalid', { path: req.path, ip: getClientIp(req) });
    }

    if (validateSession(getSessionCookie(req))) {
      res.locals.authenticated = true;
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = function(name, value) {
        if (name.toLowerCase() === 'cache-control' && res.locals.authenticated) {
          return origSetHeader('Cache-Control', 'no-store');
        }
        return origSetHeader(name, value);
      };
      res.setHeader('Cache-Control', 'no-store');
      return next();
    }

    if (isAssetPath(req.path)) {
      return res.status(403).end();
    }

    const rawNext = req.originalUrl || req.url;
    const nextUrl = rawNext === '/' ? browserRoot(browserBase) : `${browserBase}${rawNext}`;
    const safeNext = isSafeRedirect(nextUrl, browserBase) ? `?next=${encodeURIComponent(nextUrl)}` : '';
    res.redirect(302, `${browserPath(browserBase, 'login')}${safeNext}`);
  });
}
