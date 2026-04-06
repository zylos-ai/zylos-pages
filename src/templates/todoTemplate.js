// HTML template for the TODO kanban board
// Matches existing pages dark/light theme and header pattern

import { escapeHtml } from '../security/sanitize.js';

const SAFE_URL_SCHEMES = /^https?:\/\//i;

function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return SAFE_URL_SCHEMES.test(url.trim());
}

const ASSET_VERSION = Date.now();

/**
 * Generate the kanban board HTML page.
 */
export function todoTemplate({ title, boardName, active, completed, baseUrl, isAuthenticated, isShareViewer }) {
  const activeHtml = renderColumn('Active', active, 'active', !isShareViewer);
  const completedHtml = renderColumn('Completed', completed, 'completed', !isShareViewer);

  return `<!DOCTYPE html>
<html lang="en"${isShareViewer ? ' data-viewer="share"' : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Todo Board</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="${baseUrl}/_assets/todo.css?v=${ASSET_VERSION}">
  <script src="${baseUrl}/_assets/theme.js?v=${ASSET_VERSION}"></script>
</head>
<body>
  <header class="page-header">
    <div class="header-left">
      <nav class="breadcrumb">
        <a href="${baseUrl}/" class="auth-only">Pages</a>
        <span class="sep auth-only">/</span>
        <span class="current">${escapeHtml(title)}</span>
      </nav>
    </div>
    <div class="header-actions">
      <button class="theme-toggle" aria-label="Toggle dark mode">
        <span class="theme-icon"></span>
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form auth-only">
        <button type="submit" class="logout-btn" aria-label="Sign out">Sign out</button>
      </form>
    </div>
  </header>

  <div class="todo-board" data-board="${escapeHtml(boardName)}" data-base-url="${escapeHtml(baseUrl)}">
    <div class="todo-header">
      <h1 class="todo-title">${escapeHtml(title)}</h1>
      <button class="todo-add-btn auth-only" aria-label="Add item">+ Add Item</button>
    </div>
    <div class="todo-columns">
      <div class="todo-column todo-column-active">
        ${activeHtml}
      </div>
      <div class="todo-column todo-column-completed">
        ${completedHtml}
      </div>
    </div>
  </div>

  <!-- Add Item Modal -->
  <div id="todo-add-modal" class="todo-modal auth-only" hidden>
    <div class="todo-modal-backdrop"></div>
    <div class="todo-modal-content">
      <div class="todo-modal-header">
        <h3>Add Item</h3>
        <button class="todo-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="todo-modal-body">
        <label for="todo-add-title">Title</label>
        <input type="text" id="todo-add-title" class="todo-input" placeholder="What needs to be done?" autofocus>
        <label for="todo-add-source">Source (optional)</label>
        <input type="text" id="todo-add-source" class="todo-input" placeholder="Where did this come from?">
        <label for="todo-add-content">Content (optional)</label>
        <textarea id="todo-add-content" class="todo-textarea" placeholder="Background details..." rows="3"></textarea>
        <label for="todo-add-link">Link (optional)</label>
        <input type="url" id="todo-add-link" class="todo-input" placeholder="https://...">
        <button class="todo-submit-btn">Add</button>
      </div>
    </div>
  </div>

  <footer class="page-footer">
    <a href="${baseUrl}/" class="auth-only">Back to index</a>
  </footer>

  <script src="${baseUrl}/_assets/todo.js?v=${ASSET_VERSION}"></script>
</body>
</html>`;
}

function renderColumn(label, items, columnType, canEdit) {
  let html = `<h2 class="todo-column-title">${escapeHtml(label)} <span class="todo-count">${items.length}</span></h2>`;
  html += '<div class="todo-cards">';

  if (items.length === 0) {
    html += '<div class="todo-empty">No items</div>';
  }

  for (const item of items) {
    html += renderCard(item, columnType, canEdit);
  }

  html += '</div>';
  return html;
}

function renderCard(item, columnType, canEdit) {
  let html = `<div class="todo-card" data-id="${item.id}">`;
  html += `<div class="todo-card-header">`;
  html += `<span class="todo-card-id">#${item.id}</span>`;
  html += `<span class="todo-card-title">${escapeHtml(item.title)}</span>`;
  html += `</div>`;

  // Metadata
  const metaKeys = Object.keys(item.metadata || {});
  if (metaKeys.length > 0) {
    html += '<div class="todo-card-meta">';
    for (const key of metaKeys) {
      const value = item.metadata[key];
      if (!value) continue;
      if (key === 'link') {
        const safeUrl = isSafeUrl(value) ? escapeHtml(value) : null;
        if (safeUrl) {
          html += `<div class="todo-meta-line"><strong>${escapeHtml(key)}:</strong> <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a></div>`;
        } else {
          html += `<div class="todo-meta-line"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`;
        }
      } else {
        html += `<div class="todo-meta-line"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`;
      }
    }
    html += '</div>';
  }

  // Action buttons
  if (canEdit) {
    html += '<div class="todo-card-actions auth-only">';
    if (columnType === 'active') {
      html += `<button class="todo-action-btn todo-complete-btn" data-id="${item.id}" title="Mark completed">&#10003;</button>`;
      html += `<button class="todo-action-btn todo-delete-btn" data-id="${item.id}" title="Delete">&#10005;</button>`;
    } else {
      html += `<button class="todo-action-btn todo-reopen-btn" data-id="${item.id}" title="Reopen">&#8634;</button>`;
      html += `<button class="todo-action-btn todo-delete-btn" data-id="${item.id}" title="Delete">&#10005;</button>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}
