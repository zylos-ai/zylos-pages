// Share API route handlers
// POST /api/share — create share (requires login + CSRF)
// PATCH /api/share/:tokenId — toggle the attachment-write capability (requires login + CSRF)
// DELETE /api/share/:tokenId — revoke share (requires login + CSRF)
// GET /api/shares/:slug(*) — list active shares for slug (requires login)
// DELETE /api/shares/:slug(*) — revoke all shares for slug (requires login + CSRF)

import {
  createShare,
  createPasswordProtectedShare,
  createShareAccessCookie,
  disableSharePassword,
  getActiveShare,
  revealActiveSharePassword,
  revokeShare,
  revokeAllForSlug,
  listSharesForSlug,
  setSharePassword,
  updateShareAttachmentPermission,
} from '../sharing/share-manager.js';
import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath, cookiePathFromBase } from '../lib/browser-base.js';
import { renderOwnerPage, renderSharePage } from './pages.js';
import { getLogicalPage } from '../pages/page-store.js';
import { normalizeSlug } from '../utils/slug.js';
import { createShareAuthorization } from '../security/share-authorization.js';
import {
  loadSharePasswordKeyring,
  resolveSharePasswordKeyFile,
} from '../sharing/share-password-keyring.js';
import { generateSharePassword } from '../sharing/share-password-crypto.js';

/**
 * CSRF validation via Origin/Referer headers (same approach as logout).
 * Rejects requests without a matching host header.
 *
 * `allowNullOrigin` is a route-local exception for the literal `Origin: null`
 * sent by opaque-origin webviews (e.g. WeChat's built-in browser posting the
 * unlock form). Only the share unlock route opts in. A cross-site POST forced
 * through unlock is low-impact but not nothing: it can overwrite the
 * mount-path-scoped unlock cookie and force the victim to re-enter the
 * password. That residual is accepted because no content is disclosed and no
 * privilege is gained, and it stays bounded only through the combination of
 * controls — a present Referer must still be same-origin, an absent Origin is
 * NOT treated as `null` (both-missing stays rejected), and the pre-KDF rate
 * limiter bounds brute force. No single control is the defense on its own.
 */
