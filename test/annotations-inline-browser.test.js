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
        } else {
          window.inlineDeferredLocations = [];
          const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
          Object.defineProperty(MessagePort.prototype, 'onmessage', {
            ...descriptor,
            set(handler) {
              descriptor.set.call(this, event => {
                if (window.inlineHoldLocations && event.data?.type === 'locations') {
                  window.inlineDeferredLocations.push(() => handler.call(this, event));
                } else handler.call(this, event);
              });
            },
          });
        }
        window.inlineCopies = [];
        window.inlineCopyAttempts = 0;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => {
            window.inlineCopyAttempts++;
            if (window.inlineCopyMode === 'reject') throw new Error('Clipboard denied');
            if (window.inlineCopyMode === 'hold') await new Promise((resolve, reject) => { window.inlineCopyResult = { resolve, reject }; });
            window.inlineCopies.push(text);
          },
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
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), width === 320 ? 'light' : 'dark');
        await preview.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
        await preview.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.inlineCopies), [text], 'Copy Prompt copies exactly the displayed full preview');
        const copyButton = preview.locator('.annotation-actions button');
        const copyWidth = (await copyButton.boundingBox()).width;
        await page.evaluate(() => { window.inlineCopyMode = 'hold'; });
        await copyButton.click();
        assert.equal(await copyButton.innerText(), 'Copying...');
        assert.equal(await copyButton.isDisabled(), true);
        assert.equal(await copyButton.getAttribute('aria-busy'), 'true');
        await copyButton.dispatchEvent('click');
        assert.equal(await page.evaluate(() => window.inlineCopyAttempts), 2, 'pending copy rejects duplicate activation');
        if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `copy-pending-${kind}-${width}.png`) });
        await page.evaluate(() => window.inlineCopyResult.resolve());
        await preview.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        assert.equal(await copyButton.isDisabled(), false);
        assert.equal((await copyButton.boundingBox()).width, copyWidth, 'copy states keep a stable button width');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await copyButton.locator('svg').evaluate(node => getComputedStyle(node).animationName), 'none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `copy-success-${kind}-${width}.png`) });
        await page.evaluate(() => { window.inlineCopyMode = 'reject'; });
        await copyButton.click();
        await preview.getByRole('button', { name: 'Copy failed', exact: true }).waitFor();
        assert.match(await preview.locator('.annotation-preview-status').innerText(), /Clipboard unavailable/);
        assert.equal(await preview.locator('#annotation-copy-text').evaluate(node => node.selectionEnd - node.selectionStart), text.length);
        if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `copy-failure-${kind}-${width}.png`) });
        for (const outcome of ['resolve', 'reject']) {
          await page.evaluate(() => { window.inlineCopyMode = 'hold'; });
          await copyButton.click();
          await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
          await page.locator('.annotation-panel').getByRole('button', { name: 'Copy Prompt', exact: true }).click();
          await page.evaluate(result => window.inlineCopyResult[result](), outcome);
          assert.equal(await copyButton.innerText(), 'Copy Prompt', 'old clipboard result cannot change a reopened preview');
          assert.equal(await preview.locator('.annotation-preview-status').innerText(), '1 annotation(s)');
        }
        await page.evaluate(() => { window.inlineCopyMode = ''; });
        await copyButton.click();
        await preview.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        await preview.locator('#annotation-copy-text').evaluate(node => { node.value = 'x'.repeat(100001); });
        const attempts = await page.evaluate(() => window.inlineCopyAttempts);
        await copyButton.click();
        await preview.getByRole('button', { name: 'Copy manually', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.inlineCopyAttempts), attempts, 'large prompt uses manual copy without a clipboard write');
        assert.equal(await preview.locator('#annotation-copy-text').evaluate(node => node.selectionEnd - node.selectionStart), 100001);
        await preview.locator('#annotation-copy-text').evaluate((node, value) => { node.value = value; }, text);
        await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
        await copyButton.click();
        await preview.getByRole('button', { name: 'Copy failed', exact: true }).waitFor();
        assert.equal(await preview.locator('#annotation-copy-text').evaluate(node => node.selectionEnd - node.selectionStart), text.length, 'missing Clipboard API retains manual fallback');
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
        const deletion = page.locator('.annotation-item').getByRole('button', { name: 'Delete', exact: true });
        const confirmation = page.getByRole('dialog', { name: 'Delete this annotation?', exact: true });
        for (const height of [900, 400]) {
          await page.setViewportSize({ width, height });
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
            const before = await page.locator('.annotation-list').boundingBox();
            await deletion.click();
            await confirmation.waitFor({ state: 'visible' });
            await fits(page, confirmation, 'delete confirmation');
            assert.deepEqual(await page.locator('.annotation-list').boundingBox(), before, 'floating confirmation does not shift the list');
            assert.equal(await confirmation.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => node === document.activeElement), true, 'safe Cancel receives focus');
            if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `delete-${kind}-${width}-${height}-${theme}.png`) });
            await page.keyboard.press('Escape');
            assert.equal(await confirmation.isVisible(), false);
            assert.equal(await page.locator('.annotation-panel').isVisible(), true, 'Escape cancels without closing the list');
            const focus = await page.evaluate(() => {
              const current = document.querySelector('.annotation-item button[aria-label="Delete"]');
              return { matches: current === document.activeElement, active: document.activeElement?.outerHTML?.slice(0, 200) };
            });
            assert.equal(focus.matches, true, JSON.stringify({ kind, width, height, theme, focus }));
            await count(page, 1);
          }
        }
        await deletion.click();
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        await count(page, 1);
        assert.equal(await deletion.evaluate(node => node === document.activeElement), true);
        await deletion.click();
        await page.mouse.click(2, 2);
        assert.equal(await confirmation.isVisible(), false, 'outside click cancels');
        await page.locator('.annotation-panel').waitFor({ state: 'hidden' });
        await count(page, 1);
        await page.locator('.annotation-launcher').click();
        if (kind === 'html') {
          for (const cancellation of ['escape', 'cancel']) {
            for (const moveFocus of [false, true]) {
              await page.evaluate(() => { window.inlineHoldLocations = true; });
              await target.evaluate(() => window.dispatchEvent(new Event('resize')));
              await page.waitForFunction(() => window.inlineDeferredLocations.length > 0);
              await deletion.click();
              if (cancellation === 'escape') await page.keyboard.press('Escape');
              else await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
              assert.equal(await deletion.evaluate(node => node === document.activeElement), true, 'cancel restores focus before held locations are delivered');
              const close = page.locator('.annotation-panel > .annotation-heading').getByRole('button', { name: 'Close', exact: true });
              if (moveFocus) await close.focus();
              await page.evaluate(() => {
                window.inlineHoldLocations = false;
                window.inlineDeferredLocations.splice(0).forEach(deliver => deliver());
              });
              assert.equal(await (moveFocus ? close : deletion).evaluate(node => node === document.activeElement), true,
                moveFocus ? 'late locations cannot steal focus moved outside the list' : 'late locations preserve the restored current Delete action');
              await count(page, 1);
            }
          }
          await deletion.click();
          await target.locator('body').click({ position: { x: 2, y: 310 } });
          await confirmation.waitFor({ state: 'hidden' });
          await page.locator('.annotation-panel').waitFor({ state: 'hidden' });
          await count(page, 1);
          await page.locator('.annotation-launcher').click();
        }
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        const clearConfirmation = page.locator('.annotation-confirmation');
        await fits(page, clearConfirmation, 'clear all confirmation');
        await clearConfirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'More actions', exact: true }).evaluate(node => node === document.activeElement), true);
        await count(page, 1);
        await deletion.click();
        await page.evaluate(() => {
          const host = document.getElementById('pages-annotations');
          const store = PagesAnnotationsCore.createStore(localStorage, {
            baseNamespace: host.dataset.baseNamespace, viewerScope: host.dataset.viewerScope, pageId: host.dataset.pageId,
          });
          const record = store.read().records[0];
          store.update(record.id, 'Changed while confirmation was open', record);
        });
        await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
        assert.equal(await confirmation.isVisible(), true, 'stale confirmation cannot delete a changed record');
        assert.match(await page.locator('.annotation-status[role="status"]').innerText(), /Changed in another tab/);
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.reload();
        await count(page, 1);
        await page.locator('.annotation-launcher').click();
        assert.equal(await page.locator('.annotation-comment').innerText(), 'Changed while confirmation was open');
        await deletion.click();
        await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
        await count(page, 0);
        await page.reload();
        await count(page, 0);
        await page.setViewportSize({ width, height: 900 });
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
