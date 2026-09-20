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

export function handoffResultHtml({ assetBase = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>Handoff complete — Zylos Pages</title>
  <link rel="stylesheet" href="${escapeHtml(assetBase)}/_assets/style.css">
  <style>${AUTH_CARD_CSS}
    .handoff-success {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: rgba(31, 136, 61, 0.12);
      color: var(--color-success, #1a7f37);
      font-size: 30px;
      font-weight: 700;
      line-height: 1;
    }
    .handoff-complete .login-brand { margin-bottom: 18px; }
    .handoff-complete .login-hint { margin-top: 0; }
  </style>
</head>
<body>
  <main class="login-container">
    <div class="login-card handoff-complete">
      <div class="login-brand">
        <img src="${escapeHtml(assetBase)}/_assets/logo.png" alt="">
        <div class="handoff-success" aria-hidden="true">✓</div>
        <h1>Handoff complete</h1>
        <p class="login-sub">Your value was submitted securely.</p>
      </div>
      <p class="login-hint">This one-time form is now closed. You may safely close this window.</p>
    </div>
  </main>
</body>
</html>`;
}

export function handoffRevealHtml({ action, csrfToken, label, expiresAt, assetBase = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>One-time reveal — Zylos Pages</title>
  <link rel="stylesheet" href="${escapeHtml(assetBase)}/_assets/style.css">
  <style>${AUTH_CARD_CSS}</style>
</head>
<body>
  <main class="login-container">
    <div class="login-card">
      <div class="login-brand">
        <img src="${escapeHtml(assetBase)}/_assets/logo.png" alt="">
        <h1>One-time reveal</h1>
        <p class="login-sub">${escapeHtml(label)}</p>
      </div>
      <form method="post" action="${escapeHtml(action)}" autocomplete="off">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <button type="submit">Reveal once</button>
      </form>
      <p class="login-hint">The value is not loaded by this preview. Revealing consumes it permanently. This link expires at ${escapeHtml(new Date(expiresAt).toISOString())}.</p>
    </div>
  </main>
</body>
</html>`;
}

export function handoffRevealedHtml({ value, assetBase = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>Value revealed — Zylos Pages</title>
  <link rel="stylesheet" href="${escapeHtml(assetBase)}/_assets/style.css">
  <style>${AUTH_CARD_CSS}</style>
</head>
<body>
  <main class="login-container">
    <div class="login-card">
      <div class="login-brand">
        <img src="${escapeHtml(assetBase)}/_assets/logo.png" alt="">
        <h1>Value revealed</h1>
        <p class="login-sub">This value has been consumed and cannot be opened again.</p>
      </div>
      <div class="login-field">
        <label for="revealed-value">Value</label>
        <textarea id="revealed-value" rows="5" readonly>${escapeHtml(value)}</textarea>
      </div>
      <p class="login-hint">Move it directly to its intended destination, then close this window.</p>
    </div>
  </main>
</body>
</html>`;
}
