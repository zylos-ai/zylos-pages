// Cookie-based session authentication for zylos-pages
// Implements CocoClaw's 9-point security checklist.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG_PATH } from '../lib/config.js';
import { logger } from '../utils/logger.js';
import { verifyShare } from '../sharing/share-manager.js';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = '__Host-zylos_pages_session';
const SESSION_ABSOLUTE_MS = 86400_000;   // 24 hours
const SESSION_IDLE_MS = 3600_000;        // 60 minutes
const CLEANUP_INTERVAL_MS = 300_000;     // 5 minutes

// Session store: Map<sha256(token), { createdAt, lastActivityAt }>
const sessions = new Map();

// Brute-force protection
const failedAttempts = new Map(); // ip -> { count, firstFailAt }
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 600_000;
let globalFailures = { count: 0, resetAt: Date.now() + 60_000 };
const GLOBAL_MAX_PER_MIN = 30;

// Periodic session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [hash, session] of sessions) {
    if (now - session.createdAt > SESSION_ABSOLUTE_MS ||
        now - session.lastActivityAt > SESSION_IDLE_MS) {
      sessions.delete(hash);
    }
  }
}, CLEANUP_INTERVAL_MS);

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

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = sha256(token);
  const now = Date.now();
  sessions.set(hash, { createdAt: now, lastActivityAt: now });
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const hash = sha256(token);
  const session = sessions.get(hash);
  if (!session) return false;
  const now = Date.now();
  if (now - session.createdAt > SESSION_ABSOLUTE_MS ||
      now - session.lastActivityAt > SESSION_IDLE_MS) {
    sessions.delete(hash);
    return false;
  }
  session.lastActivityAt = now;
  return true;
}

