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
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const label = viewport.width === 390 ? 'mobile' : 'desktop';
      const context = await browser.newContext({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390 });
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
      await page.getByRole('button', { name: 'Clear all', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await count(page, 1);
      await snapshot(page, evidenceDir, `${label}-markdown`);
      const lightBackground = await page.locator('.annotation-panel').evaluate(node => getComputedStyle(node).backgroundColor);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      const darkBackground = await page.locator('.annotation-panel').evaluate(node => getComputedStyle(node).backgroundColor);
      assert.notEqual(darkBackground, lightBackground, 'annotation panel must follow dark theme');
      await snapshot(page, evidenceDir, `${label}-markdown-dark`);
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
      await page.locator('.annotation-heading').getByRole('button', { name: 'Close', exact: true }).click();
      await restoredFrame.locator('#quote').click({ position: { x: 25, y: 8 } });
      await page.locator('.annotation-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.annotation-item.annotation-active').count(), 1);
      // Force the tested clipboard fallback without relying on host clipboard permissions.
      await denyClipboard(page);
      await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
      await page.locator('#annotation-copy-text').waitFor({ state: 'visible' });
      const prompt = await page.locator('#annotation-copy-text').inputValue();
      assert.match(prompt, /Opaque sandbox text supports local annotations\./);
      assert.ok(prompt.includes(privateComment));
      assert.ok(prompt.includes(`${origin}/p/annotations-html`));
      const childMessages = await restoredFrame.evaluate(() => JSON.stringify(window.annotationMessages));
      assert.equal(childMessages.includes(privateComment), false);
      assert.ok(childMessages.includes('anchors'), 'frame should receive only location anchors');
      assert.deepEqual(bridgeRequests, []);
      await snapshot(page, evidenceDir, `${label}-html`);
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
  await page.waitForFunction(value => document.querySelector('.annotation-launcher')?.textContent === `Annotations (${value})`, expected);
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
}

async function denyClipboard(page) {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: () => Promise.reject(new Error('test denial')) }
  }));
}
