(() => {
  'use strict';
  const core = window.PagesAnnotationsCore;
  if (!core || window.parent === window) return;
  const highlightName = 'pages-annotations';
  let port = null;
  let generation = null;
  let index = null;
  let entries = [];
  let ranges = new Map();
  let activeRange = null;
  let selectionId = 0;
  let reportedSelection = null;
  let selectionTimer = null;
  let refreshTimer = null;
  let overlay = null;
  let disposed = false;
  let messageWindow = 0;
  let messageCount = 0;
  const style = document.createElement('style');
  style.dataset.pagesAnnotations = '';
  style.textContent = '::highlight(pages-annotations){background-color:rgba(255,210,56,.34);color:inherit}';
  (document.head || document.documentElement).appendChild(style);

  function send(type, payload = {}) {
    if (!port || disposed) return;
    try { port.postMessage({ type, version: 1, generation, ...payload }); } catch {}
  }
  function rangePosition(range) {
    const rect = range.getBoundingClientRect();
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: window.innerWidth, height: window.innerHeight } };
  }

  function currentIndex() {
    if (!index) index = core.buildTextIndex(document.body);
    return index;
  }

  function clearPaint() {
    window.CSS?.highlights?.delete(highlightName);
    overlay?.remove();
    overlay = null;
  }

  function paint() {
    clearPaint();
    if (!ranges.size) return;
    if (window.CSS?.highlights && typeof window.Highlight === 'function') {
      window.CSS.highlights.set(highlightName, new window.Highlight(...ranges.values()));
      return;
    }
    // A detached visual layer preserves the artifact's DOM text and Range offsets.
    overlay = document.createElement('div');
    overlay.dataset.pagesAnnotations = '';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden;';
    let count = 0;
    for (const range of ranges.values()) {
      for (const rect of range.getClientRects()) {
        if (++count > 1000) break;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
        const mark = document.createElement('div');
        mark.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(255,210,56,.28);`;
        overlay.appendChild(mark);
      }
      if (count > 1000) break;
    }
    document.documentElement.appendChild(overlay);
  }

  function refreshAnchors() {
    refreshTimer = null;
    if (!port || disposed) return;
    const locations = [];
    ranges = new Map();
    try {
      const textIndex = currentIndex();
      for (const entry of entries) {
        const range = core.rangeForAnchor(textIndex, entry.anchor);
        if (range) ranges.set(entry.id, range);
        locations.push({ id: entry.id, status: range ? 'matched' : 'unmatched' });
      }
      paint();
      send('locations', { items: locations });
    } catch {
      clearPaint();
      ranges.clear();
      send('locations', { items: entries.map(entry => ({ id: entry.id, status: 'unmatched' })) });
    }
  }

  function queueRefresh() {
    if (!refreshTimer) refreshTimer = setTimeout(refreshAnchors, 150);
  }

  function reportSelection() {
    selectionTimer = null;
    if (!port || disposed || !document.body) return;
    try {
      const selection = window.getSelection();
      const anchor = core.selectionAnchor(currentIndex(), selection);
      if (!anchor || selection.rangeCount !== 1) {
        send('selection-clear');
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height <= 0) return;
      activeRange = selection.getRangeAt(0).cloneRange();
      reportedSelection = activeRange.cloneRange();
      send('selection', {
        selectionId: ++selectionId,
        anchor,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
    } catch { send('selection-clear'); }
  }

  function queueSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 120);
  }

  function validId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 100;
  }

  function receive(event, receivingPort) {
    if (receivingPort !== port || disposed) return;
    const message = event.data;
    if (!message || message.version !== 1 || message.generation !== generation) return;
    const now = Date.now();
    if (now - messageWindow >= 1000) { messageWindow = now; messageCount = 0; }
    if (++messageCount > 40) return;
    if (message.type === 'anchors') {
      if (!Array.isArray(message.items) || message.items.length > core.LIMITS.records) return;
      const ids = new Set();
      for (const item of message.items) {
        if (!item || !validId(item.id) || ids.has(item.id) || !core.validateAnchor(item.anchor)) return;
        ids.add(item.id);
      }
      entries = message.items.map(({ id, anchor }) => ({ id, anchor }));
      queueRefresh();
    } else if (message.type === 'locate' && validId(message.id)) {
      const range = ranges.get(message.id);
      if (!range) return;
      const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      node?.scrollIntoView({ block: 'center', behavior: 'instant' });
      activeRange = range;
      queueRefresh();
      send('located', { id: message.id, ...rangePosition(range) });
    } else if (message.type === 'selection-clear') {
      const selection = window.getSelection();
      if (message.selectionId !== selectionId || !reportedSelection || selection?.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      // A newer native selection may exist before its debounced report is sent.
      if (range.startContainer !== reportedSelection.startContainer || range.startOffset !== reportedSelection.startOffset ||
          range.endContainer !== reportedSelection.endContainer || range.endOffset !== reportedSelection.endOffset) return;
      selection.removeAllRanges();
      reportedSelection = null;
      send('selection-clear', { selectionId });
    }
  }

  function handshake(event) {
    if (disposed || event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'pages-annotations:probe' && message.version === 1) {
      window.parent.postMessage({ type: 'pages-annotations:ready', version: 1 }, '*');
      return;
    }
    if (message?.type !== 'pages-annotations:init' || message.version !== 1 ||
        typeof message.generation !== 'string' || !message.generation.length || message.generation.length > 100 ||
        event.ports?.length !== 1) return;
    port?.close();
    clearPaint();
    entries = [];
    ranges.clear();
    reportedSelection = null;
    generation = message.generation;
    const receivingPort = event.ports[0];
    port = receivingPort;
    messageWindow = Date.now();
    messageCount = 0;
    port.onmessage = event => receive(event, receivingPort);
    port.start();
    send('ready');
    queueSelection();
  }

  const observer = new MutationObserver(mutations => {
    const external = mutations.some(mutation => {
      if (mutation.target.closest?.('[data-pages-annotations]')) return false;
      if (mutation.type !== 'childList') return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
        node.nodeType !== 1 || !node.hasAttribute('data-pages-annotations'));
    });
    if (!external) return;
    index = null;
    queueRefresh();
    queueSelection();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  window.addEventListener('message', handshake);
  document.addEventListener('selectionchange', queueSelection);
  document.addEventListener('pointerup', queueSelection);
  document.addEventListener('touchend', queueSelection, { passive: true });
  document.addEventListener('keyup', queueSelection);
  document.addEventListener('pointerdown', () => send('dismiss'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { window.getSelection()?.removeAllRanges(); send('dismiss'); }
  });
  document.addEventListener('click', event => {
    if (disposed || !port || event.defaultPrevented || event.button !== 0 ||
        ![event.clientX, event.clientY].every(Number.isFinite) || !window.getSelection()?.isCollapsed) return;
    const ids = [];
    for (const [id, range] of ranges) {
      if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom)) ids.push(id);
      if (ids.length >= core.LIMITS.records) break;
    }
    if (ids.length) { activeRange = ranges.get(ids[0]); send('activate', { ids, ...rangePosition(activeRange) }); }
  });
  window.addEventListener('scroll', () => {
    queueRefresh(); queueSelection();
    if (activeRange) send('position', rangePosition(activeRange));
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => { index = null; queueRefresh(); queueSelection(); });
  window.addEventListener('pagehide', () => {
    disposed = true;
    clearTimeout(selectionTimer);
    clearTimeout(refreshTimer);
    selectionTimer = refreshTimer = null;
    observer.disconnect();
    port?.close();
    port = null;
    generation = null;
    entries = [];
    ranges.clear();
    activeRange = null;
    reportedSelection = null;
    index = null;
    clearPaint();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false;
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    window.parent.postMessage({ type: 'pages-annotations:ready', version: 1 }, '*');
  });
  window.parent.postMessage({ type: 'pages-annotations:ready', version: 1 }, '*');
})();
