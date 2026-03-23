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
  var resultDiv = modal.querySelector('.share-result');
  var linkInput = modal.querySelector('.share-link-input');
  var copyBtn = modal.querySelector('.share-copy-btn');
  var listItems = modal.querySelector('.share-list-items');

  // Open modal
  shareBtn.addEventListener('click', function () {
    modal.hidden = false;
    resultDiv.hidden = true;
    loadShares();
  });

  // Close modal
  function closeModal() {
    modal.hidden = true;
  }
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // Generate share link
  generateBtn.addEventListener('click', function () {
    var duration = document.querySelector('input[name="share-duration"]:checked');
    if (!duration) return;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';

    fetch(baseUrl + '/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug, duration: duration.value }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          linkInput.value = data.url;
          resultDiv.hidden = false;
          loadShares();
        } else {
          alert(data.error || 'Failed to create share');
        }
      })
      .catch(function () {
        alert('Network error');
      })
      .finally(function () {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Link';
      });
  });

  // Copy link
  copyBtn.addEventListener('click', function () {
    linkInput.select();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(linkInput.value).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
      });
    } else {
      document.execCommand('copy');
      copyBtn.textContent = 'Copied!';
      setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
    }
  });

  // Load active shares for this slug
  function loadShares() {
    fetch(baseUrl + '/api/shares/' + encodeURIComponent(slug))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.shares) {
          listItems.innerHTML = '<p class="share-empty">Failed to load shares</p>';
          return;
        }
        if (data.shares.length === 0) {
          listItems.innerHTML = '<p class="share-empty">No active shares</p>';
          return;
        }
        var html = '';
        for (var i = 0; i < data.shares.length; i++) {
          var s = data.shares[i];
          var expires = s.expiresAt === 0 ? 'Never' : new Date(s.expiresAt).toLocaleString();
          var created = new Date(s.createdAt).toLocaleString();
          html += '<div class="share-item">';
          html += '<div class="share-item-info">';
          html += '<span class="share-item-created">Created: ' + created + '</span>';
          html += '<span class="share-item-expires">Expires: ' + expires + '</span>';
          html += '</div>';
          html += '<button class="share-revoke-btn" data-token-id="' + s.tokenId + '">Revoke</button>';
          html += '</div>';
        }
        html += '<button class="share-revoke-all-btn">Revoke All</button>';
        listItems.innerHTML = html;

        // Bind revoke buttons
        listItems.querySelectorAll('.share-revoke-btn').forEach(function (btn) {
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
      })
      .catch(function () {
        listItems.innerHTML = '<p class="share-empty">Failed to load shares</p>';
      });
  }

  // Revoke a single share
  function revokeShare(tokenId) {
    fetch(baseUrl + '/api/share/' + tokenId, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
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
          loadShares();
          resultDiv.hidden = true;
        } else {
          alert(data.error || 'Failed to revoke shares');
        }
      })
      .catch(function () { alert('Network error'); });
  }
})();
