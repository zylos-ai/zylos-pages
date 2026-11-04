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
const svgFile = (width, height, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
const dataImage = (width, height) => `data:image/svg+xml,${encodeURIComponent(svgFile(width, height, '#6366f1'))}`;

test('images, inline SVG and Mermaid diagrams open in a zoomable viewer in Markdown and sandboxed HTML', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 240_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pages-zoom-data-'));
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'pages-zoom-content-'));
  process.env.PAGES_DATA_DIR = dataDir;
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const express = (await import('express')).default;
  const { initCache } = await import('../src/cache/pageCache.js');
  const { registerLogicalPage } = await import('../src/pages/page-store.js');
  const { pageRoute } = await import('../src/routes/pages.js');
  const { setupLogicalAssetRoute } = await import('../src/routes/logical-assets.js');
  const { setupAuth, hashPassword } = await import('../src/security/auth.js');
  const { securityHeaders } = await import('../src/security/headers.js');
  const config = {
    contentDir, publicBaseUrl: null,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 99 }, theme: { codeTheme: 'github-dark' },
    auth: { password: hashPassword('zoom-test') },
    externalFiles: { enabled: true, allowedSources: { content: contentDir } },
  };
  await writeFile(path.join(contentDir, 'chart.svg'), svgFile(900, 450, '#0ea5e9'));
  await writeFile(path.join(contentDir, 'icon.svg'), svgFile(16, 16, '#f97316'));
  const pages = {
    markdown: ['zoom.md', '# Zoom\n\n![Chart](chart.svg)\n\nIcon ![Icon](icon.svg) inline.\n\n[![Linked chart](chart.svg)](#linked)\n\n' +
      '```mermaid\ngraph TD\n  Start --> End\n```\n\n' + 'Background passage.\n\n'.repeat(20)],
    html: ['zoom.html', '<!doctype html><html><head><title>Zoom</title><style>img{max-width:100%}</style></head><body><h1>Zoom</h1>' +
      `<img id="photo" alt="Photo" src="${dataImage(800, 400)}">` +
      '<svg id="drawing" width="300" height="150" viewBox="0 0 300 150"><circle cx="75" cy="75" r="60" fill="#22c55e"/><text x="160" y="80">Label</text></svg>' +
      `<p style="margin:160px 0">Icon <img id="icon" alt="Icon" src="${dataImage(16, 16)}"> inline.</p>` +
      `<a href="#linked"><img id="linked" alt="Linked" src="${dataImage(400, 200)}"></a>` +
      `<img id="own" alt="Own handler" style="cursor:pointer" src="${dataImage(400, 200)}">` +
      '<script src="own.js"></script>' + '<p>Background passage.</p>'.repeat(20) + '</body></html>'],
    denied: ['denied.html', '<!doctype html><html><head><title>Denied</title><style>img{max-width:100%}</style></head><body>' +
      `<img id="local" alt="Local" src="${dataImage(600, 300)}"><p style="margin:160px 0"><img id="remote" alt="Remote" width="200" height="100" src="https://example.com/remote.png"></p>` +
      '</body></html>'],
  };
  await writeFile(path.join(contentDir, 'own.js'), "document.getElementById('own').addEventListener('click', () => { document.body.dataset.ownClicks = String(Number(document.body.dataset.ownClicks || 0) + 1); });");
  for (const [kind, [file, source]] of Object.entries(pages)) {
    const sourcePath = path.join(contentDir, file);
    await writeFile(sourcePath, source);
    registerLogicalPage({ uri: `zoom-${kind}`, title: 'Zoom fixture', sourcePath, component: 'content', capabilities: [], outboundDenied: kind === 'denied' }, config);
  }
  initCache({ maxEntries: 20, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  app.use('/_assets', express.static(path.resolve(import.meta.dirname, '../assets')));
  setupAuth(app, config.auth);
  setupLogicalAssetRoute(app, config);
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
      await page.locator('input[name="password"]').fill('zoom-test');
      await Promise.all([page.waitForURL(`${origin}/`), page.locator('form').press('Enter')]);
      const press = async locator => {
        await locator.evaluate(node => node.scrollIntoView({ block: 'center' }));
        const box = await locator.boundingBox();
        if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      const label = `${width}px`;

      // Markdown: the viewer lives in the page itself.
      await page.goto(`${origin}/p/zoom-markdown`);
      await page.locator('.markdown-body .mermaid svg').waitFor();
      const md = page.locator('.markdown-body');
      await press(md.locator('img[alt="Chart"]'));
      const viewer = await openViewer(page, `${label} markdown image`);
      assert.equal(await viewer.locator('img.pz-item').count(), 1);
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'page behind the viewer does not scroll');
      const fitted = await scaleOf(viewer);
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
      assert.ok(await scaleOf(viewer) > fitted, `${label}: Zoom in enlarges`);
      await viewer.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await viewer.getByRole('button', { name: 'Zoom out', exact: true }).click();
      assert.ok(await scaleOf(viewer) < fitted, `${label}: Zoom out shrinks`);
      await viewer.getByRole('button', { name: 'Fit to screen', exact: true }).click();
      assert.ok(Math.abs(await scaleOf(viewer) - fitted) < 0.001, `${label}: 1:1 returns to the fitted size`);
      if (!touch) {
        const box = await viewer.locator('.pz-stage').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -300);
        await page.waitForFunction(scale => {
          const match = /scale\(([\d.]+)\)/.exec(document.querySelector('#pages-image-zoom .pz-content').style.transform);
          return match && Number(match[1]) > scale;
        }, fitted);
        const before = await translateOf(viewer);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 4 });
        await page.mouse.up();
        const after = await translateOf(viewer);
        assert.ok(after.x - before.x > 70 && after.y - before.y > 30, `${label}: dragging pans`);
        assert.equal(await isOpen(page), true, 'ending a drag does not close the viewer');
      }
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page), false, `${label}: Esc closes`);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'scrolling is restored');

      await press(md.locator('.mermaid'));
      const diagram = await openViewer(page, `${label} mermaid`);
      assert.equal(await diagram.locator('svg.pz-item').count(), 1);
      await diagram.getByRole('button', { name: 'Close (Esc)', exact: true }).click();
      assert.equal(await isOpen(page), false);

      // Small inline icons and linked images keep their normal behaviour.
      await press(md.locator('img[alt="Icon"]'));
      await press(md.locator('img[alt="Linked chart"]'));
      await page.waitForURL(/#linked$/);
      assert.equal(await isOpen(page), false, `${label}: icon and linked image do not open the viewer`);

      // While picking an element for an annotation, a click picks instead of zooming.
      await page.getByRole('button', { name: 'Select element', exact: true }).click();
      await press(md.locator('img[alt="Chart"]'));
      await page.waitForFunction(() => /^<img/.test(document.querySelector('.annotation-pick-label')?.textContent || ''));
      assert.equal(await isOpen(page), false, `${label}: picking does not zoom`);
      await page.keyboard.press('Escape');

      // Sandboxed HTML: the viewer opens inside the frame and the shell receives and requests nothing.
      await page.goto(`${origin}/p/zoom-html`);
      const frame = await documentFrame(page);
      const shellRequests = [];
      page.on('request', request => { if (request.frame() === page.mainFrame()) shellRequests.push(request.url()); });
      await press(frame.locator('#photo'));
      const framed = await openViewer(frame, `${label} html image`);
      assert.equal(await framed.locator('img.pz-item').count(), 1);
      assert.equal(await page.locator('#pages-image-zoom').count(), 0, 'nothing is shown in the shell');
      await framed.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(frame), false, `${label}: Esc closes inside the frame`);
      await press(frame.locator('#drawing circle'));
      const drawing = await openViewer(frame, `${label} inline svg`);
      assert.equal(await drawing.locator('svg.pz-item').count(), 1);
      // A click on the dark area closes the viewer.
      const stage = await drawing.locator('.pz-stage').boundingBox();
      if (touch) await page.touchscreen.tap(stage.x + 8, stage.y + stage.height - 8);
      else await page.mouse.click(stage.x + 8, stage.y + stage.height - 8);
      await frame.waitForFunction(() => !document.querySelector('#pages-image-zoom.pz-open'));
      assert.deepEqual(shellRequests, [], `${label}: the shell makes no requests while the viewer is used`);

      await press(frame.locator('#icon'));
      await press(frame.locator('#own'));
      await frame.waitForFunction(() => document.body.dataset.ownClicks === '1');
      await press(frame.locator('#linked'));
      await frame.waitForURL(/#linked$/);
      assert.equal(await isOpen(frame), false, `${label}: icons, page-handled and linked images do not zoom`);

      // Pages that deny outbound requests stay closed while the viewer is used: the page's own
      // external image is blocked, and using the viewer adds no request outside the origin.
      await page.goto(`${origin}/p/zoom-denied`);
      const denied = await documentFrame(page);
      assert.equal(await denied.locator('#remote').evaluate(node => node.naturalWidth), 0, 'the external image is blocked');
      const outside = [];
      page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) outside.push(request.url()); });
      await press(denied.locator('#local'));
      await openViewer(denied, `${label} denied page`);
      await denied.locator('#pages-image-zoom').getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(denied), false);
      await press(denied.locator('#remote'));
      assert.equal(await isOpen(denied), false, 'an image that never loaded does not open');
      assert.deepEqual(outside, [], `${label}: no outbound requests while the viewer is used`);

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

async function documentFrame(page) {
  const handle = await page.locator('.html-artifact-frame').elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForURL(/raw=1/);
  await frame.waitForFunction(() => Boolean(window.PagesImageZoom));
  return frame;
}

async function openViewer(target, label) {
  await target.waitForFunction(() => {
    const content = document.querySelector('#pages-image-zoom.pz-open .pz-content');
    // Fitting centres the copy, so it leaves the initial 0,0 position.
    return content && content.style.transform && !/^translate\(0px, ?0px\)/.test(content.style.transform);
  }, null, { timeout: 5000 }).catch(() => assert.fail(`${label}: viewer did not open`));
  return target.locator('#pages-image-zoom');
}

async function isOpen(target) {
  return target.evaluate(() => Boolean(document.querySelector('#pages-image-zoom.pz-open')));
}

async function scaleOf(viewer) {
  return Number(/scale\(([\d.]+)\)/.exec(await viewer.locator('.pz-content').evaluate(node => node.style.transform))[1]);
}

async function translateOf(viewer) {
  const [, x, y] = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)/.exec(await viewer.locator('.pz-content').evaluate(node => node.style.transform));
  return { x: Number(x), y: Number(y) };
}
