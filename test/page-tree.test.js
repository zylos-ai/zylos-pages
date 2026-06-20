import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanPages } from '../src/routes/index.js';
import { indexTemplate } from '../src/templates/indexTemplate.js';
import { injectNavSidebar, injectShareViewer, pageTemplate } from '../src/templates/pageTemplate.js';
import { buildPageTree } from '../src/utils/pageTree.js';

test('buildPageTree returns empty groups for empty input', () => {
  assert.deepEqual(buildPageTree([]), { topLevel: [], folders: [] });
});

test('buildPageTree groups top-level and nested pages', () => {
  const top = { slug: 'about', title: 'About', date: '2026-06-10' };
  const daily = { slug: 'daily-digest/a', title: 'Daily', date: '2026-06-11' };
  const nested = { slug: 'recruit/interview-questions/foo', title: 'Foo', date: '2026-06-12' };

  const tree = buildPageTree([top, daily, nested]);

  assert.deepEqual(tree.topLevel, [top]);
  assert.equal(tree.folders.length, 2);
  assert.deepEqual(tree.folders.map(folder => folder.path), ['daily-digest', 'recruit/interview-questions']);
  assert.equal(tree.folders[1].label, 'recruit / interview-questions');
  assert.deepEqual(tree.folders[1].pages, [nested]);
});

test('buildPageTree sorts folders by path and folder pages by newest date', () => {
  const tree = buildPageTree([
    { slug: 'z/old', title: 'Old', date: '2026-06-01' },
    { slug: 'a/page', title: 'A', date: '2026-06-02' },
    { slug: 'z/new', title: 'New', date: '2026-06-03' },
  ]);

  assert.deepEqual(tree.folders.map(folder => folder.path), ['a', 'z']);
  assert.deepEqual(tree.folders[1].pages.map(page => page.slug), ['z/new', 'z/old']);
});

test('scanPages and buildPageTree preserve hidden, draft, and multi-segment behavior', async () => {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-tree-'));
  try {
    await writeFile(path.join(contentDir, 'top.md'), '---\ntitle: Top\n---\n# Top\n');
    await writeFile(path.join(contentDir, '.hidden.md'), '# Hidden\n');
    await writeFile(path.join(contentDir, '_underscore.md'), '# Underscore\n');
    await writeFile(path.join(contentDir, 'draft.md'), '---\ndraft: true\n---\n# Draft\n');
    await mkdir(path.join(contentDir, 'daily-digest'), { recursive: true });
    await writeFile(path.join(contentDir, 'daily-digest', 'a.md'), '---\ntitle: Daily\n---\n# Daily\n');
    await mkdir(path.join(contentDir, 'recruit', 'interview-questions'), { recursive: true });
    await writeFile(path.join(contentDir, 'recruit', 'interview-questions', 'foo.md'), '---\ntitle: Foo\n---\n# Foo\n');

    const pages = await scanPages(contentDir);
    const tree = buildPageTree(pages);

    assert.deepEqual(pages.map(page => page.slug).sort(), [
      'daily-digest/a',
      'recruit/interview-questions/foo',
      'top',
    ]);
    assert.deepEqual(tree.topLevel.map(page => page.slug), ['top']);
    assert.deepEqual(tree.folders.map(folder => folder.path), ['daily-digest', 'recruit/interview-questions']);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('indexTemplate renders escaped folder details and page counts', () => {
  const html = indexTemplate({
    topLevel: [{ slug: 'top', title: 'Top', date: '2026-06-14' }],
    folders: [{
      path: 'safe/<script>',
      label: 'safe / <script>',
      pages: [{ slug: 'safe/<script>/page', title: 'Nested', date: '2026-06-13' }],
    }],
  }, '/pages');

  assert.match(html, /2 pages/);
  assert.match(html, /<details class="page-folder">/);
  assert.match(html, /safe \/ &lt;script&gt;/);
  assert.match(html, /1 page/);
  assert.doesNotMatch(html, /<script><\/script>/);
});

test('injectNavSidebar expands active folder and escapes folder labels', () => {
  const html = injectNavSidebar('<html><body><!-- NAV_SIDEBAR --></body></html>', [
    { slug: 'top', title: 'Top', date: '2026-06-14' },
    { slug: 'daily-digest/a', title: 'Daily A', date: '2026-06-13' },
    { slug: 'safe/<script>/page', title: 'Unsafe Folder', date: '2026-06-12' },
  ], 'daily-digest/a', '/pages');

  assert.match(html, /<details open><summary><span class="nav-folder-name">daily-digest<\/span>/);
  assert.match(html, /<li class="active"><a href="\/pages\/daily-digest\/a">Daily A<\/a><\/li>/);
  assert.match(html, /safe \/ &lt;script&gt;/);
  assert.doesNotMatch(html, /<span class="nav-folder-name">safe \/ <script>/);
});

test('injectShareViewer marks share pages and exposes attachment edit flag', () => {
  const readOnly = injectShareViewer('<html lang="en"><head></head><body></body></html>');
  assert.match(readOnly, /<html lang="en" data-viewer="share">/);
  assert.match(readOnly, /window\.__PAGES_VIEWER="share"/);
  assert.match(readOnly, /window\.__PAGES_SHARE_EDITABLE=false/);

  const editable = injectShareViewer('<html lang="en"><head></head><body></body></html>', {
    canWriteAttachments: true,
  });
  assert.match(editable, /window\.__PAGES_SHARE_EDITABLE=true/);
});

test('pageTemplate renders nested and top-level breadcrumbs with escaped folder segments', () => {
  const nested = pageTemplate({
    title: 'Nested Page',
    description: '',
    date: '',
    tags: [],
    bodyHtml: '<p>Body</p>',
    tocItems: [],
    baseUrl: '/pages',
    slug: 'recruit/interview-questions/foo',
  });
  assert.match(nested, /<span class="breadcrumb-folder auth-only">recruit<\/span>/);
  assert.match(nested, /<span class="breadcrumb-folder auth-only">interview-questions<\/span>/);
  assert.match(nested, /<span class="current">Nested Page<\/span>/);

  const escaped = pageTemplate({
    title: 'Escaped',
    description: '',
    date: '',
    tags: [],
    bodyHtml: '<p>Body</p>',
    tocItems: [],
    baseUrl: '/pages',
    slug: 'safe/<script>/page',
  });
  assert.match(escaped, /<span class="breadcrumb-folder auth-only">&lt;script&gt;<\/span>/);
  assert.doesNotMatch(escaped, /<span class="breadcrumb-folder auth-only"><script>/);

  const topLevel = pageTemplate({
    title: 'Top',
    description: '',
    date: '',
    tags: [],
    bodyHtml: '<p>Body</p>',
    tocItems: [],
    baseUrl: '/pages',
    slug: 'top',
  });
  assert.doesNotMatch(topLevel, /breadcrumb-folder/);
  assert.match(topLevel, /<span class="current">Top<\/span>/);
});
