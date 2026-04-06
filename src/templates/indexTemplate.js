// Directory index page template

import { escapeHtml } from '../security/sanitize.js';

// Stable cache version — generated once per process start
const ASSET_VERSION = Date.now();

/**
 * Generate the directory index page listing all available pages.
 * @param {Array<{slug, title, description, date}>} pages
 * @param {string} baseUrl
 */
export function indexTemplate(pages, baseUrl, todoBoards = []) {
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
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
  <script src="${baseUrl}/_assets/theme.js?v=${ASSET_VERSION}"></script>
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <span class="current">Pages</span>
    </nav>
    <div class="header-actions">
      <button class="theme-toggle" aria-label="Toggle dark mode">
        <span class="theme-icon"></span>
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form">
        <button type="submit" class="logout-btn" aria-label="Sign out">Sign out</button>
      </form>
    </div>
  </header>

  <main class="page-content index-page">
    ${todoBoards.length > 0 ? `
    <section class="todo-boards-section">
      <h2>Todo Boards</h2>
      <ul class="page-list">
        ${todoBoards.map(b => `
          <li class="page-item">
            <a href="${baseUrl}/${encodeURI(b.slug)}">
              <span class="page-item-title">${escapeHtml(b.name)}</span>
            </a>
          </li>
        `).join('')}
      </ul>
    </section>
    ` : ''}
    <h1>Pages</h1>
    <p class="index-count">${pages.length} page${pages.length !== 1 ? 's' : ''}</p>
    ${pages.length === 0
      ? '<p class="empty-state">No pages yet. Write a <code>.md</code> file to get started.</p>'
      : `<ul class="page-list">${pageRows}</ul>`
    }
  </main>

</body>
</html>`;
}
