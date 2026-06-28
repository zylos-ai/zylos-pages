// Page service: orchestrates path resolution, cache, and rendering (P0 core)

import { readFile, stat } from 'node:fs/promises';
import { resolvePageDescriptor } from '../security/pathGuard.js';
import { rewriteRelativeAssetRefs } from '../pages/asset-resolver.js';
import { getCachedPage, setCachedPage, invalidatePage } from '../cache/pageCache.js';
import { singleflight } from '../cache/singleflight.js';
import { renderPage } from './renderService.js';
import { normalizeSlug } from '../utils/slug.js';
import { generateEtag } from '../utils/etag.js';
import { logger } from '../utils/logger.js';

/**
 * Get a rendered page by slug.
 * Handles caching, singleflight dedup, and timeout (via worker_threads).
 *
 * @param {string} rawSlug - URL path segment after /
 * @param {object} config - full app config
 * @param {string} browserBase - browser-visible route prefix, e.g. /pages
 * @returns {{ html, etag, meta, cacheHit: boolean, singleflightShared: boolean }}
 */
export async function getPage(rawSlug, config, browserBase = '') {
  const slug = normalizeSlug(rawSlug);
  const routeSlug = slug.startsWith('p/') ? slug.slice(2) : slug;
  const publicSlug = slug.startsWith('p/') ? slug : routeSlug;
  const cacheKey = `${browserBase || '/'}:${slug}`;
  const descriptor = await resolvePageDescriptor(routeSlug, config.contentDir);

  // Check cache — with mtime validation as safety net.
  // fs.watch on Linux can miss events from editors that use write-to-temp-then-rename
  // (sed -i, vim, etc.). A single stat() call per cached request catches stale entries.
  const cached = getCachedPage(cacheKey);
  if (cached) {
    try {
      if (cached.type !== descriptor.type || cached.filePath !== descriptor.filePath) {
        invalidatePage(cacheKey);
        logger.info('cache stale (descriptor)', { path: slug, oldType: cached.type, newType: descriptor.type });
      } else {
        const st = await stat(descriptor.filePath);
        const fileMtime = st.mtimeMs;
        if (cached.cachedAt && fileMtime > cached.cachedAt) {
          invalidatePage(cacheKey);
          logger.info('cache stale (mtime)', { path: slug });
          // Fall through to re-render
        } else {
          return { ...cached, cacheHit: true, singleflightShared: false };
        }
      }
    } catch {
      // File gone — fall through, will 404 during render/read
    }
  }

  // Singleflight: only one render/read per slug at a time
  const { result, shared } = await singleflight(cacheKey, async () => {
    const current = await resolvePageDescriptor(routeSlug, config.contentDir);
    let rendered;
    let st;

    if (current.type === 'html') {
      st = await stat(current.filePath);
      const maxFileSizeBytes = config.security?.maxFileSizeBytes ?? 1048576;
      if (st.size > maxFileSizeBytes) {
        const err = new Error(`File too large: ${st.size} bytes (max ${maxFileSizeBytes})`);
        err.statusCode = 413;
        throw err;
      }
      const html = await readFile(current.filePath, 'utf8');
      rendered = {
        html,
        etag: generateEtag(html),
        meta: {},
        type: 'html',
        companionPath: current.companionPath,
      };
      if (current.logical) {
        rendered.html = rewriteRelativeAssetRefs(rendered.html, { baseUrl: browserBase, pageUri: routeSlug });
      }
    } else {
      rendered = await renderPage(current.filePath, {
        allowRawHtml: config.security?.allowRawHtml ?? false,
        maxFileSizeBytes: config.security?.maxFileSizeBytes ?? 1048576,
        tocMinHeadings: config.toc?.minHeadings ?? 3,
        codeTheme: config.theme?.codeTheme ?? 'github-dark',
        renderTimeoutMs: config.security?.renderTimeoutMs ?? 5000,
        baseUrl: browserBase,
        slug: publicSlug,
      });
      if (current.logical) {
        rendered.html = rewriteRelativeAssetRefs(rendered.html, { baseUrl: browserBase, pageUri: routeSlug });
      }
      rendered.type = 'markdown';
      st = await stat(current.filePath);
    }

    setCachedPage(cacheKey, {
      html: rendered.html,
      etag: rendered.etag,
      meta: rendered.meta,
      type: current.type,
      filePath: current.filePath,
      companionPath: current.companionPath,
      cachedAt: Date.now(),
      fileMtime: st.mtimeMs,
    });
    return rendered;
  });

  return { ...result, cacheHit: false, singleflightShared: shared };
}
