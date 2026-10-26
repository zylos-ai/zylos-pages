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
  skip: available ? false : 'set browser paths for browser coverage', timeout: 90_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightPath);
  const assets = new Map(['style.css', 'annotations-core.js', 'annotations.js', 'annotations.css'].map(name =>
    [`/${name}`, fs.readFileSync(path.resolve(import.meta.dirname, '../assets', name))]));
  const hebrew = 'טקסט עברי בתוך פסקה משמאל לימין';
  const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/annotations.css">
    <script src="/annotations-core.js"></script><script src="/annotations.js" defer></script></head>
    <body><main class="markdown-body"><p id="ltr" style="width:420px">${'Annotation placement text. '.repeat(12)}</p>
    <p id="rtl" dir="rtl" style="width:420px">${'טקסט לבדיקת מיקום הכפתור. '.repeat(3)}</p>
    <p id="nested" style="width:420px;margin-left:100px"><span>Nested span text for an ancestor endpoint.</span></p>
    <p id="mixed" dir="ltr" style="width:420px;margin-left:100px"><span dir="rtl">${hebrew}</span></p>
    <p id="spaces" style="white-space:pre;margin-left:100px"><span>Preserved</span><span>          </span></p></main>
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
    const rectOf = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    // Applies a selection given as [anchorPath, anchorOffset, focusPath, focusOffset], where a path is an
    // element id followed by child indexes, and returns the selected fragments measured independently.
    const select = (anchor, anchorOffset, focus, focusOffset) => page.evaluate(({ anchor, anchorOffset, focus, focusOffset }) => {
      const resolve = ([id, ...indexes]) => indexes.reduce((node, index) => node.childNodes[index], document.getElementById(id));
      const selection = getSelection(); selection.removeAllRanges();
      selection.collapse(resolve(anchor), anchorOffset); selection.extend(resolve(focus), focusOffset);
      document.dispatchEvent(new Event('selectionchange'));
      return [...selection.getRangeAt(0).getClientRects()].filter(rect => rect.width > 0)
        .map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    }, { anchor, anchorOffset, focus, focusOffset });
    // Waits for the debounced placement to reach x = `expected` (within 2px), failing on timeout.
    const settledAt = async (expected, message) => {
      try {
        await page.waitForFunction(expected => {
          const button = document.querySelector('.annotation-add');
          return !button.hidden && Math.abs(button.getBoundingClientRect().left - expected) <= 2;
        }, expected, { timeout: 3000 });
      } catch {
        const left = await page.evaluate(() => document.querySelector('.annotation-add').getBoundingClientRect().left);
        assert.fail(`${message}: button at ${left}, expected ${expected}`);
      }
      return page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector('.annotation-add').getBoundingClientRect())));
    };

    let fragments = await select(['ltr', 0], 30, ['ltr', 0], 200);
    assert.ok(fragments.length > 1, 'the fixture selection spans several lines');
    let button = await settledAt(fragments.at(-1).right, 'forward: button starts at the end of the last line');
    assert.ok(button.top >= fragments.at(-1).bottom, 'forward: button sits below the last selected line');

    fragments = await select(['ltr', 0], 200, ['ltr', 0], 30);
    button = await settledAt(fragments[0].left, 'backward: button starts at the selection start');
    assert.ok(button.top >= fragments[0].bottom, 'backward: button sits below the first selected line');

    fragments = await select(['ltr', 0], 0, ['ltr', 0], 10);
    assert.equal(fragments.length, 1);
    await settledAt(fragments[0].right, 'single line: button starts at the selection end');

    // Ending exactly at a soft wrap: the focus caret belongs to the next line, the button stays by the text.
    const wrap = await page.evaluate(() => {
      const node = document.getElementById('ltr').firstChild, range = document.createRange();
      const top = offset => { range.setStart(node, offset); range.setEnd(node, offset + 1); return range.getBoundingClientRect().top; };
      for (let offset = 1; offset < node.length - 1; offset++) if (top(offset) > top(offset - 1)) return offset;
      return -1;
    });
    assert.ok(wrap > 0, 'the fixture paragraph wraps');
    fragments = await select(['ltr', 0], 0, ['ltr', 0], wrap);
    button = await settledAt(fragments.at(-1).right, 'wrap: button starts at the end of the last selected line');
    assert.ok(button.top >= fragments.at(-1).bottom && button.top < fragments.at(-1).bottom + 20,
      'wrap: button sits under the last selected line, not the next one');

    fragments = await select(['rtl', 0], 0, ['rtl', 0], 12);
    await settledAt(fragments.at(-1).left, 'rtl forward: button starts at the left end of the selection');

    fragments = await select(['nested', 0, 0], 0, ['nested'], 1);
    await settledAt(Math.max(...fragments.map(rect => rect.right)), 'focus on the paragraph after its text: button at the text end');

    fragments = await select(['nested', 0, 0], 20, ['nested'], 0);
    await settledAt(Math.min(...fragments.map(rect => rect.left)), 'backward, focus on the paragraph start: button at the text start');

    fragments = await select(['mixed', 0, 0], 0, ['mixed'], 1);
    await settledAt(Math.min(...fragments.map(rect => rect.left)), 'RTL span in an LTR paragraph: button at the left end of the RTL text');

    fragments = await select(['spaces', 0, 0], 0, ['spaces'], 2);
    await settledAt(Math.max(...fragments.map(rect => rect.right)), 'displayed trailing spaces count as selected text');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
