// HTML page template with SEO meta, TOC, theme support, and sharing

import { APP_VERSION } from '../lib/app-version.js';
import { escapeHtml } from '../security/sanitize.js';
import { buildPageTree } from '../utils/pageTree.js';
import { icon, themeToggleIcons } from './icons.js';

// Stable cache version — generated once per process start
const ASSET_VERSION = Date.now();

/**
 * Generate a complete HTML page from rendered content.
 * The HTML is cached per slug — viewer-specific adjustments (share vs auth)
 * are done post-cache via injectShareViewer().
 */
export function pageTemplate({ title, description, date, tags, bodyHtml, tocItems, baseUrl, slug }) {
  const tocHtml = tocItems.length > 0 ? renderToc(tocItems) : '';
  const hasToc = tocItems.length > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  ${date ? `<meta property="article:published_time" content="${escapeHtml(String(date))}">` : ''}
  ${tags.length ? `<meta name="keywords" content="${tags.map(t => escapeHtml(String(t))).join(', ')}">` : ''}
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="${baseUrl}/_assets/print.css?v=${ASSET_VERSION}" media="print">
  <script src="${baseUrl}/_assets/theme.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/raw.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
  <header class="page-header">
    <div class="header-left">
      <button class="nav-toggle icon-btn auth-only" aria-label="Toggle pages list">
        ${icon('sidebar')}
      </button>
      ${renderBreadcrumb({ baseUrl, slug, title })}
    </div>
    <div class="header-actions">
      <a class="console-link icon-btn auth-only" href="${baseUrl}/" aria-label="Back to console" title="Back to console">
        ${icon('grid')}
      </a>
      <button class="copy-raw-btn btn btn-secondary auth-only" data-slug="${escapeHtml(slug || '')}" data-base-url="${escapeHtml(baseUrl)}" aria-label="Copy raw Markdown">
        ${icon('copy')}
        <span class="copy-raw-label">Copy Markdown</span>
      </button>
      <button class="share-btn btn btn-primary auth-only" data-slug="${escapeHtml(slug || '')}" data-base-url="${escapeHtml(baseUrl)}" aria-label="Share this page">
        ${icon('share')}
        Share
      </button>
      <button class="theme-toggle icon-btn" aria-label="Toggle dark mode">
        ${themeToggleIcons()}
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form auth-only">
        <button type="submit" class="logout-btn icon-btn" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
      </form>
    </div>
  </header>

  <!-- NAV_SIDEBAR -->
  <div class="nav-overlay" hidden></div>

  <div class="page-layout${hasToc ? ' has-toc' : ''}">
    ${tocHtml ? `<aside class="toc-sidebar">${tocHtml}</aside>` : ''}
    <main class="page-content">
      ${date ? `<time class="page-date" datetime="${escapeHtml(String(date))}">${escapeHtml(String(date))}</time>` : ''}
      <h1 class="page-title">${escapeHtml(title)}</h1>
      ${tags.length ? `<div class="page-tags">${tags.map(t => `<span class="tag">${escapeHtml(String(t))}</span>`).join(' ')}</div>` : ''}
      <article class="markdown-body">
        ${bodyHtml}
      </article>
    </main>
  </div>

  <footer class="page-footer">
    <a href="${baseUrl}/" class="auth-only">Back to index</a>
  </footer>

  <!-- Share Modal (hidden for share viewers via CSS) -->
  <div id="share-modal" class="share-modal auth-only" hidden>
    <div class="share-modal-backdrop"></div>
    <div class="share-modal-content">
      <div class="share-modal-header">
        <h3>Share "${escapeHtml(title)}"</h3>
        <button class="share-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="share-modal-body">
        <div class="share-create">
          <label>Link expires in:</label>
          <div class="share-duration-options">
            <label><input type="radio" name="share-duration" value="24h" checked> 24 hours</label>
            <label><input type="radio" name="share-duration" value="7d"> 7 days</label>
            <label><input type="radio" name="share-duration" value="30d"> 30 days</label>
            <label><input type="radio" name="share-duration" value="permanent"> Permanent</label>
          </div>
          <label class="share-editable-option"><input type="checkbox" class="share-editable-input"> Allow photo upload/delete</label>
          <button class="share-generate-btn">Generate Link</button>
        </div>
        <div class="share-result" hidden>
          <label>Share link:</label>
          <div class="share-link-row">
            <input type="text" class="share-link-input" readonly>
            <button class="share-copy-btn">Copy</button>
          </div>
        </div>
        <div class="share-list">
          <h4>Active shares</h4>
          <div class="share-list-items"></div>
        </div>
      </div>
    </div>
  </div>
  <script src="${baseUrl}/_assets/share.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/nav.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/codeblocks.js?v=${ASSET_VERSION}"></script>
  ${bodyHtml.includes('class="mermaid"') ? `<script src="${baseUrl}/_assets/mermaid.min.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/mermaid-zoom.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/mermaid-init.js?v=${ASSET_VERSION}"></script>` : ''}

</body>
</html>`;
}

/**
 * Inject data-viewer="share" on the <html> tag for share token viewers.
 * This activates CSS rules that hide auth-only elements.
 * Called post-cache in the page route.
 */
export function htmlArtifactTemplate({ title, baseUrl, slug, iframeSrc }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="${baseUrl}/_assets/print.css?v=${ASSET_VERSION}" media="print">
  <script src="${baseUrl}/_assets/theme.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/raw.js?v=${ASSET_VERSION}" defer></script>
</head>
<body class="html-artifact-page">
  <header class="page-header">
    <div class="header-left">
      <button class="nav-toggle icon-btn auth-only" aria-label="Toggle pages list">
        ${icon('sidebar')}
      </button>
      ${renderBreadcrumb({ baseUrl, slug, title })}
    </div>
    <div class="header-actions">
      <a class="console-link icon-btn auth-only" href="${baseUrl}/" aria-label="Back to console" title="Back to console">
        ${icon('grid')}
      </a>
      <button class="share-btn btn btn-primary auth-only" data-slug="${escapeHtml(slug || '')}" data-base-url="${escapeHtml(baseUrl)}" aria-label="Share this page">
        ${icon('share')}
        Share
      </button>
      <button class="theme-toggle icon-btn" aria-label="Toggle dark mode">
        ${themeToggleIcons()}
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form auth-only">
        <button type="submit" class="logout-btn icon-btn" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
      </form>
    </div>
  </header>

  <!-- NAV_SIDEBAR -->
  <div class="nav-overlay" hidden></div>

  <div class="html-artifact-container">
    <iframe class="html-artifact-frame" src="${escapeHtml(iframeSrc)}"></iframe>
  </div>

  <!-- Share Modal (hidden for share viewers via CSS) -->
  <div id="share-modal" class="share-modal auth-only" hidden>
    <div class="share-modal-backdrop"></div>
    <div class="share-modal-content">
      <div class="share-modal-header">
        <h3>Share "${escapeHtml(title)}"</h3>
        <button class="share-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="share-modal-body">
        <div class="share-create">
          <label>Link expires in:</label>
          <div class="share-duration-options">
            <label><input type="radio" name="share-duration" value="24h" checked> 24 hours</label>
            <label><input type="radio" name="share-duration" value="7d"> 7 days</label>
            <label><input type="radio" name="share-duration" value="30d"> 30 days</label>
            <label><input type="radio" name="share-duration" value="permanent"> Permanent</label>
          </div>
          <label class="share-editable-option"><input type="checkbox" class="share-editable-input"> Allow photo upload/delete</label>
          <button class="share-generate-btn">Generate Link</button>
        </div>
        <div class="share-result" hidden>
          <label>Share link:</label>
          <div class="share-link-row">
            <input type="text" class="share-link-input" readonly>
            <button class="share-copy-btn">Copy</button>
          </div>
        </div>
        <div class="share-list">
          <h4>Active shares</h4>
          <div class="share-list-items"></div>
        </div>
      </div>
    </div>
  </div>
  <script src="${baseUrl}/_assets/share.js?v=${ASSET_VERSION}"></script>
  <script src="${baseUrl}/_assets/nav.js?v=${ASSET_VERSION}"></script>

</body>
</html>`;
}

