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
  listActiveShares,
  revokeShare,
  revokeAllForSlug,
  listSharesForSlug,
  updateShareAttachmentPermission,
} from '../sharing/share-manager.js';
import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath, cookiePathFromBase } from '../lib/browser-base.js';
import { renderSharePage } from './pages.js';
import { getLogicalPage } from '../pages/page-store.js';
import { normalizeSlug } from '../utils/slug.js';

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

function registeredShareSlug(rawSlug) {
  const normalized = normalizeSlug(rawSlug);
  const pageUri = normalized.startsWith('p/') ? normalized.slice(2) : normalized;
  if (!pageUri || !getLogicalPage(pageUri)) {
    throw Object.assign(new Error('Page not found'), { statusCode: 404 });
  }
  return `p/${pageUri}`;
}

/**
 * Register share API routes on the Express app.
 * Must be called AFTER auth middleware so that only authenticated users reach these.
 * @param {Express} app
 * @param {object} sharingConfig - { allowPermanent }
 */
export function setupShareApi(app, sharingConfig, config = {}) {
  // GET /llms.txt · /llms-full.txt — public AI discovery index built from
  // ACTIVE SHARES ONLY: a page appears here iff it currently has a live share
  // token, and each entry links to that token's /s/<tokenId>.md raw route.
  // Revoking/expiring the share removes the page from the index. Unshared
  // pages are never exposed externally.
  async function sharedMarkdownEntries(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const base = `${proto}://${host}${browserBaseFromRequest(req)}`;
    // One entry per page: prefer the longest-lived active token (0 = permanent).
    const byUri = new Map();
    for (const share of listActiveShares()) {
      if (share.sourceExt !== '.md') continue;
      const prev = byUri.get(share.uri);
      const lifetime = (s) => (s.expiresAt === 0 ? Infinity : s.expiresAt);
      if (!prev || lifetime(share) > lifetime(prev)) byUri.set(share.uri, share);
    }
    const entries = [];
    for (const share of byUri.values()) {
      let description = '';
      let body = '';
      try {
        const text = await readFile(share.sourcePath, 'utf8');
        const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
        const d = fm && fm[1].match(/^description:\s*(.+(?:\n(?:  |\t).+)*)$/m);
        description = d ? d[1].replace(/\n\s+/g, ' ').trim().replace(/^[>|]-?\s*/, '').replace(/^["']|["']$/g, '') : '';
        body = fm ? text.slice(fm[0].length) : text;
      } catch { continue; }
      entries.push({ title: share.title || share.uri, url: `${base}/s/${share.tokenId}.md`, description, body });
    }
    return entries;
  }

  app.get('/llms.txt', async (req, res) => {
    const entries = await sharedMarkdownEntries(req);
    const lines = [
      '# Shared Pages',
      '',
      '> Actively shared documents. Each link returns the original Markdown.',
      '',
      ...entries.map((e) => `- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ''}`),
      '',
    ];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(lines.join('\n'));
  });

  app.get('/llms-full.txt', async (req, res) => {
    const entries = await sharedMarkdownEntries(req);
    const full = entries
      .map((e) => `\n\n---\n\n# ${e.title}\n\nSource: ${e.url}\n${e.description ? `\n> ${e.description}\n` : ''}\n${e.body.trim()}`)
      .join('');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(`# Shared Pages — full content (${entries.length} docs)${full}\n`);
  });

  // GET /s/:tokenId.md — raw markdown of the shared page. Same capability
  // scope as the share token itself (one page, read-only), so no privilege
  // escalation vs the rendered view. Registered before /s/:tokenId because
  // that param would otherwise swallow the ".md" suffix.
  app.get('/s/:tokenId.md', async (req, res) => {
    const share = getActiveShare(req.params.tokenId);
    if (!share) {
      return res.status(404).send('Share not found');
    }
    const pageUri = share.slug.startsWith('p/') ? share.slug.slice(2) : share.slug;
    const page = getLogicalPage(pageUri);
    if (!page || page.sourceExt !== '.md') {
      return res.status(404).send('Not a markdown page');
    }
    try {
      const markdown = await readFile(page.sourcePath, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
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
      return res.status(404).send('Share not found');
    }

    const browserBase = browserBaseFromRequest(req);
    const accessCookie = createShareAccessCookie(share.pageId, share.tokenId, share.expiresAt, cookiePathFromBase(browserBase));
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

      const shareSlug = registeredShareSlug(slug);
      const result = createShare(shareSlug, duration, sharingConfig, { canWriteAttachments });

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
