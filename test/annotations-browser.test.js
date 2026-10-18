import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const available = playwrightPath && chromiumPath && fs.existsSync(playwrightPath) && fs.existsSync(chromiumPath);

test('annotation header keeps all controls inside narrow panels at 1, 10 and 200 records', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 60_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const evidenceDir = process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const assets = new Map(['style.css', 'annotations-core.js', 'annotations.js', 'annotations.css'].map(name =>
    [`/${name}`, fs.readFileSync(path.resolve(import.meta.dirname, '../assets', name))]));
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/annotations.css">
    <script src="/annotations-core.js"></script><script src="/annotations.js" defer></script></head>
    <body><main class="markdown-body"><h1>Review notes</h1><p>A passage for annotation review.</p></main>
    <section id="pages-annotations" data-base-namespace="/" data-viewer-scope="owner" data-page-id="narrow-count"></section></body></html>`;
  const server = http.createServer((request, response) => {
    const asset = assets.get(request.url);
    response.setHeader('Content-Type', asset ? request.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
    response.end(asset || fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [320, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 720 } });
      for (const records of [1, 10, 200]) {
        await page.goto(origin);
        await page.evaluate(total => {
          const store = PagesAnnotationsCore.createStore(localStorage, { baseNamespace: '/', viewerScope: 'owner', pageId: 'narrow-count' });
          store.clear(store.snapshot());
          const index = PagesAnnotationsCore.buildTextIndex(document.querySelector('.markdown-body'));
          const exact = 'A passage for annotation review.';
          const start = index.text.indexOf(exact);
          const anchor = { quote: { exact, prefix: '', suffix: '' }, textPosition: { start, end: start + exact.length, indexVersion: 1 }, contentRevision: index.contentRevision };
          for (let i = 0; i < total; i++) store.add(anchor, `Review note ${i + 1}`);
        }, records);
        await page.reload(); await count(page, records); await page.locator('.annotation-launcher').click();
        await page.evaluate(() => {
          document.body.style.fontFamily = 'Arial, sans-serif';
          document.querySelector('.annotation-heading h2').style.fontWeight = '600';
        });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
          const panel = await page.locator('.annotation-panel').boundingBox();
          assert.ok(panel.height <= 520, 'summary is capped rather than growing with the record count');
          assert.equal(await page.locator('.annotation-panel .annotation-toolbar .annotation-primary').innerText(), 'Prompt');
          const scrolling = await page.locator('.annotation-list').evaluate(node => ({ height: node.clientHeight, full: node.scrollHeight }));
          if (records === 1) assert.equal(scrolling.full, scrolling.height, 'a short list does not need scrolling');
          else {
            assert.ok(scrolling.full > scrolling.height, 'long lists scroll within the capped panel');
            const headerBefore = await page.locator('.annotation-panel > .annotation-heading').boundingBox();
            await page.locator('.annotation-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
            assert.equal(await page.locator('.annotation-list').evaluate(node => node.scrollTop > 0), true);
            assert.deepEqual(await page.locator('.annotation-panel > .annotation-heading').boundingBox(), headerBefore, 'header remains fixed while the list scrolls');
            assert.equal(await page.locator('.annotation-panel').evaluate(node => node.scrollTop), 0, 'panel itself does not scroll');
            const last = await page.locator('.annotation-list .annotation-item').last().boundingBox();
            assert.ok(last.y + last.height <= panel.y + panel.height, 'the final annotation remains reachable');
            await page.locator('.annotation-list').evaluate(node => { node.scrollTop = 0; });
          }
          let right = panel.x;
          for (const selector of ['h2', '.annotation-primary', '.annotation-more > button', ':scope > button']) {
            const box = await page.locator('.annotation-panel > .annotation-heading').locator(selector).boundingBox();
            assert.ok(box.x >= right && box.x + box.width <= panel.x + panel.width, `${width}px/${records}/${theme}: ${selector} inside panel and ordered`);
            assert.ok(box.y >= panel.y && box.y + box.height <= panel.y + panel.height, `${selector} inside panel vertically`);
            right = box.x + box.width;
          }
          const heading = page.locator('.annotation-panel > .annotation-heading h2');
          assert.equal(await heading.innerText(), `Annotations · ${records}`);
          assert.equal(await heading.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'count remains visible');
          if (evidenceDir && records > 1) await page.screenshot({ path: path.join(evidenceDir, `header-${width}-${records}-${theme}.png`) });
        }
        await page.setViewportSize({ width, height: 400 });
        const shortPanel = await page.locator('.annotation-panel').boundingBox();
        assert.ok(shortPanel.y >= 0 && shortPanel.y + shortPanel.height <= 400, 'summary respects a short viewport');
        assert.ok(shortPanel.height <= 290, 'viewport cap takes precedence over the fixed maximum');
        await page.setViewportSize({ width, height: 720 });
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'Clear all', exact: true }).isVisible(), true);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        assert.equal(await page.locator('.annotation-panel').isVisible(), false, 'close stays reachable at every count');
      }
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('Markdown annotation index is lazy, reused on long documents, and invalidated by body changes', {
  skip: available ? false : 'set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for browser coverage',
  timeout: 60_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const assets = new Map(['annotations-core.js', 'annotations.js', 'annotations.css'].map(name =>
    [`/${name}`, fs.readFileSync(path.resolve(import.meta.dirname, '../assets', name))]));
  const probe = `window.annotationIndexBuilds = [];
    window.PagesAnnotationsCore = { ...window.PagesAnnotationsCore, buildTextIndex(root) {
      const start = performance.now();
      const index = originalCore.buildTextIndex(root);
      window.annotationIndexBuilds.push(performance.now() - start);
      return index;
    } };`;
  const fixture = `<!doctype html><html><head><title>Long Markdown</title>
    <link rel="stylesheet" href="/annotations.css">
    <script src="/annotations-core.js"></script><script src="/probe.js"></script>
    <script src="/annotations.js" defer></script></head><body>
    <article class="markdown-body"><p id="quote">Unique long document selection.</p>
    <p id="bulk">${'Long readable text. '.repeat(35000)}</p>
    <p id="visibility" hidden>Newly visible selection.</p></article>
    <section id="pages-annotations" data-base-namespace="/" data-viewer-scope="owner"
      data-page-id="long-markdown" data-document-url="/p/long-markdown"></section></body></html>`;
  assert.ok(Buffer.byteLength(fixture) < 1048576, 'fixture stays below the default 1 MiB file limit');
  const server = http.createServer((req, res) => {
    if (assets.has(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
      res.end(assets.get(req.url));
    } else if (req.url === '/probe.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`const originalCore = window.PagesAnnotationsCore;${probe}`);
    } else { res.setHeader('Content-Type', 'text/html'); res.end(fixture); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/p/long-markdown`);
    await page.locator('.annotation-launcher').waitFor();
    const builds = () => page.evaluate(() => window.annotationIndexBuilds.length);
    const settled = () => page.waitForTimeout(350);
    await page.locator('#quote').click();
    await settled();
    assert.equal(await builds(), 0, 'ordinary clicks with zero annotations never index the document');
    await select(page, '#quote', 'Unique long document selection.');
    await page.locator('.annotation-add').waitFor({ state: 'visible' });
    assert.equal(await builds(), 1, 'the first real selection builds one index');
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('#quote'));
      range.setEnd(document.querySelector('#quote').firstChild, 'Unique long document'.length);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await settled();
    assert.equal(await builds(), 1, 'selection adjustment reuses the unchanged index');
    await saveSelection(page, 'Long document comment');
    await count(page, 1);
    await page.locator('.annotation-launcher').click();
    await page.getByRole('button', { name: 'Locate', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.locator('#quote').click();
    await settled();
    assert.equal(await builds(), 1, 'save, locate and highlight clicks reuse the index');

    await page.evaluate(() => { document.querySelector('#bulk').firstChild.data += ' Extra text.'; });
    await settled();
    assert.equal(await builds(), 2, 'characterData invalidates the index');
    await page.evaluate(() => document.querySelector('#visibility').removeAttribute('hidden'));
    await settled();
    assert.equal(await builds(), 3, 'visibility attributes invalidate the index');
    await page.locator('#visibility').scrollIntoViewIfNeeded();
    await select(page, '#visibility', 'Newly visible selection.');
    await page.locator('.annotation-add').waitFor({ state: 'visible' });
    assert.equal(await builds(), 3, 'newly visible text is selectable using the refreshed index');
    await page.evaluate(() => {
      window.getSelection().removeAllRanges();
      const paragraph = document.createElement('p'); paragraph.textContent = 'Inserted selection.';
      document.querySelector('.markdown-body').prepend(paragraph);
    });
    await settled();
    assert.equal(await builds(), 4, 'childList invalidates the index');
    assert.equal(await page.locator('.annotation-unmatched').count(), 0, 'stored quote relocates after insertion');
    await page.evaluate(() => {
      document.querySelector('#quote').textContent = 'The original quote was removed.';
      document.querySelector('.markdown-body').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settled();
    assert.equal(await builds(), 5, 'a same-task click drains pending mutations before reusing the index');
    assert.equal(await page.locator('.annotation-unmatched').count(), 1, 'removed text never uses a stale cached match');
    console.log('Long Markdown index builds:', JSON.stringify(await page.evaluate(() => window.annotationIndexBuilds)));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('annotations persist and manage Markdown and opaque HTML without backend capabilities', {
  skip: available ? false : 'set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for browser coverage',
  timeout: 120_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pages-annotations-data-'));
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'pages-annotations-content-'));
  const evidenceDir = process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR || path.join(dataDir, 'screenshots');
  await mkdir(evidenceDir, { recursive: true });
  process.env.PAGES_DATA_DIR = dataDir;
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const express = (await import('express')).default;
  const { initCache } = await import('../src/cache/pageCache.js');
  const { registerLogicalPage } = await import('../src/pages/page-store.js');
  const { pageRoute } = await import('../src/routes/pages.js');
  const { setupAuth, hashPassword } = await import('../src/security/auth.js');
  const { securityHeaders } = await import('../src/security/headers.js');
  const { setupShareApi } = await import('../src/routes/share-api.js');
  const { createShare } = await import('../src/sharing/share-manager.js');
  const markdown = path.join(contentDir, 'annotations-markdown.md');
  const html = path.join(contentDir, 'annotations-html.html');
  await writeFile(markdown, '# Annotation fixture\n\nA readable passage for persistent annotations.\n\nSecond unique paragraph for a second annotation.\n');
  await writeFile(html, '<!doctype html><html><head><title>HTML annotations</title></head><body><h1>HTML annotation fixture</h1><p id="quote">Opaque sandbox text supports local annotations.</p><p id="second">Another paragraph in this artifact.</p><div style="height:1200px"></div></body></html>');
  const config = {
    contentDir, publicBaseUrl: null,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 }, theme: { codeTheme: 'github-dark' },
    auth: { password: hashPassword('annotation-test') },
    externalFiles: { enabled: true, allowedSources: { content: contentDir } },
  };
  registerLogicalPage({ uri: 'annotations-markdown', title: 'Annotation fixture', sourcePath: markdown, component: 'content' }, config);
  registerLogicalPage({ uri: 'annotations-html', title: 'HTML annotations', sourcePath: html, component: 'content', capabilities: [] }, config);
  registerLogicalPage({ uri: 'annotations-disabled', title: 'Disabled annotations', sourcePath: html, component: 'content', scriptsEnabled: false }, config);
  const firstShare = createShare('annotations-markdown', '24h', { allowPermanent: false });
  const secondShare = createShare('annotations-markdown', '24h', { allowPermanent: false });
  initCache({ maxEntries: 20, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  app.use('/_assets', express.static(path.resolve(import.meta.dirname, '../assets')));
  setupAuth(app, config.auth);
  setupShareApi(app, { enabled: true, allowPermanent: false }, config);
  app.get('/:slug(*)', pageRoute(config));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      const label = viewport.width === 320 ? 'mobile-narrow' : viewport.width === 390 ? 'mobile' : 'desktop';
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      // Capture only annotation messages delivered to the artifact, to verify comment isolation.
      await context.addInitScript(() => {
        window.annotationMessages = [];
        window.addEventListener('message', event => {
          if (event.data?.type !== 'pages-annotations:init' || !event.ports?.[0]) return;
          event.ports[0].addEventListener('message', message => window.annotationMessages.push(message.data));
        });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const bridgeRequests = [];
      page.on('request', request => { if (request.url().includes('/api/bridge/')) bridgeRequests.push(request.url()); });
      await page.goto(`${origin}/login`);
      await page.locator('input[name="password"]').fill('annotation-test');
      await Promise.all([page.waitForURL(`${origin}/`), page.locator('form').press('Enter')]);
      await page.goto(`${origin}/p/annotations-markdown`);
      await page.locator('.annotation-launcher').waitFor();
      await select(page, '.markdown-body p', 'A readable passage for persistent annotations.');
      await page.getByRole('button', { name: 'Annotate', exact: true }).click();
      await page.locator('#annotation-comment').fill(`Private markdown comment ${label}`);
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('zylos-pages:annotations:')) throw new DOMException('Test quota', 'QuotaExceededError');
          return original.call(this, key, value);
        };
        window.restoreAnnotationStorage = () => { Storage.prototype.setItem = original; };
      });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await count(page, 0);
      assert.equal(await page.locator('.annotation-editor').isVisible(), true);
      assert.equal(await page.locator('#annotation-comment').inputValue(), `Private markdown comment ${label}`);
      assert.match(await page.locator('.annotation-status[role="status"]').innerText(), /Could not save/);
      await page.evaluate(() => window.restoreAnnotationStorage());
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await count(page, 1);
      await page.reload();
      await count(page, 1);
      await page.locator('.annotation-launcher').click();
      assert.equal(await page.locator('.annotation-comment').innerText(), `Private markdown comment ${label}`);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('#annotation-comment').fill('Canceled edit');
      await page.locator('.annotation-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.locator('.annotation-comment').innerText(), `Private markdown comment ${label}`);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('#annotation-comment').fill(`Updated markdown comment ${label}`);
      await page.locator('.annotation-editor').getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal(await page.locator('.annotation-comment').innerText(), `Updated markdown comment ${label}`);
      const otherTab = await context.newPage();
      await otherTab.goto(`${origin}/p/annotations-markdown`);
      await otherTab.locator('.annotation-launcher').waitFor();
      await otherTab.evaluate(() => {
        const host = document.getElementById('pages-annotations');
        window.testAnnotationStore = PagesAnnotationsCore.createStore(localStorage, {
          baseNamespace: host.dataset.baseNamespace, viewerScope: host.dataset.viewerScope, pageId: host.dataset.pageId
        });
        const original = window.testAnnotationStore.read().records[0];
        window.testExtraAnnotation = window.testAnnotationStore.add(original, 'Another tab annotation');
      });
      await count(page, 2);
      await page.locator('.annotation-item').first().getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('#annotation-comment').fill('Draft retained after conflict');
      await otherTab.evaluate(() => {
        const original = window.testAnnotationStore.read().records.find(record => record.id !== window.testExtraAnnotation.id);
        window.testAnnotationStore.update(original.id, 'Changed in another tab', original);
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.annotation-comment')].some(node => node.textContent === 'Changed in another tab'));
      await page.locator('.annotation-editor').getByRole('button', { name: 'Save', exact: true }).click();
      assert.match(await page.locator('.annotation-status[role="status"]').innerText(), /Changed in another tab/);
      assert.equal(await page.locator('#annotation-comment').inputValue(), 'Draft retained after conflict');
      assert.equal(await page.locator('.annotation-editor').isVisible(), true);
      await page.locator('.annotation-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
      await otherTab.evaluate(() => window.testAnnotationStore.remove(window.testExtraAnnotation.id, window.testExtraAnnotation));
      await count(page, 1);
      await otherTab.close();
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Clear all', exact: true }).isVisible(), false);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Clear all', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await count(page, 1);
      await snapshot(page, evidenceDir, `${label}-markdown`);
      const lightBackground = await page.locator('.annotation-panel').evaluate(node => getComputedStyle(node).backgroundColor);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      const darkBackground = await page.locator('.annotation-panel').evaluate(node => getComputedStyle(node).backgroundColor);
      assert.notEqual(darkBackground, lightBackground, 'annotation panel must follow dark theme');
      await snapshot(page, evidenceDir, `${label}-markdown-dark`);
      if (viewport.width === 320) await multiCountHeader(page, evidenceDir, label);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      const ownerStorage = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('zylos-pages:annotations:')));
      const shareContext = await browser.newContext({ viewport });
      await shareContext.addInitScript(({ origin, entries }) => {
        if (location.origin !== origin) return;
        for (const [key, value] of entries) if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      }, { origin, entries: ownerStorage });
      const sharePage = await shareContext.newPage();
      await sharePage.goto(`${origin}/s/${firstShare.tokenId}`);
      await count(sharePage, 0);
      await select(sharePage, '.markdown-body p', 'A readable passage for persistent annotations.');
      await saveSelection(sharePage, `Share-only comment ${label}`);
      await count(sharePage, 1);
      await sharePage.reload();
      await count(sharePage, 1);
      await sharePage.locator('.annotation-launcher').click();
      assert.equal(await sharePage.locator('.annotation-comment').innerText(), `Share-only comment ${label}`);
      await denyClipboard(sharePage);
      await sharePage.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
      await sharePage.getByRole('dialog', { name: 'Feedback preview', exact: true }).getByRole('button', { name: 'Copy Prompt', exact: true }).click();
      await sharePage.locator('#annotation-copy-text').waitFor({ state: 'visible' });
      const sharePrompt = await sharePage.locator('#annotation-copy-text').inputValue();
      assert.ok(sharePrompt.includes(`Share-only comment ${label}`));
      assert.equal(sharePrompt.includes(firstShare.tokenId), false, 'export must not disclose bearer share URL');
      assert.equal(sharePrompt.includes('Changed in another tab'), false, 'share must not read owner annotations');
      await sharePage.goto(`${origin}/s/${secondShare.tokenId}`);
      await count(sharePage, 0);
      await count(page, 1);
      assert.equal(await page.locator('.annotation-comment').innerText(), 'Changed in another tab');
      await shareContext.close();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await count(page, 0);
      await page.reload();
      await count(page, 0);

      await page.goto(`${origin}/p/annotations-html`);
      const iframe = await rawFrame(page);
      await iframe.waitForFunction(() => Boolean(window.PagesAnnotationsCore));
      const denied = await iframe.evaluate(() => {
        try { localStorage.getItem('any'); return false; } catch (error) { return error.name === 'SecurityError'; }
      });
      assert.equal(denied, true, 'opaque iframe must not access localStorage');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
        source: window, data: { type: 'pages-annotations:ready', version: 1 }
      })));
      await count(page, 0);
      assert.equal(await page.getByRole('button', { name: 'Annotate', exact: true }).isVisible(), false);
      await select(iframe, '#quote', 'Opaque sandbox text supports local annotations.');
      const privateComment = `HTML private comment ${label}`;
      await saveSelection(page, privateComment);
      await count(page, 1);
      await page.reload();
      await count(page, 1);
      await page.locator('.annotation-launcher').click();
      const restoredFrame = await rawFrame(page);
      await page.getByRole('button', { name: 'Locate', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.annotation-item button')?.disabled);
      await page.getByRole('button', { name: 'Locate', exact: true }).click();
      assert.equal(await page.locator('.annotation-comment').innerText(), privateComment);
      await page.locator('.annotation-panel > .annotation-heading').getByRole('button', { name: 'Close', exact: true }).click();
      await restoredFrame.locator('#quote').click({ position: { x: 25, y: 8 } });
      await page.getByRole('dialog', { name: 'Annotation editor', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.locator('.annotation-view').innerText(), privateComment);
      await page.getByRole('button', { name: 'Close annotation editor', exact: true }).click();
      await page.locator('.annotation-launcher').click();
      assert.equal(await page.locator('.annotation-item.annotation-active').count(), 1);
      // Force the tested clipboard fallback without relying on host clipboard permissions.
      await denyClipboard(page);
      await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
      await page.getByRole('dialog', { name: 'Feedback preview', exact: true }).getByRole('button', { name: 'Copy Prompt', exact: true }).click();
      await page.locator('#annotation-copy-text').waitFor({ state: 'visible' });
      const prompt = await page.locator('#annotation-copy-text').inputValue();
      assert.match(prompt, /Opaque sandbox text supports local annotations\./);
      assert.ok(prompt.includes(privateComment));
      assert.ok(prompt.includes(`${origin}/p/annotations-html`));
      const childMessages = await restoredFrame.evaluate(() => JSON.stringify(window.annotationMessages));
      assert.equal(childMessages.includes(privateComment), false);
      assert.ok(childMessages.includes('anchors'), 'frame should receive only location anchors');
      assert.deepEqual(bridgeRequests, []);
      await page.getByRole('button', { name: 'Close preview', exact: true }).click();
      await snapshot(page, evidenceDir, `${label}-html`);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await snapshot(page, evidenceDir, `${label}-html-dark`);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Clear all', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await count(page, 0);
      await page.goto(`${origin}/p/annotations-disabled`);
      await page.getByRole('button', { name: 'Annotations unavailable', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Annotations unavailable', exact: true }).click();
      assert.match(await page.locator('.annotation-status[role="status"]').innerText(), /Annotations unavailable/);
      const disabledFrame = await rawFrame(page);
      assert.equal(await disabledFrame.locator('script[src*="annotations-frame"]').count(), 0);
      assert.equal(await page.locator('.html-artifact-frame').getAttribute('sandbox'), '');
      assert.deepEqual(errors, [], `${label} browser errors`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }
});

async function select(frame, selector, exact) {
  await frame.locator(selector).first().waitFor();
  await frame.evaluate(({ selector, exact }) => {
    const target = [...document.querySelectorAll(selector)].find(node => node.textContent === exact);
    if (!target) throw new Error(`Missing selection text: ${exact}`);
    const range = document.createRange(); range.selectNodeContents(target);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, { selector, exact });
}

async function saveSelection(page, comment) {
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.locator('#annotation-comment').fill(comment);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

async function count(page, expected) {
  await page.waitForFunction(value => document.querySelector('.annotation-launcher')?.getAttribute('aria-label') === `Annotations (${value})`, expected);
}

async function rawFrame(page) {
  const element = await page.locator('.html-artifact-frame').elementHandle();
  const frame = await element.contentFrame();
  await frame.waitForURL(/raw=1/);
  return frame;
}

async function snapshot(page, directory, label) {
  await page.screenshot({ path: path.join(directory, `${label}.png`), fullPage: true });
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth }));
  assert.ok(dimensions.body <= dimensions.viewport + 1, `${label} has horizontal overflow`);
  const panel = await page.locator('.annotation-panel').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width + 1, `${label} panel fits horizontally`);
  assert.ok(panel.y >= 0 && panel.y + panel.height <= viewport.height, `${label} panel fits vertically`);
  assert.equal(await page.locator('.annotation-panel > .annotation-heading h2').innerText(), 'Annotations · 1');
  const heading = page.locator('.annotation-panel > .annotation-heading');
  const title = await heading.locator('h2').boundingBox();
  const copy = await heading.getByRole('button', { name: 'Copy Prompt', exact: true }).boundingBox();
  const more = await heading.getByRole('button', { name: 'More actions', exact: true }).boundingBox();
  const close = await heading.getByRole('button', { name: 'Close', exact: true }).boundingBox();
  assert.ok(title.x + title.width <= copy.x && copy.x + copy.width <= more.x && more.x + more.width <= close.x, `${label} header controls do not overlap`);
  assert.ok(Math.abs(title.y + title.height / 2 - copy.y - copy.height / 2) < 2, `${label} copy aligns with title`);
  assert.equal(copy.height, 30);
  assert.equal(await page.locator('.annotation-panel > .annotation-toolbar').count(), 0, 'no standalone toolbar row');
  if (label.includes('markdown')) assert.ok(panel.height < 280, `${label} one-record panel is shorter than the previous 319px desktop / 312px mobile layout`);
  console.log(`${label} panel height: ${panel.height}px`);
  for (const name of ['Locate', 'Edit', 'Delete']) {
    const control = page.locator('.annotation-item-actions').getByRole('button', { name, exact: true });
    assert.equal(await control.getAttribute('title'), name);
    assert.equal(await control.locator('svg').count(), 1);
  }
}

async function denyClipboard(page) {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: () => Promise.reject(new Error('test denial')) }
  }));
}