function csrfCheck(req, res, { allowNullOrigin = false } = {}) {
  const expectedHost = req.headers.host;

  function extractHost(urlOrOrigin) {
    try { return new URL(urlOrOrigin).host; } catch { return null; }
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (allowNullOrigin && origin === 'null') {
      if (referer && extractHost(referer) !== expectedHost) {
        res.status(403).json({ error: 'CSRF validation failed' });
        return false;
      }
      return true;
    }
    if (extractHost(origin) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else if (referer) {
    if (extractHost(referer) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else {
    // Neither Origin nor Referer — reject
    res.status(403).json({ error: 'CSRF validation failed: missing Origin/Referer' });
    return false;
  }
  return true;
}

/**
 * Parse JSON body from request (no body-parser dependency).
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 4096) {
        rejected = true;
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function absoluteUrl(req, path) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  return `${proto}://${host}${path}`;
}

function formatShareResponse(req, share) {
  const browserBase = browserBaseFromRequest(req);
  const shortUrl = absoluteUrl(req, browserPath(browserBase, `s/${share.tokenId}`));
  const { password: _password, ...safeShare } = share;
  return {
    ...safeShare,
    shortUrl,
    protection: {
      type: share.passwordProtected ? 'password' : 'none',
      retrievable: share.passwordProtected === true,
    },
  };
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

function registeredShareSlug(rawSlug) {
  const normalized = normalizeSlug(rawSlug);
  const pageUri = normalized.startsWith('p/') ? normalized.slice(2) : normalized;
  if (!pageUri || !getLogicalPage(pageUri)) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404 });
  }
  return `p/${pageUri}`;
}

function protectionAvailable(config) {
  return config.auth?.enabled === true &&
    typeof config.auth?.password === 'string' && config.auth.password.length > 0;
}

function loadConfiguredKeyring(config) {
  return loadSharePasswordKeyring(resolveSharePasswordKeyFile(config));
}

function passwordOperation(body) {
  const source = body?.protection && typeof body.protection === 'object' ? body.protection : body;
  const mode = source?.mode || 'generated';
  if (!['generated', 'provided'].includes(mode)) {
    throw Object.assign(new Error('Invalid password mode'), { code: 'invalid_password', statusCode: 400 });
  }
  if (mode === 'generated') return {};
  const bytes = typeof source.password === 'string' ? Buffer.byteLength(source.password, 'utf8') : 0;
  if (bytes < 8 || bytes > 1024) {
    throw Object.assign(new Error('Password must be between 8 and 1024 bytes'), {
      code: 'invalid_password', statusCode: 400,
    });
  }
  return { password: source.password };
}

function sendApiError(res, status, code, message = code) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(status).json({ error: message, code });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function shareChallengeHtml(tokenId, browserBase, code) {
  const message = code === 'invalid_password'
    ? '<p role="alert">Incorrect password.</p>'
    : code === 'rate_limited'
      ? '<p role="alert">Too many attempts. Try again later.</p>'
      : '';
  const action = browserPath(browserBase, `s/${tokenId}/unlock`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Unlock shared page</title></head><body><main><h1>Unlock shared page</h1>${message}<form method="post" action="${escapeHtml(action)}"><label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Unlock</button></form></main></body></html>`;
}

function sendReadFailure(req, res, failure, representation, tokenId) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Zylos-Share-Error', failure.code);
  if (failure.status === 401) res.setHeader('WWW-Authenticate', 'ZylosShare realm="pages-share"');
  if (failure.retryAfterSeconds) res.setHeader('Retry-After', String(failure.retryAfterSeconds));
  if (representation === 'markdown') {
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    return res.status(failure.status).json({
      type: 'about:blank',
      title: failure.code === 'rate_limited' ? 'Share password rate limit exceeded' : 'Share password required',
      status: failure.status,
      code: failure.code,
    });
  }
  return res.status(failure.status).send(shareChallengeHtml(
    tokenId,
    browserBaseFromRequest(req),
    failure.code,
  ));
}

function parseUnlockBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 4096) {
        rejected = true;
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        if (req.headers['content-type']?.includes('application/json')) {
          resolve(body ? JSON.parse(body) : {});
        } else {
          resolve(Object.fromEntries(new URLSearchParams(body)));
        }
      } catch {
        reject(Object.assign(new Error('Invalid request body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Register share API routes on the Express app.
 * Must be called AFTER auth middleware so that only authenticated users reach these.
 * @param {Express} app
 * @param {object} sharingConfig - { enabled }
 */
export function setupShareApi(app, sharingConfig, config = {}) {
  const authorization = createShareAuthorization({
    rateLimit: sharingConfig.passwordRateLimit,
  });

  // GET /s/:tokenId.md — raw markdown of the shared page. Audience and reach
  // match the share token itself (one page, read-only, expiry and revocation
  // honoured). The representation does not: this returns the source file
  // verbatim, including the frontmatter block, while the rendered view strips
  // it and projects only title/description/date/tags — and unlike the render
  // path it applies no maxFileSizeBytes ceiling. Registered before /s/:tokenId
  // because that param would otherwise swallow the ".md" suffix.
  app.get('/s/:tokenId.md', async (req, res) => {
    const share = getActiveShare(req.params.tokenId);
    if (!share) {
      return sendApiError(res, 404, 'share_not_found', 'Share not found');
    }
    const decision = await authorization.authorizeRead(req, share, {
      ownerAuthenticated: res.locals.authenticated === true,
    });
    if (!decision.authorized) {
      return sendReadFailure(req, res, decision, 'markdown', share.tokenId);
    }
    const authorizedShare = decision.share;
    const pageUri = authorizedShare.slug.startsWith('p/') ? authorizedShare.slug.slice(2) : authorizedShare.slug;
    const page = getLogicalPage(pageUri);
    if (!page || page.sourceExt !== '.md') {
      return res.status(404).send('Not a markdown page');
    }
    try {
      const markdown = await readFile(page.sourcePath, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(200).send(markdown);
    } catch (err) {
      logger.error('share raw markdown read failed', { tokenId: req.params.tokenId, err: err.message });
      return res.status(err.code === 'ENOENT' ? 404 : 500).send('Error reading page');
    }
  });

  // GET /s/:tokenId — short share link rendered in place
  app.get('/s/:tokenId', async (req, res, next) => {
    const share = getActiveShare(req.params.tokenId);
    if (!share) {
      return sendApiError(res, 404, 'share_not_found', 'Share not found');
    }

    const browserBase = browserBaseFromRequest(req);
    const decision = await authorization.authorizeRead(req, share, {
      ownerAuthenticated: res.locals.authenticated === true,
    });
    if (!decision.authorized) {
      return sendReadFailure(req, res, decision, 'html', share.tokenId);
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (decision.proof === 'owner') {
        return await renderOwnerPage(req, res, {
          slug: share.slug,
          config,
          browserBase,
        });
      }
      if (decision.proof === 'unprotected') {
        const accessCookie = createShareAccessCookie(
          share.pageId,
          share.tokenId,
          share.expiresAt,
          cookiePathFromBase(browserBase),
          share.credentialVersion,
        );
        if (!accessCookie) return sendApiError(res, 404, 'share_not_found', 'Share not found');
        appendSetCookie(res, accessCookie.header);
      }
      await renderSharePage(req, res, {
        slug: decision.share.slug,
        config,
        browserBase,
        share: decision.share,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/s/:tokenId/unlock', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!csrfCheck(req, res, { allowNullOrigin: true })) return;
    const share = getActiveShare(req.params.tokenId);
    if (!share) return sendApiError(res, 404, 'share_not_found', 'Share not found');
    if (!share.passwordProtected) {
      return sendApiError(res, 409, 'not_protected', 'Share is not password protected');
    }

    try {
      const body = await parseUnlockBody(req);
      const decision = await authorization.verifyProof(req, share.tokenId, body.password);
      if (!decision.authorized) {
        return sendReadFailure(req, res, decision, 'html', share.tokenId);
      }
      const browserBase = browserBaseFromRequest(req);
      const accessCookie = createShareAccessCookie(
        decision.verified.pageId,
        share.tokenId,
        decision.verified.expiresAt,
        cookiePathFromBase(browserBase),
        decision.verified.credentialVersion,
      );
      if (!accessCookie) {
        return sendReadFailure(req, res, { status: 401, code: 'invalid_password' }, 'html', share.tokenId);
      }
      appendSetCookie(res, accessCookie.header);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(303, browserPath(browserBase, `s/${share.tokenId}`));
    } catch (err) {
      return sendApiError(res, err.statusCode || 400, err.code || 'invalid_request', err.message);
    }
  });

  // POST /api/share — create a share link
  app.post('/api/share', async (req, res) => {
    if (!csrfCheck(req, res)) return;

    // Must be authenticated (not share viewer)
    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot create shares' });
    }

    try {
      const body = await parseJsonBody(req);
      const { slug, duration } = body;

      if (!slug || typeof slug !== 'string') {
        return res.status(400).json({ error: 'Missing slug' });
      }
      if (!duration || typeof duration !== 'string') {
        return res.status(400).json({ error: 'Missing duration' });
      }
      // Absent means read-only. Anything present must be an actual boolean, so
      // a client that sends "true" or 1 gets a 400 instead of silently either
      // granting or dropping the capability.
      if (body.canWriteAttachments !== undefined && typeof body.canWriteAttachments !== 'boolean') {
        return res.status(400).json({ error: 'Invalid canWriteAttachments' });
      }

      const shareSlug = registeredShareSlug(slug);
      let result;
      const requestedProtection = body.protection?.type || 'none';
      if (!['none', 'password'].includes(requestedProtection)) {
        return sendApiError(res, 400, 'invalid_protection', 'Invalid protection type');
      }
      if (requestedProtection === 'password') {
        if (!protectionAvailable(config)) {
          return sendApiError(res, 409, 'protection_unavailable', 'Password protection is unavailable');
        }
        if (res.locals.authenticated !== true) {
          return sendApiError(res, 403, 'owner_required', 'Owner authentication required');
        }
        const keyring = loadConfiguredKeyring(config);
        result = await createPasswordProtectedShare(shareSlug, duration, {
          canWriteAttachments: body.canWriteAttachments === true,
          ...passwordOperation(body),
        }, keyring);
      } else {
        result = createShare(shareSlug, duration, {
          canWriteAttachments: body.canWriteAttachments === true,
        });
      }

      const share = formatShareResponse(req, result);

      if (requestedProtection === 'password') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
      }

      res.json({
        ok: true,
        tokenId: share.tokenId,
        expiresAt: share.expiresAt,
        canWriteAttachments: share.canWriteAttachments,
        url: share.shortUrl,
        shortUrl: share.shortUrl,
        protection: requestedProtection === 'password'
          ? { type: 'password', password: result.password }
          : { type: 'none' },
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('share create failed', { err: err.message });
      res.status(status).json({ error: err.message });
    }
  });

  async function changePassword(req, res, operation) {
    if (!csrfCheck(req, res)) return;
    if (!protectionAvailable(config)) {
      return sendApiError(res, 409, 'protection_unavailable', 'Password protection is unavailable');
    }
    if (res.locals.authenticated !== true || res.locals.viewerType === 'share') {
      return sendApiError(res, 403, 'owner_required', 'Owner authentication required');
    }
    const current = getActiveShare(req.params.tokenId);
    if (!current) return sendApiError(res, 404, 'share_not_found', 'Share not found');
    if (operation === 'enable' && current.passwordProtected) {
      return sendApiError(res, 409, 'already_protected', 'Share is already password protected');
    }
    if (operation === 'rotate' && !current.passwordProtected) {
      return sendApiError(res, 409, 'not_protected', 'Share is not password protected');
    }
    try {
      const body = await parseJsonBody(req);
      const requested = passwordOperation(body);
      const password = requested.password ?? generateSharePassword();
      const keyring = loadConfiguredKeyring(config);
      const updated = await setSharePassword(current.tokenId, password, keyring);
      if (!updated) return sendApiError(res, 404, 'share_not_found', 'Share not found');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.json({
        ok: true,
        tokenId: updated.tokenId,
        credentialVersion: updated.credentialVersion,
        protection: { type: 'password', password },
      });
    } catch (err) {
      return sendApiError(res, err.statusCode || 500, err.code || 'password_custody_unavailable', err.message);
    }
  }

  app.post('/api/share/:tokenId/password/enable', (req, res) => changePassword(req, res, 'enable'));
  app.post('/api/share/:tokenId/password/rotate', (req, res) => changePassword(req, res, 'rotate'));

  app.post('/api/share/:tokenId/password/reveal', (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!protectionAvailable(config)) {
      return sendApiError(res, 409, 'protection_unavailable', 'Password protection is unavailable');
    }
    if (res.locals.authenticated !== true || res.locals.viewerType === 'share') {
      return sendApiError(res, 403, 'owner_required', 'Owner authentication required');
    }
    const share = getActiveShare(req.params.tokenId);
    if (!share) return sendApiError(res, 404, 'share_not_found', 'Share not found');
    if (!share.passwordProtected) {
      return sendApiError(res, 409, 'not_protected', 'Share is not password protected');
    }
    try {
      const password = revealActiveSharePassword(share.tokenId, loadConfiguredKeyring(config));
      if (password === null) return sendApiError(res, 404, 'share_not_found', 'Share not found');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.json({ ok: true, tokenId: share.tokenId, protection: { type: 'password', password } });
    } catch (err) {
      const code = err.code === 'password_custody_unavailable'
        ? err.code
        : 'password_decryption_failed';
      return sendApiError(res, 503, code, err.message);
    }
  });

  app.delete('/api/share/:tokenId/password', (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!protectionAvailable(config)) {
      return sendApiError(res, 409, 'protection_unavailable', 'Password protection is unavailable');
    }
    if (res.locals.authenticated !== true || res.locals.viewerType === 'share') {
      return sendApiError(res, 403, 'owner_required', 'Owner authentication required');
    }
    const share = getActiveShare(req.params.tokenId);
    if (!share) return sendApiError(res, 404, 'share_not_found', 'Share not found');
    if (!share.passwordProtected) {
      return sendApiError(res, 409, 'not_protected', 'Share is not password protected');
    }
    const updated = disableSharePassword(share.tokenId);
    if (!updated) return sendApiError(res, 409, 'credential_conflict', 'Share changed concurrently');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.json({
      ok: true,
      tokenId: updated.tokenId,
      credentialVersion: updated.credentialVersion,
      protection: { type: 'none' },
    });
  });

  // PATCH /api/share/:tokenId — grant or withdraw attachment writes on one token
  app.patch('/api/share/:tokenId', async (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot update shares' });
    }

    const { tokenId } = req.params;
    if (!tokenId || typeof tokenId !== 'string' || tokenId.length !== 32) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }

    try {
      const body = await parseJsonBody(req);
      if (typeof body.canWriteAttachments !== 'boolean') {
        return res.status(400).json({ error: 'Invalid canWriteAttachments' });
      }

      const updated = updateShareAttachmentPermission(tokenId, body.canWriteAttachments);
      if (!updated) {
        return res.status(404).json({ error: 'Share not found' });
      }

      res.json({
        ok: true,
        tokenId: updated.tokenId,
        expiresAt: updated.expiresAt,
        createdAt: updated.createdAt,
        canWriteAttachments: updated.canWriteAttachments,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('share update failed', { err: err.message });
      res.status(status).json({ error: err.message });
    }
  });

  // DELETE /api/share/:tokenId — revoke a single share
  app.delete('/api/share/:tokenId', (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot revoke shares' });
    }

    const { tokenId } = req.params;
    if (!tokenId || typeof tokenId !== 'string' || tokenId.length !== 32) {
      return res.status(400).json({ error: 'Invalid tokenId' });
    }

    const revoked = revokeShare(tokenId);
    if (!revoked) {
      return res.status(404).json({ error: 'Share not found' });
    }

    res.json({ ok: true });
  });

  // GET /api/shares/:slug(*) — list active shares for a document
  app.get('/api/shares/:slug(*)', (req, res) => {
    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot list shares' });
    }

    const rawSlug = req.params.slug || req.params[0] || '';
    const shares = listSharesForSlug(rawSlug).map(share => formatShareResponse(req, share));
    res.json({ ok: true, shares });
  });

  // DELETE /api/shares/:slug(*) — revoke all shares for a document
  app.delete('/api/shares/:slug(*)', (req, res) => {
    if (!csrfCheck(req, res)) return;

    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot revoke shares' });
    }

    const rawSlug = req.params.slug || req.params[0] || '';
    const count = revokeAllForSlug(rawSlug);
    res.json({ ok: true, revoked: count });
  });
}
