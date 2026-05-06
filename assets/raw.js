// Copy raw Markdown frontend logic

(function () {
  'use strict';

  if (document.documentElement.dataset.viewer === 'share') return;

  var copyBtn = document.querySelector('.copy-raw-btn');
  if (!copyBtn) return;

  var defaultText = copyBtn.textContent.trim() || 'Copy Markdown';
  var slug = copyBtn.dataset.slug || '';
  var baseUrl = copyBtn.dataset.baseUrl || '';
  var label = copyBtn.querySelector('.copy-raw-label');

  function setButtonText(text) {
    copyBtn.setAttribute('aria-label', text === defaultText ? 'Copy raw Markdown' : text);
    if (label) {
      label.textContent = text;
      return;
    }
    copyBtn.appendChild(document.createTextNode(' ' + text));
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();

      try {
        var copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        copied ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        document.body.removeChild(textarea);
        reject(err);
      }
    });
  }

  function resetButton() {
    copyBtn.disabled = false;
    setButtonText(defaultText);
  }

  copyBtn.addEventListener('click', function () {
    copyBtn.disabled = true;
    setButtonText('Copying...');

    fetch(baseUrl + '/api/raw/' + encodeURIComponent(slug), {
      headers: { Accept: 'text/plain' },
    })
      .then(function (res) {
        if (!res.ok) throw new Error('raw fetch failed');
        return res.text();
      })
      .then(copyText)
      .then(function () {
        setButtonText('Copied');
        setTimeout(resetButton, 2000);
      })
      .catch(function () {
        setButtonText('Failed');
        setTimeout(resetButton, 2000);
      });
  });
})();
