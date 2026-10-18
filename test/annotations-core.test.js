import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const context = vm.createContext({ URL, crypto: { randomUUID } });
vm.runInContext(readFileSync(new URL('../assets/annotations-core.js', import.meta.url), 'utf8'), context);
const core = context.PagesAnnotationsCore;
const identity = { baseNamespace: '/pages', viewerScope: 'owner', pageId: 'docs/test' };
function memoryStorage() {
  const map = new Map();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
function anchor(text = 'before quoted text after', exact = 'quoted text') {
  const start = text.indexOf(exact), end = start + exact.length;
  return { quote: { exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) },
    textPosition: { start, end, indexVersion: 1 }, contentRevision: core.revisionOf(text) };
}

test('anchors match a verified offset and uniquely reattach after inserted content', () => {
  const saved = anchor();
  assert.equal(core.resolveAnchor('before quoted text after', saved).start, 7);
  assert.equal(core.resolveAnchor('new before quoted text after', saved).start, 11);
  assert.equal(core.resolveAnchor('before changed text after', saved).status, 'missing');
  const repeated = anchor('word', 'word');
  assert.equal(core.resolveAnchor('word and word', repeated).status, 'ambiguous');
  assert.equal(core.resolveAnchor('word and other', repeated).status, 'matched');
  assert.equal(core.resolveAnchor('word', { ...repeated, textPosition: { start: -1, end: 4, indexVersion: 1 } }).status, 'missing');
});

test('quote and comment limits include UTF-16 boundaries, empty and malformed anchors are rejected', () => {
  assert.equal(core.validateAnchor(anchor('a'.repeat(10000), 'a'.repeat(10000))), true);
  assert.equal(core.validateAnchor(anchor('a'.repeat(10001), 'a'.repeat(10001))), false);
  assert.equal(core.validateAnchor(anchor('😀', '😀')), true);
  assert.equal(core.validateAnchor({ ...anchor(), quote: { exact: ' ', prefix: '', suffix: '' } }), false);
  const store = core.createStore(memoryStorage(), identity);
  assert.throws(() => store.add(anchor(), ' '), { code: 'comment' });
  assert.throws(() => store.add(anchor(), 'x'.repeat(4001)), { code: 'comment' });
  assert.equal(store.add(anchor(), 'x'.repeat(4000)).comment.length, 4000);
});

test('per-record storage restores and separates pages, viewers, and base namespaces', () => {
  const storage = memoryStorage();
  const store = core.createStore(storage, identity);
  const first = store.add(anchor(), 'first');
  const other = core.createStore(storage, { ...identity, pageId: 'different' });
  other.add(anchor(), 'other');
  core.createStore(storage, { ...identity, viewerScope: 'share-1' }).add(anchor(), 'share');
  core.createStore(storage, { ...identity, baseNamespace: '/different' }).add(anchor(), 'base');
  assert.equal(core.createStore(storage, identity).read().records[0].id, first.id);
  assert.equal(store.read().records.length, 1);
  assert.equal(storage.length, 4);
  const edited = store.update(first.id, 'edited', first);
  assert.equal(edited.comment, 'edited');
  assert.throws(() => store.update(first.id, 'stale', first), { code: 'conflict' });
  assert.throws(() => store.remove(first.id, first), { code: 'conflict' });
  store.remove(first.id, edited);
  assert.equal(store.read().records.length, 0);
  assert.equal(other.read().records.length, 1);
});

test('corruption is reported without overwrite and scope clear respects the confirmation snapshot', () => {
  const storage = memoryStorage(), store = core.createStore(storage, identity);
  const first = store.add(anchor(), 'first');
  storage.setItem(store.prefix + 'bad', '{bad');
  storage.setItem('theme', 'dark');
  assert.equal(store.read().corrupt.length, 1);
  const snapshot = store.snapshot();
  const edited = store.update(first.id, 'after confirmation', first);
  const added = store.add(anchor(), 'new tab');
  assert.equal(store.clear(snapshot), 1);
  assert.equal(store.read().records.length, 2);
  assert.equal(store.read().records.some(record => record.id === added.id), true);
  assert.equal(store.read().records.some(record => record.comment === edited.comment), true);
  assert.equal(storage.getItem('theme'), 'dark');
  assert.throws(() => store.clear([{ key: 'theme', value: 'dark' }]), { code: 'snapshot' });
});

