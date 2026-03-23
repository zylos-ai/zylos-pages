// Page service: orchestrates path resolution, cache, and rendering (P0 core)

import { stat } from 'node:fs/promises';
import { resolveSafePath } from '../security/pathGuard.js';
import { getCachedPage, setCachedPage, invalidatePage } from '../cache/pageCache.js';
import { singleflight } from '../cache/singleflight.js';
import { renderPage } from './renderService.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

/**
 * Get a rendered page by slug.
 * Handles caching, singleflight dedup, and timeout (via worker_threads).
 *
 * @param {string} rawSlug - URL path segment after /pages/
 * @param {object} config - full app config
 * @returns {{ html, etag, meta, cacheHit: boolean, singleflightShared: boolean }}
 */
export async function getPage(rawSlug, config) {
  const slug = normalizeSlug(rawSlug);
  const filePath = resolveSafePath(slug, config.contentDir);

  // Check cache — with mtime validation as safety net.
  // fs.watch on Linux can miss events from editors that use write-to-temp-then-rename
  // (sed -i, vim, etc.). A single stat() call per cached request catches stale entries.
  const cached = getCachedPage(slug);
  if (cached) {
    try {
      const st = await stat(filePath);
      const fileMtime = st.mtimeMs;
      if (cached.cachedAt && fileMtime > cached.cachedAt) {
        invalidatePage(slug);
        logger.info('cache stale (mtime)', { path: slug });
        // Fall through to re-render
      } else {
        return { ...cached, cacheHit: true, singleflightShared: false };
      }
    } catch {
      // File gone — fall through, will 404 during render
    }
  }

  // Singleflight: only one render per slug at a time
  const { result, shared } = await singleflight(slug, async () => {
    const rendered = await renderPage(filePath, {
      allowRawHtml: config.security?.allowRawHtml ?? false,
      maxFileSizeBytes: config.security?.maxFileSizeBytes ?? 1048576,
      tocMinHeadings: config.toc?.minHeadings ?? 3,
      codeTheme: config.theme?.codeTheme ?? 'github-dark',
      renderTimeoutMs: config.security?.renderTimeoutMs ?? 5000,
      baseUrl: '/pages',
    });
    // Store in cache with timestamp for mtime validation
    setCachedPage(slug, {
      html: rendered.html,
      etag: rendered.etag,
      meta: rendered.meta,
      cachedAt: Date.now(),
    });
    return rendered;
  });

  return { ...result, cacheHit: false, singleflightShared: shared };
}
