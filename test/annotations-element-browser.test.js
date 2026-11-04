import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const available = playwrightPath && chromiumPath && fs.existsSync(playwrightPath) && fs.existsSync(chromiumPath);
const image = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%2260%22%3E%3Crect width=%22200%22 height=%2260%22 fill=%22%236366f1%22/%3E%3C/svg%3E';

test('element annotations pick, walk ancestors, save, export and relocate in Markdown and opaque HTML', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 180_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pages-element-data-'));
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'pages-element-content-'));
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
    toc: { minHeadings: 99 }, theme: { codeTheme: 'github-dark' },
    auth: { password: hashPassword('element-test') },
    externalFiles: { enabled: true, allowedSources: { content: contentDir } },
  };
  const filler = '<p>Background passage for scrolling.</p>'.repeat(30);
  for (const kind of ['markdown', 'html']) {
    const sourcePath = path.join(contentDir, `element.${kind === 'html' ? 'html' : 'md'}`);
    await writeFile(sourcePath, kind === 'html'
      ? `<!doctype html><html><head><title>Element fixture</title></head><body><h1>Pawly plans</h1><h2>1 Background</h2><p>Intro passage.</p>` +
        `<img alt="Architecture" src="${image}"><h2>2 Pricing</h2><h3>2.2 Compare</h3>` +
        '<table class="pricing"><tr><th>Feature</th><th>Basic</th><th>Pro</th></tr><tr><td>Pets</td><td>1</td><td>3</td></tr></table>' +
        `<p><a href="https://example.com/subscribe">Subscribe now</a></p>${filler}</body></html>`
      : '# Pawly plans\n\n## 1 Background\n\nIntro passage.\n\n## 2 Pricing\n\n### 2.2 Compare\n\n' +
        '| Feature | Basic | Pro |\n|---|---|---|\n| Pets | 1 | 3 |\n\n[Subscribe now](https://example.com/subscribe)\n\n' +
        'Background passage for scrolling.\n\n'.repeat(30));
    registerLogicalPage({ uri: `element-${kind}`, title: 'Element fixture', sourcePath, component: 'content', capabilities: [] }, config);
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
    for (const width of [1280, 390]) {
      const touch = width < 500;
      const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: touch, hasTouch: touch });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/login`);
      await page.locator('input[name="password"]').fill('element-test');
      await Promise.all([page.waitForURL(`${origin}/`), page.locator('form').press('Enter')]);
      const press = async locator => {
        await locator.evaluate(node => node.scrollIntoView({ block: 'center' }));
        const box = await locator.boundingBox();
        if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      for (const kind of ['markdown', 'html']) {
        await page.goto(`${origin}/p/element-${kind}`);
        const target = await documentFrame(page, kind);
        const pick = page.getByRole('button', { name: 'Select element', exact: true });
        const bar = page.getByRole('toolbar', { name: 'Select element', exact: true });
        const label = bar.locator('.annotation-pick-label');
        await count(page, 0);
        await pick.click();
        await bar.waitFor();
        assert.match(await label.innerText(), /Click or tap an element/);

        // A link is selected, not followed, while picking.
        const urlBefore = kind === 'html' ? target.url() : page.url();
        await press(target.locator('a', { hasText: 'Subscribe now' }));
        await page.waitForFunction(() => /^<a/.test(document.querySelector('.annotation-pick-label')?.textContent || ''));
        assert.equal(kind === 'html' ? target.url() : page.url(), urlBefore, `${kind}/${width}: link did not navigate`);

        const cell = target.locator('td', { hasText: '3' });
        await press(cell);
        await page.waitForFunction(() => /^<td/.test(document.querySelector('.annotation-pick-label')?.textContent || ''));
        assert.equal(await bar.getByRole('button', { name: 'Child', exact: true }).isDisabled(), true);
        // Opaque HTML answers over the MessagePort, so wait for each step before reading the label again.
        for (let i = 0; i < 4 && !/^<table/.test(await label.innerText()); i++) {
          const before = await label.textContent();
          await bar.getByRole('button', { name: 'Parent', exact: true }).click();
          await page.waitForFunction(before => document.querySelector('.annotation-pick-label')?.textContent !== before, before);
        }
        assert.match(await label.innerText(), /^<table/);
        assert.equal(await bar.getByRole('button', { name: 'Child', exact: true }).isDisabled(), false);

        // The toolbar sits right next to the chosen element.
        const table = await target.locator('table').boundingBox(), toolbar = await bar.boundingBox();
        const gap = Math.min(Math.abs(toolbar.y - (table.y + table.height)), Math.abs(table.y - (toolbar.y + toolbar.height)));
        assert.ok(gap <= 12, `${kind}/${width}: toolbar ${JSON.stringify(toolbar)} follows table ${JSON.stringify(table)}`);
        assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= width, 'toolbar stays inside the viewport');

        await bar.getByRole('button', { name: '+ Note', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Annotation editor', exact: true });
        await editor.waitFor();
        assert.match(await editor.locator('.annotation-quote').innerText(), /^<table[^\n]*>\nFeature Basic Pro/);
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-pages-picking')), false);
        await editor.locator('textarea').fill('Drop the pets row');
        await editor.locator('textarea').press('Enter');
        await count(page, 1);

        // Escape leaves picking without saving anything.
        await pick.click(); await bar.waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await bar.isHidden(), true);
        await count(page, 1);

        await page.locator('.annotation-launcher').click();
        await located(page);
        await page.getByRole('button', { name: 'Copy Prompt', exact: true }).first().click();
        const prompt = await page.locator('.annotation-copy-text').inputValue();
        // Markdown lifts the H1 into the page title (already in the prompt header); opaque HTML keeps it in the body.
        const section = kind === 'html' ? 'Pawly plans › 2 Pricing › 2\\.2 Compare' : '2 Pricing › 2\\.2 Compare';
        assert.match(prompt, new RegExp(`1\\. 「${section}」里的表格 \`<table[^\`]*>\`，文字为"Feature Basic Pro Pets 1 3"\\n   > 批注：Drop the pets row`));
        assert.equal(prompt.includes('nth-of-type'), false, 'internal paths stay out of the prompt');

        await page.reload();
        const reloaded = await documentFrame(page, kind);
        await count(page, 1);
        await page.locator('.annotation-launcher').click();
        // HTML documents answer over the MessagePort, so the list first says it is still locating.
        await located(page);
        assert.equal(await page.locator('.annotation-unmatched').count(), 0, `${kind}/${width}: element relocated after reload`);
        await page.getByRole('button', { name: 'Locate', exact: true }).click();
        await page.waitForTimeout(200);
        if (kind === 'html') {
          // Location replies (here triggered by scrolling the document) must not rebuild the row under a click.
          if (!await page.locator('.annotation-panel').isVisible()) await page.locator('.annotation-launcher').click();
          const box = await page.locator('.annotation-item').getByRole('button', { name: 'Delete', exact: true }).boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await reloaded.evaluate(() => scrollBy(0, 300));
          await page.waitForTimeout(500);
          await page.mouse.up();
          const confirmation = page.getByRole('dialog', { name: 'Delete this annotation?', exact: true });
          await confirmation.waitFor({ state: 'visible', timeout: 3000 });
          await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        }
        await page.evaluate(() => localStorage.clear());
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
  await page.getByRole('button', { name: 'Select element', exact: true }).waitFor();
  return frame;
}

async function count(page, expected) {
  await page.waitForFunction(expected => document.querySelector('.annotation-launcher')?.getAttribute('aria-label') === `Annotations (${expected})`, expected);
}

async function located(page) {
  await page.waitForFunction(() => !document.querySelector('.annotation-locating') &&
    !document.querySelector('.annotation-item button[aria-label="Locate"]')?.disabled);
}
