import {
  registerLogicalPage,
  searchLogicalPages,
  unregisterLogicalPageById,
  updateLogicalPage,
} from '../pages/page-store.js';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { logger } from '../utils/logger.js';

function csrfCheck(req, res) {
  const expectedHost = req.headers.host;
  const extractHost = (urlOrOrigin) => {
    try { return new URL(urlOrOrigin).host; } catch { return null; }
  };
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin && extractHost(origin) !== expectedHost) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return false;
  }
  if (!origin && referer && extractHost(referer) !== expectedHost) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return false;
  }
  if (!origin && !referer) {
    res.status(403).json({ error: 'CSRF validation failed: missing Origin/Referer' });
    return false;
  }
  return true;
}

function parseJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > limit) {
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

function requireOwner(res) {
  if (res.locals.viewerType === 'share') {
    res.status(403).json({ error: 'Share viewers cannot manage pages' });
    return false;
  }
  return true;
}

export function setupPageApi(app, config) {
  app.get('/api/pages', (req, res) => {
    if (!requireOwner(res)) return;
    const pages = searchLogicalPages(req.query.q || '').map(page => ({
      ...page,
      url: browserPath(browserBaseFromRequest(req), `p/${page.uri}`),
    }));
    res.json({ ok: true, pages });
  });

  app.post('/api/pages', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireOwner(res)) return;

    try {
      const body = await parseJsonBody(req);
      const page = registerLogicalPage({
        uri: body.uri,
        title: body.title,
        sourcePath: body.source_path || body.sourcePath,
        component: body.component,
        accessMode: body.access_mode || body.accessMode || 'private',
      }, config);
      res.status(201).json({
        ok: true,
        page: {
          ...page,
          url: browserPath(browserBaseFromRequest(req), `p/${page.uri}`),
        },
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('page register failed', { status, err: err.message });
      res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message, code: err.code });
    }
  });

  // PATCH /api/pages/:pageId — move (uri) and/or rename (title). Share links
  // stay valid because shares are keyed by page_id, not uri.
  app.patch('/api/pages/:pageId', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireOwner(res)) return;

    try {
      const body = await parseJsonBody(req);
      if (body.uri !== undefined && typeof body.uri !== 'string') {
        return res.status(400).json({ error: 'uri must be a string' });
      }
      if (body.title !== undefined && typeof body.title !== 'string') {
        return res.status(400).json({ error: 'title must be a string' });
      }
      const page = updateLogicalPage(req.params.pageId, { uri: body.uri, title: body.title });
      res.json({
        ok: true,
        page: {
          ...page,
          url: browserPath(browserBaseFromRequest(req), `p/${page.uri}`),
        },
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('page update failed', { pageId: req.params.pageId, status, err: err.message });
      res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message, code: err.code });
    }
  });

  app.delete('/api/pages/:pageId', (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireOwner(res)) return;

    try {
      const result = unregisterLogicalPageById(req.params.pageId);
      res.json({
        ok: true,
        pageId: result.page.pageId,
        uri: result.page.uri,
        removedShares: result.removedShares,
        removedSessions: result.removedSessions,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('page unregister failed', { pageId: req.params.pageId, status, err: err.message });
      res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message, code: err.code });
    }
  });
}
