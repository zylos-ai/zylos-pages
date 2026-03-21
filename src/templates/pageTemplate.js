// HTML page template with SEO meta, TOC, and theme support

import { escapeHtml } from '../security/sanitize.js';

// Stable cache version — generated once per process start
const ASSET_VERSION = Date.now();

/**
 * Generate a complete HTML page from rendered content.
 */
export function pageTemplate({ title, description, date, tags, bodyHtml, tocItems, baseUrl }) {
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
  <script src="${baseUrl}/_assets/theme.js"></script>
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="${baseUrl}/">Pages</a>
      <span class="sep">/</span>
      <span class="current">${escapeHtml(title)}</span>
    </nav>
    <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle dark mode">
      <span class="theme-icon"></span>
    </button>
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
    <a href="${baseUrl}/">Back to index</a>
  </footer>

</body>
</html>`;
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
