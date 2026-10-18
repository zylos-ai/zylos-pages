import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const available = playwrightPath && chromiumPath && fs.existsSync(playwrightPath) && fs.existsSync(chromiumPath);
const quote = 'First passage for touch annotation.';

async function fixtureServer() {
  const assets = path.resolve(import.meta.dirname, '../assets');
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1);
    if (['annotations.js', 'annotations-core.js', 'annotations-frame.js', 'annotations.css'].includes(name)) {
      response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(fs.readFileSync(path.join(assets, name))); return;
    }
    response.setHeader('Content-Type', 'text/html');
    const paragraphs = `<p>${quote}</p><p>Second passage for another selection.</p>`;
    if (name === 'frame') {
      response.end(`<!doctype html>${paragraphs}<script src="/annotations-core.js"></script><script src="/annotations-frame.js"></script>`); return;
    }
    const content = name === 'html' ? '<iframe class="html-artifact-frame" sandbox="allow-scripts" src="/frame" style="width:100%;height:400px;border:0"></iframe>' : `<main class="markdown-body">${paragraphs}</main>`;
    response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/annotations.css">${content}<div id="pages-annotations" data-base-namespace="/" data-viewer-scope="touch-test" data-page-id="touch"></div><script src="/annotations-core.js"></script><script src="/annotations.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('touch activation survives selection collapse and rejects cancelled gestures', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 120_000,
}, async () => {
  const server = await fixtureServer();
  let browser;
  try {
    const { chromium } = createRequire(import.meta.url)(playwrightPath);
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const cases = [[390, 'markdown'], [390, 'html'], [320, 'markdown'], [320, 'html']];
    for (const [width, kind] of cases) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.setDefaultTimeout(4000);
      await page.addInitScript(() => {
        window.touchTrace = [];
        const trace = event => {
          window.touchTrace.push({ type: event.type, time: performance.now(), target: event.target?.className,
            x: event.clientX, y: event.clientY, addHidden: document.querySelector('.annotation-add')?.hidden,
            collapsed: getSelection()?.isCollapsed });
          if (window.touchTrace.length > 80) window.touchTrace.shift();
        };
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'selectionchange', 'click']) document.addEventListener(type, trace, true);
        for (const type of ['resize', 'scroll', 'blur']) window.addEventListener(type, trace, true);
        visualViewport?.addEventListener('resize', trace);
      });
      const cdp = await context.newCDPSession(page);
      await page.goto(`http://127.0.0.1:${server.address().port}/${kind}`);
      const target = kind === 'html' ? page.frames().find(frame => frame !== page.mainFrame()) : page.mainFrame();
      await target.waitForFunction(() => window.PagesAnnotationsCore);
      const add = page.locator('.annotation-add');
      const editor = page.locator('.annotation-editor');
      const select = async (paragraph = 0) => {
        await target.evaluate(index => {
          const node = document.querySelectorAll('p')[index];
          const range = document.createRange(); range.selectNodeContents(node);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        }, paragraph);
        await add.waitFor({ state: 'visible' });
      };
      const start = async (edge = false) => {
        const box = await add.boundingBox();
        const point = { x: box.x + box.width / 2, y: edge ? box.y + box.height - 2 : box.y + box.height / 2 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        return point;
      };
      const end = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const collapse = () => target.evaluate(() => getSelection().removeAllRanges());
      const cancelEditor = async () => {
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
      };
      await select();
      await start(); await page.waitForTimeout(250); await end();
      try { await editor.waitFor({ state: 'visible' }); }
      catch (error) {
        console.error(JSON.stringify({ width, kind, stage: 'ordinary touch', trace: await page.evaluate(() => window.touchTrace) }));
        throw error;
      }
      await cancelEditor();
      await select();
      await start(); await collapse(); await page.waitForTimeout(250); await end();
      await editor.waitFor({ state: 'visible', timeout: 2000 });
      assert.equal(await editor.locator('.annotation-quote').innerText(), quote);
      assert.equal(await page.locator('#annotation-comment').evaluate(node => node === document.activeElement), true);
      if (process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PAGES_ANNOTATIONS_EVIDENCE_DIR, `touch-${kind}-${width}.png`) });
      }
      await page.locator('#annotation-comment').fill('Draft survives the compatibility click');
      await add.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      assert.equal(await page.locator('#annotation-comment').inputValue(), 'Draft survives the compatibility click');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      assert.equal(await editor.isVisible(), true, 'retargeted compatibility click cannot dismiss the editor');
      await cancelEditor();

      for (const rejection of ['cancel', 'drag', 'outside', 'resize', 'scroll', 'blur', 'escape', 'replace']) {
        await select();
        const point = await start(rejection === 'outside');
        await collapse();
        if (rejection === 'cancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        if (rejection === 'drag') await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 40, y: point.y + 40 }] });
        if (rejection === 'outside') await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + 8 }] });
        if (rejection === 'resize') await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize')));
        if (rejection === 'scroll') await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        if (rejection === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        if (rejection === 'escape') await page.keyboard.press('Escape');
        if (rejection === 'replace') await target.evaluate(() => {
          const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('p')[1]);
          getSelection().addRange(range);
        });
        await page.waitForTimeout(250);
        if (rejection !== 'cancel') await end();
        await page.waitForTimeout(180);
        assert.equal(await editor.isVisible(), false, `${rejection} cannot open a stale draft`);
        await add.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
        assert.equal(await editor.isVisible(), false, `${rejection} compatibility click cannot resurrect the draft`);
        await page.keyboard.press('Escape');
      }
      await select(1);
      await add.focus(); await page.keyboard.press('Enter');
      await editor.waitFor({ state: 'visible' });
      assert.equal(await editor.locator('.annotation-quote').innerText(), 'Second passage for another selection.');
      await cancelEditor();
      await select(); await page.touchscreen.tap(20, 250); await page.waitForTimeout(250);
      assert.equal(await add.isVisible(), false, 'outside tap still clears the selection candidate');
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('outside pointer dismisses the summary without deleting records or breaking inside controls', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 120_000,
}, async () => {
  const server = await fixtureServer();
  let browser;
  try {
    const { chromium } = createRequire(import.meta.url)(playwrightPath);
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const width of [390, 320, 1280]) for (const kind of ['markdown', 'html']) {
      const touch = width !== 1280;
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
      const page = await context.newPage();
      page.setDefaultTimeout(4000);
      await page.goto(`http://127.0.0.1:${server.address().port}/${kind}`);
      const target = kind === 'html' ? page.frames().find(frame => frame !== page.mainFrame()) : page.mainFrame();
      await target.waitForFunction(() => window.PagesAnnotationsCore);
      await target.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('p'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.locator('.annotation-add').click();
      await page.locator('#annotation-comment').fill('Keep this saved annotation');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const panel = page.locator('.annotation-panel');
      const launcher = page.locator('.annotation-launcher');
      const press = locator => touch ? locator.tap() : locator.click();
      const outside = async inFrame => {
        if (inFrame) {
          const point = await page.locator('iframe').evaluate(frame => {
            const bounds = frame.getBoundingClientRect();
            for (const y of [390, 350, 220, 150]) for (const x of [20, bounds.width - 2]) {
              const point = { x: bounds.x + x, y: bounds.y + y };
              if (document.elementFromPoint(point.x, point.y) === frame) return point;
            }
            return null;
          });
          assert.ok(point, 'the outside touch must reach the opaque document');
          if (touch) await page.touchscreen.tap(point.x, point.y);
          else await page.mouse.click(point.x, point.y);
        } else {
          assert.equal(await page.evaluate(() => !!document.elementFromPoint(2, 600)?.closest('#pages-annotations')), false);
          if (touch) await page.touchscreen.tap(2, 600);
          else await page.mouse.click(2, 600);
        }
      };
      const open = async () => {
        await press(launcher); await panel.waitFor({ state: 'visible' });
        assert.equal(await launcher.getAttribute('aria-expanded'), 'true');
        assert.equal(await panel.locator('.annotation-item').count(), 1);
      };
      const closed = async () => {
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await launcher.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.annotation-confirmation').isVisible(), false);
      };
      await open(); await outside(false); await closed();
      await open();
      await press(panel.locator('h2'));
      assert.equal(await panel.isVisible(), true, 'inside summary remains open');
      await press(panel.getByRole('button', { name: 'More actions', exact: true }));
      assert.equal(await page.locator('.annotation-menu').isVisible(), true);
      assert.equal(await panel.isVisible(), true, 'menu does not dismiss summary');
      await press(panel.getByRole('button', { name: 'Clear all', exact: true }));
      const confirmation = page.locator('.annotation-confirmation');
      await confirmation.waitFor({ state: 'visible' });
      await press(confirmation.getByRole('button', { name: 'Cancel', exact: true }));
      assert.equal(await panel.isVisible(), true, 'cancelling confirmation preserves summary');
      await press(panel.getByRole('button', { name: 'Delete', exact: true }));
      await confirmation.waitFor({ state: 'visible' });
      await outside(kind === 'html'); await closed();
      await open();
      await press(panel.getByRole('button', { name: 'Edit', exact: true }));
      await page.locator('.annotation-editor').waitFor({ state: 'visible' });
      await outside(kind === 'html');
      await page.locator('.annotation-editor').waitFor({ state: 'hidden' }); await closed();
      await open();
      await press(panel.getByRole('button', { name: 'More actions', exact: true }));
      await outside(kind === 'html'); await closed();
      await open();
      assert.equal(await page.locator('.annotation-menu').isVisible(), false, 'reopen does not restore stale menu');
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
