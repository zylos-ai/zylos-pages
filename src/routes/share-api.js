// Share API route handlers
// POST /api/share — create share (requires login + CSRF)
// PATCH /api/share/:tokenId — deprecated write permission endpoint (requires login + CSRF)
// DELETE /api/share/:tokenId — revoke share (requires login + CSRF)
// GET /api/shares/:slug(*) — list active shares for slug (requires login)
// DELETE /api/shares/:slug(*) — revoke all shares for slug (requires login + CSRF)

import {
  createShare,
  createShareAccessCookie,
  getActiveShare,
  revokeShare,
  revokeAllForSlug,
  listSharesForSlug,
  updateShareAttachmentPermission,
} from '../sharing/share-manager.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { renderSharePage } from './pages.js';

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

function formatShareResponse(req, share) {
  const browserBase = browserBaseFromRequest(req);
  const shortUrl = absoluteUrl(req, browserPath(browserBase, `s/${share.tokenId}`));
  return {
    ...share,
    shortUrl,
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

/**
 * Register share API routes on the Express app.
 * Must be called AFTER auth middleware so that only authenticated users reach these.
 * @param {Express} app
 * @param {object} sharingConfig - { allowPermanent }
 */
export function setupShareApi(app, sharingConfig, config = {}) {
  // GET /s/:tokenId — short share link rendered in place
  app.get('/s/:tokenId', async (req, res, next) => {
    const share = getActiveShare(req.params.tokenId);
    if (!share) {
      return res.status(404).send('Share not found');
    }

    const browserBase = browserBaseFromRequest(req);
    const accessCookie = createShareAccessCookie(share.slug, share.tokenId, share.expiresAt);
    appendSetCookie(res, accessCookie.header);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await renderSharePage(req, res, {
        slug: share.slug,
        config,
        browserBase,
        share,
      });
    } catch (err) {
      next(err);
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
      const canWriteAttachments = body.canWriteAttachments === true;

      if (!slug || typeof slug !== 'string') {
        return res.status(400).json({ error: 'Missing slug' });
      }
      if (!duration || typeof duration !== 'string') {
        return res.status(400).json({ error: 'Missing duration' });
      }

      const result = createShare(slug, duration, sharingConfig, { canWriteAttachments });

      const share = formatShareResponse(req, result);

      res.json({
        ok: true,
        tokenId: share.tokenId,
        expiresAt: share.expiresAt,
        canWriteAttachments: share.canWriteAttachments,
        url: share.shortUrl,
        shortUrl: share.shortUrl,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('share create failed', { err: err.message });
      res.status(status).json({ error: err.message });
    }
  });

  // PATCH /api/share/:tokenId — attachment writes are no longer supported for public shares
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
      if (body.canWriteAttachments === true) {
        return res.status(410).json({ error: 'Public attachment writes are deprecated' });
      }

      const updated = updateShareAttachmentPermission(tokenId, false);
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
