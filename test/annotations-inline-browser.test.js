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
const quote = 'First passage for inline annotation.';
const secondQuote = 'Second passage for a fresh selection.';

test('inline editor dismisses drafts, preserves edits, and previews the full copied feedback in Markdown and opaque HTML', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 180_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pages-inline-data-'));
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'pages-inline-content-'));
  const evidenceDir = process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  process.env.PAGES_DATA_DIR = dataDir;
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const express = (await import('express')).default;
  const { initCache } = await import('../src/cache/pageCache.js');
  const { registerLogicalPage } = await import('../src/pages/page-store.js');
  const { pageRoute } = await import('../src/routes/pages.js');
  const { setupAuth, hashPassword } = await import('../src/security/auth.js');
  const { securityHeaders } = await import('../src/security/headers.js');
  const config = {
    contentDir, publicBaseUrl: null,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 }, theme: { codeTheme: 'github-dark' },
    auth: { password: hashPassword('inline-test') },
    externalFiles: { enabled: true, allowedSources: { content: contentDir } },
  };
  for (const kind of ['markdown', 'html']) {
    const sourcePath = path.join(contentDir, `inline.${kind === 'html' ? 'html' : 'md'}`);
    await writeFile(sourcePath, kind === 'html'
      ? `<!doctype html><html><head><title>Inline fixture</title></head><body><h1>Inline fixture</h1><p>${quote}</p><p>${secondQuote}</p>${'<p>Background passage for scrolling.</p>'.repeat(80)}</body></html>`
      : `# Inline fixture\n\n${quote}\n\n${secondQuote}\n\n${'Background passage for scrolling.\n\n'.repeat(80)}`);
    registerLogicalPage({ uri: `inline-${kind}`, title: 'Inline fixture', sourcePath, component: 'content', capabilities: [] }, config);
  }
  initCache({ maxEntries: 20, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  app.use('/_assets', express.static(path.resolve(import.meta.dirname, '../assets')));
  setupAuth(app, config.auth);
  app.get('/:slug(*)', pageRoute(config));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500, hasTouch: width < 500 });
      await context.addInitScript(() => {
        if (window !== window.parent) {
          window.inlineDeferredClears = [];
          const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
          Object.defineProperty(MessagePort.prototype, 'onmessage', {
            ...descriptor,
            set(handler) {
              descriptor.set.call(this, event => {
                if (window.inlineHoldClear && event.data?.type === 'selection-clear') {
                  window.inlineDeferredClears.push(() => handler.call(this, event));
                } else handler.call(this, event);
              });
            },
          });
        }
        window.inlineCopies = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => { window.inlineCopies.push(text); },
        } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login`);
      await page.locator('input[name="password"]').fill('inline-test');
      await Promise.all([page.waitForURL(`${origin}/`), page.locator('form').press('Enter')]);
      for (const kind of ['markdown', 'html']) {
        await page.goto(`${origin}/p/inline-${kind}`);
        await count(page, 0);
        let target = await documentFrame(page, kind);
        const editor = page.getByRole('dialog', { name: 'Annotation editor', exact: true });
        if (kind === 'html') {
          for (let attempt = 0; attempt < 5; attempt++) {
            await select(target, quote);
            await page.locator('.annotation-add').waitFor({ state: 'visible' });
            await target.evaluate(() => { window.inlineHoldClear = true; });
            await page.locator('.annotation-add').click();
            await editor.waitFor({ state: 'visible' });
            await target.waitForFunction(() => window.inlineDeferredClears.length === 1);
            await select(target, secondQuote);
            await target.evaluate(() => {
              window.inlineHoldClear = false;
              window.inlineDeferredClears.splice(0).forEach(deliver => deliver());
            });
            assert.equal(await target.evaluate(() => getSelection().toString()), secondQuote,
              'late editor clear preserves the immediately replaced native selection');
            await page.locator('.annotation-add').waitFor({ state: 'visible' });
            await editor.waitFor({ state: 'hidden' });
            await page.locator('.annotation-add').click();
            await editor.waitFor({ state: 'visible' });
            assert.equal(await editor.locator('.annotation-quote').innerText(), secondQuote);
            await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
          }
        }
        await select(target, quote);
        await page.locator('.annotation-add').waitFor({ state: 'visible' });
        await target.locator('body').press('Escape');
        await page.waitForTimeout(300);
        assert.equal(await page.locator('.annotation-add').isVisible(), false, 'Escape cannot resurrect the selection trigger on keyup');
        // Each dismissal must release the old empty draft so a different quote can be annotated.
        for (const dismissal of ['close', 'cancel', 'escape', 'outside', 'summary', 'selection']) {
          await select(target, quote);
          await page.locator('.annotation-add').waitFor({ state: 'visible' });
          const trigger = await page.locator('.annotation-add').boundingBox();
          assert.equal(trigger.height, 25, 'selection launcher retains its compact height');
          assert.ok(trigger.width <= 80, 'selection launcher stays compact');
          await page.locator('.annotation-add').click();
          await editor.waitFor({ state: 'visible' });
          assert.equal(await page.locator('.annotation-panel').isVisible(), false, 'selection opens an inline editor independently of the summary');
          if (dismissal === 'close') await editor.getByRole('button', { name: 'Close annotation editor', exact: true }).click();
          if (dismissal === 'cancel') await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
          if (dismissal === 'escape') await page.keyboard.press('Escape');
          if (dismissal === 'outside') await page.mouse.click(2, 2);
          if (dismissal === 'summary') {
            await page.locator('.annotation-launcher').click();
            await page.locator('.annotation-panel').waitFor({ state: 'visible' });
            await page.getByRole('button', { name: 'Close', exact: true }).click();
          }
          if (dismissal !== 'selection') await editor.waitFor({ state: 'hidden' });
          await select(target, secondQuote);
          await page.locator('.annotation-add').waitFor({ state: 'visible' });
          await page.locator('.annotation-add').click();
          await editor.waitFor({ state: 'visible' });
          assert.equal(await editor.locator('.annotation-quote').innerText(), secondQuote, `${dismissal}: next selection replaces the dismissed anchor`);
          assert.equal(await editor.locator('#annotation-comment').inputValue(), '', `${dismissal}: empty draft does not leak`);
          await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
          await count(page, 0);
        }
        const comment = 'First comment line\nSecond comment line';
        await select(target, quote);
        await page.locator('.annotation-add').click();
        await editor.locator('#annotation-comment').fill(comment);
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
          await fits(page, editor, `${kind}/${width}/${theme} editor`);
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `inline-${kind}-${width}-${theme}.png`) });
        }
        await editor.getByRole('button', { name: 'Save', exact: true }).click();
        await count(page, 1);
        await editor.waitFor({ state: 'hidden' });
        await page.reload();
        await count(page, 1);
        target = await documentFrame(page, kind);
        if (kind === 'html') await target.waitForFunction(() => [...CSS.highlights.values()].some(highlight => highlight.size > 0));
        await target.evaluate(() => getSelection().removeAllRanges());
        await target.locator('p').filter({ hasText: quote }).click({ position: { x: 15, y: 8 } });
        await editor.waitFor({ state: 'visible' });
        assert.equal(await editor.locator('.annotation-view').innerText(), comment, 'saved highlight opens the persisted comment in place');
        await editor.getByRole('button', { name: 'Edit', exact: true }).click();
        await editor.locator('#annotation-comment').fill('Canceled replacement');
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.locator('.annotation-launcher').click();
        assert.equal(await page.locator('.annotation-comment').innerText(), comment, 'cancel preserves stored comment');
        await page.locator('.annotation-item').getByRole('button', { name: 'Edit', exact: true }).click();
        await editor.locator('#annotation-comment').fill(`${comment}\nSaved third line`);
        await editor.getByRole('button', { name: 'Save', exact: true }).click();
        const saved = `${comment}\nSaved third line`;
        await page.locator('.annotation-panel').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.annotation-comment').innerText(), saved);
        await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
        const preview = page.getByRole('dialog').filter({ has: page.locator('#annotation-copy-text') });
        await preview.waitFor({ state: 'visible' });
        assert.equal(await preview.locator('label').count(), 0, 'preview has no redundant copy label');
        assert.equal(await preview.getByRole('button', { name: 'View annotations', exact: true }).count(), 0, 'preview has no redundant return button');
        assert.equal(await preview.getByRole('textbox', { name: 'Feedback prompt' }).count(), 1, 'prompt keeps an accessible name');
        assert.deepEqual(await page.evaluate(() => window.inlineCopies), [], 'preview opens before any clipboard write');
        const text = await preview.locator('#annotation-copy-text').inputValue();
        assert.ok(text.includes(quote), 'preview includes original quote');
        assert.match(text, /1\. /, 'compact Markdown uses a numbered annotation');
        assert.match(text, /\n\s+> .*First comment line\n\s+> Second comment line\n\s+> Saved third line/, 'each multiline comment line stays in the Markdown quote');
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
          await fits(page, preview, `${kind}/${width}/${theme} preview`);
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `preview-${kind}-${width}-${theme}.png`) });
        }
        await preview.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.inlineCopies), [text], 'Copy Prompt copies exactly the displayed full preview');
        await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
        await preview.waitFor({ state: 'hidden' });
        await page.reload();
        await count(page, 1);
        await page.locator('.annotation-launcher').click();
        assert.equal(await page.locator('.annotation-comment').innerText(), saved, 'saved edit persists across reload');
        target = await documentFrame(page, kind);
        await target.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(300);
        await page.locator('.annotation-item').getByRole('button', { name: 'Edit', exact: true }).click();
        await editor.waitFor({ state: 'visible' });
        await page.waitForTimeout(350);
        assert.equal(await editor.isVisible(), true, 'Edit remains open after scrolling an offscreen saved quote into view');
        assert.ok(await target.evaluate(() => scrollY < 300), 'Edit locates the original passage');
        await editor.locator('#annotation-comment').fill('Draft retained while scrolling');
        await target.evaluate(() => scrollBy(0, 100));
        await page.waitForTimeout(350);
        assert.equal(await editor.isVisible(), true, 'scrolling repositions rather than dropping an open draft');
        assert.equal(await editor.locator('#annotation-comment').inputValue(), 'Draft retained while scrolling');
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      assert.deepEqual(errors, [], `${width}px browser errors`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }
});

async function documentFrame(page, kind) {
  if (kind === 'markdown') return page;
  const handle = await page.locator('.html-artifact-frame').elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForURL(/raw=1/);
  await frame.waitForFunction(() => Boolean(window.PagesAnnotationsCore));
  return frame;
}

async function select(target, text) {
  await target.evaluate(text => {
    const paragraph = [...document.querySelectorAll('p')].find(node => node.textContent === text);
    if (!paragraph) throw new Error(`Missing fixture paragraph: ${text}`);
    const range = document.createRange(); range.selectNodeContents(paragraph);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, text);
}

async function count(page, expected) {
  await page.waitForFunction(value => document.querySelector('.annotation-launcher')?.getAttribute('aria-label') === `Annotations (${value})`, expected);
}

async function fits(page, locator, label) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label} stays inside viewport`);
  for (const button of await locator.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    if (bounds) assert.ok(bounds.x >= box.x && bounds.x + bounds.width <= box.x + box.width + 1, `${label}: ${await button.getAttribute('aria-label') || await button.innerText()} remains reachable`);
  }
}
