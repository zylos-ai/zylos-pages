// Progressive controls for secure-handoff forms and reveal pages.
// Loaded as an external asset because the pages CSP is `script-src 'self'`
// (no inline scripts). Progressive enhancement only: the value is always
// Password fields remain masked and revealed values remain selectable if this
// script does not run.
(function () {
  'use strict';

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for insecure contexts / older browsers without the async API.
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy command was rejected'));
    });
  }

  function flash(btn) {
    btn.classList.add('copied');
    btn.setAttribute('aria-label', btn.getAttribute('data-copied-label') || 'Copied');
    if (btn._copyTimer) { window.clearTimeout(btn._copyTimer); }
    btn._copyTimer = window.setTimeout(function () {
      btn.classList.remove('copied');
      btn.setAttribute('aria-label', btn.getAttribute('data-copy-label') || 'Copy');
    }, 1600);
  }

  document.addEventListener('click', function (ev) {
    var toggle = ev.target && ev.target.closest ? ev.target.closest('.password-toggle') : null;
    if (toggle) {
      ev.preventDefault();
      var inputId = toggle.getAttribute('data-password-toggle');
      var input = inputId ? document.getElementById(inputId) : null;
      if (!input) return;
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      toggle.classList.toggle('revealed', reveal);
      var label = toggle.getAttribute(reveal ? 'data-hide-label' : 'data-show-label');
      toggle.setAttribute('aria-label', label || (reveal ? 'Hide value' : 'Show value'));
      toggle.setAttribute('title', label || (reveal ? 'Hide value' : 'Show value'));
      return;
    }
    var btn = ev.target && ev.target.closest ? ev.target.closest('.copy-btn') : null;
    if (!btn) return;
    ev.preventDefault();
    var targetId = btn.getAttribute('data-copy-target');
    var el = targetId ? document.getElementById(targetId) : null;
    if (!el) return;
    var text = el.value != null ? el.value : el.textContent;
    copyText(text).then(function () {
      flash(btn);
    }).catch(function () {
      // Last resort: select the text so the user can copy it manually.
      if (typeof el.focus === 'function') { el.focus(); }
      if (typeof el.select === 'function') { el.select(); }
    });
  });
})();
