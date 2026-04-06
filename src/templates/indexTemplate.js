// Directory index page template

import { escapeHtml } from '../security/sanitize.js';

// Stable cache version — generated once per process start
const ASSET_VERSION = Date.now();

/**
 * Generate the directory index page listing all available pages.
 * @param {Array<{slug, title, description, date}>} pages
 * @param {string} baseUrl
 * @param {Array<{name, slug}>} todoBoards
 */
export function indexTemplate(pages, baseUrl, todoBoards = []) {
  const hasTodo = todoBoards.length > 0;

  const pageRows = pages.map(p => `
    <li class="page-item">
      <a href="${baseUrl}/${encodeURI(p.slug)}">
        <span class="page-item-title">${escapeHtml(p.title)}</span>
        ${p.date ? `<time class="page-item-date">${escapeHtml(String(p.date))}</time>` : ''}
      </a>
      ${p.description ? `<p class="page-item-desc">${escapeHtml(p.description)}</p>` : ''}
    </li>
  `).join('');

  const todoRows = todoBoards.map(b => `
    <li class="page-item">
      <a href="${baseUrl}/${encodeURI(b.slug)}">
        <span class="page-item-title">${escapeHtml(b.name)}</span>
      </a>
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
  <style>
    .index-tabs {
      display: flex;
      gap: 0;
      border-bottom: 2px solid var(--color-border, #e1e4e8);
      margin-bottom: 1.5rem;
    }
    .index-tab {
      padding: 0.75rem 1.5rem;
      cursor: pointer;
      border: none;
      background: none;
      font-size: 1rem;
      font-weight: 500;
      color: var(--color-text-secondary, #6a737d);
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
    }
    .index-tab:hover {
      color: var(--color-text-primary, #24292e);
    }
    .index-tab.active {
      color: var(--color-text-primary, #24292e);
      border-bottom-color: var(--color-accent, #0969da);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
  </style>
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
    ${hasTodo ? `
    <div class="index-tabs">
      <button class="index-tab active" data-tab="pages">Pages</button>
      <button class="index-tab" data-tab="todo">Todo</button>
    </div>
    ` : ''}

    <div id="panel-pages" class="tab-panel active">
      <p class="index-count">${pages.length} page${pages.length !== 1 ? 's' : ''}</p>
      ${pages.length === 0
        ? '<p class="empty-state">No pages yet. Write a <code>.md</code> file to get started.</p>'
        : `<ul class="page-list">${pageRows}</ul>`
      }
    </div>

    ${hasTodo ? `
    <div id="panel-todo" class="tab-panel">
      <p class="index-count">${todoBoards.length} board${todoBoards.length !== 1 ? 's' : ''}</p>
      <ul class="page-list">${todoRows}</ul>
    </div>
    ` : ''}
  </main>

  ${hasTodo ? `<script src="${baseUrl}/_assets/tabs.js?v=${ASSET_VERSION}"></script>` : ''}

</body>
</html>`;
}
