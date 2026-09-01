import { escapeHtml } from '../security/sanitize.js';
import { AUTH_CARD_CSS } from './authCardStyles.js';

export function handoffFormHtml({ action, csrfToken, label, expiresAt, assetBase = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>Secure handoff — Zylos Pages</title>
  <link rel="stylesheet" href="${escapeHtml(assetBase)}/_assets/style.css">
  <style>${AUTH_CARD_CSS}</style>
</head>
<body>
  <main class="login-container">
    <div class="login-card">
      <div class="login-brand">
        <img src="${escapeHtml(assetBase)}/_assets/logo.png" alt="">
        <h1>Secure handoff</h1>
        <p class="login-sub">${escapeHtml(label)}</p>
      </div>
      <form method="post" action="${escapeHtml(action)}" autocomplete="off">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <div class="login-field">
          <label for="value">Value</label>
          <input type="password" id="value" name="value" autocomplete="new-password" maxlength="4096" required autofocus>
        </div>
        <button type="submit">Send securely</button>
      </form>
      <p class="login-hint">This one-time form expires at ${escapeHtml(new Date(expiresAt).toISOString())}. The value is not retained after delivery.</p>
    </div>
  </main>
</body>
</html>`;
}

export function handoffResultHtml() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>Handoff complete</title></head><body><main><h1>Handoff complete</h1><p>You may close this window.</p></main></body></html>';
}
