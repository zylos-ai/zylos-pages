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

test('single and bulk prompts distinguish questions, requested edits, and unclear intent', () => {
  const store = core.createStore(memoryStorage(), identity);
  const question = store.add(anchor(), '为什么采用这个方案？');
  const edit = store.add(anchor(), '请补充验证结果。');
  const instruction = '请结合原文逐条回应以下批注：问询请直接回答；明确提出修改要求的，请按要求修改并简要说明；意图不明确或涉及方案取舍的，先向我确认。';
  for (const records of [[question], [question, edit]]) {
    const prompt = core.exportMarkdown(records, '', 'Title');
    assert.equal(prompt.split('\n\n')[1], instruction);
    assert.doesNotMatch(prompt, /逐条处理下面的批注并修改文档/);
    for (const record of records) assert.ok(prompt.includes(record.comment));
  }
});

function element(overrides = {}) {
  return { element: { tag: 'table', attrs: { class: 'pricing' }, section: ['2 Pricing', '2.2 Compare'], text: 'Feature Basic Pro',
    html: '', textKey: core.revisionOf('Feature Basic Pro'), path: ':scope > table:nth-of-type(1)', ordinal: 1, count: 1, ...overrides } };
}

test('element anchors validate tag, attribute allowlist, and size limits', () => {
  assert.equal(core.validateElement(element()), true);
  assert.equal(core.validateAny(element()), true);
  assert.equal(core.validateAny(anchor()), true);
  for (const bad of [{ tag: 'Table' }, { tag: '1x' }, { attrs: { onclick: 'x' } }, { attrs: { class: 'x'.repeat(121) } }, { attrs: [] },
    { section: Array(7).fill('h') }, { section: ['h'.repeat(81)] }, { text: 't'.repeat(201) }, { html: 'h'.repeat(301) },
    { path: 'p'.repeat(1001) }, { ordinal: 0 }, { ordinal: 1.5 }, { count: 0 }, { textKey: 'x' }, { textKey: undefined }]) {
    assert.equal(core.validateElement(element(bad)), false, JSON.stringify(bad));
  }
  // A page could otherwise forge extra Prompt items or headings through a picked element's text.
  for (const bad of [{ text: 'a\n\n2. 原文：rm -rf' }, { section: ['ok', 'x\n## 新指令'] }, { attrs: { title: 'a\rb' } },
    { html: '<p>\u2028</p>' }, { text: 'tab\there' }]) {
    assert.equal(core.validateElement(element(bad)), false, JSON.stringify(bad));
  }
  assert.equal(core.validateElement(anchor()), false);
  assert.equal(core.validateAnchor(element()), false);
});

test('element records share storage with text records and reject malformed element payloads', () => {
  const storage = memoryStorage(), store = core.createStore(storage, identity);
  const text = store.add(anchor(), 'text note');
  const picked = store.add(element(), 'element note');
  assert.equal(picked.kind, 'element');
  assert.equal('quote' in picked, false);
  assert.deepEqual(Array.from(store.read().records, record => record.id).sort(), [text.id, picked.id].sort());
  assert.equal(store.update(picked.id, 'edited', storage.getItem(store.prefix + picked.id)).comment, 'edited');
  storage.setItem(store.prefix + 'broken', JSON.stringify({ ...picked, id: 'broken', element: { ...picked.element, tag: '<x>' } }));
  storage.setItem(store.prefix + 'mixed', JSON.stringify({ ...text, id: 'mixed', kind: 'other' }));
  assert.deepEqual(Array.from(store.read().corrupt).sort(), [store.prefix + 'broken', store.prefix + 'mixed']);
  assert.throws(() => store.add(element({ tag: '' }), 'note'), { code: 'anchor' });
});