async function multiCountHeader(page, directory, label) {
  for (const total of [10, 200]) {
    await page.evaluate(count => {
      const host = document.getElementById('pages-annotations');
      const store = PagesAnnotationsCore.createStore(localStorage, { baseNamespace: host.dataset.baseNamespace, viewerScope: host.dataset.viewerScope, pageId: host.dataset.pageId });
      const anchor = store.read().records[0];
      window.headerExtraRecords ||= [];
      for (let i = store.read().records.length; i < count; i++) window.headerExtraRecords.push(store.add(anchor, `Extra note ${i}`));
      window.dispatchEvent(new StorageEvent('storage', { key: store.prefix }));
    }, total);
    await count(page, total);
    const panel = await page.locator('.annotation-panel').boundingBox();
    for (const name of ['Copy Prompt', 'More actions', 'Close']) {
      const box = await page.locator('.annotation-panel > .annotation-heading').getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width, `${total} records: ${name} stays inside real page panel`);
    }
    await page.screenshot({ path: path.join(directory, `${label}-${total}-records.png`) });
  }
  await page.evaluate(() => {
    const host = document.getElementById('pages-annotations');
    const store = PagesAnnotationsCore.createStore(localStorage, { baseNamespace: host.dataset.baseNamespace, viewerScope: host.dataset.viewerScope, pageId: host.dataset.pageId });
    for (const record of window.headerExtraRecords) store.remove(record.id, record);
    window.headerExtraRecords = [];
    window.dispatchEvent(new StorageEvent('storage', { key: store.prefix }));
  });
  await count(page, 1);
}
