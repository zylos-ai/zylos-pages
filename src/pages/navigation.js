import sanitizeHtml from 'sanitize-html';
import { browserPath } from '../lib/browser-base.js';

/**
 * List registered logical pages for navigation.
 *
 * The content directory may contain drafts, source artifacts, or historical
 * bare files, but owner-facing navigation should reflect the logical page
 * registry, not the filesystem.
 */
export async function scanPages() {
  const { listLogicalPagesForNavigation } = await import('./page-store.js');
  return listLogicalPagesForNavigation();
}

function pageViewPaths(page, browserBase) {
  const canonical = browserPath(browserBase, page.slug);
  const legacySlug = page.slug.startsWith('p/') ? page.slug.slice(2) : page.slug;
  return [...new Set([canonical, browserPath(browserBase, legacySlug)])];
}

function anchorHrefs(html) {
  const hrefs = [];
  sanitizeHtml(html, {
    allowedTags: ['a'],
    allowedAttributes: { a: ['href'] },
    transformTags: {
      a: (tagName, attribs) => {
        if (typeof attribs.href === 'string') hrefs.push(attribs.href);
        return { tagName, attribs };
      },
    },
  });
  return hrefs;
}

function hasQueryDelimiter(url) {
  const withoutHash = url.hash ? url.href.slice(0, -url.hash.length) : url.href;
  return withoutHash.includes('?');
}

/**
 * Build the exact same-site view allowlist consumed by the trusted shell.
 * Owner shells may navigate to every registered page. Share shells expose only
 * destinations linked by the shared artifact, while still accepting either
 * public view form for each linked destination.
 */
export function pageOpenPaths({ pages, browserBase = '', html = '', currentSlug = '', linkedOnly = false }) {
  const entries = pages.map(page => ({ paths: pageViewPaths(page, browserBase) }));
  if (!linkedOnly) return entries.flatMap(entry => entry.paths);

  const routes = new Map();
  for (const entry of entries) {
    for (const route of entry.paths) routes.set(route, entry.paths);
  }

  const legacyCurrentSlug = currentSlug.startsWith('p/') ? currentSlug.slice(2) : currentSlug;
  const base = new URL(browserPath(browserBase, legacyCurrentSlug), 'https://pages.invalid');
  const allowed = new Set();
  for (const href of anchorHrefs(html)) {
    let target;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.origin !== base.origin || hasQueryDelimiter(target)) continue;
    const matched = routes.get(target.pathname);
    if (matched) matched.forEach(route => allowed.add(route));
  }
  return entries.flatMap(entry => entry.paths.filter(route => allowed.has(route)));
}
