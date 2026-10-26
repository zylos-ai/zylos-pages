import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const available = playwrightPath && chromiumPath && fs.existsSync(playwrightPath) && fs.existsSync(chromiumPath);

test('the + Note button follows the end of the selection where the pointer was released', {
  skip: available ? false : 'set browser paths for browser coverage', timeout: 60_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const assets = new Map(['style.css', 'annotations-core.js', 'annotations.js', 'annotations.css'].map(name =>
    [`/${name}`, fs.readFileSync(path.resolve(import.meta.dirname, '../assets', name))]));
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/annotations.css">
    <script src="/annotations-core.js"></script><script src="/annotations.js" defer></script></head>
    <body><main class="markdown-body"><p id="text" style="width:420px">${'Annotation placement text. '.repeat(12)}</p></main>
    <section id="pages-annotations" data-base-namespace="/" data-viewer-scope="owner" data-page-id="add-position"></section></body></html>`;
  const server = http.createServer((request, response) => {
    const asset = assets.get(request.url);
    response.setHeader('Content-Type', asset ? request.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
    response.end(asset || fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.annotation-launcher').waitFor();
    // Selects from character `from` to `to`; a backward selection has its focus at `from`.
    const select = async (from, to, backward) => {
      await page.evaluate(({ from, to, backward }) => {
        const node = document.querySelector('#text').firstChild;
        const selection = getSelection(); selection.removeAllRanges();
        if (backward) { selection.collapse(node, to); selection.extend(node, from); }
        else { selection.collapse(node, from); selection.extend(node, to); }
        document.dispatchEvent(new Event('selectionchange'));
      }, { from, to, backward });
      await page.waitForTimeout(350);
      await page.locator('.annotation-add').waitFor({ state: 'visible' });
      return page.evaluate(({ from, to }) => {
        const node = document.querySelector('#text').firstChild;
        const range = document.createRange(); range.setStart(node, from); range.setEnd(node, to);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        const button = document.querySelector('.annotation-add').getBoundingClientRect();
        const plain = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        return { first: plain(rects[0]), last: plain(rects.at(-1)), lines: rects.length, button: plain(button) };
      }, { from, to });
    };

    const multi = await select(30, 200, false);
    assert.ok(multi.lines > 1, 'the fixture selection spans several lines');
    assert.ok(Math.abs(multi.button.left - (multi.last.right - 1)) <= 2, 'forward: button starts at the end of the last line');
    assert.ok(multi.button.top >= multi.last.bottom, 'forward: button sits below the last selected line');
    assert.ok(multi.button.left > multi.last.left + 20, 'forward: button is no longer pinned to the left edge of the selection');

    const backward = await select(30, 200, true);
    assert.ok(Math.abs(backward.button.left - backward.first.left) <= 2, 'backward: button starts at the selection start');
    assert.ok(backward.button.top >= backward.first.bottom, 'backward: button sits below the first selected line');

    const single = await select(0, 10, false);
    assert.equal(single.lines, 1);
    assert.ok(Math.abs(single.button.left - (single.last.right - 1)) <= 2, 'single line: button starts at the selection end');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
