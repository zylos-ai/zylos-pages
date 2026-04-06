// Todo board frontend interactions
// Handles: complete, reopen, delete, add item

(function () {
  'use strict';

  // Don't init for share viewers
  if (document.documentElement.dataset.viewer === 'share') return;

  var board = document.querySelector('.todo-board');
  if (!board) return;

  var boardName = board.dataset.board;
  var baseUrl = board.dataset.baseUrl;
  var apiBase = baseUrl + '/api/todo/' + encodeURIComponent(boardName);

  // --- Complete / Reopen / Delete via event delegation ---

  board.addEventListener('click', function (e) {
    var btn = e.target.closest('.todo-action-btn');
    if (!btn) return;

    var itemId = btn.dataset.id;
    if (!itemId) return;

    if (btn.classList.contains('todo-complete-btn')) {
      patchStatus(itemId, 'completed');
    } else if (btn.classList.contains('todo-reopen-btn')) {
      patchStatus(itemId, 'active');
    } else if (btn.classList.contains('todo-delete-btn')) {
      if (confirm('Delete this item?')) {
        deleteItem(itemId);
      }
    }
  });

  function patchStatus(itemId, status) {
    fetch(apiBase + '/' + itemId, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          location.reload();
        } else {
          alert(data.error || 'Failed to update item');
        }
      })
      .catch(function () {
        alert('Network error');
      });
  }

  function deleteItem(itemId) {
    fetch(apiBase + '/' + itemId, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          // Remove the card from DOM without full reload
          var card = board.querySelector('.todo-card[data-id="' + itemId + '"]');
          if (card) {
            var column = card.closest('.todo-column');
            card.remove();
            // Update count
            if (column) {
              var cards = column.querySelectorAll('.todo-card');
              var count = column.querySelector('.todo-count');
              if (count) count.textContent = cards.length;
              // Show empty state if needed
              var cardsContainer = column.querySelector('.todo-cards');
              if (cards.length === 0 && cardsContainer) {
                cardsContainer.innerHTML = '<div class="todo-empty">No items</div>';
              }
            }
          }
        } else {
          alert(data.error || 'Failed to delete item');
        }
      })
      .catch(function () {
        alert('Network error');
      });
  }

  // --- Add Item Modal ---

  var addBtn = document.querySelector('.todo-add-btn');
  var modal = document.getElementById('todo-add-modal');

  if (addBtn && modal) {
    var backdrop = modal.querySelector('.todo-modal-backdrop');
    var closeBtn = modal.querySelector('.todo-modal-close');
    var submitBtn = modal.querySelector('.todo-submit-btn');
    var titleInput = document.getElementById('todo-add-title');
    var sourceInput = document.getElementById('todo-add-source');
    var contentInput = document.getElementById('todo-add-content');
    var linkInput = document.getElementById('todo-add-link');

    addBtn.addEventListener('click', function () {
      modal.hidden = false;
      titleInput.value = '';
      sourceInput.value = '';
      contentInput.value = '';
      linkInput.value = '';
      titleInput.focus();
    });

    function closeModal() {
      modal.hidden = true;
    }

    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });

    submitBtn.addEventListener('click', function () {
      var title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return;
      }

      var metadata = {};
      var source = sourceInput.value.trim();
      var content = contentInput.value.trim();
      var link = linkInput.value.trim();
      if (source) metadata.source = source;
      if (content) metadata.content = content;
      if (link) metadata.link = link;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding...';

      fetch(apiBase, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, metadata: metadata }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            closeModal();
            location.reload();
          } else {
            alert(data.error || 'Failed to add item');
          }
        })
        .catch(function () {
          alert('Network error');
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
        });
    });

    // Submit on Enter in title field
    titleInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitBtn.click();
      }
    });
  }
})();