test('failed writes preserve the existing record and report storage errors', () => {
  const storage = memoryStorage(), store = core.createStore(storage, identity);
  const saved = store.add(anchor(), 'existing');
  storage.setItem = () => { const error = new Error('quota'); error.name = 'QuotaExceededError'; error.code = 22; throw error; };
  assert.throws(() => store.update(saved.id, 'draft', saved), { code: 'storage' });
  assert.throws(() => store.add(anchor(), 'new draft'), { code: 'storage' });
  assert.equal(store.read().records[0].comment, 'existing');
  const denied = core.createStore({ get length() { throw new Error('SecurityError'); } }, identity);
  assert.throws(() => denied.read(), { code: 'storage' });
});

test('record ceiling counts damaged keys and rejects excess without evicting records', () => {
  const storage = memoryStorage(), store = core.createStore(storage, identity);
  for (let i = 0; i < 200; i++) storage.setItem(store.prefix + 'bad-' + i, 'bad');
  assert.throws(() => store.add(anchor(), 'limit'), { code: 'limit' });
  assert.equal(storage.length, 200);
});

test('simple Markdown export preserves full multiline quote/comment and omits internal metadata', () => {
  const store = core.createStore(memoryStorage(), identity);
  const quote = 'first `code`\n> second [link]';
  const record = store.add(anchor(quote, quote), 'comment *bold*\nnext line');
  const prompt = core.exportMarkdown([record], 'https://example.com/pages/p/docs/test');
  assert.match(prompt, /文档：<https:\/\/example.com\/pages\/p\/docs\/test>/);
  assert.match(prompt, /1\. 原文：first \\`code\\`\n   \\> second \\\[link\\\]/);
  assert.match(prompt, /comment \\\*bold\\\*\n   > next line/);
  assert.match(prompt, /逐条处理下面的批注并修改文档/);
  assert.match(prompt, /有歧义的地方先向我确认/);
  assert.equal(prompt.includes(record.id), false);
  assert.equal(prompt.includes('contentRevision'), false);
  assert.match(core.exportMarkdown([{ ...record, locationStatus: 'missing' }], '', '共享文档'), /^# 文档反馈：共享文档\n[\s\S]*1\. 原文（引用位置已变化）/);
  const two = core.exportMarkdown([record, { ...record, id: 'second', createdAt: record.createdAt }], '', 'Title');
  assert.match(two, /\n   > next line\n2\. 原文/);
  assert.equal(two.includes('---'), false);
  for (const url of ['javascript:alert(1)', 'https://example.com/s/secret', 'https://example.com/share/secret',
    'https://example.com/p/doc?token=secret', 'https://example.com/p/doc#secret', 'https://user:password@example.com/p/doc']) {
    assert.throws(() => core.exportMarkdown([record], url), { code: 'url' });
  }
});

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
test('browser indexes visible text, maps UTF-16 selection across blocks, and rejects controls', {
  skip: playwrightPath && chromiumPath && existsSync(playwrightPath) && existsSync(chromiumPath) ? false : 'set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for DOM coverage',
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<article><p id="one">first <em>quoted</em> text</p><button>skip button</button><p id="two">second 😀 paragraph</p><span hidden>hidden</span><script>invisible text</script><div data-pages-annotations>annotation UI</div></article>');
    await page.addScriptTag({ path: new URL('../assets/annotations-core.js', import.meta.url).pathname });
    const result = await page.evaluate(() => {
      const core = globalThis.PagesAnnotationsCore, root = document.querySelector('article');
      const index = core.buildTextIndex(root), selection = getSelection(), range = document.createRange();
      range.setStart(document.querySelector('#one').firstChild, 0);
      range.setEnd(document.querySelector('#two').firstChild, 9);
      selection.removeAllRanges(); selection.addRange(range);
      const anchor = core.selectionAnchor(index, selection);
      const match = core.resolveAnchor(index, anchor);
      const restored = core.rangeForAnchor(index, anchor);
      range.selectNodeContents(document.querySelector('button'));
      selection.removeAllRanges(); selection.addRange(range);
      const blocked = core.selectionAnchor(index, selection);
      return { text: index.text, anchor, match, blocked, restoredStart: restored.startContainer.textContent, restoredEnd: restored.endOffset };
    });
    assert.equal(result.text, 'first quoted text second 😀 paragraph');
    assert.equal(result.anchor.quote.exact, 'first quoted text\nsecond 😀');
    assert.equal(result.match.status, 'matched');
    assert.equal(result.restoredStart, 'first ');
    assert.equal(result.restoredEnd, 9);
    assert.equal(result.blocked, null);
  } finally { await browser.close(); }
});
