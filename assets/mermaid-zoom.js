(function () {
  var OVERLAY_ID = 'mermaid-zoom-overlay';

  function createOverlay() {
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML =
      '<div class="mz-backdrop"></div>' +
      '<div class="mz-toolbar">' +
        '<span class="mz-hint">Scroll to zoom / Drag to pan</span>' +
        '<button class="mz-btn mz-reset" title="Reset zoom">1:1</button>' +
        '<button class="mz-btn mz-close" title="Close (Esc)">&times;</button>' +
      '</div>' +
      '<div class="mz-container"><div class="mz-content"></div></div>';

    var style = document.createElement('style');
    style.textContent =
      '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:10000;display:none}' +
      '#' + OVERLAY_ID + '.active{display:flex;flex-direction:column}' +
      '.mz-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.8)}' +
      '.mz-toolbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:flex-end;padding:12px 16px;gap:12px}' +
      '.mz-hint{color:rgba(255,255,255,.6);font-size:13px;margin-right:auto}' +
      '.mz-btn{background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:14px;cursor:pointer;transition:background .15s}' +
      '.mz-btn:hover{background:rgba(255,255,255,.25)}' +
      '.mz-close{font-size:22px;padding:4px 12px;line-height:1}' +
      '.mz-container{position:relative;z-index:1;flex:1;overflow:hidden;cursor:grab}' +
      '.mz-container.dragging{cursor:grabbing}' +
      '.mz-content{transform-origin:0 0;will-change:transform}' +
      '.mz-content .mz-svg-wrap{background:#fff;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.3);display:inline-block;padding:20px}' +
      '.mz-content svg{display:block;max-width:none!important;height:auto!important}' +
      '.markdown-body .mermaid{cursor:zoom-in;position:relative;transition:box-shadow .2s}' +
      '.markdown-body .mermaid:hover{box-shadow:0 0 0 2px var(--color-link,#2563eb)}';

    document.head.appendChild(style);
    document.body.appendChild(overlay);
    return overlay;
  }

  function init() {
    var overlay = document.getElementById(OVERLAY_ID) || createOverlay();
    var container = overlay.querySelector('.mz-container');
    var content = overlay.querySelector('.mz-content');
    var closeBtn = overlay.querySelector('.mz-close');
    var resetBtn = overlay.querySelector('.mz-reset');

    var scale = 1, tx = 0, ty = 0;
    var dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

    function applyTransform() {
      content.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }

    function centerAndFit() {
      var cr = container.getBoundingClientRect();
      var wrap = content.querySelector('.mz-svg-wrap');
      if (!wrap) return;
      var natW = wrap.offsetWidth;
      var natH = wrap.offsetHeight;
      var fitScale = Math.min((cr.width - 60) / natW, (cr.height - 60) / natH, 2);
      scale = Math.max(fitScale, 0.1);
      tx = (cr.width - natW * scale) / 2;
      ty = (cr.height - natH * scale) / 2;
      applyTransform();
    }

    function open(mermaidEl) {
      var svg = mermaidEl.querySelector('svg');
      if (!svg) return;

      var clone = svg.cloneNode(true);
      var rect = svg.getBoundingClientRect();
      clone.setAttribute('width', rect.width);
      clone.setAttribute('height', rect.height);
      clone.style.width = rect.width + 'px';
      clone.style.height = rect.height + 'px';
      clone.style.maxWidth = 'none';

      var wrap = document.createElement('div');
      wrap.className = 'mz-svg-wrap';
      wrap.appendChild(clone);

      content.innerHTML = '';
      content.appendChild(wrap);

      scale = 1; tx = 0; ty = 0;
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';

      requestAnimationFrame(function () {
        centerAndFit();
      });
    }

    function close() {
      overlay.classList.remove('active');
      document.body.style.overflow = '';
      content.innerHTML = '';
    }

    closeBtn.addEventListener('click', close);
    resetBtn.addEventListener('click', centerAndFit);
    overlay.querySelector('.mz-backdrop').addEventListener('click', close);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('active')) {
        close();
      }
    });

    container.addEventListener('wheel', function (e) {
      if (!overlay.classList.contains('active')) return;
      e.preventDefault();
      var rect = container.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;

      var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      var newScale = Math.min(Math.max(scale * factor, 0.1), 10);

      tx = mx - (mx - tx) * (newScale / scale);
      ty = my - (my - ty) * (newScale / scale);
      scale = newScale;
      applyTransform();
    }, { passive: false });

    container.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startTx = tx; startTy = ty;
      container.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      tx = startTx + (e.clientX - startX);
      ty = startTy + (e.clientY - startY);
      applyTransform();
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      container.classList.remove('dragging');
    });

    var lastTouchDist = 0, lastTouchCenter = null;
    container.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        dragging = true;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startTx = tx; startTy = ty;
      } else if (e.touches.length === 2) {
        dragging = false;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.sqrt(dx * dx + dy * dy);
        lastTouchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
      }
    }, { passive: true });

    container.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        tx = startTx + (e.touches[0].clientX - startX);
        ty = startTy + (e.touches[0].clientY - startY);
        applyTransform();
      } else if (e.touches.length === 2 && lastTouchCenter) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var factor = dist / lastTouchDist;
        var rect = container.getBoundingClientRect();
        var cx = lastTouchCenter.x - rect.left;
        var cy = lastTouchCenter.y - rect.top;
        var newScale = Math.min(Math.max(scale * factor, 0.1), 10);
        tx = cx - (cx - tx) * (newScale / scale);
        ty = cy - (cy - ty) * (newScale / scale);
        scale = newScale;
        lastTouchDist = dist;
        lastTouchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2
        };
        applyTransform();
      }
    }, { passive: false });

    container.addEventListener('touchend', function () {
      dragging = false;
      lastTouchDist = 0;
      lastTouchCenter = null;
    }, { passive: true });

    document.querySelectorAll('.markdown-body .mermaid').forEach(function (el) {
      if (el.querySelector('svg')) {
        el.addEventListener('click', function () { open(el); });
      }
    });
  }

  if (typeof mermaid !== 'undefined') {
    var origRun = mermaid.run;
    mermaid.run = function () {
      var result = origRun.apply(this, arguments);
      if (result && typeof result.then === 'function') {
        result.then(function () { setTimeout(init, 100); });
      } else {
        setTimeout(init, 100);
      }
      return result;
    };
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 500); });
  }
})();
