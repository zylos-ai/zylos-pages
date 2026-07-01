// Code block copy controls.

(function () {
  'use strict';

  var buttons = document.querySelectorAll('.code-copy-btn');
  if (!buttons.length) return;

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

  buttons.forEach(function (button) {
    var defaultText = button.textContent;
    var resetTimer = null;

    button.addEventListener('click', function () {
      var block = button.closest('.code-block');
      var code = block && block.querySelector('pre code');
      if (!code) return;

      button.disabled = true;
      button.textContent = 'Copying...';

      copyText(code.textContent)
        .then(function () {
          button.textContent = 'Copied';
          button.classList.add('is-copied');
        })
        .catch(function () {
          button.textContent = 'Failed';
        })
        .finally(function () {
          clearTimeout(resetTimer);
          resetTimer = setTimeout(function () {
            button.disabled = false;
            button.textContent = defaultText;
            button.classList.remove('is-copied');
          }, 1600);
        });
    });
  });
})();
