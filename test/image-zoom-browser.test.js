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

// Integration case: the image viewer in a real browser against the real page routes.
// Covers: Markdown images, Mermaid and inline SVG open and zoom at 1280px and 390px touch; zoomed SVG keeps
// its #id-based styles; HTML pages show the viewer only inside the sandboxed frame, the shell makes no
// requests, and an outbound-denied page makes none either; images in links, buttons, labels, summaries,
// role=button/link and annotation UI, page-handled or default-prevented clicks, modifier clicks, clicks while
// text is selected, icons and element picking do not zoom; raster images are not enlarged past their pixels;
// pinch zooms; a drag that ends on the dark area does not close.
// Run when changing assets/image-zoom.js, the page or frame templates that load it, the HTML sandbox/CSP,
// or the annotation picker. Skipped automatically without PAGES_PLAYWRIGHT_CORE_PATH / PAGES_CHROMIUM_PATH.
// Isolation: data and content live in mkdtemp dirs under TMPDIR; the server listens on 127.0.0.1:0.
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
      '<style>#drawing circle{fill:#22c55e;stroke:#15803d;stroke-width:4px}</style><svg id="drawing" width="300" height="150" viewBox="0 0 300 150"><circle cx="75" cy="75" r="60"/><text x="160" y="80">Label</text></svg>' +
      `<p style="margin:160px 0">Icon <img id="icon" alt="Icon" src="${dataImage(16, 16)}"> inline.</p>` +
      `<a href="#linked"><img id="linked" alt="Linked" src="${dataImage(400, 200)}"></a>` +
      `<img id="own" alt="Own handler" style="cursor:pointer" src="${dataImage(400, 200)}">` +
      '<script src="own.js"></script>' + '<p>Background passage.</p>'.repeat(20) + '</body></html>'],
    guards: ['guards.html', '<!doctype html><html><head><title>Guards</title><style>img{max-width:100%;display:block}' +
      '.gap{margin:120px 0}a,button,label,summary,[role]{cursor:default}</style></head><body>' +
      `<p id="text">Selectable passage of text.</p><img id="plain" alt="Plain" src="${dataImage(300, 150)}">` +
      `<div class="gap"><a href="#plain-link"><img id="in-link" alt="In link" src="${dataImage(300, 150)}"></a></div>` +
      `<div class="gap"><button type="button"><img id="in-button" alt="In button" src="${dataImage(300, 150)}"></button></div>` +
      `<div class="gap"><label><img id="in-label" alt="In label" src="${dataImage(300, 150)}"><input type="checkbox"></label></div>` +
      `<div class="gap"><details><summary><img id="in-summary" alt="In summary" src="${dataImage(300, 150)}"></summary><p>More</p></details></div>` +
      `<div class="gap" role="button"><img id="in-role-button" alt="In role button" src="${dataImage(300, 150)}"></div>` +
      `<div class="gap"><span role="link"><img id="in-role-link" alt="In role link" src="${dataImage(300, 150)}"></span></div>` +
      `<div class="gap" data-pages-annotations><img id="in-annotations" alt="In annotation UI" src="${dataImage(300, 150)}"></div>` +
      `<div class="gap"><img id="prevented" alt="Page prevents default" src="${dataImage(300, 150)}"></div>` +
      '<script src="prevent.js"></script></body></html>'],
    denied: ['denied.html', '<!doctype html><html><head><title>Denied</title><style>img{max-width:100%}</style></head><body>' +
      `<img id="local" alt="Local" src="${dataImage(600, 300)}"><p style="margin:160px 0"><img id="remote" alt="Remote" width="200" height="100" src="https://example.com/remote.png"></p>` +
      '</body></html>'],
  };
  await writeFile(path.join(contentDir, 'prevent.js'), "document.getElementById('prevented').addEventListener('click', event => event.preventDefault());");
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
      if (touch) {
        // Two fingers moving apart zoom in around their midpoint.
        const box = await viewer.locator('.pz-stage').boundingBox();
        const before = await scaleOf(viewer);
        await pinch(page, box.x + box.width / 2, box.y + box.height / 2, 30, 120);
        assert.ok(await scaleOf(viewer) > before * 2, `${label}: pinching apart zooms in`);
      }
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page), false, `${label}: Esc closes`);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'scrolling is restored');

      await press(md.locator('.mermaid'));
      const diagram = await openViewer(page, `${label} mermaid`);
      assert.equal(await diagram.locator('svg.pz-item').count(), 1);
      // Mermaid styles nodes and edges through the diagram's #id, so the copy must keep it.
      assert.deepEqual(await paintOf(diagram.locator('svg.pz-item .node').first()), await paintOf(md.locator('.mermaid svg .node').first()),
        `${label}: zoomed Mermaid nodes keep their colours`);
      assert.deepEqual(await paintOf(diagram.locator('svg.pz-item .flowchart-link').first()), await paintOf(md.locator('.mermaid svg .flowchart-link').first()),
        `${label}: zoomed Mermaid edges keep their stroke`);
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
      assert.deepEqual(await paintOf(drawing.locator('svg.pz-item circle')), await paintOf(frame.locator('#drawing circle').first()),
        `${label}: inline SVG styled through its #id keeps its colours`);
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

      // Guards: only plain content images zoom, and the browser keeps its own click behaviours.
      await page.goto(`${origin}/p/zoom-guards`);
      const guards = await documentFrame(page);
      for (const id of ['in-link', 'in-button', 'in-label', 'in-summary', 'in-role-button', 'in-role-link', 'in-annotations', 'prevented']) {
        await press(guards.locator(`#${id}`));
        await page.waitForTimeout(150);
        assert.equal(await isOpen(guards), false, `${label}: #${id} does not open the viewer`);
      }
      assert.match(guards.url(), /#plain-link$/, 'the link image still navigates');
      // A selection in the page means the reader is selecting text, not opening images.
      await guards.evaluate(() => getSelection().selectAllChildren(document.getElementById('text')));
      await guards.locator('#plain').dispatchEvent('click', { button: 0 });
      assert.equal(await isOpen(guards), false, `${label}: no zoom while text is selected`);
      await guards.evaluate(() => getSelection().removeAllRanges());
      await guards.locator('#plain').dispatchEvent('click', { button: 0 });
      const plain = await openViewer(guards, `${label} plain image`);
      // A 300x150 raster image is shown at its own size at most, even with room to spare.
      assert.equal(await scaleOf(plain), 1, `${label}: raster images are not enlarged past their pixels`);
      await page.keyboard.press('Escape');
      if (!touch) {
        for (const modifier of ['Shift', 'Control', 'Alt', 'Meta']) {
          await guards.locator('#plain').click({ modifiers: [modifier] });
          await page.waitForTimeout(150);
          assert.equal(await isOpen(guards), false, `${label}: ${modifier}+click keeps the browser default`);
        }
        // Pressing on the image and releasing over the dark area ends a drag; it does not close.
        await guards.locator('#plain').click();
        const zoomed = await openViewer(guards, `${label} drag`);
        const item = await zoomed.locator('.pz-item').boundingBox();
        const area = await zoomed.locator('.pz-stage').boundingBox();
        await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
        await page.mouse.down();
        await page.mouse.move(area.x + 10, area.y + area.height - 10, { steps: 6 });
        await page.mouse.up();
        assert.equal(await isOpen(guards), true, `${label}: a drag that ends on the dark area does not close`);
        // Grabbing the dark area itself pans too; releasing there is the end of a drag, not a click.
        await page.mouse.move(area.x + 10, area.y + 10);
        await page.mouse.down();
        await page.mouse.move(area.x + 60, area.y + 50, { steps: 6 });
        await page.mouse.up();
        assert.equal(await isOpen(guards), true, `${label}: dragging on the dark area does not close`);
        await page.keyboard.press('Escape');
      }

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

// Computed paint of a shape, or of the first shape inside a group such as a Mermaid node.
async function paintOf(locator) {
  return locator.evaluate(node => {
    const shape = node.matches('rect,circle,ellipse,polygon,path,line') ? node : node.querySelector('rect,circle,ellipse,polygon,path');
    const style = getComputedStyle(shape);
    return { fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth };
  });
}

// Two touch points start `from` pixels apart and move to `to` pixels apart, centred on (x, y).
async function pinch(page, x, y, from, to) {
  const session = await page.context().newCDPSession(page);
  const points = gap => [{ x: x - gap / 2, y, id: 1 }, { x: x + gap / 2, y, id: 2 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let step = 1; step <= 6; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * step / 6) });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
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
