(function () {
  'use strict';
  const host = document.getElementById('pages-annotations');
  const core = window.PagesAnnotationsCore;
  if (!host || !core) return;
  const root = document.querySelector('.markdown-body');
  const frame = document.querySelector('.html-artifact-frame');
  if (!root && !frame) return;
  const unavailable = host.dataset.unavailable === 'true';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, action, parent, className) => {
    const node = element('button', className, text);
    node.type = 'button'; node.addEventListener('click', action); parent.append(node); return node;
  };
  const icons = {
    comment: '<path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5"/>',
    delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  };
  function decorate(node, name, label, text) {
    // Match the reader's existing inline stroke-icon convention.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    svg.innerHTML = icons[name];
    node.replaceChildren(svg);
    if (text !== undefined) node.append(element('span', 'annotation-count', text));
    node.setAttribute('aria-label', label); node.title = label;
    return node;
  }
  const launcher = button('Annotations (0)', () => {
    panel.hidden = !panel.hidden;
    launcher.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { refresh(); closeButton.focus(); }
  }, host, 'annotation-launcher');
  launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'annotation-panel');
  decorate(launcher, 'comment', 'Annotations (0)', '0');
  const add = button('Annotate', () => openEditor(candidate), host, 'annotation-add');
  add.hidden = true;
  add.addEventListener('pointerdown', event => event.preventDefault());
  const panel = element('div', 'annotation-panel');
  panel.id = 'annotation-panel'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Annotations');
  const heading = element('div', 'annotation-heading');
  const title = element('h2', '', 'Annotations · 0');
  heading.append(title);
  const closeButton = button('Close', () => {
    panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus();
  }, heading);
  closeButton.className = 'annotation-icon';
  decorate(closeButton, 'close', 'Close');
  const status = element('p', 'annotation-status', 'Saved in this browser');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'annotation-actions annotation-toolbar');
  const copy = button('Copy Prompt', copyPrompt, actions, 'annotation-primary');
  decorate(copy, 'copy', 'Copy Prompt', 'Copy');
  const moreWrap = element('div', 'annotation-more'); actions.append(moreWrap);
  const more = button('More actions', () => {
    menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) clear.focus();
  }, moreWrap, 'annotation-icon');
  decorate(more, 'more', 'More actions');
  more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'annotation-more-menu');
  const menu = element('div', 'annotation-menu'); menu.id = 'annotation-more-menu'; menu.hidden = true;
  moreWrap.append(menu);
  const clear = button('Clear all', () => { closeMenu(); confirmClear(); }, menu, 'annotation-danger');
  function closeMenu() { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
  document.addEventListener('click', event => { if (!moreWrap.contains(event.target)) closeMenu(); });
  moreWrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); more.focus(); }
  });
  heading.insertBefore(actions, closeButton);
  const list = element('ol', 'annotation-list');
  const editor = element('form', 'annotation-editor'); editor.hidden = true;
  const selectedQuote = element('blockquote', 'annotation-quote');
  const label = element('label', '', 'Comment'); label.htmlFor = 'annotation-comment';
  const input = element('textarea'); input.id = 'annotation-comment'; input.maxLength = core.LIMITS.comment;
  input.required = true;
  const editorActions = element('div', 'annotation-actions');
  const save = element('button', '', 'Save'); save.type = 'submit'; editorActions.append(save);
  button('Cancel', () => { editor.hidden = true; editing = null; refresh(); }, editorActions);
  editor.append(selectedQuote, label, input, editorActions);
  const confirmation = element('div'); confirmation.hidden = true;
  const confirmText = element('p'); const confirmActions = element('div', 'annotation-actions');
  confirmation.append(confirmText, confirmActions);
  const manual = element('div'); manual.hidden = true;
  const manualLabel = element('label', '', 'Copy Prompt'); manualLabel.htmlFor = 'annotation-copy-text';
  const manualText = element('textarea', 'annotation-copy-text'); manualText.id = 'annotation-copy-text'; manualText.readOnly = true;
  manual.append(manualLabel, manualText);
  panel.append(heading, status, editor, confirmation, manual, list); host.append(panel);
  let store, records = [], candidate = null, editing = null, index = null;
  let markdownObserver, mutationTimer;
  let port = null, generation = '', portReady = false, handshakeTimer, rateTime = 0, rateCount = 0;
  const locations = new Map();
  let activeIds = new Set();
  try {
    if (unavailable) throw new Error('unavailable');
    store = core.createStore(window.localStorage, {
      baseNamespace: host.dataset.baseNamespace,
      viewerScope: host.dataset.viewerScope,
      pageId: host.dataset.pageId,
    });
  } catch {
    status.textContent = unavailable
      ? 'Annotations unavailable for this document configuration.'
      : 'Browser storage unavailable. Annotations cannot be saved.';
    if (unavailable) {
      launcher.textContent = 'Annotations unavailable';
      launcher.setAttribute('aria-label', 'Annotations unavailable'); launcher.title = 'Annotations unavailable';
    }
  }

  function report(error) {
    status.textContent = error?.code === 'conflict'
      ? 'Changed in another tab. Your draft is kept; cancel and reload before editing.'
      : error?.code === 'comment' ? 'Enter a comment of up to 4,000 characters.'
        : error?.code === 'limit' ? 'This page has reached its annotation limit.'
          : 'Could not save changes. Your draft is kept. Browser storage may be unavailable or full.';
  }
  function setCandidate(anchor, rect) {
    if (!core.validateAnchor(anchor) || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    if (rect.width < 0 || rect.height < 0 || rect.y + rect.height < 0 || rect.y > innerHeight) return;
    candidate = anchor;
    add.hidden = !editor.hidden;
    add.style.left = `${Math.max(8, Math.min(innerWidth - 110, rect.x))}px`;
    // Place below selection, leaving the native selection menu above it.
    add.style.top = `${Math.max(8, Math.min(innerHeight - 48, rect.y + rect.height + 10))}px`;
  }
  function clearCandidate() { candidate = null; add.hidden = true; }
  function showPanel() { panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); }
  function openEditor(anchor, record = null) {
    if (!core.validateAnchor(anchor)) return;
    showPanel(); manual.hidden = true; confirmation.hidden = true;
    editing = { anchor, record }; editor.hidden = false; add.hidden = true;
    selectedQuote.textContent = anchor.quote.exact; input.value = record?.comment || '';
    input.focus();
  }
  editor.addEventListener('submit', event => {
    event.preventDefault();
    if (!editing || !store) { report(); return; }
    try {
      if (editing.record) store.update(editing.record.id, input.value, editing.record);
      else store.add(editing.anchor, input.value);
      editor.hidden = true; editing = null; clearCandidate(); refresh();
      status.textContent = 'Saved in this browser';
    } catch (error) { report(error); }
  });
  function ask(text, action) {
    showPanel(); confirmText.textContent = text; confirmActions.replaceChildren(); confirmation.hidden = false;
    button('Confirm', () => {
      try { action(); confirmation.hidden = true; refresh(); }
      catch (error) { report(error); }
    }, confirmActions);
    button('Cancel', () => { confirmation.hidden = true; }, confirmActions);
  }
  function confirmClear() {
    if (!store) return;
    try {
      const snapshot = store.snapshot();
      ask(`Clear ${snapshot.length} saved annotation record(s) for this page and viewing context?`, () => store.clear(snapshot));
    } catch (error) { report(error); }
  }
  function renderList() {
    list.replaceChildren();
    for (const record of records) {
      const item = element('li', 'annotation-item');
      item.dataset.annotationId = record.id;
      item.classList.toggle('annotation-active', activeIds.has(record.id));
      const quote = element('blockquote', 'annotation-quote', record.quote.exact);
      const comment = element('p', 'annotation-comment', record.comment);
      const controls = element('div', 'annotation-actions annotation-item-actions');
      const matched = locations.get(record.id) === 'matched';
      if (!matched) item.append(element('p', 'annotation-unmatched', 'Original text changed or could not be located'));
      decorate(button('Locate', () => locate(record), controls, 'annotation-icon'), 'locate', 'Locate').disabled = !matched;
      decorate(button('Edit', () => openEditor(record, record), controls, 'annotation-icon'), 'edit', 'Edit');
      decorate(button('Delete', () => ask('Delete this annotation?', () => store.remove(record.id, record)), controls, 'annotation-icon'), 'delete', 'Delete');
      item.append(quote, comment, controls); list.append(item);
    }
    if (!records.length) list.append(element('li', 'annotation-status', 'No annotations'));
  }
  function refresh() {
    if (!store) { copy.disabled = clear.disabled = true; return; }
    try {
      const result = store.read(); records = result.records;
      status.textContent = result.corrupt.length ? 'Some saved records could not be read. They have been preserved.' : 'Saved in this browser';
    } catch (error) { report(error); return; }
    decorate(launcher, 'comment', `Annotations (${records.length})`, String(records.length));
    title.textContent = `Annotations · ${records.length}`;
    copy.disabled = !records.length; clear.disabled = !store;
    updateLocations(); renderList();
  }
  function updateLocations() {
    if (root) {
      if (!records.length) { window.CSS?.highlights?.delete('pages-annotations'); return; }
      index = markdownIndex();
      const ranges = [];
      for (const record of records) {
        const range = core.rangeForAnchor(index, record);
        locations.set(record.id, range ? 'matched' : 'unmatched');
        if (range) ranges.push(range);
      }
      if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('pages-annotations', new Highlight(...ranges));
    } else send({ type: 'anchors', items: records.map(record => ({ id: record.id, anchor: {
      quote: record.quote, textPosition: record.textPosition, contentRevision: record.contentRevision,
    } })) });
  }
  function locate(record) {
    if (frame) { send({ type: 'locate', id: record.id }); return; }
    index = markdownIndex();
    const range = core.rangeForAnchor(index, record);
    if (!range) { refresh(); return; }
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!window.CSS?.highlights) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  function activate(ids) {
    const known = new Set(records.map(record => record.id));
    if (!Array.isArray(ids) || ids.length > core.LIMITS.records || ids.some(id => !known.has(id))) return;
    activeIds = new Set(ids);
    showPanel();
    const active = [...list.children].filter(item => ids.includes(item.dataset.annotationId));
    for (const item of list.children) item.classList.toggle('annotation-active', active.includes(item));
    active[0]?.scrollIntoView({ block: 'nearest' });
  }
  async function copyPrompt() {
    try {
      const documentUrl = host.dataset.documentUrl
        ? new URL(host.dataset.documentUrl, location.origin).href : '';
      const text = core.exportMarkdown(records.map(record => ({ ...record, locationStatus: locations.get(record.id) })), documentUrl, document.title);
      manualText.value = text;
      manual.hidden = false;
      if (text.length > 100000) { status.textContent = 'Large prompt. Review and copy the full text below.'; manualText.focus(); manualText.select(); return; }
      try {
        await navigator.clipboard.writeText(text); manual.hidden = true; status.textContent = 'Prompt copied';
      } catch { status.textContent = 'Clipboard unavailable. Select and copy the full prompt below.'; manualText.focus(); manualText.select(); }
    } catch { status.textContent = 'Could not prepare a safe prompt.'; }
  }
  function send(message) { if (port && portReady) port.postMessage({ ...message, version: 1, generation }); }
  function invalidateMarkdownIndex() {
    index = null;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => { updateLocations(); renderList(); }, 200);
  }
  function markdownIndex() {
    // Drain pending mutations too, so synchronous selection/locate never uses stale nodes.
    if (markdownObserver?.takeRecords().length) invalidateMarkdownIndex();
    if (!index) index = core.buildTextIndex(root);
    return index;
  }
  function disconnect() {
    clearTimeout(handshakeTimer); port?.close(); port = null; portReady = false;
    clearCandidate(); locations.clear();
  }
  function connect() {
    if (!frame?.contentWindow) return;
    disconnect(); generation = window.crypto?.randomUUID?.() || `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    rateTime = Date.now(); rateCount = 0;
    const channel = new MessageChannel(); port = channel.port1;
    const current = port;
    port.onmessage = event => {
      if (port !== current) return;
      const data = event.data;
      if (!data || data.version !== 1 || data.generation !== generation) return;
      const now = Date.now();
      if (now - rateTime > 1000) { rateTime = now; rateCount = 0; }
      if (++rateCount > 30) return;
      if (data.type === 'ready' && !portReady) {
        portReady = true; clearTimeout(handshakeTimer); refresh();
      } else if (data.type === 'selection' && portReady) {
        const rect = data.rect, viewport = data.viewport;
        if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite)) return;
        if (viewport.width <= 0 || viewport.height <= 0 || viewport.width > 100000 || viewport.height > 100000 ||
            rect.width < 0 || rect.height < 0 || [rect.x, rect.y, rect.width, rect.height].some(value => Math.abs(value) > 10000000)) return;
        const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
        const right = Math.min(viewport.width, rect.x + rect.width), bottom = Math.min(viewport.height, rect.y + rect.height);
        if (right <= x || bottom <= y) return;
        const bounds = frame.getBoundingClientRect();
        const scaleX = bounds.width / viewport.width, scaleY = bounds.height / viewport.height;
        setCandidate(data.anchor, { x: bounds.x + x * scaleX, y: bounds.y + y * scaleY, width: (right - x) * scaleX, height: (bottom - y) * scaleY });
      } else if (data.type === 'selection-clear') clearCandidate();
      else if (data.type === 'activate' && portReady) activate(data.ids);
      else if (data.type === 'locations' && portReady && Array.isArray(data.items) && data.items.length <= core.LIMITS.records) {
        const ids = new Set(records.map(record => record.id));
        for (const item of data.items) if (ids.has(item?.id) && ['matched', 'unmatched'].includes(item.status)) locations.set(item.id, item.status);
        renderList();
      }
    };
    port.start();
    frame.contentWindow.postMessage({ type: 'pages-annotations:init', version: 1, generation }, '*', [channel.port2]);
    handshakeTimer = setTimeout(() => { if (!portReady) { status.textContent = 'Annotations unavailable in this document'; } }, 5000);
  }
  if (root && !unavailable) {
    let selectionTimer;
    function selectionChanged() {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (!editor.hidden) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1 ||
            !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) { clearCandidate(); return; }
        index = markdownIndex();
        const anchor = core.selectionAnchor(index, selection);
        if (!anchor) { clearCandidate(); return; }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setCandidate(anchor, rect);
      }, 120);
    }
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('pointerup', selectionChanged);
    document.addEventListener('keyup', selectionChanged);
    root.addEventListener('click', event => {
      if (!records.length || !window.getSelection()?.isCollapsed) return;
      index = markdownIndex();
      const ids = records.filter(record => {
        const range = core.rangeForAnchor(index, record);
        return range && [...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
      }).map(record => record.id);
      if (ids.length) activate(ids);
    });
    markdownObserver = new MutationObserver(invalidateMarkdownIndex);
    markdownObserver.observe(root, { childList: true, characterData: true, attributes: true, subtree: true });
  } else if (!unavailable) {
    frame.addEventListener('load', connect);
    window.addEventListener('message', event => {
      if (event.source === frame.contentWindow && event.data?.type === 'pages-annotations:ready' && event.data.version === 1 && !portReady && !port) connect();
    });
    connect();
  }
  window.addEventListener('storage', event => { if (!event.key || event.key.startsWith(store?.prefix || 'zylos-pages:annotations:')) refresh(); });
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      index = null;
      if (frame && !unavailable) connect();
      refresh();
    }
  });
  window.addEventListener('scroll', () => { if (candidate) add.hidden = true; }, { passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); } });
  refresh();
})();
