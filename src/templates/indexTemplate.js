// Directory index page template

import { escapeHtml } from '../security/sanitize.js';

/**
 * Generate the directory index page listing all available pages.
 * @param {Array<{slug, title, description, date}>} pages
 * @param {string} baseUrl
 */
export function indexTemplate(pages, baseUrl) {
  const pageRows = pages.map(p => `
    <li class="page-item">
      <a href="${baseUrl}/${encodeURI(p.slug)}">
        <span class="page-item-title">${escapeHtml(p.title)}</span>
        ${p.date ? `<time class="page-item-date">${escapeHtml(String(p.date))}</time>` : ''}
      </a>
      ${p.description ? `<p class="page-item-desc">${escapeHtml(p.description)}</p>` : ''}
    </li>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pages</title>
  <meta name="description" content="Index of available pages">
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css">
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <span class="current">Pages</span>
    </nav>
    <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle dark mode">
      <span class="theme-icon"></span>
    </button>
  </header>

  <main class="page-content index-page">
    <h1>Pages</h1>
    <p class="index-count">${pages.length} page${pages.length !== 1 ? 's' : ''}</p>
    ${pages.length === 0
      ? '<p class="empty-state">No pages yet. Write a <code>.md</code> file to get started.</p>'
      : `<ul class="page-list">${pageRows}</ul>`
    }
  </main>

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
