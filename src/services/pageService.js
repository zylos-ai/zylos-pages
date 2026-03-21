// Page service: orchestrates path resolution, cache, and rendering (P0 core)

import { resolveSafePath } from '../security/pathGuard.js';
import { getCachedPage, setCachedPage } from '../cache/pageCache.js';
import { singleflight } from '../cache/singleflight.js';
import { renderPage } from './renderService.js';
import { withTimeout } from '../utils/timeout.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

/**
 * Get a rendered page by slug.
 * Handles caching, singleflight dedup, and timeout.
 *
 * @param {string} rawSlug - URL path segment after /pages/
 * @param {object} config - full app config
 * @returns {{ html, etag, meta, cacheHit: boolean }}
 */
export async function getPage(rawSlug, config) {
  const slug = normalizeSlug(rawSlug);
  const filePath = resolveSafePath(slug, config.contentDir);

  // Check cache
  const cached = getCachedPage(slug);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  // Singleflight: only one render per slug at a time
  const result = await singleflight(slug, async () => {
    const rendered = await withTimeout(
      renderPage(filePath, {
        allowRawHtml: config.security?.allowRawHtml ?? false,
        maxFileSizeBytes: config.security?.maxFileSizeBytes ?? 1048576,
        tocMinHeadings: config.toc?.minHeadings ?? 3,
        baseUrl: '/pages',
      }),
      config.security?.renderTimeoutMs ?? 5000,
      'render'
    );
    // Store in cache
    setCachedPage(slug, {
      html: rendered.html,
      etag: rendered.etag,
      meta: rendered.meta,
    });
    return rendered;
  });

  return { ...result, cacheHit: false };
}
