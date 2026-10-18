// Share modal frontend logic
// Handles: open/close modal, create share link, copy link, list/revoke shares

(function () {
  'use strict';

  // Don't init for share viewers
  if (document.documentElement.dataset.viewer === 'share') return;

  var shareBtn = document.querySelector('.share-btn');
  var modal = document.getElementById('share-modal');
  if (!shareBtn || !modal) return;

  var slug = shareBtn.dataset.slug;
  var baseUrl = shareBtn.dataset.baseUrl;
  var backdrop = modal.querySelector('.share-modal-backdrop');
  var closeBtn = modal.querySelector('.share-modal-close');
  var generateBtn = modal.querySelector('.share-generate-btn');
  var listItems = modal.querySelector('.share-list-items');
  var editableInput = modal.querySelector('.share-editable-input');
  var passwordInput = modal.querySelector('.share-password-input');
  var passwordOptions = modal.querySelector('.share-password-create-options');
  var providedPasswordInput = modal.querySelector('.share-provided-password');
  var createdPassword = modal.querySelector('.share-created-password');
  var createdPasswordCode = createdPassword.querySelector('code');
  var createdPasswordReveal = modal.querySelector('.share-created-password-reveal');
  var createdPasswordCopy = modal.querySelector('.share-created-password-copy');
  var warning = modal.querySelector('.share-security-warning');
  var revealedPasswords = Object.create(null);
  var lastCreatedPassword = '';
  var lastCreatedTokenId = '';
  var hasUnprotectedShares = false;
  var hasProtectedShares = false;
  var lastLoadedShares = [];
  var maskedPassword = '••••••••••••••••••••••';

  function escapeAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function copyText(text, button, resetText) {
    var originalText = resetText || button.textContent;

    function markCopied() {
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = originalText; }, 2000);
    }

    function fallbackCopy() {
      var input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      try {
        input.select();
        if (!document.execCommand('copy')) throw new Error('Copy rejected');
        markCopied();
      } catch (error) {
        button.textContent = 'Copy failed';
        var row = button.closest('.share-item');
        var selectable = row && row.querySelector('.share-link-input');
        if (button.classList.contains('share-item-copy-btn') && selectable) {
          selectable.focus();
          selectable.select();
        } else {
          var secret = button.closest('.share-password-secret');
          if (secret) {
            var code = secret.querySelector('code');
            code.textContent = text;
            var reveal = secret.querySelector('.share-created-password-reveal, .share-password-reveal-btn');
            if (reveal) reveal.textContent = 'Hide';
            if (row) revealedPasswords[button.dataset.tokenId] = text;
            var range = document.createRange();
            range.selectNodeContents(code);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
          }
        }
        setTimeout(function () { button.textContent = originalText; }, 2000);
      } finally {
        document.body.removeChild(input);
      }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function requestJson(path, options) {
    return fetch(baseUrl + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  function passwordRequest(tokenId, action, method) {
    var suffix = action ? '/' + action : '';
    return requestJson('/api/share/' + encodeURIComponent(tokenId) + '/password' + suffix, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify({ mode: 'generated' }),
    });
  }

  function revealPassword(tokenId) {
    return passwordRequest(tokenId, 'reveal').then(function (data) {
      return data.protection.password;
    });
  }

  // Open modal
  shareBtn.addEventListener('click', function () {
    modal.hidden = false;
    loadShares();
  });

  // Close modal
  function clearCreatedShare() {
    lastCreatedPassword = '';
    lastCreatedTokenId = '';
    createdPassword.hidden = true;
    createdPasswordCode.textContent = maskedPassword;
  }
  function closeModal() {
    modal.hidden = true;
    clearCreatedShare();
    revealedPasswords = Object.create(null);
    lastLoadedShares = [];
    providedPasswordInput.value = '';
  }
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  passwordInput.addEventListener('change', function () {
    passwordOptions.hidden = !passwordInput.checked;
    updateWarning();
  });

  function updateWarning() {
    warning.hidden = !hasUnprotectedShares || !(passwordInput.checked || hasProtectedShares);
  }
  passwordOptions.querySelectorAll('input[name="share-password-mode"]').forEach(function (input) {
    input.addEventListener('change', function () {
      providedPasswordInput.hidden = input.value !== 'provided' || !input.checked;
      if (providedPasswordInput.hidden) providedPasswordInput.value = '';
    });
  });

  // Generate share link
  generateBtn.addEventListener('click', function () {
    var duration = document.querySelector('input[name="share-duration"]:checked');
    if (!duration) return;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';

    var mode = modal.querySelector('input[name="share-password-mode"]:checked');
    var protection = { type: 'none' };
    if (passwordInput.checked) {
      protection = {
        type: 'password',
        mode: mode ? mode.value : 'generated',
      };
      if (protection.mode === 'provided') protection.password = providedPasswordInput.value;
    }

    requestJson('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: slug,
        duration: duration.value,
        canWriteAttachments: editableInput ? editableInput.checked === true : false,
        protection: protection,
      }),
    })
      .then(function (data) {
        lastCreatedTokenId = data.tokenId;
        providedPasswordInput.value = '';
        lastCreatedPassword = data.protection && data.protection.password ? data.protection.password : '';
        createdPassword.hidden = !lastCreatedPassword;
        createdPasswordCode.textContent = maskedPassword;
        createdPasswordReveal.textContent = 'Reveal';
        // Keep the newly created link usable if the list refresh fails.
        loadShares({ tokenId: data.tokenId, shortUrl: data.shortUrl || data.url,
          createdAt: Date.now(), expiresAt: data.expiresAt,
          canWriteAttachments: data.canWriteAttachments,
          protection: { type: protection.type } });
      })
      .catch(function (error) { alert(error.message || 'Network error'); })
      .finally(function () {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Link';
      });
  });

  createdPasswordReveal.addEventListener('click', function () {
    var visible = createdPasswordCode.textContent !== maskedPassword;
    createdPasswordCode.textContent = visible ? maskedPassword : lastCreatedPassword;
    createdPasswordReveal.textContent = visible ? 'Reveal' : 'Hide';
  });
  createdPasswordCopy.addEventListener('click', function () {
    copyText(lastCreatedPassword, createdPasswordCopy, 'Copy password');
  });

  // Load active shares for this slug
  function loadShares(createdShare) {
    return requestJson('/api/shares/' + encodeURIComponent(slug))
      .then(function (data) {
        if (!Array.isArray(data.shares)) throw new Error('Invalid shares');
        lastLoadedShares = data.shares;
        renderShares(data.shares);
      })
      .catch(function () {
        var known = lastLoadedShares.slice();
        if (createdShare && !known.some(function (share) { return share.tokenId === createdShare.tokenId; })) {
          known.push(createdShare);
        }
        lastLoadedShares = known;
        renderShares(known, true);
      });
  }

  function renderShares(shares, failed) {
    hasUnprotectedShares = shares.some(function (share) {
      return !share.protection || share.protection.type !== 'password';
    });
    hasProtectedShares = shares.some(function (share) {
      return share.protection && share.protection.type === 'password';
    });
    updateWarning();
    var html = failed ? '<p class="share-empty" role="status">Failed to refresh shares. Reopen to retry.</p>' : '';
    if (shares.length === 0) {
      if (failed) { listItems.innerHTML = html; return; }
      listItems.innerHTML = '<p class="share-empty">No active shares</p>';
      return;
    }
    shares = shares.slice().sort(function (a, b) {
      return Number(b.tokenId === lastCreatedTokenId) - Number(a.tokenId === lastCreatedTokenId);
    });
    for (var i = 0; i < shares.length; i++) {
      var s = shares[i];
      var isNew = s.tokenId === lastCreatedTokenId;
      var expires = s.expiresAt === 0 ? 'Never' : new Date(s.expiresAt).toLocaleString();
      var created = new Date(s.createdAt).toLocaleString();
      html += '<div class="share-item' + (isNew ? ' is-new' : '') + '">';
      html += '<div class="share-item-info">';
      if (isNew) html += '<span class="share-item-new" role="status">New link</span>';
      html += '<input type="text" class="share-link-input" aria-label="Share link" value="' + escapeAttr(s.shortUrl) + '" readonly>';
      html += '<span class="share-item-created">Created: ' + created + '</span>';
      html += '<span class="share-item-expires">Expires: ' + expires + '</span>';
      var protectedShare = s.protection && s.protection.type === 'password';
      html += '<span class="share-protection-label ' + (protectedShare ? 'is-protected' : 'is-unprotected') + '">' + (protectedShare ? 'Protected' : 'Unprotected') + '</span>';
      if (protectedShare) {
        var visiblePassword = revealedPasswords[s.tokenId] || '';
        html += '<div class="share-password-secret" data-password-row="' + escapeAttr(s.tokenId) + '">';
        html += '<code>' + (visiblePassword ? escapeAttr(visiblePassword) : maskedPassword) + '</code>';
        html += '<button class="share-copy-btn share-password-reveal-btn" data-token-id="' + s.tokenId + '">' + (visiblePassword ? 'Hide' : 'Reveal') + '</button>';
        html += '<button class="share-copy-btn share-password-copy-btn" data-token-id="' + s.tokenId + '">Copy password</button>';
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="share-item-actions">';
      html += '<label class="share-item-permission">';
      html += '<input type="checkbox" class="share-permission-toggle" data-token-id="' + s.tokenId + '"' + (s.canWriteAttachments ? ' checked' : '') + '>';
      html += '<span>Allow photo upload/delete</span>';
      html += '</label>';
      html += '<button class="share-copy-btn share-item-copy-btn" data-short-url="' + escapeAttr(s.shortUrl) + '">Copy link</button>';
      if (protectedShare) {
        html += '<button class="share-copy-btn share-password-rotate-btn" data-token-id="' + s.tokenId + '">Rotate password</button>';
        html += '<button class="share-revoke-btn share-password-remove-btn" data-token-id="' + s.tokenId + '">Remove password</button>';
      } else {
        html += '<button class="share-copy-btn share-password-enable-btn" data-token-id="' + s.tokenId + '">Add password</button>';
      }
      html += '<button class="share-revoke-btn share-revoke-link-btn" data-token-id="' + s.tokenId + '">Revoke</button>';
      html += '</div>';
      html += '</div>';
    }
    if (!failed) html += '<button class="share-revoke-all-btn">Revoke All</button>';
    listItems.innerHTML = html;

    // Bind permission toggles
    listItems.querySelectorAll('.share-permission-toggle').forEach(function (input) {
      input.addEventListener('change', function () {
        updateSharePermission(input, input.checked);
      });
    });

    // Bind copy buttons
    listItems.querySelectorAll('.share-item-copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        copyText(btn.dataset.shortUrl, btn, 'Copy link');
      });
    });

    listItems.querySelectorAll('.share-password-reveal-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tokenId = btn.dataset.tokenId;
        if (revealedPasswords[tokenId]) {
          delete revealedPasswords[tokenId];
          loadShares();
          return;
        }
        btn.disabled = true;
        revealPassword(tokenId).then(function (password) {
          revealedPasswords[tokenId] = password;
          loadShares();
        }).catch(function (error) { alert(error.message); });
      });
    });

    listItems.querySelectorAll('.share-password-copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tokenId = btn.dataset.tokenId;
        btn.disabled = true;
        revealPassword(tokenId).then(function (password) {
          copyText(password, btn, 'Copy password');
          btn.disabled = false;
        }).catch(function (error) { btn.disabled = false; alert(error.message); });
      });
    });

    listItems.querySelectorAll('.share-password-enable-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { changePassword(btn.dataset.tokenId, 'enable'); });
    });
    listItems.querySelectorAll('.share-password-rotate-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (confirm('Rotate this password? Existing unlock sessions and protected asset links will stop working.')) {
          changePassword(btn.dataset.tokenId, 'rotate');
        }
      });
    });
    listItems.querySelectorAll('.share-password-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (confirm('Remove password protection? Anyone with this share link will be able to open it.')) {
          removePassword(btn.dataset.tokenId);
        }
      });
    });

    // Bind revoke buttons
    listItems.querySelectorAll('.share-revoke-link-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        revokeShare(btn.dataset.tokenId);
      });
    });
    var revokeAllBtn = listItems.querySelector('.share-revoke-all-btn');
    if (revokeAllBtn) {
      revokeAllBtn.addEventListener('click', function () {
        revokeAllShares();
      });
    }
  }

  function changePassword(tokenId, action) {
    passwordRequest(tokenId, action).then(function () {
      delete revealedPasswords[tokenId];
      if (tokenId === lastCreatedTokenId) clearCreatedShare();
      lastLoadedShares = lastLoadedShares.map(function (share) {
        if (share.tokenId === tokenId) share.protection = { type: 'password' };
        return share;
      });
      loadShares();
    }).catch(function (error) { alert(error.message); });
  }

  function removePassword(tokenId) {
    passwordRequest(tokenId, '', 'DELETE').then(function () {
      delete revealedPasswords[tokenId];
      if (tokenId === lastCreatedTokenId) clearCreatedShare();
      lastLoadedShares = lastLoadedShares.map(function (share) {
        if (share.tokenId === tokenId) share.protection = { type: 'none' };
        return share;
      });
      loadShares();
    }).catch(function (error) { alert(error.message); });
  }

  // Update attachment write permission for an existing share
  function updateSharePermission(input, canWriteAttachments) {
    var previous = !canWriteAttachments;
    input.disabled = true;

    fetch(baseUrl + '/api/share/' + input.dataset.tokenId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canWriteAttachments: canWriteAttachments }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          lastLoadedShares.forEach(function (share) {
            if (share.tokenId === input.dataset.tokenId) share.canWriteAttachments = canWriteAttachments;
          });
          loadShares();
        } else {
          input.checked = previous;
          input.disabled = false;
          loadShares();
          alert(data.error || 'Failed to update share');
        }
      })
      .catch(function () {
        input.checked = previous;
        input.disabled = false;
        loadShares();
        alert('Network error');
      });
  }

  // Revoke a single share
  function revokeShare(tokenId) {
    fetch(baseUrl + '/api/share/' + tokenId, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          lastLoadedShares = lastLoadedShares.filter(function (share) { return share.tokenId !== tokenId; });
          delete revealedPasswords[tokenId];
          if (tokenId === lastCreatedTokenId) clearCreatedShare();
          loadShares();
        } else {
          alert(data.error || 'Failed to revoke share');
        }
      })
      .catch(function () { alert('Network error'); });
  }

  // Revoke all shares for this slug
  function revokeAllShares() {
    fetch(baseUrl + '/api/shares/' + encodeURIComponent(slug), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          lastLoadedShares = [];
          clearCreatedShare();
          revealedPasswords = Object.create(null);
          loadShares();
        } else {
          alert(data.error || 'Failed to revoke shares');
        }
      })
      .catch(function () { alert('Network error'); });
  }
})();
