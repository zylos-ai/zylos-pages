// Static asset route for files served from the pages content directory.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveAssetPath } from '../security/pathGuard.js';
import { isAssetExtension } from '../utils/mime.js';
import { generateEtag } from '../utils/etag.js';
import { logger } from '../utils/logger.js';

function isAssetSlug(slug) {
  return isAssetExtension(path.extname(slug).toLowerCase());
}

export function setupAssetRoute(app, config) {
  app.get('*', async (req, res, next) => {
    const rawSlug = req.path.slice(1) || '';
    if (!isAssetSlug(rawSlug)) return next();

    try {
      const { filePath, mimeType } = resolveAssetPath(rawSlug, config.contentDir);
      const info = await stat(filePath);
      const maxFileSizeBytes = config.security?.maxFileSizeBytes ?? 1048576;
      if (info.size > maxFileSizeBytes) {
        return res.status(413).send(`File too large: ${info.size} bytes (max ${maxFileSizeBytes})`);
      }

      const content = await readFile(filePath);
      const etag = generateEtag(content);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', res.locals.viewerType === 'share' ? 'no-store' : 'public, max-age=3600');

      if (req.headers['if-none-match'] === etag) {
        logger.info('asset served', { path: rawSlug, status: 304, viewer: res.locals.viewerType === 'share' ? 'share' : 'auth' });
        return res.status(304).end();
      }

      logger.info('asset served', { path: rawSlug, status: 200, viewer: res.locals.viewerType === 'share' ? 'share' : 'auth' });
      return res.send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.info('asset not found', { path: rawSlug });
        return res.status(404).send('Asset not found');
      }
      if (err.statusCode) {
        logger.warn('asset path rejected', { path: rawSlug, status: err.statusCode, err: err.message });
        return res.status(err.statusCode).send(err.message);
      }
      return next(err);
    }
  });
}
