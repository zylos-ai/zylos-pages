// Error page templates (404, 500)

import { escapeHtml } from '../security/sanitize.js';

export function notFoundTemplate(slug, baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page Not Found</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css">
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="${baseUrl}/">Pages</a>
      <span class="sep">/</span>
      <span class="current">Not Found</span>
    </nav>
  </header>
  <main class="page-content error-page">
    <h1>404 — Page Not Found</h1>
    <p>The page <code>${escapeHtml(slug)}</code> does not exist.</p>
    <p><a href="${baseUrl}/">Browse all pages</a></p>
  </main>
</body>
</html>`;
}

export function errorTemplate(message, baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css">
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="${baseUrl}/">Pages</a>
      <span class="sep">/</span>
      <span class="current">Error</span>
    </nav>
  </header>
  <main class="page-content error-page">
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="${baseUrl}/">Browse all pages</a></p>
  </main>
</body>
</html>`;
}
