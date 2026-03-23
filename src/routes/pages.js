// Page rendering route handler (P0 core)

import { getPage } from '../services/pageService.js';
import { normalizeSlug } from '../utils/slug.js';
import { notFoundTemplate, errorTemplate } from '../templates/errorTemplate.js';
import { injectShareViewer } from '../templates/pageTemplate.js';
import { logger } from '../utils/logger.js';

/**
 * Route handler for GET /pages/:slug(*)
 */
export function pageRoute(config) {
  return async (req, res) => {
    const start = performance.now();
    const rawSlug = req.params.slug || req.params[0] || req.path.slice(1) || '';

    // Redirect .md URLs to clean URLs
    if (rawSlug.endsWith('.md')) {
      const clean = rawSlug.replace(/\.md$/i, '');
      return res.redirect(301, `/pages/${clean}`);
    }

    const slug = normalizeSlug(rawSlug);

    // Redirect if slug was normalized differently
    if (slug !== rawSlug && slug !== decodeURIComponent(rawSlug)) {
      return res.redirect(301, `/pages/${slug}`);
    }

    const isShareViewer = res.locals.viewerType === 'share';

    try {
      const result = await getPage(slug, config);
      const elapsed = Math.round(performance.now() - start);

      // ETag / 304 handling
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && clientEtag === result.etag) {
        logger.info('page served', { path: slug, status: 304, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth' });
        return res.status(304).end();
      }

      res.setHeader('ETag', result.etag);
      res.setHeader('Cache-Control', isShareViewer ? 'no-store' : 'public, max-age=60');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      // For share viewers: inject data-viewer attribute to hide auth-only elements
      const html = isShareViewer ? injectShareViewer(result.html) : result.html;

      logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth' });
      res.send(html);
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);

      if (err.code === 'ENOENT') {
        logger.info('page not found', { path: slug, render_ms: elapsed });
        res.status(404).send(notFoundTemplate(slug, '/pages'));
        return;
      }

      if (err.statusCode) {
        logger.warn('page error', { path: slug, status: err.statusCode, err: err.message, render_ms: elapsed });
        res.status(err.statusCode).send(errorTemplate(err.message, '/pages'));
        return;
      }

      logger.error('page render failed', { path: slug, err: err.message, render_ms: elapsed });
      res.status(500).send(errorTemplate('An error occurred while rendering this page.', '/pages'));
    }
  };
}
