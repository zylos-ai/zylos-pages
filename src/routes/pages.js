// Page rendering route handler (P0 core)

import { getPage } from '../services/pageService.js';
import { normalizeSlug } from '../utils/slug.js';
import { notFoundTemplate, errorTemplate } from '../templates/errorTemplate.js';
import { injectShareViewer, injectNavSidebar, htmlArtifactTemplate } from '../templates/pageTemplate.js';
import { scanPages } from './index.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { HTML_ARTIFACT_CSP } from '../security/headers.js';

function redirectCleanExtension(req, res, browserBase, rawSlug, extension) {
  const clean = rawSlug.replace(new RegExp(`\\.${extension}$`, 'i'), '');
  const queryIndex = req.url.indexOf('?');
  const query = queryIndex === -1 ? '' : req.url.slice(queryIndex);
  return res.redirect(301, `${browserPath(browserBase, clean)}${query}`);
}

/**
 * Route handler for GET /:slug(*)
 */
export function pageRoute(config) {
  return async (req, res) => {
    const start = performance.now();
    const browserBase = browserBaseFromRequest(req);
    const rawSlug = req.params.slug || req.params[0] || req.path.slice(1) || '';

    // Redirect explicit extension URLs to clean URLs.
    if (/\.md$/i.test(rawSlug)) {
      return redirectCleanExtension(req, res, browserBase, rawSlug, 'md');
    }
    if (/\.html$/i.test(rawSlug)) {
      return redirectCleanExtension(req, res, browserBase, rawSlug, 'html');
    }

    const slug = normalizeSlug(rawSlug);

    // Redirect if slug was normalized differently
    if (slug !== rawSlug && slug !== decodeURIComponent(rawSlug)) {
      return res.redirect(301, browserPath(browserBase, slug));
    }

    const isShareViewer = res.locals.viewerType === 'share';

    try {
      const result = await getPage(slug, config, browserBase);
      const elapsed = Math.round(performance.now() - start);
      const isHtmlArtifact = result.type === 'html';

      // Raw mode: serve HTML artifact directly (used as iframe src)
      if (isHtmlArtifact && req.query.raw === '1') {
        res.setHeader('Content-Security-Policy', HTML_ARTIFACT_CSP);
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag && clientEtag === result.etag) {
          logger.info('page served', { path: slug, status: 304, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: 'html-raw' });
          return res.status(304).end();
        }
        res.setHeader('ETag', result.etag);
        res.setHeader('Cache-Control', isShareViewer ? 'no-store' : 'public, max-age=60');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: 'html-raw' });
        const baseTag = `<script>window.__PAGES_BASE=${JSON.stringify(browserBase)};</script>`;
        const injected = result.html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
        return res.send(injected !== result.html ? injected : baseTag + result.html);
      }

      // ETag / 304 handling
      const wrapperEtag = isHtmlArtifact ? `"${result.etag.replace(/"/g, '')}-wrapped"` : result.etag;
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && clientEtag === wrapperEtag) {
        logger.info('page served', { path: slug, status: 304, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: result.type });
        return res.status(304).end();
      }

      res.setHeader('ETag', wrapperEtag);
      res.setHeader('Cache-Control', isShareViewer ? 'no-store' : 'public, max-age=60');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (isHtmlArtifact) {
        const titleMatch = result.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : slug;
        const iframeSrc = `${browserBase}/${encodeURI(slug)}?raw=1`;
        let html = htmlArtifactTemplate({ title, baseUrl: browserBase, slug, iframeSrc });
        if (isShareViewer) {
          html = injectShareViewer(html);
        } else {
          const pages = await scanPages(config.contentDir);
          html = injectNavSidebar(html, pages, slug, browserBase);
        }
        logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: result.type });
        return res.send(html);
      }

      // For share viewers: inject data-viewer attribute to hide auth-only elements
      // For auth viewers: inject pages nav sidebar for quick article switching
      let html = result.html;
      if (isShareViewer) {
        html = injectShareViewer(html);
      } else {
        const pages = await scanPages(config.contentDir);
        html = injectNavSidebar(html, pages, slug, browserBase);
      }

      logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth' });
      res.send(html);
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);

      if (err.code === 'ENOENT') {
        logger.info('page not found', { path: slug, render_ms: elapsed });
        res.status(404).send(notFoundTemplate(slug, browserBase));
        return;
      }

      if (err.statusCode) {
        logger.warn('page error', { path: slug, status: err.statusCode, err: err.message, render_ms: elapsed });
        res.status(err.statusCode).send(errorTemplate(err.message, browserBase));
        return;
      }

      logger.error('page render failed', { path: slug, err: err.message, render_ms: elapsed });
      res.status(500).send(errorTemplate('An error occurred while rendering this page.', browserBase));
    }
  };
}
