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

test('touch activation survives selection collapse and rejects cancelled gestures', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 120_000,
}, async () => {
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
  let browser;
  try {
    const { chromium } = createRequire(import.meta.url)(playwrightPath);
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const [width, kind] of [[390, 'markdown'], [390, 'html'], [320, 'markdown'], [320, 'html']]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.setDefaultTimeout(4000);
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
      await editor.waitFor({ state: 'visible' });
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
