import { createHash } from 'node:crypto';
import { escapeHtml } from '../security/sanitize.js';

const ASSET_VERSION = Date.now();

export function injectAnnotations(html, { baseUrl, pageId, uri, share, enabled = true }) {
  const viewerScope = share
    ? `share-${createHash('sha256').update(String(share.tokenId)).digest('hex')}`
    : 'owner';
  const path = `${baseUrl}/p/${uri}`;
  const attributes = {
    'data-unavailable': String(!enabled),
    'data-base-namespace': baseUrl || '/',
    'data-viewer-scope': viewerScope,
    'data-page-id': pageId || uri,
    'data-document-url': share ? '' : path,
  };
  const host = `<section id="pages-annotations" ${Object.entries(attributes).map(([key, value]) => `${key}="${escapeHtml(String(value))}"`).join(' ')} aria-label="Reading annotations"></section>`;
  const assets = `<link rel="stylesheet" href="${baseUrl}/_assets/annotations.css?v=${ASSET_VERSION}">\n<script src="${baseUrl}/_assets/annotations-core.js?v=${ASSET_VERSION}" defer></script>\n<script src="${baseUrl}/_assets/annotations.js?v=${ASSET_VERSION}" defer></script>`;
  return html.replace('</head>', `${assets}\n</head>`).replace('</body>', `${host}\n</body>`);
}

export function injectAnnotationReporter(html, baseUrl) {
  const scripts = `<script src="${baseUrl}/_assets/annotations-core.js?v=${ASSET_VERSION}"></script><script src="${baseUrl}/_assets/annotations-frame.js?v=${ASSET_VERSION}" defer></script>`;
  const result = html.replace(/<head([^>]*)>/i, `<head$1>${scripts}`);
  return result === html ? scripts + html : result;
}
