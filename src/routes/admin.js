import { browserBaseFromRequest } from '../lib/browser-base.js';

const ASSET_VERSION = Date.now();

export function adminRoute() {
  return (req, res) => {
    const baseUrl = browserBaseFromRequest(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pages</title>
  <link rel="stylesheet" href="${baseUrl}/_assets/style.css?v=${ASSET_VERSION}">
  <script src="${baseUrl}/_assets/theme.js?v=${ASSET_VERSION}"></script>
</head>
<body>
  <header class="page-header">
    <nav class="breadcrumb"><a href="${baseUrl}/">Pages</a></nav>
    <div class="header-actions">
      <button class="theme-toggle" aria-label="Toggle dark mode"><span class="theme-icon"></span></button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form"><button type="submit" class="logout-btn" aria-label="Sign out">Sign out</button></form>
    </div>
  </header>
  <main class="admin-page">
    <div id="pages-admin-root" data-base-url="${baseUrl}"></div>
  </main>
  <script type="module" src="${baseUrl}/_assets/admin.js?v=${ASSET_VERSION}"></script>
</body>
</html>`);
  };
}
