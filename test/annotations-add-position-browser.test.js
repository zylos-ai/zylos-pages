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
    <body><main class="markdown-body"><p id="ltr" style="width:420px">${'Annotation placement text. '.repeat(12)}</p>
    <p id="rtl" dir="rtl" style="width:420px">${'טקסט לבדיקת מיקום הכפתור. '.repeat(3)}</p>
    <p id="nested" style="width:420px"><span>Nested span text for an ancestor endpoint.</span></p>
    <p id="mixed" dir="ltr" style="width:420px;margin-left:100px"><span dir="rtl">טקסט עברי בתוך פסקה משמאל לימין</span></p></main>
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
    // Selects text-node offsets [from, to) of `id`; a backward selection has its focus at `from`.
    // Returns the selected fragments (independent of the code under test) and, once the debounced
    // update has moved the button away from its previous position, the button rect.
    const select = async (id, from, to, backward) => {
      const before = await page.evaluate(() => {
        const button = document.querySelector('.annotation-add');
        return button.hidden ? null : JSON.stringify(button.getBoundingClientRect());
      });
      const fragments = await page.evaluate(({ id, from, to, backward }) => {
        const node = document.getElementById(id).firstChild;
        const selection = getSelection(); selection.removeAllRanges();
        if (backward) { selection.collapse(node, to); selection.extend(node, from); }
        else { selection.collapse(node, from); selection.extend(node, to); }
        document.dispatchEvent(new Event('selectionchange'));
        return [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0)
          .map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
      }, { id, from, to, backward });
      await page.waitForFunction(before => {
        const button = document.querySelector('.annotation-add');
        return !button.hidden && JSON.stringify(button.getBoundingClientRect()) !== before;
      }, before);
      // The debounced update may move the button more than once; wait until two checks 150 ms apart agree.
      let previous = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await page.evaluate(() => JSON.stringify(document.querySelector('.annotation-add').getBoundingClientRect()));
        if (current === previous) break;
        previous = current; await page.waitForTimeout(150);
      }
      const button = await page.evaluate(() => {
        const rect = document.querySelector('.annotation-add').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return { first: fragments[0], last: fragments.at(-1), lines: fragments.length, button };
    };
    // Waits for the debounced placement to reach `expected`, then asserts with the final position.
    const settledAt = async (expected, message) => {
      await page.waitForFunction(expected => Math.abs(document.querySelector('.annotation-add').getBoundingClientRect().left - expected) <= 2,
        expected, { timeout: 3000 }).catch(() => {});
      const left = await page.evaluate(() => document.querySelector('.annotation-add').getBoundingClientRect().left);
      assert.ok(Math.abs(left - expected) <= 2, `${message}: ${left} vs ${expected}`);
    };
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 2, `${message}: ${actual} vs ${expected}`);

    const multi = await select('ltr', 30, 200, false);
    assert.ok(multi.lines > 1, 'the fixture selection spans several lines');
    near(multi.button.left, multi.last.right, 'forward: button starts at the end of the last line');
    assert.ok(multi.button.top >= multi.last.bottom, 'forward: button sits below the last selected line');

    const backward = await select('ltr', 30, 200, true);
    near(backward.button.left, backward.first.left, 'backward: button starts at the selection start');
    assert.ok(backward.button.top >= backward.first.bottom, 'backward: button sits below the first selected line');

    const single = await select('ltr', 0, 10, false);
    assert.equal(single.lines, 1);
    near(single.button.left, single.last.right, 'single line: button starts at the selection end');

    // Ending exactly at a soft wrap: the focus caret belongs to the next line, the button stays by the text.
    const wrap = await page.evaluate(() => {
      const node = document.getElementById('ltr').firstChild, range = document.createRange();
      const top = offset => { range.setStart(node, offset); range.setEnd(node, offset + 1); return range.getBoundingClientRect().top; };
      for (let offset = 1; offset < node.length - 1; offset++) if (top(offset) > top(offset - 1)) return offset;
      return -1;
    });
    assert.ok(wrap > 0, 'the fixture paragraph wraps');
    const atWrap = await select('ltr', 0, wrap, false);
    assert.ok(atWrap.button.top >= atWrap.last.bottom && atWrap.button.top < atWrap.last.bottom + 20,
      'wrap: button sits under the last selected line, not the next one');

    const rtl = await select('rtl', 0, 12, false);
    near(rtl.button.left, rtl.last.left, 'rtl forward: button starts at the left end of the selection');

    // Focus on the paragraph element after its only child: still a forward selection ending after the text.
    const nested = await page.evaluate(() => {
      const paragraph = document.getElementById('nested'), text = paragraph.firstChild.firstChild;
      const selection = getSelection(); selection.removeAllRanges();
      selection.collapse(text, 0); selection.extend(paragraph, 1);
      document.dispatchEvent(new Event('selectionchange'));
      const rects = [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0);
      return { left: rects[0].left, right: rects.at(-1).right };
    });
    await page.waitForFunction(right => Math.abs(document.querySelector('.annotation-add').getBoundingClientRect().left - right) <= 2,
      nested.right);

    // RTL text inside an LTR paragraph, focus on the paragraph: the text ends at its left edge.
    const mixed = await page.evaluate(() => {
      const paragraph = document.getElementById('mixed'), text = paragraph.firstChild.firstChild;
      const selection = getSelection(); selection.removeAllRanges();
      selection.collapse(text, 0); selection.extend(paragraph, 1);
      document.dispatchEvent(new Event('selectionchange'));
      const rects = [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0);
      return { left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)) };
    });
    await settledAt(mixed.left, 'mixed direction: button starts at the left end of the RTL text');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
