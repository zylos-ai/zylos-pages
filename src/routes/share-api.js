// Share API route handlers
// POST /api/share — create share (requires login + CSRF)
// DELETE /api/share/:tokenId — revoke share (requires login + CSRF)
// GET /api/shares/:slug(*) — list active shares for slug (requires login)
// DELETE /api/shares/:slug(*) — revoke all shares for slug (requires login + CSRF)

import {
  createShare,
  createShareAccessCookie,
  createShareScopeCookie,
  getActiveShare,
  revokeShare,
  revokeAllForSlug,
  listSharesForSlug,
} from '../sharing/share-manager.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';

/**
 * CSRF validation via Origin/Referer headers (same approach as logout).
 * Rejects requests without a matching host header.
 */
function csrfCheck(req, res) {
  const expectedHost = req.headers.host;

  function extractHost(urlOrOrigin) {
    try { return new URL(urlOrOrigin).host; } catch { return null; }
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
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
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 4096) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
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

/**
 * Register share API routes on the Express app.
 * Must be called AFTER auth middleware so that only authenticated users reach these.
 * @param {Express} app
 * @param {object} sharingConfig - { allowPermanent }
 */
export function setupShareApi(app, sharingConfig) {
  // GET /s/:tokenId — short share link redirect
  app.get('/s/:tokenId', (req, res) => {
    const share = getActiveShare(req.params.tokenId);
    if (!share) {
      return res.status(404).send('Share not found');
    }

    const browserBase = browserBaseFromRequest(req);
    const accessCookie = createShareAccessCookie(share.slug, share.tokenId, share.expiresAt);
    const scopeCookie = createShareScopeCookie(share.slug, share.tokenId, share.expiresAt);
    appendSetCookie(res, accessCookie.header);
    appendSetCookie(res, scopeCookie.header);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, browserPath(browserBase, share.slug));
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
      const canWriteAttachments = body.canWriteAttachments === true;

      if (!slug || typeof slug !== 'string') {
        return res.status(400).json({ error: 'Missing slug' });
      }
      if (!duration || typeof duration !== 'string') {
        return res.status(400).json({ error: 'Missing duration' });
      }

      const result = createShare(slug, duration, sharingConfig, { canWriteAttachments });

      const browserBase = browserBaseFromRequest(req);
      const shortUrl = absoluteUrl(req, browserPath(browserBase, `s/${result.tokenId}`));

      res.json({
        ok: true,
        tokenId: result.tokenId,
        expiresAt: result.expiresAt,
        canWriteAttachments: result.canWriteAttachments,
        url: shortUrl,
        shortUrl,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('share create failed', { err: err.message });
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
    const shares = listSharesForSlug(rawSlug);
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
