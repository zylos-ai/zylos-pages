// HTML page template with SEO meta, TOC, and theme support

import { escapeHtml } from '../security/sanitize.js';

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
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css">
  <link rel="stylesheet" href="${baseUrl}/_assets/print.css" media="print">
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

  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    }
    (function() {
      const saved = localStorage.getItem('theme');
      if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
      } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
  </script>
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
