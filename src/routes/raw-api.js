// Raw Markdown API route handlers
// GET /api/raw/:slug(*) - return the original Markdown text (requires login)

import { streamFileResponse } from '../utils/stream-file.js';
import { resolveSafePath } from '../security/pathGuard.js';
import { getLogicalPage } from '../pages/page-store.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

/**
 * Register raw Markdown API routes on the Express app.
 * Must be called AFTER auth middleware so that only authenticated users reach these.
 * @param {Express} app
 * @param {object} config - full app config
 */
export function setupRawApi(app, config) {
  app.get('/api/raw/:slug(*)', async (req, res) => {
    if (res.locals.viewerType === 'share') {
      return res.status(403).json({ error: 'Share viewers cannot read raw Markdown' });
    }

    const rawSlug = req.params.slug || req.params[0] || '';
    let slug;
    let filePath;

    try {
      slug = normalizeSlug(rawSlug);
      resolveSafePath(slug, config.contentDir);
      const pageUri = slug.startsWith('p/') ? slug.slice(2) : slug;
      const logicalPage = getLogicalPage(pageUri);
      if (!logicalPage || logicalPage.sourceExt !== '.md') {
        logger.info('raw markdown not found', { path: slug });
        return res.status(404).json({ error: 'Page not found' });
      }
      filePath = logicalPage.sourcePath;
    } catch (err) {
      const status = err.statusCode || 400;
      logger.warn('raw markdown path rejected', { path: rawSlug, status, err: err.message });
      return res.status(status).json({ error: 'Invalid path' });
    }

    return streamFileResponse(res, filePath, {
      contentType: 'text/plain; charset=utf-8',
      onError: (err) => {
        if (err.code === 'ENOENT') {
          logger.info('raw markdown not found', { path: slug });
          res.status(404).json({ error: 'Page not found' });
          return;
        }

        logger.error('raw markdown read failed', { path: slug, err: err.message });
        res.status(500).json({ error: 'Internal Server Error' });
      },
    });
  });
}
