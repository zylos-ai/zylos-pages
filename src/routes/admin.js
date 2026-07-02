import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserBaseFromRequest } from '../lib/browser-base.js';
import { icon, themeToggleIcons } from '../templates/icons.js';

const ASSET_VERSION = Date.now();

// Read the component version from package.json at startup — never hardcoded in markup.
const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '';
  } catch {
    return '';
  }
})();

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
    <div class="header-left">
      <a href="${baseUrl}/" class="nav-brand header-brand"><span class="nav-brand-mark">${icon('document')}</span><b>Pages</b></a>${APP_VERSION ? `<span class="header-version">v${APP_VERSION}</span>` : ''}
    </div>
    <div class="header-actions">
      <button class="theme-toggle icon-btn" aria-label="Toggle dark mode">
        ${themeToggleIcons()}
      </button>
      <form method="POST" action="${baseUrl}/logout" class="logout-form"><button type="submit" class="logout-btn icon-btn" aria-label="Sign out" title="Sign out">${icon('logout')}</button></form>
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