export function injectShareViewer(html, options = {}) {
  const editable = options.canWriteAttachments === true;
  const viewerScript = `<script>window.__PAGES_VIEWER="share";window.__PAGES_SHARE_EDITABLE=${editable ? 'true' : 'false'};</script>`;
  const editableAttr = editable ? ' data-share-editable="true"' : '';
  let injected = html.replace('<html lang="en">', `<html lang="en" data-viewer="share"${editableAttr}>`);
  injected = injected.replace(/<head([^>]*)>/i, `<head$1>${viewerScript}`);
  return injected !== html ? injected : viewerScript + html;
}

/**
 * Inject pages navigation sidebar into the rendered HTML (post-cache).
 * Adds a left sidebar with all pages for quick switching.
 */
export function injectNavSidebar(html, pages, currentSlug, baseUrl) {
  const navHtml = renderNavSidebar(pages, currentSlug, baseUrl);
  html = html.replace('<!-- NAV_SIDEBAR -->', navHtml);
  return html;
}

function renderNavSidebar(pages, currentSlug, baseUrl) {
  const pageTree = buildPageTree(pages);
  let html = `<aside class="nav-sidebar auth-only"><nav class="page-nav">
    <div class="nav-brand"><span class="nav-brand-mark">${icon('document')}</span><b>Pages</b>${APP_VERSION ? `<span class="header-version">v${APP_VERSION}</span>` : ''}</div>
    <h4>Workspace</h4><ul class="page-nav-list">`;
  for (const page of pageTree.topLevel) {
    html += renderNavPageItem(page, currentSlug, baseUrl);
  }

  for (const folder of pageTree.folders) {
    const isOpen = folder.pages.some(page => isCurrentPageSlug(page.slug, currentSlug));
    html += `<li class="nav-folder"><details${isOpen ? ' open' : ''}><summary>${icon('folder')}<span class="nav-folder-name">${escapeHtml(folder.label)}</span><span class="nav-folder-count">${folder.pages.length}</span></summary><ul class="nav-folder-list">`;
    for (const page of folder.pages) {
      html += renderNavPageItem(page, currentSlug, baseUrl);
    }
    html += '</ul></details></li>';
  }

  html += '</ul></nav></aside>';
  return html;
}

