// Click an image, inline SVG or Mermaid diagram to view it larger: wheel, pinch or the
// toolbar zooms, dragging pans. Markdown pages load this in the shell; HTML pages load it
// inside their sandboxed frame (data-root="body"), so the viewer never leaves the sandbox.
// The viewer only shows a copy of what is already on the page and never loads a new address.
(function () {
  if (window.PagesImageZoom) return;
  var script = document.currentScript;
  var ROOT = (script && script.getAttribute('data-root')) || '.markdown-body';
  var ID = 'pages-image-zoom';
  var MIN_SIZE = 48, MIN_SCALE = 0.1, MAX_SCALE = 10, STEP = 1.25;
  var overlay, stage, content, lastFocus, savedOverflow;
  var item = null, scale = 1, tx = 0, ty = 0;

  function root() { return document.querySelector(ROOT); }

  function style() {
    var node = document.createElement('style');
    node.textContent =
      '#' + ID + '{all:initial;position:fixed;inset:0;z-index:2147483645;display:none;flex-direction:column;' +
        'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}' +
      '#' + ID + '.pz-open{display:flex}' +
      '#' + ID + ' .pz-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.82)}' +
      '#' + ID + ' .pz-bar{position:relative;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px}' +
      '#' + ID + ' .pz-hint{color:rgba(255,255,255,.65);font-size:13px;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#' + ID + ' button{all:initial;box-sizing:border-box;min-width:36px;height:36px;padding:0 10px;border-radius:6px;' +
        'background:rgba(255,255,255,.16);color:#fff;font:15px/36px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'text-align:center;cursor:pointer}' +
      '#' + ID + ' button:hover{background:rgba(255,255,255,.28)}' +
      '#' + ID + ' button:focus-visible{outline:2px solid #93c5fd;outline-offset:1px}' +
      '#' + ID + ' .pz-stage{position:relative;z-index:1;flex:1;overflow:hidden;cursor:grab;touch-action:none}' +
      '#' + ID + ' .pz-stage.pz-dragging{cursor:grabbing}' +
      '#' + ID + ' .pz-content{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}' +
      '#' + ID + ' .pz-item{display:block;background:#fff;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,.35)}' +
      '#' + ID + ' svg.pz-item{padding:16px;box-sizing:content-box}' +
      '#' + ID + ' img.pz-item{max-width:none;max-height:none;-webkit-user-drag:none;user-select:none}' +
      (ROOT === 'body' ? '' :
        ROOT + ' :is(img,svg):not(:is(a,button) *),' + ROOT + ' .mermaid{cursor:zoom-in}');
    document.head.appendChild(node);
  }

  function button(label, title, action) {
    var node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.title = title; node.setAttribute('aria-label', title);
    node.addEventListener('click', function (event) { event.stopPropagation(); action(); });
    return node;
  }

  function build() {
    style();
    overlay = document.createElement('div');
    overlay.id = ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image viewer');
    var backdrop = document.createElement('div');
    backdrop.className = 'pz-backdrop';
    var bar = document.createElement('div');
    bar.className = 'pz-bar';
    var hint = document.createElement('span');
    hint.className = 'pz-hint';
    hint.textContent = 'Scroll or pinch to zoom, drag to pan';
    bar.append(hint,
      button('−', 'Zoom out', function () { zoomBy(1 / STEP); }),
      button('+', 'Zoom in', function () { zoomBy(STEP); }),
      button('1:1', 'Fit to screen', fit),
      button('×', 'Close (Esc)', close));
    stage = document.createElement('div');
    stage.className = 'pz-stage';
    content = document.createElement('div');
    content.className = 'pz-content';
    stage.appendChild(content);
    overlay.append(backdrop, bar, stage);
    document.body.appendChild(overlay);
    listen();
  }

  function apply() {
    content.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }

  // SVG elements have no offsetWidth; the on-screen box divided by the zoom works for both.
  function size() {
    var rect = item.getBoundingClientRect();
    return { width: rect.width / scale, height: rect.height / scale };
  }

  function fit() {
    if (!item) return;
    var box = stage.getBoundingClientRect(), s = size();
    if (!s.width || !s.height) return;
    // Raster images are not blown up past their own pixels; vector art may double.
    var limit = item.tagName.toLowerCase() === 'img' ? 1 : 2;
    scale = Math.max(Math.min((box.width - 32) / s.width, (box.height - 32) / s.height, limit), MIN_SCALE);
    tx = (box.width - s.width * scale) / 2;
    ty = (box.height - s.height * scale) / 2;
    apply();
  }

  function zoomAt(factor, x, y) {
    var next = Math.min(Math.max(scale * factor, MIN_SCALE), MAX_SCALE);
    tx = x - (x - tx) * (next / scale);
    ty = y - (y - ty) * (next / scale);
    scale = next;
    apply();
  }

  function zoomBy(factor) {
    var box = stage.getBoundingClientRect();
    zoomAt(factor, box.width / 2, box.height / 2);
  }

  function copyOf(node) {
    var rect = node.getBoundingClientRect(), copy;
    if (node.tagName.toLowerCase() === 'img') {
      copy = document.createElement('img');
      // The address the page already shows; no srcset, so the copy cannot pick another file.
      copy.src = node.currentSrc || node.src;
      copy.alt = node.alt || '';
      copy.draggable = false;
      var width = node.naturalWidth || rect.width, height = node.naturalHeight || rect.height;
      copy.width = Math.round(width); copy.height = Math.round(height);
    } else {
      // Keep the id: Mermaid and many pages style SVG through #id selectors. The viewer is
      // appended after the page, so getElementById still finds the original first.
      copy = node.cloneNode(true);
      copy.setAttribute('width', rect.width);
      copy.setAttribute('height', rect.height);
      copy.style.width = rect.width + 'px';
      copy.style.height = rect.height + 'px';
      copy.style.maxWidth = 'none';
    }
    copy.classList.add('pz-item');
    return copy;
  }

  function open(node) {
    if (!overlay) build();
    item = copyOf(node);
    content.replaceChildren(item);
    lastFocus = document.activeElement;
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlay.classList.add('pz-open');
    scale = 1; tx = 0; ty = 0;
    apply();
    overlay.querySelector('button[aria-label^="Close"]').focus({ preventScroll: true });
    requestAnimationFrame(fit);
    if (item.tagName.toLowerCase() === 'img' && !item.complete) item.addEventListener('load', fit, { once: true });
  }

  function close() {
    if (!overlay || !overlay.classList.contains('pz-open')) return;
    overlay.classList.remove('pz-open');
    content.replaceChildren();
    item = null;
    document.body.style.overflow = savedOverflow;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  // The element to show for a click on `target`, or null when the click is not ours.
  function zoomable(target) {
    var area = root();
    if (!area || !target || target.nodeType !== 1 || !area.contains(target)) return null;
    if (target.closest('#' + ID + ',#pages-annotations,[data-pages-annotations]')) return null;
    var node = null, diagram = ROOT === 'body' ? null : target.closest('.mermaid');
    if (diagram && area.contains(diagram)) node = diagram.querySelector('svg');
    if (!node) {
      for (var part = target.closest('svg'); part && area.contains(part); part = part.parentElement.closest('svg')) {
        node = part;
        if (!part.parentElement) break;
      }
    }
    if (!node && target.tagName.toLowerCase() === 'img') node = target;
    if (!node) return null;
    // Links, buttons and anything the page made clickable keep their own behaviour.
    if (node.closest('a[href],button,[role="button"],[role="link"],label,summary')) return null;
    if (window.getComputedStyle(target).cursor === 'pointer') return null;
    if (node.tagName.toLowerCase() === 'img' && !(node.complete && node.naturalWidth)) return null;
    var rect = node.getBoundingClientRect();
    if (Math.max(rect.width, rect.height) < MIN_SIZE) return null;
    return node;
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (document.documentElement.hasAttribute('data-pages-picking')) return;
    if (overlay && overlay.classList.contains('pz-open')) return;
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    var node = zoomable(event.target);
    if (!node) return;
    event.preventDefault();
    open(node);
  });

  function listen() {
    var drag = null, moved = false, pinch = null;
    document.addEventListener('keydown', function (event) {
      if (!overlay.classList.contains('pz-open')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }, true);
    stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      var box = stage.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - box.left, event.clientY - box.top);
    }, { passive: false });
    stage.addEventListener('pointerdown', function (event) {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, tx: tx, ty: ty };
      moved = false;
      stage.classList.add('pz-dragging');
      event.preventDefault();
    });
    document.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerType !== 'mouse') return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) moved = true;
      tx = drag.tx + event.clientX - drag.x;
      ty = drag.ty + event.clientY - drag.y;
      apply();
    });
    document.addEventListener('pointerup', function (event) {
      if (!drag || event.pointerType !== 'mouse') return;
      drag = null;
      stage.classList.remove('pz-dragging');
    });
    // A plain click on the dark area (not the image, not the end of a drag) closes the viewer.
    stage.addEventListener('click', function (event) {
      if (!moved && item && !item.contains(event.target)) close();
      moved = false;
    });
    function center(touches) {
      var box = stage.getBoundingClientRect();
      return { x: (touches[0].clientX + touches[1].clientX) / 2 - box.left, y: (touches[0].clientY + touches[1].clientY) / 2 - box.top };
    }
    function distance(touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }
    stage.addEventListener('touchstart', function (event) {
      if (event.touches.length === 1) {
        drag = { x: event.touches[0].clientX, y: event.touches[0].clientY, tx: tx, ty: ty, touch: true };
        moved = false; pinch = null;
      } else if (event.touches.length === 2) {
        drag = null; moved = true;
        pinch = { distance: distance(event.touches) };
      }
    }, { passive: true });
    stage.addEventListener('touchmove', function (event) {
      event.preventDefault();
      if (event.touches.length === 1 && drag && drag.touch) {
        if (Math.hypot(event.touches[0].clientX - drag.x, event.touches[0].clientY - drag.y) > 4) moved = true;
        tx = drag.tx + event.touches[0].clientX - drag.x;
        ty = drag.ty + event.touches[0].clientY - drag.y;
        apply();
      } else if (event.touches.length === 2 && pinch) {
        var now = distance(event.touches), at = center(event.touches);
        if (pinch.distance) zoomAt(now / pinch.distance, at.x, at.y);
        pinch.distance = now;
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (event) {
      if (!event.touches.length) { drag = null; pinch = null; }
    }, { passive: true });
  }

  // Marks the viewer as loaded so a second copy of the script does nothing.
  window.PagesImageZoom = Object.freeze({});
})();
