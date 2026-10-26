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
    check: '<path d="m5 12 4 4L19 6"/>',
    loading: '<path d="M12 3a9 9 0 1 1-9 9"/>',
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
    const opening = panel.hidden || !editor.hidden || !manual.hidden;
    closeConfirmation(false); dismissEditor(); closePreview(); clearCandidate();
    panel.hidden = !opening;
    launcher.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { refresh(); closeButton.focus(); }
  }, host, 'annotation-launcher');
  launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'annotation-panel');
  decorate(launcher, 'comment', 'Annotations (0)', '0');
  const add = button('+ Note', () => openEditor(candidate, null, candidateRect), host, 'annotation-add');
  add.setAttribute('aria-label', 'Annotate');
  add.title = 'Annotate';
  add.hidden = true;
  add.addEventListener('pointerdown', event => {
    touchClickPending = event.pointerType === 'touch';
    if (event.pointerType === 'touch' && event.isPrimary && candidate) {
      addTouch = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor: candidate, rect: candidateRect };
    }
    event.preventDefault();
  });
  const panel = element('div', 'annotation-panel');
  panel.id = 'annotation-panel'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Annotations');
  const heading = element('div', 'annotation-heading');
  const title = element('h2', '', 'Annotations · 0');
  heading.append(title);
  const closeButton = button('Close', () => {
    closeConfirmation(false); dismissEditor(); closePreview(); clearCandidate();
    panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus();
  }, heading);
  closeButton.className = 'annotation-icon';
  decorate(closeButton, 'close', 'Close');
  const status = element('p', 'annotation-status', 'Saved in this browser');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'annotation-actions annotation-toolbar');
  const copy = button('Copy Prompt', previewPrompt, actions, 'annotation-primary');
  decorate(copy, 'copy', 'Copy Prompt', 'Prompt');
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
  editor.setAttribute('role', 'dialog'); editor.setAttribute('aria-label', 'Annotation editor');
  const editorHeading = element('div', 'annotation-heading');
  const editorTitle = element('h2', '', 'Add annotation'); editorHeading.append(editorTitle);
  decorate(button('Close annotation editor', () => dismissEditor(), editorHeading, 'annotation-icon'), 'close', 'Close annotation editor');
  const selectedQuote = element('blockquote', 'annotation-quote');
  const viewText = element('p', 'annotation-view'); viewText.hidden = true;
  const label = element('label', '', 'Comment'); label.htmlFor = 'annotation-comment';
  const input = element('textarea'); input.id = 'annotation-comment'; input.maxLength = core.LIMITS.comment;
  input.required = true;
  const editorActions = element('div', 'annotation-actions');
  const save = element('button', 'annotation-primary', 'Save'); save.type = 'submit'; editorActions.append(save);
  const cancelEdit = button('Cancel', () => { dismissEditor(); refresh(); }, editorActions);
  const editSaved = button('Edit', () => {
    if (editing?.record) openEditor(editing.anchor, editing.record, editorRect);
  }, editorActions);
  editor.append(editorHeading, selectedQuote, viewText, label, input, editorActions);
  const confirmation = element('div', 'annotation-confirmation'); confirmation.hidden = true;
  confirmation.setAttribute('role', 'dialog'); confirmation.setAttribute('aria-labelledby', 'annotation-confirm-title');
  const confirmText = element('p'); confirmText.id = 'annotation-confirm-title';
  const confirmActions = element('div', 'annotation-actions');
  let confirmationAnchor = null;
  let confirmationRecordId = null;
  confirmation.append(confirmText, confirmActions);
  const manual = element('section', 'annotation-preview'); manual.hidden = true;
  manual.setAttribute('role', 'dialog'); manual.setAttribute('aria-label', 'Feedback preview');
  const previewHeading = element('div', 'annotation-heading');
  previewHeading.append(element('h2', '', 'Feedback preview'));
  decorate(button('Close preview', closePreview, previewHeading, 'annotation-icon'), 'close', 'Close preview');
  const manualText = element('textarea', 'annotation-copy-text'); manualText.id = 'annotation-copy-text'; manualText.readOnly = true;
  manualText.setAttribute('aria-label', 'Feedback prompt');
  const previewStatus = element('p', 'annotation-preview-status'); previewStatus.setAttribute('role', 'status');
  const previewActions = element('div', 'annotation-actions');
  const copyAll = button('Copy Prompt', copyPrompt, previewActions, 'annotation-primary annotation-copy-button');
  let copyGeneration = 0, copyPending = false;
  manual.append(previewHeading, manualText, previewStatus, previewActions);
  panel.append(heading, status, list); host.append(panel, editor, manual, confirmation);
  let store, records = [], candidate = null, candidateRect = null, editing = null, index = null;
  let addTouch = null, touchClickPending = false;
  setCopyState('idle');
  let editorRect = null, restorePanel = false, pendingLocate = null;
  let frameSelectionId = null;
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
  function visibleRect(rect) {
    return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
      rect.width >= 0 && rect.height >= 0 && rect.y + rect.height >= 0 && rect.y <= innerHeight;
  }
  function setCandidate(anchor, rect, end) {
    if (!core.validateAnchor(anchor) || !visibleRect(rect)) return;
    dismissEditor(); closePreview(); panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
    candidate = anchor; candidateRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    place(add, visibleRect(end) ? end : candidateRect);
  }
  function place(node, rect) {
    node.hidden = false;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    node.style.maxHeight = `${Math.max(40, height - 16)}px`;
    const box = node.getBoundingClientRect();
    node.style.left = `${Math.max(left + 8, Math.min(left + width - box.width - 8, rect?.x ?? left + width / 2 - box.width / 2))}px`;
    const below = (rect?.y ?? top + 30) + (rect?.height || 0) + 8;
    const above = (rect?.y ?? top + 30) - box.height - 8;
    node.style.top = `${Math.max(top + 8, Math.min(top + height - box.height - 8, below + box.height <= top + height - 8 ? below : above))}px`;
  }
  function clearCandidate() { addTouch = null; candidate = null; candidateRect = null; add.hidden = true; }
  document.addEventListener('pointerdown', () => { touchClickPending = false; }, true);
  document.addEventListener('click', event => {
    // The compatibility click may land on the editor that pointerup just opened.
    if (touchClickPending && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  function touchSelectionChanged() {
    if (!addTouch || !root) return false;
    const selection = window.getSelection();
    // Native touch menus can collapse the selection before the finger is lifted.
    if (!selection || selection.isCollapsed) return false;
    const anchor = core.selectionAnchor(markdownIndex(), selection);
    return JSON.stringify(anchor) !== JSON.stringify(addTouch.anchor);
  }
  document.addEventListener('pointermove', event => {
    if (addTouch?.id === event.pointerId && Math.hypot(event.clientX - addTouch.x, event.clientY - addTouch.y) > 10) clearCandidate();
  });
  document.addEventListener('pointercancel', event => {
    if (addTouch?.id === event.pointerId) clearCandidate();
  });
  document.addEventListener('pointerup', event => {
    if (addTouch?.id !== event.pointerId) return;
    const gesture = addTouch;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10 ||
        !target || !add.contains(target) || touchSelectionChanged()) { clearCandidate(); return; }
    addTouch = null;
    openEditor(gesture.anchor, null, gesture.rect);
  });
  function showPanel() { panel.hidden = false; launcher.setAttribute('aria-expanded', 'true'); }
  function dismissEditor() {
    editor.hidden = true; editing = null; pendingLocate = null; editorRect = null;
    panel.insertBefore(status, list);
    if (restorePanel) showPanel();
    restorePanel = false; clearCandidate();
  }
  function closePreview() { manual.hidden = true; resetCopyState(); }
  function dismissOutside() {
    closeConfirmation(false); dismissEditor(); closePreview(); clearCandidate(); closeMenu();
    // Editor dismissal can restore the summary, so hide it after that restoration.
    panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
  }
  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    if (frame && frameSelectionId !== null) send({ type: 'selection-clear', selectionId: frameSelectionId });
  }
  function openEditor(anchor, record = null, rect = null, viewing = false) {
    if (!core.validateAnchor(anchor)) return;
    const returning = restorePanel || !panel.hidden;
    dismissEditor(); closePreview(); closeConfirmation(false); closeMenu();
    restorePanel = returning; panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
    editing = { anchor, record }; editor.hidden = false; add.hidden = true;
    editorRect = rect;
    editorTitle.textContent = viewing ? 'Annotation' : record ? 'Edit annotation' : 'Add annotation';
    selectedQuote.textContent = anchor.quote.exact; input.value = record?.comment || '';
    viewText.textContent = record?.comment || ''; viewText.hidden = !viewing;
    label.hidden = input.hidden = save.hidden = cancelEdit.hidden = viewing;
    editSaved.hidden = !viewing;
    status.textContent = 'Saved in this browser'; editor.insertBefore(status, editorActions);
    save.disabled = !input.value.trim();
    clearCandidate(); clearSelection(); place(editor, rect);
    (viewing ? editSaved : input).focus({ preventScroll: true });
  }
  let composingComment = false;
  input.addEventListener('compositionstart', () => { composingComment = true; });
  input.addEventListener('compositionend', () => { composingComment = false; });
  input.addEventListener('blur', () => { composingComment = false; });
  input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
  input.addEventListener('keydown', event => {
    // Some IMEs end composition before the confirming Enter (keyCode 229).
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composingComment || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !editor.hidden && !save.disabled) editor.requestSubmit(save);
  });
  editor.addEventListener('submit', event => {
    event.preventDefault();
    if (!editing || !store) { report(); return; }
    try {
      if (editing.record) store.update(editing.record.id, input.value, editing.record);
      else store.add(editing.anchor, input.value);
      dismissEditor(); clearSelection(); refresh();
      status.textContent = 'Saved in this browser';
    } catch (error) { report(error); }
  });
  function closeConfirmation(restore = true) {
    if (confirmation.hidden) return;
    confirmation.hidden = true;
    const anchor = confirmationAnchor?.isConnected ? confirmationAnchor
      : [...list.querySelectorAll('.annotation-item')].find(item => item.dataset.annotationId === confirmationRecordId)?.querySelector('button[aria-label="Delete"]');
    confirmationAnchor = null; confirmationRecordId = null;
    if (restore) (anchor || closeButton).focus({ preventScroll: true });
  }
  function ask(text, action, anchor, label = 'Delete') {
    dismissEditor(); closePreview(); clearCandidate();
    showPanel(); confirmText.textContent = text; confirmActions.replaceChildren();
    confirmationAnchor = anchor;
    confirmationRecordId = anchor.closest('.annotation-item')?.dataset.annotationId || null;
    const cancel = button('Cancel', () => closeConfirmation(), confirmActions);
    button(label, () => {
      try { action(); closeConfirmation(false); refresh(); closeButton.focus({ preventScroll: true }); }
      catch (error) { report(error); }
    }, confirmActions, 'annotation-delete-confirm');
    place(confirmation, anchor.getBoundingClientRect());
    cancel.focus({ preventScroll: true });
  }
  function confirmClear() {
    if (!store) return;
    try {
      const snapshot = store.snapshot();
      ask(`Delete all ${snapshot.length} annotations saved for this page and viewing context?`, () => store.clear(snapshot), more, 'Delete all');
    } catch (error) { report(error); }
  }
  function renderList() {
    // Location replies may rebuild a row just after cancellation restored its focus.
    const active = document.activeElement;
    const focusedItem = list.contains(active) ? active.closest('.annotation-item') : null;
    const focusedId = focusedItem?.dataset.annotationId;
    const focusedAction = focusedItem ? active.getAttribute('aria-label') : null;
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
      decorate(button('Edit', () => locate(record, true), controls, 'annotation-icon'), 'edit', 'Edit');
      decorate(button('Delete', event => ask('Delete this annotation?', () => store.remove(record.id, record), event.currentTarget), controls, 'annotation-icon'), 'delete', 'Delete');
      item.append(quote, comment, controls); list.append(item);
    }
    if (!records.length) list.append(element('li', 'annotation-status', 'No annotations'));
    if (focusedAction) {
      const item = [...list.children].find(node => node.dataset.annotationId === focusedId);
      const action = [...(item?.querySelectorAll('button') || [])].find(node => node.getAttribute('aria-label') === focusedAction && !node.disabled);
      (action || closeButton).focus({ preventScroll: true });
    }
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
  function locate(record, edit = false) {
    dismissEditor(); closePreview(); clearCandidate();
    if (edit && locations.get(record.id) !== 'matched') { openEditor(record, record); return; }
    if (frame) { pendingLocate = { record, edit }; send({ type: 'locate', id: record.id }); return; }
    index = markdownIndex();
    const range = core.rangeForAnchor(index, record);
    if (!range) { refresh(); if (edit) openEditor(record, record); return; }
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (edit) { openEditor(record, record, range.getBoundingClientRect()); return; }
    if (!window.CSS?.highlights) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  function activate(ids, rect) {
    const known = new Set(records.map(record => record.id));
    if (!Array.isArray(ids) || ids.length > core.LIMITS.records || ids.some(id => !known.has(id))) return;
    activeIds = new Set(ids);
    const record = records.find(record => ids.includes(record.id));
    if (record) openEditor(record, record, rect, true);
  }
  function previewPrompt() {
    try {
      closeConfirmation(false); dismissEditor(); clearCandidate();
      const documentUrl = host.dataset.documentUrl
        ? new URL(host.dataset.documentUrl, location.origin).href : '';
      const text = core.exportMarkdown(records.map(record => ({ ...record, locationStatus: locations.get(record.id) })), documentUrl, document.title);
      manualText.value = text;
      resetCopyState();
      previewStatus.textContent = `${records.length} annotation(s)`;
      place(manual); manualText.focus({ preventScroll: true });
    } catch { status.textContent = 'Could not prepare a safe prompt.'; }
  }
  function setCopyState(state) {
    const [icon, label] = state === 'pending' ? ['loading', 'Copying...']
      : state === 'success' ? ['check', 'Copied']
        : state === 'error' ? ['close', 'Copy failed']
          : state === 'manual' ? ['copy', 'Copy manually'] : ['copy', 'Copy Prompt'];
    decorate(copyAll, icon, label, label);
    copyAll.dataset.copyState = state;
    copyPending = state === 'pending';
    copyAll.disabled = copyPending || !records.length;
    copyAll.setAttribute('aria-busy', String(copyPending));
  }
  function resetCopyState() { copyGeneration++; setCopyState('idle'); }
  async function copyPrompt() {
    if (copyPending || manual.hidden || !records.length) return;
    const generation = ++copyGeneration;
    const text = manualText.value;
    if (text.length > 100000) { setCopyState('manual'); previewStatus.textContent = 'Large prompt. Select and copy the full text.'; manualText.focus(); manualText.select(); return; }
    setCopyState('pending');
    previewStatus.textContent = 'Copying prompt...';
    try {
      await navigator.clipboard.writeText(text);
      if (generation !== copyGeneration || manual.hidden) return;
      setCopyState('success'); previewStatus.textContent = 'Prompt copied';
    } catch {
      if (generation !== copyGeneration || manual.hidden) return;
      setCopyState('error'); previewStatus.textContent = 'Clipboard unavailable. Select and copy the full prompt, or try again.';
      manualText.focus(); manualText.select();
    }
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
    frameSelectionId = null;
    dismissEditor(); closePreview(); clearCandidate(); locations.clear();
  }
  function frameRect(rect, viewport) {
    if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite)) return null;
    if (viewport.width <= 0 || viewport.height <= 0 || viewport.width > 100000 || viewport.height > 100000 ||
        rect.width < 0 || rect.height < 0 || [rect.x, rect.y, rect.width, rect.height].some(value => Math.abs(value) > 10000000)) return null;
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const right = Math.min(viewport.width, rect.x + rect.width), bottom = Math.min(viewport.height, rect.y + rect.height);
    if (right <= x || bottom <= y) return null;
    const bounds = frame.getBoundingClientRect();
    const scaleX = bounds.width / viewport.width, scaleY = bounds.height / viewport.height;
    return { x: bounds.x + x * scaleX, y: bounds.y + y * scaleY, width: (right - x) * scaleX, height: (bottom - y) * scaleY };
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
        const rect = frameRect(data.rect, data.viewport);
        if (rect && core.validateAnchor(data.anchor) && Number.isSafeInteger(data.selectionId) && data.selectionId > 0) {
          frameSelectionId = data.selectionId;
          setCandidate(data.anchor, rect, data.end && frameRect(data.end, data.viewport));
        }
      } else if (data.type === 'selection-clear' && !addTouch && (data.selectionId === undefined || data.selectionId === frameSelectionId)) clearCandidate();
      else if (data.type === 'position' && portReady && !editor.hidden) {
        const rect = frameRect(data.rect, data.viewport);
        if (rect) { editorRect = rect; place(editor, rect); }
      } else if (data.type === 'dismiss' && portReady) dismissOutside();
      else if (data.type === 'activate' && portReady) {
        const rect = frameRect(data.rect, data.viewport);
        if (rect) activate(data.ids, rect);
      } else if (data.type === 'located' && portReady && pendingLocate?.record.id === data.id) {
        const rect = frameRect(data.rect, data.viewport), pending = pendingLocate;
        pendingLocate = null;
        if (pending.edit) openEditor(pending.record, pending.record, rect);
      } else if (data.type === 'locations' && portReady && Array.isArray(data.items) && data.items.length <= core.LIMITS.records) {
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
      if (touchSelectionChanged()) clearCandidate();
      selectionTimer = setTimeout(() => {
        if (addTouch) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1 ||
            !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) { clearCandidate(); return; }
        index = markdownIndex();
        const anchor = core.selectionAnchor(index, selection);
        if (!anchor) { clearCandidate(); return; }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setCandidate(anchor, rect, core.selectionEndRect(selection));
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
      if (ids.length) {
        const record = records.find(record => record.id === ids[0]);
        activate(ids, core.rangeForAnchor(index, record).getBoundingClientRect());
      }
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
  document.addEventListener('pointerdown', event => {
    if (addTouch && addTouch.id !== event.pointerId) clearCandidate();
    if (!host.contains(event.target)) dismissOutside();
    else if (!confirmation.hidden && !confirmation.contains(event.target)) closeConfirmation();
  });
  list.addEventListener('scroll', () => closeConfirmation(), { passive: true });
  window.addEventListener('blur', () => {
    if (addTouch) clearCandidate();
    if (frame && document.activeElement === frame) closeConfirmation();
  });
  function resizeTransient() {
    clearCandidate();
    if (!editor.hidden) place(editor, editorRect);
    if (!manual.hidden) place(manual);
    closeConfirmation();
  }
  window.addEventListener('scroll', () => {
    closeConfirmation();
    clearCandidate();
    if (!editor.hidden && root && editing) {
      const range = core.rangeForAnchor(markdownIndex(), editing.anchor);
      if (range) { editorRect = range.getBoundingClientRect(); place(editor, editorRect); }
    }
  }, { passive: true });
  window.addEventListener('resize', resizeTransient);
  window.visualViewport?.addEventListener('resize', resizeTransient);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!confirmation.hidden) { event.preventDefault(); closeConfirmation(); return; }
    clearSelection();
    if (!editor.hidden) { dismissEditor(); return; }
    if (!manual.hidden) { closePreview(); return; }
    clearCandidate();
    if (!panel.hidden) { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  });
  refresh();
})();
