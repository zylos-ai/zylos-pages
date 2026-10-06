import { escapeHtml } from '../security/sanitize.js';
import { AUTH_CARD_CSS } from './authCardStyles.js';

function handoffFieldsHtml(fields) {
  if (!fields) {
    return `<div class="login-field">
          <label for="value">Value</label>
          <input type="password" id="value" name="value" autocomplete="new-password" maxlength="4096" required autofocus>
        </div>`;
  }
  return fields.map((field, index) => {
    const id = `handoff-field-${index}`;
    const input = `<input type="${escapeHtml(field.type)}" id="${id}" name="${escapeHtml(field.name)}" autocomplete="${field.type === 'password' ? 'new-password' : 'off'}" maxlength="4096" required${index === 0 ? ' autofocus' : ''}>`;
    const control = field.type === 'password'
      ? `<div class="password-input">${input}
          <button type="button" class="password-toggle" data-password-toggle="${id}" data-show-label="Show ${escapeHtml(field.label)}" data-hide-label="Hide ${escapeHtml(field.label)}" aria-label="Show ${escapeHtml(field.label)}" title="Show ${escapeHtml(field.label)}">
            <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"></path><circle cx="12" cy="12" r="3"></circle></svg>
            <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 002.8 2.8"></path><path d="M9.9 4.2A10.8 10.8 0 0112 4c6.5 0 10 8 10 8a16.5 16.5 0 01-2.1 3.1"></path><path d="M6.6 6.6C3.5 8.6 2 12 2 12s3.5 8 10 8a9.8 9.8 0 004.1-.9"></path></svg>
          </button>
        </div>`
      : input;
    return `<div class="login-field">
          <label for="${id}">${escapeHtml(field.label)}</label>
          ${control}
        </div>`;
  }).join('\n        ');
}

export function handoffFormHtml({ action, csrfToken, label, expiresAt, fields = null, assetBase = '' }) {
  const hasPasswordToggle = fields?.some(field => field.type === 'password');
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
        ${handoffFieldsHtml(fields)}
        <button type="submit">Send securely</button>
      </form>
      <p class="login-hint">This one-time form expires at ${escapeHtml(new Date(expiresAt).toISOString())}. The value is not retained after delivery.</p>
    </div>
  </main>
  ${hasPasswordToggle ? `<script src="${escapeHtml(assetBase)}/_assets/handoff.js" defer></script>` : ''}
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
      <div class="login-field copy-field">
        <label for="revealed-value">Value</label>
        <div class="copy-input">
          <textarea id="revealed-value" rows="5" readonly>${escapeHtml(value)}</textarea>
          <button type="button" class="copy-btn" data-copy-target="revealed-value" data-copy-label="Copy value" data-copied-label="Copied" aria-label="Copy value" title="Copy value">
            <svg class="clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </button>
        </div>
      </div>
      <p class="login-hint">Move it directly to its intended destination, then close this window.</p>
    </div>
  </main>
  <script src="${escapeHtml(assetBase)}/_assets/handoff.js" defer></script>
</body>
</html>`;
}

export function handoffUnavailableHtml({ assetBase = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>Handoff unavailable — Zylos Pages</title>
  <link rel="stylesheet" href="${escapeHtml(assetBase)}/_assets/style.css">
  <style>${AUTH_CARD_CSS}
    .handoff-unavailable-icon {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--color-bg-secondary, rgba(101, 109, 118, 0.12));
      color: var(--color-text-secondary);
    }
    .handoff-unavailable-icon svg { width: 26px; height: 26px; display: block; }
    .handoff-complete .login-brand { margin-bottom: 18px; }
    .handoff-complete .login-hint { margin-top: 0; }
  </style>
</head>
<body>
  <main class="login-container">
    <div class="login-card handoff-complete">
      <div class="login-brand">
        <img src="${escapeHtml(assetBase)}/_assets/logo.png" alt="">
        <div class="handoff-unavailable-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path></svg>
        </div>
        <h1>Handoff unavailable</h1>
        <p class="login-sub">This link is invalid, expired, or has already been used.</p>
      </div>
      <p class="login-hint">One-time links open only once and expire quickly. Ask the sender to create a new one if you still need the value.</p>
    </div>
  </main>
</body>
</html>`;
}
