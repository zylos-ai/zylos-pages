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
  function rangeForAnchor(index, anchor) {
    const match = resolveAnchor(index, anchor);
    if (match.status !== 'matched') return null;
    const first = index.points[match.start], last = index.points[match.end - 1];
    if (!first || !last) return null;
    const range = index.root.ownerDocument.createRange();
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.end);
    return range;
  }
  function createStore(storage, identity) {
    for (const name of ['baseNamespace', 'viewerScope', 'pageId']) {
      if (typeof identity?.[name] !== 'string' || !identity[name] || identity[name].length > 1024) fail('identity', 'Invalid annotation scope');
    }
    const prefix = 'zylos-pages:annotations:v1:' + ['baseNamespace', 'viewerScope', 'pageId'].map(name => encodeURIComponent(identity[name])).join(':') + ':';
    const run = fn => { try { return fn(); } catch (error) { if (error.annotationError) throw error; fail('storage', 'Browser annotation storage is unavailable or full'); } };
    const validRecord = record => record?.schemaVersion === 1 && typeof record.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(record.id) &&
      record.pageId === identity.pageId && validateAnchor(record) && typeof record.comment === 'string' && !!record.comment.trim() &&
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
        checkComment(comment); if (!validateAnchor(anchor)) fail('anchor', 'Invalid selected text');
        if (snapshot().length >= LIMITS.records) fail('limit', 'This page has reached its annotation limit');
        const id = global.crypto?.randomUUID?.() || `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const now = new Date().toISOString();
        const record = { schemaVersion: 1, id, pageId: identity.pageId, createdAt: now, updatedAt: now,
          quote: { ...anchor.quote }, textPosition: { ...anchor.textPosition }, contentRevision: anchor.contentRevision, comment };
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
      if (!validateAnchor(record) || typeof record.comment !== 'string' || record.comment.length > LIMITS.comment) fail('record', 'Invalid annotation');
      const quote = escape(record.quote.exact).replace(/\r\n|\r/g, '\n').replace(/\n/g, '\n   ');
      const comment = escape(record.comment).replace(/\r\n|\r/g, '\n').replace(/\n/g, '\n   > ');
      const mismatch = record.locationStatus && record.locationStatus !== 'matched' ? '（引用位置已变化）' : '';
      return `${index + 1}. 原文${mismatch}：${quote}\n   > 批注：${comment}`;
    }).join('\n');
  }
  global.PagesAnnotationsCore = Object.freeze({ LIMITS, normalizeText, revisionOf, validateAnchor, resolveAnchor, buildTextIndex, selectionAnchor, rangeForAnchor, createStore, exportMarkdown });
})(globalThis);
