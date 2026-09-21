// Shared card styles for the standalone credential pages (owner login and
// share unlock). Both pages link /_assets/style.css for the theme variables
// and embed this block inline — the CSP allows inline styles
// (style-src 'unsafe-inline') but not inline scripts, so anything scripted
// must stay in external assets.
export const AUTH_CARD_CSS = `
    body { min-height: 100vh; }
    .login-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .login-card {
      width: 100%;
      max-width: 380px;
      border: 1px solid var(--color-border);
      border-radius: 14px;
      padding: 36px 32px;
      background: var(--color-bg);
      box-shadow: 0 8px 28px rgba(27, 31, 36, 0.10);
    }
    .login-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      margin-bottom: 26px;
    }
    .login-brand img {
      width: 48px;
      height: 48px;
      border-radius: 12px;
    }
    .login-card h1 {
      font-size: 1.3em;
      margin: 0;
      text-align: center;
    }
    .login-sub {
      margin: 0;
      font-size: 13px;
      color: var(--color-text-secondary);
      text-align: center;
    }
    .login-field { margin-bottom: 16px; }
    .login-card label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text);
      margin-bottom: 6px;
    }
    .login-card input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-bg);
      color: var(--color-text);
      box-sizing: border-box;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .login-card input[type="password"]:focus {
      outline: none;
      border-color: var(--color-link);
      box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.18);
    }
    .login-card textarea {
      width: 100%;
      padding: 10px 12px;
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      line-height: 1.5;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-bg);
      color: var(--color-text);
      box-sizing: border-box;
      resize: vertical;
      overflow-wrap: anywhere;
    }
    .login-card textarea:focus {
      outline: none;
      border-color: var(--color-link);
      box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.18);
    }
    /* Value box with an inline copy control (used by the reveal page). */
    .login-card .copy-input { position: relative; }
    .login-card .copy-input textarea { padding-right: 46px; }
    .login-card .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 32px;
      height: 32px;
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 1px solid var(--color-border);
      border-radius: 7px;
      background: var(--color-bg);
      color: var(--color-text-secondary);
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }
    .login-card .copy-btn:hover { color: var(--color-text); border-color: var(--color-link); }
    .login-card .copy-btn:focus-visible {
      outline: none;
      border-color: var(--color-link);
      box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.18);
    }
    .login-card .copy-btn svg { width: 16px; height: 16px; display: block; }
    .login-card .copy-btn .check { display: none; }
    .login-card .copy-btn.copied {
      color: var(--color-success, #1a7f37);
      border-color: var(--color-success, #1a7f37);
    }
    .login-card .copy-btn.copied .clip { display: none; }
    .login-card .copy-btn.copied .check { display: block; }
    .login-card .remember-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--color-text-secondary);
    }
    .login-card .remember-row input[type="checkbox"] { margin: 0; }
    .login-card .remember-row label { margin: 0; font-weight: 400; color: var(--color-text-secondary); }
    .login-card button {
      width: 100%;
      padding: 11px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      background: var(--color-link);
      color: #fff;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .login-card button:hover { background: var(--color-link-hover); }
    .login-hint {
      margin: 18px 0 0;
      font-size: 12px;
      color: var(--color-text-secondary);
      text-align: center;
      line-height: 1.5;
    }
    .login-hint code {
      font-size: 11px;
      padding: 1px 4px;
      border: 1px solid var(--color-border);
      border-radius: 4px;
      background: var(--color-bg-secondary, transparent);
    }
    .login-error {
      background: rgba(207, 34, 46, 0.1);
      border: 1px solid rgba(207, 34, 46, 0.25);
      color: var(--color-danger, #cf222e);
      font-size: 13px;
      text-align: center;
      padding: 9px 12px;
      border-radius: 8px;
      margin-bottom: 16px;
    }
`;