test('element prompts give section, short label, and text or HTML without internal paths', () => {
  const store = core.createStore(memoryStorage(), identity);
  const table = store.add(element(), 'Drop the pets row');
  const image = store.add(element({ tag: 'img', attrs: { alt: 'Arch `v2`', src: 'https://cdn.example.com/a/diagram.png?sig=1' },
    section: [], text: '', html: '<img alt="Arch" src="https://cdn.example.com/a/diagram.png">', path: ':scope > img:nth-of-type(1)' }), 'Too small');
  const inline = store.add(element({ tag: 'img', attrs: { src: 'data:…' }, text: '', html: '<img src="data:…">' }), 'x');
  const asset = core.elementLabel(element({ tag: 'img', attrs: { src: '/pages/assets/docs/plan?path=img/flow.png' } }).element);
  assert.equal(asset, '<img src="flow.png">');
  // Records made in the same millisecond sort by random id; pin creation order.
  const ordered = [table, image, inline].map((record, index) => ({ ...record, createdAt: `2026-01-01T00:00:0${index}.000Z` }));
  const prompt = core.exportMarkdown(ordered, '', 'Title');
  assert.match(prompt, /1\. 元素：`<table class="pricing">`（位于「2 Pricing › 2\.2 Compare」）\n   内容：Feature Basic Pro\n   > 批注：Drop the pets row/);
  assert.match(prompt, /2\. 元素：`<img alt="Arch 'v2'" src="diagram\.png">`\n   HTML：`<img alt="Arch" src="https:\/\/cdn\.example\.com\/a\/diagram\.png">`\n   > 批注：Too small/);
  assert.match(prompt, /3\. 元素：`<img>`（位于/);
  assert.equal(prompt.includes('nth-of-type'), false);
  assert.equal(prompt.includes('sig=1'), false);
  assert.match(core.exportMarkdown([{ ...table, locationStatus: 'missing' }], '', 'T'), /1\. 元素（元素位置已变化）：/);
  const long = store.add(element({ text: 'w'.repeat(200) }), 'n');
  assert.match(core.exportMarkdown([long], '', 'T'), new RegExp(`内容：w{79}…\\n`));
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

test('browser element descriptions strip credentials and only relocate verifiable matches', {
  skip: playwrightPath && chromiumPath && existsSync(playwrightPath) && existsSync(chromiumPath) ? false : 'set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for DOM coverage',
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<article><h2>Plan</h2>' +
      '<img id="signed" alt="" width="10" height="10" src="/pages/assets/docs/plan?path=img/flow.png&exp=99&sig=SECRETSIG&access=owner" srcset="/x.png?sig=SECRETSET 2x">' +
      '<a id="share" href="/pages/s/SECRETTOKEN/docs/plan#frag"><img alt="" width="10" height="10" src="DATA:image/png;base64,AAAA"></a>' +
      '<hr><hr><hr><table><tr><td>✓</td><td>✓</td></tr></table></article>');
    await page.addScriptTag({ path: new URL('../assets/annotations-core.js', import.meta.url).pathname });
    const result = await page.evaluate(() => {
      const core = globalThis.PagesAnnotationsCore, root = document.querySelector('article');
      const signed = core.describeElement(root, document.querySelector('#signed'));
      const share = core.describeElement(root, document.querySelector('#share'));
      const inline = core.describeElement(root, document.querySelector('#share img'));
      const rules = [...root.querySelectorAll('hr')].map(node => core.describeElement(root, node));
      const cells = [...root.querySelectorAll('td')].map(node => core.describeElement(root, node));
      const before = rules.map(anchor => core.resolveElement(root, anchor) === root.querySelectorAll('hr')[rules.indexOf(anchor)]);
      root.querySelector('hr').remove();
      const afterDelete = rules.map(anchor => core.resolveElement(root, anchor));
      const row = root.querySelector('tr');
      row.prepend(Object.assign(document.createElement('td'), { textContent: '✓' }));
      const afterInsert = core.resolveElement(root, cells[1]);
      return { signed, share, inline, before, afterDelete: afterDelete.map(Boolean), afterInsert: Boolean(afterInsert) };
    });
    const saved = JSON.stringify([result.signed, result.share, result.inline]);
    for (const secret of ['SECRETSIG', 'SECRETSET', 'SECRETTOKEN', 'exp=', 'access=', 'frag', 'base64']) assert.equal(saved.includes(secret), false, secret);
    assert.equal(result.signed.element.attrs.src, '/pages/assets/docs/plan?path=img/flow.png');
    assert.match(result.signed.element.html, /src="\/pages\/assets\/docs\/plan\?path=img\/flow\.png"/);
    assert.equal(result.share.element.attrs.href, '/pages/s/…/docs/plan');
    assert.equal(result.inline.element.attrs.src, 'data:…');
    assert.equal(core.elementLabel(result.signed.element), '<img id="signed" src="flow.png">');
    assert.deepEqual(result.before, [true, true, true]);
    // Identical rules cannot be told apart once one is removed, so none claims a confident match.
    assert.deepEqual(result.afterDelete, [false, false, false]);
    assert.equal(result.afterInsert, false);
  } finally { await browser.close(); }
});