function renderNavPageItem(page, currentSlug, baseUrl) {
  const active = isCurrentPageSlug(page.slug, currentSlug) ? ' class="active"' : '';
  return `<li${active}><a href="${baseUrl}/${encodeURI(page.slug)}">${icon('document')}<span>${escapeHtml(page.title)}</span></a></li>`;
}

function isCurrentPageSlug(pageSlug, currentSlug) {
  return pageSlug === currentSlug || pageSlug === `p/${currentSlug}` || `p/${pageSlug}` === currentSlug;
}

function renderBreadcrumb({ baseUrl, slug, title }) {
  const segments = (slug || '').split('/').filter(Boolean);
  const folderSegments = segments.slice(0, -1);
  const folderCrumbs = folderSegments.map(segment => `
        <span class="sep auth-only">/</span>
        <span class="breadcrumb-folder auth-only">${escapeHtml(segment)}</span>`).join('');

  return `<nav class="breadcrumb">
        <a href="${baseUrl}/" class="auth-only">Pages</a>
        ${folderCrumbs}
        <span class="sep auth-only">/</span>
        <span class="current">${escapeHtml(title)}</span>
      </nav>`;
}

function renderToc(items) {
  let html = '<nav class="toc"><h4>Contents</h4><ul>';
  for (const item of items) {
    const indent = item.level === 3 ? ' class="toc-sub"' : '';
    html += `<li${indent}><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
  }
  html += '</ul></nav>';
  return html;
}
