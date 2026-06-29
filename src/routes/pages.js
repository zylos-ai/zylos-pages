// Page rendering route handler (P0 core)

import { getPage } from '../services/pageService.js';
import { normalizeSlug } from '../utils/slug.js';
import { notFoundTemplate, errorTemplate } from '../templates/errorTemplate.js';
import { injectShareViewer, injectNavSidebar, htmlArtifactTemplate } from '../templates/pageTemplate.js';
import { rewriteSignedShareAssetRefs } from '../pages/asset-resolver.js';
import { scanPages } from './index.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { HTML_ARTIFACT_CSP } from '../security/headers.js';

const ASSET_VERSION = Date.now();

function redirectCleanExtension(req, res, browserBase, rawSlug, extension) {
  const clean = rawSlug.replace(new RegExp(`\\.${extension}$`, 'i'), '');
  const queryIndex = req.url.indexOf('?');
  const query = queryIndex === -1 ? '' : req.url.slice(queryIndex);
  return res.redirect(301, `${browserPath(browserBase, clean)}${query}`);
}

function injectBaseHref(html, baseHref) {
  const baseTag = `<base href="${baseHref}">`;
  const injected = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  return injected === html ? `${baseTag}${html}` : injected;
}

async function finalizeShareHtml(html, { config, browserBase, displaySlug, share }) {
  let output = injectBaseHref(html, browserPath(browserBase, displaySlug));
  output = await rewriteSignedShareAssetRefs(output, {
    baseUrl: browserBase,
    pageUri: displaySlug.startsWith('p/') ? displaySlug.slice(2) : displaySlug,
    config,
    share,
  });
  return output;
}

async function renderPageSlug({ req, res, config, browserBase, rawSlug, shareContext = null }) {
  const start = performance.now();
  const isLogicalRoute = rawSlug.startsWith('p/');
  const routeSlug = isLogicalRoute ? rawSlug.slice(2) : rawSlug;

  // Redirect explicit extension URLs to clean URLs.
  if (/\.md$/i.test(rawSlug)) {
    return redirectCleanExtension(req, res, browserBase, rawSlug, 'md');
  }
  if (/\.html$/i.test(rawSlug)) {
    return redirectCleanExtension(req, res, browserBase, rawSlug, 'html');
  }

  const slug = normalizeSlug(routeSlug);
  const displaySlug = isLogicalRoute ? `p/${slug}` : slug;

  // Redirect if slug was normalized differently
  if (routeSlug && slug !== routeSlug && slug !== decodeURIComponent(routeSlug)) {
    return res.redirect(301, browserPath(browserBase, displaySlug));
  }

  const isShareViewer = Boolean(shareContext) || res.locals.viewerType === 'share';
  const shareCanWriteAttachments = shareContext
    ? shareContext.canWriteAttachments === true
    : res.locals.shareCanWriteAttachments === true;

  try {
    const result = await getPage(displaySlug, config, browserBase);
    const elapsed = Math.round(performance.now() - start);
    const isHtmlArtifact = result.type === 'html';

    // Raw mode serves the HTML artifact directly. Share viewers also receive
    // the artifact directly because shared HTML is a complete page design.
    if (isHtmlArtifact && (req.query.raw === '1' || isShareViewer)) {
      res.setHeader('Content-Security-Policy', HTML_ARTIFACT_CSP);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      if (!isShareViewer) {
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag && clientEtag === result.etag) {
          logger.info('page served', { path: slug, status: 304, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: 'auth', type: 'html-raw' });
          return res.status(304).end();
        }
        res.setHeader('ETag', result.etag);
        res.setHeader('Cache-Control', 'public, max-age=60');
      } else {
        res.setHeader('Cache-Control', 'no-store');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: 'html-raw' });
      const baseTag = `<script>window.__PAGES_BASE=${JSON.stringify(browserBase)};window.__PAGES_VIEWER=${JSON.stringify(isShareViewer ? 'share' : 'auth')};window.__PAGES_SHARE_EDITABLE=${shareCanWriteAttachments ? 'true' : 'false'};</script>`;
      let injected = result.html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
      if (injected === result.html) injected = baseTag + result.html;
      const viewerAttr = isShareViewer ? ` data-viewer="share"` : '';
      const editableAttr = shareCanWriteAttachments ? ` data-share-editable="true"` : '';
      injected = injected.replace(/<html([^>]*)>/i, `<html$1${viewerAttr}${editableAttr}>`);
      injected = injected.replace(/src="([^"?]*_assets\/[^"?]+)"/g, `src="$1?v=${ASSET_VERSION}"`);
      if (isShareViewer) {
        injected = await finalizeShareHtml(injected, { config, browserBase, displaySlug, share: shareContext || res.locals.shareContext });
      }
      return res.send(injected);
    }

    // ETag / 304 handling — skip for share viewers because post-cache
    // injections (editable flag, viewer attr) are not reflected in the ETag.
    const wrapperEtag = isHtmlArtifact ? `"${result.etag.replace(/"/g, '')}-wrapped"` : result.etag;
    if (!isShareViewer) {
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && clientEtag === wrapperEtag) {
        logger.info('page served', { path: slug, status: 304, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: 'auth', type: result.type });
        return res.status(304).end();
      }
      res.setHeader('ETag', wrapperEtag);
      res.setHeader('Cache-Control', 'public, max-age=60');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (isHtmlArtifact) {
      const titleMatch = result.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : slug;
      const iframeSrc = browserPath(browserBase, `${displaySlug}?raw=1`);
      let html = htmlArtifactTemplate({ title, baseUrl: browserBase, slug: displaySlug, iframeSrc });
      if (isShareViewer) {
        html = injectShareViewer(html, { canWriteAttachments: shareCanWriteAttachments });
        html = await finalizeShareHtml(html, { config, browserBase, displaySlug, share: shareContext || res.locals.shareContext });
      } else {
        const pages = await scanPages(config.contentDir);
        html = injectNavSidebar(html, pages, displaySlug, browserBase);
      }
      logger.info('page served', { path: slug, status: 200, cache_hit: result.cacheHit, singleflight_shared: result.singleflightShared, render_ms: elapsed, viewer: isShareViewer ? 'share' : 'auth', type: result.type });
      return res.send(html);
    }

    let html = result.html;
    if (isShareViewer) {
      html = injectShareViewer(html, { canWriteAttachments: shareCanWriteAttachments });
      html = await finalizeShareHtml(html, { config, browserBase, displaySlug, share: shareContext || res.locals.shareContext });
    } else {
      const pages = await scanPages(config.contentDir);
      html = injectNavSidebar(html, pages, displaySlug, browserBase);
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
}

export async function renderSharePage(req, res, { slug, config, browserBase, share }) {
  res.locals.viewerType = 'share';
  res.locals.authenticated = false;
  res.locals.shareSlug = share.slug;
  res.locals.shareCanWriteAttachments = share.canWriteAttachments === true;
  res.locals.shareContext = share;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return renderPageSlug({ req, res, config, browserBase, rawSlug: slug, shareContext: share });
}

/**
 * Route handler for GET /:slug(*)
 */
export function pageRoute(config) {
  return async (req, res) => {
    const browserBase = browserBaseFromRequest(req);
    const rawSlug = req.params.slug || req.params[0] || req.path.slice(1) || '';
    return renderPageSlug({ req, res, config, browserBase, rawSlug });
  };
}
