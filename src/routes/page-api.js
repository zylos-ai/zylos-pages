import {
  registerLogicalPage,
  searchLogicalPages,
  listPageChildren,
  pageFolderExists,
  getLogicalPage,
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

function isRegisteredViewPath(value, base) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
      || /[?#\\\u0000-\u0020]/.test(value) || (base && !value.startsWith(`${base}/`))) return false;
  const relative = value.slice(base.length + 1);
  // Candidate lookup is bounded; exact comparison below rejects aliases created
  // by slug normalization (extensions, case changes or redundant slashes).
  for (const uri of [relative.startsWith('p/') ? relative.slice(2) : null, relative]) {
    if (!uri) continue;
    let page;
    try { page = getLogicalPage(uri); } catch { continue; }
    if (page && [browserPath(base, `p/${page.uri}`), browserPath(base, page.uri)]
      .some(candidate => new URL(candidate, 'https://pages.invalid').pathname === value)) return true;
  }
  return false;
}

export function setupPageApi(app, config) {
  app.get('/api/pages', (req, res) => {
    if (!requireOwner(res)) return;
    const paginated = ['folder', 'limit', 'offset', 'folderExists', 'viewPath'].some(key => req.query[key] !== undefined);
    if (paginated) {
      if (res.locals.authenticated !== true) {
        return res.status(403).json({ error: 'Owner authentication is required to browse pages' });
      }
      try {
        if (req.query.viewPath !== undefined) {
          return res.json({ ok: true, allowed: isRegisteredViewPath(req.query.viewPath, browserBaseFromRequest(req)) });
        }
        if (req.query.folderExists !== undefined) {
          return res.json({ ok: true, exists: pageFolderExists(req.query.folderExists) });
        }
        const parseInteger = (key, fallback) => {
          const value = req.query[key];
          if (value === undefined) return fallback;
          if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw Object.assign(new Error(`${key} must be a nonnegative integer`), { statusCode: 400 });
          }
          return Number(value);
        };
        const result = listPageChildren({
          folder: req.query.folder ?? '', query: req.query.q ?? '',
          offset: parseInteger('offset', 0), limit: parseInteger('limit', 50),
        });
        const items = result.items.map(item => item.kind === 'page'
          ? { ...item, url: browserPath(browserBaseFromRequest(req), `p/${item.uri}`) } : item);
        return res.json({ ok: true, ...result, items });
      } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
      }
    }
    const pages = searchLogicalPages(req.query.q || '').map(page => ({
      ...page,
      url: browserPath(browserBaseFromRequest(req), `p/${page.uri}`),
    }));
    res.json({ ok: true, pages, total: pages.length });
  });

  app.post('/api/pages', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireOwner(res)) return;

    try {
      const body = await parseJsonBody(req);
      const outboundDenied = body.outbound_denied ?? body.outboundDenied;
      const scriptsEnabled = body.scripts_enabled ?? body.scriptsEnabled;
      if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
        return res.status(400).json({ error: 'capabilities must be an array' });
      }
      if ((outboundDenied !== undefined && typeof outboundDenied !== 'boolean')
          || (scriptsEnabled !== undefined && typeof scriptsEnabled !== 'boolean')) {
        return res.status(400).json({ error: 'page security flags must be booleans' });
      }
      const page = registerLogicalPage({
        uri: body.uri,
        title: body.title,
        sourcePath: body.source_path || body.sourcePath,
        component: body.component,
        accessMode: body.access_mode || body.accessMode || 'private',
        capabilities: body.capabilities,
        outboundDenied,
        scriptsEnabled,
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
      if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
        return res.status(400).json({ error: 'capabilities must be an array' });
      }
      const outboundDenied = body.outbound_denied ?? body.outboundDenied;
      const scriptsEnabled = body.scripts_enabled ?? body.scriptsEnabled;
      if (outboundDenied !== undefined && typeof outboundDenied !== 'boolean') {
        return res.status(400).json({ error: 'outbound_denied must be a boolean' });
      }
      if (scriptsEnabled !== undefined && typeof scriptsEnabled !== 'boolean') {
        return res.status(400).json({ error: 'scripts_enabled must be a boolean' });
      }
      const page = updateLogicalPage(req.params.pageId, {
        uri: body.uri,
        title: body.title,
        capabilities: body.capabilities,
        outboundDenied,
        scriptsEnabled,
      });
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
        // Renamed from removedShares: the rows are kept as an audit trail now,
        // and a caller reading "removed" would conclude the links were purged.
        tombstonedShares: result.tombstonedShares,
        removedSessions: result.removedSessions,
      });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('page unregister failed', { pageId: req.params.pageId, status, err: err.message });
      res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message, code: err.code });
    }
  });
}