function destroySession(token) {
  if (!token) return;
  sessions.delete(sha256(token));
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

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

// --- Brute-force protection ---

function getClientIp(req) {
  // Only trust X-Forwarded-For from local reverse proxy (Caddy)
  const remoteIp = req.socket.remoteAddress || '';
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp;
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

function isSafeRedirect(path) {
  if (!path || typeof path !== 'string') return false;
  // Must start with / and not contain protocol, double slashes, backslashes, or control chars
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('://')
    && !path.includes('\\') && !/[\x00-\x1f]/.test(path);
}

// --- Login page template ---
const LOGIN_ASSET_VERSION = Date.now();

function loginPageHtml(baseUrl, error, next) {
  const nextParam = next && isSafeRedirect(next) ? next : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — Zylos Pages</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${LOGIN_ASSET_VERSION}">
  <script src="${baseUrl}/_assets/theme.js?v=${LOGIN_ASSET_VERSION}"></script>
  <style>
    .login-container {
      max-width: 360px;
      margin: 80px auto;
      padding: 0 24px;
    }
    .login-card {
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 32px 24px;
      background: var(--color-header-bg);
    }
    .login-card h1 {
      font-size: 1.25em;
      margin-bottom: 20px;
      text-align: center;
    }
    .login-card label {
      display: block;
      font-size: 14px;
      color: var(--color-text-secondary);
      margin-bottom: 6px;
    }
    .login-card input[type="password"] {
      width: 100%;
      padding: 8px 12px;
      font-size: 14px;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-bg);
      color: var(--color-text);
      margin-bottom: 16px;
      box-sizing: border-box;
    }
    .login-card input[type="password"]:focus {
      outline: none;
      border-color: var(--color-link);
    }
    .login-card button {
      width: 100%;
      padding: 10px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      background: var(--color-link);
      color: #fff;
      cursor: pointer;
    }
    .login-card button:hover { opacity: 0.9; }
    .login-error {
      color: #d1242f;
      font-size: 13px;
      text-align: center;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <h1>Zylos Pages</h1>
      ${error ? `<p class="login-error">${error}</p>` : ''}
      <form method="POST" action="${baseUrl}/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required>
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
 * @param {string} baseUrl - e.g. '/pages'
 */
export function setupAuth(app, authConfig, baseUrl) {
  migratePasswordIfNeeded(authConfig);

  // Parse URL-encoded bodies for login form
  app.use('/login', (req, res, next) => {
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
  });

  // GET /login — show login page
  app.get('/login', (req, res) => {
    // If already authenticated, redirect to index
    if (validateSession(getSessionCookie(req))) {
      return res.redirect(baseUrl + '/');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.send(loginPageHtml(baseUrl, null, req.query.next));
  });

  // POST /login — authenticate
  app.post('/login', (req, res) => {
    const ip = getClientIp(req);

    if (isLockedOut(ip) || isGlobalLimited()) {
      logger.warn('auth blocked', { ip, reason: 'lockout' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).send(loginPageHtml(baseUrl, 'Too many attempts. Try again later.', req.body?.next));
    }

    const password = req.body?.password || '';

    if (!verifyPassword(password, authConfig.password)) {
      recordFailure(ip);
      logger.warn('auth failed', { ip, reason: 'invalid_password' });
      res.setHeader('Cache-Control', 'no-store');
      return res.send(loginPageHtml(baseUrl, 'Incorrect password.', req.body?.next));
    }

    // Success — always issue new token (prevents session fixation)
    clearFailures(ip);
    const token = createSession();
    setSessionCookie(res, token);

    const next = req.body?.next;
    const redirectTo = (next && isSafeRedirect(next)) ? next : baseUrl + '/';
    res.redirect(302, redirectTo);
  });

  // POST /logout — same-host CSRF protection
  // Compare host portion only (protocol may differ behind reverse proxy)
  app.post('/logout', (req, res) => {
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

    // Priority: Origin header > Referer header > reject
    if (origin) {
      if (extractHost(origin) !== expectedHost) {
        return res.status(403).send('Forbidden');
      }
    } else if (referer) {
      if (extractHost(referer) !== expectedHost) {
        return res.status(403).send('Forbidden');
      }
    } else {
      // Neither Origin nor Referer — reject (most conservative)
      return res.status(403).send('Forbidden');
    }

    destroySession(getSessionCookie(req));
    clearSessionCookie(res);
    res.redirect(302, baseUrl + '/login');
  });

  // Auth middleware — protect all other routes
  app.use((req, res, next) => {
    // Skip if auth disabled or no password
    if (!authConfig.enabled || !authConfig.password) return next();

    // Skip static assets, login/logout, and API routes (API has own auth checks)
    if (req.path.startsWith('/_assets') || req.path === '/login' || req.path === '/logout') {
      return next();
    }

    // Share token bypass — only for GET/HEAD on document routes (not /api/*, not /)
    if ((req.method === 'GET' || req.method === 'HEAD') && req.query.token
        && !req.path.startsWith('/api/') && req.path !== '/') {
      const slug = req.path.slice(1); // strip leading /
      const result = verifyShare(req.query.token, slug);
      if (result.valid) {
        res.locals.viewerType = 'share';
        res.locals.authenticated = false;
        // Shared pages: no-store + no-referrer to prevent token leakage
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return next();
      }
      // Invalid token — fall through to normal auth check (don't reveal token was bad)
      logger.info('share token invalid', { path: req.path, ip: getClientIp(req) });
    }

    if (validateSession(getSessionCookie(req))) {
      // Authenticated — mark for no-store and override any downstream Cache-Control
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

    // Not authenticated — redirect to login
    // Prepend baseUrl to captured path since reverse proxy strips the prefix
    const rawNext = req.originalUrl || req.url;
    const next_url = rawNext === '/' ? baseUrl + '/' : baseUrl + rawNext;
    const safeNext = isSafeRedirect(next_url) ? `?next=${encodeURIComponent(next_url)}` : '';
    res.redirect(302, `${baseUrl}/login${safeNext}`);
  });
}
