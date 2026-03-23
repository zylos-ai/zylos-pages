// HTML page template with SEO meta, TOC, theme support, and sharing

import { escapeHtml } from '../security/sanitize.js';

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
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="${baseUrl}/" class="auth-only">Pages</a>
      <span class="sep auth-only">/</span>
      <span class="current">${escapeHtml(title)}</span>
    </nav>
    <div class="header-actions">
      <button class="share-btn auth-only" data-slug="${escapeHtml(slug || '')}" data-base-url="${escapeHtml(baseUrl)}" aria-label="Share this page">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.5 2.5 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5z"/></svg>
        Share
      </button>
      <button class="theme-toggle" aria-label="Toggle dark mode">
        <span class="theme-icon"></span>
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form auth-only">
        <button type="submit" class="logout-btn" aria-label="Sign out">Sign out</button>
      </form>
    </div>
  </header>

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

</body>
</html>`;
}

/**
 * Inject data-viewer="share" on the <html> tag for share token viewers.
 * This activates CSS rules that hide auth-only elements.
 * Called post-cache in the page route.
 */
export function injectShareViewer(html) {
  return html.replace('<html lang="en">', '<html lang="en" data-viewer="share">');
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
