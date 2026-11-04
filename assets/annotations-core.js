(function (global) {
  'use strict';
  const LIMITS = Object.freeze({ quote: 10000, comment: 4000, records: 200 });
  const normalizeText = value => String(value).replace(/\s+/gu, ' ').trim();
  const fail = (code, message) => { const error = new Error(message); error.code = code; error.annotationError = true; throw error; };
  function revisionOf(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `v1-${text.length}-${(hash >>> 0).toString(16)}`;
  }
  function validateAnchor(anchor) {
    return !!anchor && typeof anchor.quote?.exact === 'string' &&
      anchor.quote.exact.length <= LIMITS.quote && !!normalizeText(anchor.quote.exact) &&
      typeof anchor.quote.prefix === 'string' && anchor.quote.prefix.length <= 64 &&
      typeof anchor.quote.suffix === 'string' && anchor.quote.suffix.length <= 64 &&
      Number.isSafeInteger(anchor.textPosition?.start) && anchor.textPosition.start >= 0 &&
      Number.isSafeInteger(anchor.textPosition.end) && anchor.textPosition.end > anchor.textPosition.start &&
      anchor.textPosition.indexVersion === 1 && typeof anchor.contentRevision === 'string' &&
      anchor.contentRevision.length <= 100;
  }
  // Element annotations describe a picked element by what an Agent needs to find it in the source.
  const ELEMENT_ATTRS = ['id', 'class', 'src', 'alt', 'href', 'title', 'aria-label', 'role', 'name', 'type'];
  const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
  // Element fields are shown on one Prompt line: collapse whitespace and drop other control characters.
  const cleanText = value => normalizeText(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  // SVG elements have no innerText; skip their <style>/<script> so a diagram is not described by its CSS.
  function visibleText(node) {
    if (typeof node.innerText === 'string') return node.innerText;
    const parts = [], walker = node.ownerDocument.createTreeWalker(node, 4);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.parentElement?.closest('style,script')) parts.push(text.data);
    }
    return parts.join(' ');
  }
  const elementText = node => clip(cleanText(visibleText(node)), 200);
  // Layout-independent fingerprint used to find the element again; innerText changes with CSS.
  const textKey = node => revisionOf(normalizeText(node.textContent || ''));
  // Signed asset links carry exp/sig/access in the query and share links a token in the path:
  // keep only the asset's own `path` parameter so neither storage nor the Prompt holds credentials.
  // Browsers ignore tabs, newlines and controls inside a URL, so `java<Tab>script:` is still javascript:.
  const compactUrl = value => String(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  function safeUrl(value) {
    const text = cleanText(value);
    const scheme = /^(data|blob|javascript|vbscript):/i.exec(compactUrl(value));
    if (scheme) return scheme[1].toLowerCase() + ':…';
    const [main, query = ''] = text.split('#')[0].split(/\?(.*)/s);
    let asset = null;
    try { asset = new URLSearchParams(query).get('path'); } catch {}
    const base = main.replace(/(^|\/)(s|share)\/[^/]+/gi, '$1$2/…');
    return asset ? `${base}?path=${asset}` : base;
  }
  const URL_ATTRS = new Set(['src', 'href', 'poster', 'action', 'formaction', 'xlink:href', 'background', 'cite']);
  // Any value that could be a link (a scheme, a path, or a signed query) is cleaned like a URL.
  const urlLike = (name, value) => URL_ATTRS.has(name) || /^(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)/i.test(compactUrl(value)) ||
    /[?&](?:sig|exp|token|access|key|signature)=/i.test(value);
  // Saved text is shown in a one-line Prompt item, so line breaks or controls could forge new items.
  const oneLine = text => typeof text === 'string' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text);
  function validateElement(anchor) {
    const item = anchor?.element;
    if (!item || typeof item.tag !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(item.tag)) return false;
    if (!item.attrs || typeof item.attrs !== 'object' || Array.isArray(item.attrs) ||
        Object.entries(item.attrs).some(([name, value]) => !ELEMENT_ATTRS.includes(name) || !oneLine(value) || value.length > 120)) return false;
    return Array.isArray(item.section) && item.section.length <= 6 && item.section.every(text => oneLine(text) && text.length <= 80) &&
      oneLine(item.text) && item.text.length <= 200 && oneLine(item.html) && item.html.length <= 300 &&
      typeof item.textKey === 'string' && /^v1-\d+-[0-9a-f]+$/.test(item.textKey) && item.textKey.length <= 40 &&
      oneLine(item.path) && item.path.length <= 1000 && Number.isSafeInteger(item.ordinal) && item.ordinal >= 1 &&
      Number.isSafeInteger(item.count) && item.count >= item.ordinal;
  }
  const validateAny = anchor => validateAnchor(anchor) || validateElement(anchor);
  // Tags are saved lowercase; SVG keeps camelCase names (foreignObject), which a tag lookup misses.
  function elementsOf(root, tag) {
    const fast = root.getElementsByTagName(tag);
    return fast.length ? [...fast] : [...root.getElementsByTagName('*')].filter(node => node.localName.toLowerCase() === tag);
  }
  function elementPath(root, node) {
    const parts = [];
    for (; node && node !== root; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && root.querySelectorAll('#' + node.id).length === 1) { parts.unshift('#' + node.id); break; }
      let position = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === node.localName) position++;
      parts.unshift(`${node.localName}:nth-of-type(${position})`);
    }
    const path = (parts[0]?.startsWith('#') ? '' : ':scope > ') + parts.join(' > ');
    return path.length <= 1000 ? path : '';
  }
  // Headings the element sits under, outermost first: ["2 定价", "2.2 功能对比"].
  function sectionPath(root, node) {
    const chain = [];
    for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (heading === node || !(heading.compareDocumentPosition(node) & 4)) break;
      const level = Number(heading.tagName[1]);
      while (chain.length && chain[chain.length - 1].level >= level) chain.pop();
      chain.push({ level, text: clip(cleanText(heading.textContent), 80) });
    }
    return chain.slice(-6).map(entry => entry.text);
  }
  function snippet(node) {
    const copy = node.cloneNode(true);
    // Inline CSS can carry signed asset URLs; it is also noise for an Agent reading the source.
    for (const part of copy.querySelectorAll('style,script')) part.remove();
    for (const part of [copy, ...copy.querySelectorAll('*')]) {
      for (const attribute of [...part.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name === 'style' || name.startsWith('on') || name.startsWith('data-') || name === 'srcset' || name === 'imagesrcset') part.removeAttribute(attribute.name);
        else if (urlLike(name, attribute.value)) part.setAttribute(attribute.name, clip(safeUrl(attribute.value), 80));
        else if (attribute.value.length > 80) part.setAttribute(attribute.name, clip(attribute.value, 80));
      }
    }
    return clip(cleanText(copy.outerHTML), 300);
  }
  function describeElement(root, node) {
    if (!node || node.nodeType !== 1 || node === root || !root.contains(node)) return null;
    const attrs = {};
    for (const name of ELEMENT_ATTRS) {
      const value = attributeValue(node, name);
      if (value) attrs[name] = value;
    }
    const tag = node.localName.toLowerCase(), text = elementText(node), all = elementsOf(root, tag);
    const anchor = { element: { tag, attrs, section: sectionPath(root, node), text, html: text ? '' : snippet(node),
      textKey: textKey(node), path: elementPath(root, node), ordinal: all.indexOf(node) + 1, count: all.length } };
    return validateElement(anchor) ? anchor : null;
  }
  function attributeValue(node, name) {
    let value = cleanText(node.getAttribute(name) || '');
    if (!value) return '';
    if (name === 'class') value = value.split(' ').slice(0, 3).join(' ');
    if (urlLike(name, node.getAttribute(name))) value = safeUrl(node.getAttribute(name));
    return clip(value, 120);
  }
  function resolveElement(root, anchor) {
    if (!validateElement(anchor)) return null;
    const item = anchor.element;
    const same = node => ['id', 'src', 'alt', 'href'].every(name => (item.attrs[name] ?? '') === attributeValue(node, name)) &&
      textKey(node) === item.textKey;
    const all = elementsOf(root, item.tag);
    const candidates = all.filter(same);
    if (candidates.length === 1) return candidates[0];
    // Several look identical (empty cells, rules, repeated labels): trust the saved position only
    // while the document still has as many of these elements, otherwise report it as changed.
    if (!candidates.length || all.length !== item.count) return null;
    let found = null;
    try { found = item.path ? root.querySelector(item.path) : null; } catch {}
    if (candidates.includes(found)) return found;
    const byOrder = all[item.ordinal - 1];
    return candidates.includes(byOrder) ? byOrder : null;
  }
  const ELEMENT_KINDS = { table: '表格', thead: '表头', tbody: '表格', tr: '表格行', td: '单元格', th: '单元格', img: '图片', picture: '图片',
    svg: '图形', canvas: '图形', video: '视频', audio: '音频', figure: '图', figcaption: '图注', a: '链接', button: '按钮',
    h1: '标题', h2: '标题', h3: '标题', h4: '标题', h5: '标题', h6: '标题', p: '段落', ul: '列表', ol: '列表', li: '列表项',
    dl: '列表', pre: '代码块', code: '代码', blockquote: '引用', input: '输入框', textarea: '输入框', select: '下拉框', form: '表单',
    nav: '导航', header: '页头', footer: '页脚', section: '区块', article: '区块', aside: '侧栏', div: '区块', span: '文字', hr: '分隔线' };
  const elementKind = tag => ELEMENT_KINDS[tag] || '元素';
  function elementLabel(item) {
    const shown = ['id', 'class', 'alt', 'title', 'aria-label', 'role', 'name', 'type'].filter(name => item.attrs[name])
      .map(name => ` ${name}="${item.attrs[name]}"`);
    const source = item.attrs.src || item.attrs.href;
    if (source && !/^[a-z]+:…$/.test(source)) {
      const asset = /[?&]path=([^&#]*)/.exec(source)?.[1];
      shown.push(` ${item.attrs.src ? 'src' : 'href'}="${clip((asset ?? source.split(/[?#]/)[0]).split('/').pop() || source, 60)}"`);
    }
    return `<${item.tag}${shown.join('')}>`;
  }
  function resolveAnchor(index, anchor) {
    if (!validateAnchor(anchor)) return { status: 'missing' };
    const text = typeof index === 'string' ? index : index.text;
    const exact = normalizeText(anchor.quote.exact);
    const { start, end } = anchor.textPosition;
    if (revisionOf(text) === anchor.contentRevision && text.slice(start, end) === exact) {
      return { status: 'matched', start, end };
    }
    const matches = [];
    for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
      if ((!anchor.quote.prefix || text.slice(Math.max(0, at - anchor.quote.prefix.length), at) === anchor.quote.prefix) &&
          (!anchor.quote.suffix || text.slice(at + exact.length, at + exact.length + anchor.quote.suffix.length) === anchor.quote.suffix)) {
        matches.push(at);
      }
    }
    return matches.length === 1 ? { status: 'matched', start: matches[0], end: matches[0] + exact.length } :
      { status: matches.length ? 'ambiguous' : 'missing' };
  }
  function buildTextIndex(root) {
    const points = [], excluded = [];
    let text = '', pending = null;
    const win = root.ownerDocument.defaultView;
    const blocked = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|OPTION|BUTTON|IFRAME|CANVAS|SVG)$/;
    function addSpace(point, virtual = false) { if (text) pending = { ...point, virtual }; }
    function visit(node) {
      if (node.nodeType === 3) {
        for (let i = 0; i < node.data.length; i++) {
          const point = { node, offset: i, end: i + 1 };
          if (/\s/u.test(node.data[i])) { addSpace(point); continue; }
          if (pending) { text += ' '; points.push(pending); pending = null; }
          text += node.data[i]; points.push(point);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const style = win?.getComputedStyle(node);
      if (blocked.test(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true' ||
          node.hasAttribute('data-pages-annotations') || node.isContentEditable ||
          style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') {
        excluded.push(node); return;
      }
      const block = /^(P|DIV|SECTION|ARTICLE|LI|H[1-6]|PRE|BLOCKQUOTE|TR|BR|HR)$/.test(node.tagName);
      if (block && points.length) addSpace(points[points.length - 1], true);
      for (const child of node.childNodes) visit(child);
      if (block && points.length) addSpace(points[points.length - 1], true);
    }
    visit(root);
    return { root, text, points, excluded, contentRevision: revisionOf(text) };
  }
  function selectionAnchor(index, selection) {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!index.root.contains(range.startContainer) || !index.root.contains(range.endContainer)) return null;
    if (index.excluded.some(node => node.contains(range.startContainer) || node.contains(range.endContainer))) return null;
    let exact = range.toString();
    let start = -1, end = -1;
    for (let i = 0; i < index.points.length; i++) {
      const point = index.points[i];
      if (range.comparePoint(point.node, point.offset) === 0 && range.comparePoint(point.node, point.end) === 0) {
        if (start < 0) start = i;
        end = i + 1;
      }
    }
    while (start >= 0 && index.text[start] === ' ') start++;
    while (end > start && index.text[end - 1] === ' ') end--;
    if (start < 0 || end <= start) return null;
    if (index.text.slice(start, end) !== normalizeText(exact)) {
      exact = index.text.slice(start, end).split('').map((character, offset) => index.points[start + offset].virtual ? '\n' : character).join('');
    }
    if (exact.length > LIMITS.quote) return null;
    return { quote: { exact, prefix: index.text.slice(Math.max(0, start - 32), start), suffix: index.text.slice(end, end + 32) },
      textPosition: { start, end, indexVersion: 1 }, contentRevision: index.contentRevision };
  }
  // An element boundary has no caret or text direction of its own; step inward from it to the nearest
  // selected text that is actually rendered (hidden nodes have no rects, displayed spaces do).
  function textBoundary(range, node, offset, atEnd) {
    if (node.nodeType === 3) return { node, offset };
    const doc = range.startContainer.ownerDocument, probe = doc.createRange();
    const walker = doc.createTreeWalker(range.commonAncestorContainer, 4);
    // Start at the child on the selected side of the boundary; with none, step out of the element.
    let start = node.childNodes[atEnd ? offset - 1 : offset], edge = node;
    if (start && atEnd) while (start.lastChild) start = start.lastChild;
    if (!start && !atEnd) while (edge.lastChild) edge = edge.lastChild;
    walker.currentNode = start || edge;
    const step = () => atEnd ? walker.previousNode() : walker.nextNode();
    let text = start?.nodeType === 3 ? start : step();
    for (; text && range.intersectsNode(text); text = step()) {
      const from = text === range.startContainer ? range.startOffset : 0;
      const to = text === range.endContainer ? range.endOffset : text.length;
      if (to <= from) continue;
      probe.setStart(text, from); probe.setEnd(text, to);
      if ([...probe.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) return { node: text, offset: atEnd ? to : from };
    }
    return { node, offset };
  }
  // The point where the pointer released the selection (its focus), as a 1px-wide rect.
  function selectionEndRect(selection) {
    try {
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0), doc = range.startContainer.ownerDocument;
      const fragments = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      if (!fragments.length) return null;
      const origin = doc.createRange(); origin.setStart(selection.anchorNode, selection.anchorOffset);
      const backward = origin.comparePoint(selection.focusNode, selection.focusOffset) < 0;
      const fragment = backward ? fragments[0] : fragments[fragments.length - 1];
      const focus = textBoundary(range, selection.focusNode, selection.focusOffset, !backward);
      const caret = doc.createRange(); caret.setStart(focus.node, focus.offset);
      const point = [...caret.getClientRects()].find(rect => rect.height > 0 && Number.isFinite(rect.left));
      // A caret at a soft wrap or on an empty line sits on another line than the selected text; stay by the text.
      if (point && point.top < fragment.bottom && point.bottom > fragment.top) {
        return { x: point.left, y: fragment.top, width: 1, height: fragment.height };
      }
      const element = focus.node.nodeType === 1 ? focus.node : focus.node.parentElement;
      const rtl = !!element && doc.defaultView?.getComputedStyle(element).direction === 'rtl';
      const left = backward !== rtl;
      return { x: left ? fragment.left : Math.max(fragment.left, fragment.right - 1), y: fragment.top, width: 1, height: fragment.height };
    } catch { return null; }
  }
  function rangeForAnchor(index, anchor) {
    const match = resolveAnchor(index, anchor);
    if (match.status !== 'matched') return null;
    const first = index.points[match.start], last = index.points[match.end - 1];
    if (!first || !last) return null;
    const range = index.root.ownerDocument.createRange();
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.end);
    return range;
  }
  // Keep only known fields: the HTML frame is untrusted and could otherwise pad records to fill storage.
  function elementFields(item) {
    const attrs = {};
    for (const name of ELEMENT_ATTRS) if (typeof item.attrs[name] === 'string') attrs[name] = item.attrs[name];
    return { tag: item.tag, attrs, section: [...item.section], text: item.text, html: item.html, textKey: item.textKey,
      path: item.path, ordinal: item.ordinal, count: item.count };
  }
  function createStore(storage, identity) {
    for (const name of ['baseNamespace', 'viewerScope', 'pageId']) {
      if (typeof identity?.[name] !== 'string' || !identity[name] || identity[name].length > 1024) fail('identity', 'Invalid annotation scope');
    }
    const prefix = 'zylos-pages:annotations:v1:' + ['baseNamespace', 'viewerScope', 'pageId'].map(name => encodeURIComponent(identity[name])).join(':') + ':';
    const run = fn => { try { return fn(); } catch (error) { if (error.annotationError) throw error; fail('storage', 'Browser annotation storage is unavailable or full'); } };
    const validRecord = record => record?.schemaVersion === 1 && typeof record.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(record.id) &&
      record.pageId === identity.pageId && (record.kind === 'element' ? validateElement(record) : record.kind === undefined && validateAnchor(record)) && typeof record.comment === 'string' && !!record.comment.trim() &&
      record.comment.length <= LIMITS.comment && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) &&
      typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
    function snapshot() {
      return run(() => {
        const entries = [];
        for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(prefix)) entries.push({ key, value: storage.getItem(key) }); }
        return entries;
      });
    }
    function read() {
      const records = [], corrupt = [];
      for (const entry of snapshot()) {
        try { const record = JSON.parse(entry.value); if (!validRecord(record) || entry.key !== prefix + record.id) throw new Error(); records.push(record); }
        catch { corrupt.push(entry.key); }
      }
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { records, corrupt };
    }
    function checkComment(comment) { if (typeof comment !== 'string' || !comment.trim() || comment.length > LIMITS.comment) fail('comment', 'Enter a comment of at most 4,000 characters'); }
    function current(id, expected) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) fail('record', 'Invalid annotation');
      const raw = run(() => storage.getItem(prefix + id));
      const expectedRaw = typeof expected === 'string' ? expected : JSON.stringify(expected);
      if (!raw || raw !== expectedRaw) fail('conflict', 'This annotation changed in another tab. Reload before saving');
      let record; try { record = JSON.parse(raw); } catch { fail('record', 'Invalid annotation'); }
      if (!validRecord(record)) fail('record', 'Invalid annotation');
      return record;
    }
    return { prefix, read, snapshot,
      add(anchor, comment) {
        checkComment(comment);
        const element = validateElement(anchor);
        if (!element && !validateAnchor(anchor)) fail('anchor', 'Invalid selected text');
        if (snapshot().length >= LIMITS.records) fail('limit', 'This page has reached its annotation limit');
        const id = global.crypto?.randomUUID?.() || `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const now = new Date().toISOString();
        const record = { schemaVersion: 1, id, pageId: identity.pageId, createdAt: now, updatedAt: now,
          ...(element ? { kind: 'element', element: elementFields(anchor.element) }
            : { quote: { ...anchor.quote }, textPosition: { ...anchor.textPosition }, contentRevision: anchor.contentRevision }), comment };
        run(() => { if (storage.getItem(prefix + id) !== null) fail('conflict', 'Annotation identity collision'); storage.setItem(prefix + id, JSON.stringify(record)); });
        return record;
      },
      update(id, comment, expected) {
        checkComment(comment); const record = current(id, expected);
        record.comment = comment; record.updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString();
        run(() => storage.setItem(prefix + id, JSON.stringify(record))); return record;
      },
      remove(id, expected) { current(id, expected); run(() => storage.removeItem(prefix + id)); },
      clear(entries) {
        if (!Array.isArray(entries)) fail('snapshot', 'Confirmation snapshot is required');
        let removed = 0;
        for (const entry of entries) {
          if (!entry || typeof entry.key !== 'string' || !entry.key.startsWith(prefix) || typeof entry.value !== 'string') fail('snapshot', 'Invalid confirmation snapshot');
        }
        run(() => { for (const entry of entries) if (storage.getItem(entry.key) === entry.value) { storage.removeItem(entry.key); removed++; } });
        return removed;
      }
    };
  }
  function exportMarkdown(records, documentUrl, title = '文档') {
    let url;
    if (documentUrl) {
      try { url = new URL(documentUrl); } catch { fail('url', 'A safe document link is required'); }
    }
    if (url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)) fail('url', 'A safe document link is required');
    // Only the trusted shell supplies this URL. Share bearer paths must never be passed here.
    if (url && /(?:^|\/)s(?:hare)?\//i.test(url.pathname)) fail('url', 'Share credentials cannot be exported');
    const safeUrl = url?.href.replace(/[<>\r\n]/g, character => encodeURIComponent(character));
    const escape = text => text.replace(/([\\`*_{}\[\]<>!#|])/g, '\\$1');
    const sorted = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const header = `# 文档反馈：${escape(String(title).replace(/\s+/g, ' ').slice(0, 500))}\n` +
      (safeUrl ? `文档：<${safeUrl}>\n` : '') +
      '\n请结合原文逐条回应以下批注：问询请直接回答；明确提出修改要求的，请按要求修改并简要说明；意图不明确或涉及方案取舍的，先向我确认。\n\n## 批注\n';
    return header + sorted.map((record, index) => {
      const element = record.kind === 'element';
      if (!(element ? validateElement(record) : validateAnchor(record)) || typeof record.comment !== 'string' || record.comment.length > LIMITS.comment) fail('record', 'Invalid annotation');
      const comment = escape(record.comment).replace(/\r\n|\r/g, '\n').replace(/\n/g, '\n   > ');
      if (element) {
        // Plan v2 format, one line: 「2 定价 › 2.2 功能对比」里的表格 `<table class="pricing">`，文字以"功能 基础版…"开头
        const item = record.element, code = text => '`' + normalizeText(text).replace(/`/g, "'") + '`';
        const moved = record.locationStatus && record.locationStatus !== 'matched' ? '（元素位置已变化）' : '';
        const kind = elementKind(item.tag), what = `${kind} ${code(elementLabel(item))}`;
        const where = item.section.length ? `「${escape(normalizeText(item.section.join(' › ')))}」里的${what}` : what;
        const text = normalizeText(item.text);
        const detail = text ? (text.length > 40 ? `，文字以"${escape(text.slice(0, 40))}…"开头` : `，文字为"${escape(text)}"`)
          : item.html ? `，HTML：${code(item.html)}` : '';
        return `${index + 1}. ${moved}${where}${detail}\n   > 批注：${comment}`;
      }
      const quote = escape(record.quote.exact).replace(/\r\n|\r/g, '\n').replace(/\n/g, '\n   ');
      const mismatch = record.locationStatus && record.locationStatus !== 'matched' ? '（引用位置已变化）' : '';
      return `${index + 1}. 原文${mismatch}：${quote}\n   > 批注：${comment}`;
    }).join('\n');
  }
  // Pick an element under root: hover highlights with a mouse, a tap or click selects, and
  // parent()/child() walk the ancestors of the first chosen element. Clicks inside root are
  // swallowed while picking so links and buttons in the document do not react.
  function createElementPicker(root, { onSelect, onCancel } = {}) {
    const doc = root.ownerDocument, win = doc.defaultView;
    const box = doc.createElement('div');
    box.dataset.pagesAnnotations = ''; box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
      'border:2px solid #6366f1;background:rgba(99,102,241,.12);border-radius:3px;';
    let active = false, selected = null, trail = [], press = null, flashTimer = null;
    const eligible = node => !!node && node.nodeType === 1 && node !== root && root.contains(node) &&
      !node.closest('[data-pages-annotations],#pages-annotations');
    const pointAt = (x, y) => { const node = doc.elementFromPoint(x, y); return eligible(node) ? node : null; };
    function outline(node) {
      const rect = node?.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { box.style.display = 'none'; return null; }
      if (!box.isConnected) doc.documentElement.appendChild(box);
      Object.assign(box.style, { display: 'block', left: `${rect.left - 2}px`, top: `${rect.top - 2}px`, width: `${rect.width + 4}px`, height: `${rect.height + 4}px` });
      return rect;
    }
    function choose(node) {
      selected = node;
      const at = trail.indexOf(node);
      onSelect?.(node, { rect: outline(node), canParent: at >= 0 && at < trail.length - 1, canChild: at > 0 });
    }
    function cancel() { stop(); onCancel?.(); }
    function stop() {
      active = false; selected = null; trail = []; press = null;
      box.style.display = 'none'; doc.documentElement.removeAttribute('data-pages-picking');
    }
    const insideRoot = event => eligible(event.target) || event.target === root;
    doc.addEventListener('pointermove', event => { if (active && !selected && event.pointerType === 'mouse') outline(pointAt(event.clientX, event.clientY)); }, true);
    doc.addEventListener('pointerdown', event => {
      if (!active || !insideRoot(event)) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (event.pointerType === 'mouse') event.preventDefault();
    }, true);
    doc.addEventListener('pointerup', event => {
      if (!active || press?.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10;
      press = null;
      const node = moved ? null : pointAt(event.clientX, event.clientY);
      if (!node) return;
      trail = [];
      for (let part = node; part && part !== root; part = part.parentElement) trail.push(part);
      choose(node);
    }, true);
    doc.addEventListener('click', event => { if (active && insideRoot(event)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    doc.addEventListener('keydown', event => { if (active && event.key === 'Escape') { event.preventDefault(); cancel(); } }, true);
    return {
      get active() { return active; },
      get selected() { return selected; },
      start() { stop(); active = true; doc.documentElement.setAttribute('data-pages-picking', ''); },
      stop, cancel,
      parent() { const at = trail.indexOf(selected); if (at >= 0 && at < trail.length - 1) choose(trail[at + 1]); },
      child() { const at = trail.indexOf(selected); if (at > 0) choose(trail[at - 1]); },
      // Keep the outline on the element while the page scrolls; returns its current rect.
      refresh() { return selected ? outline(selected) : null; },
      flash(node) {
        clearTimeout(flashTimer);
        if (!outline(node)) return null;
        flashTimer = win.setTimeout(() => { if (!active) box.style.display = 'none'; else outline(selected); }, 1400);
        return node.getBoundingClientRect();
      }
    };
  }
  global.PagesAnnotationsCore = Object.freeze({ LIMITS, normalizeText, revisionOf, validateAnchor, resolveAnchor, buildTextIndex, selectionAnchor, selectionEndRect, rangeForAnchor, createStore, exportMarkdown,
    validateElement, validateAny, describeElement, resolveElement, elementLabel, createElementPicker });
})(globalThis);
