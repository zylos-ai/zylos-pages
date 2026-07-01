// Directory index route handler

import { indexTemplate } from '../templates/indexTemplate.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest } from '../lib/browser-base.js';
import { buildPageTree } from '../utils/pageTree.js';

/**
 * Route handler for GET / — lists all available pages.
 */
export function indexRoute(config) {
  return async (req, res) => {
    const start = performance.now();

    try {
      const pages = await scanPages(config.contentDir);

      const html = indexTemplate(buildPageTree(pages), browserBaseFromRequest(req));
      const elapsed = Math.round(performance.now() - start);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=30');

      logger.info('index served', { count: pages.length, render_ms: elapsed });
      res.send(html);
    } catch (err) {
      logger.error('index failed', { err: err.message });
      res.status(500).send('Failed to list pages');
    }
  };
}

/**
 * List registered logical pages for navigation.
 *
 * The content directory may contain drafts, source artifacts, or historical
 * bare files, but owner-facing navigation should reflect the logical page
 * registry, not the filesystem.
 */
export async function scanPages() {
  const { listLogicalPagesForNavigation } = await import('../pages/page-store.js');
  return listLogicalPagesForNavigation();
}
