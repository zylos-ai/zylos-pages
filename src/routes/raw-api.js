// Raw Markdown API route handlers
// GET /api/raw/:slug(*) - return the original Markdown text (requires login)

import { readFile } from 'node:fs/promises';
import { resolveSafePath } from '../security/pathGuard.js';
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
      filePath = resolveSafePath(slug, config.contentDir);
    } catch (err) {
      const status = err.statusCode || 400;
      logger.warn('raw markdown path rejected', { path: rawSlug, status, err: err.message });
      return res.status(status).json({ error: 'Invalid path' });
    }

    try {
      const markdown = await readFile(filePath, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(markdown);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.info('raw markdown not found', { path: slug });
        return res.status(404).json({ error: 'Page not found' });
      }

      logger.error('raw markdown read failed', { path: slug, err: err.message });
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });
}
