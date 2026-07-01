import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanPages } from '../src/pages/navigation.js';
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

test('scanPages lists only registered logical pages and preserves directory groups', async () => {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-tree-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-tree-db-'));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-tree-source-'));
  process.env.PAGES_DATA_DIR = dataDir;
  try {
    const config = {
      contentDir,
      externalFiles: {
        allowedSources: {
          source: sourceRoot,
        },
      },
    };
    await writeFile(path.join(contentDir, 'bare.md'), '# Bare filesystem page\n');
    await writeFile(path.join(sourceRoot, 'top.md'), '# Top\n');
    await mkdir(path.join(sourceRoot, 'daily-digest'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'daily-digest', 'a.md'), '# Daily\n');
    await mkdir(path.join(sourceRoot, 'recruit', 'interview-questions'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'recruit', 'interview-questions', 'foo.md'), '# Foo\n');

    const { registerLogicalPage } = await import('../src/pages/page-store.js');
    registerLogicalPage({ uri: 'top', title: 'Top', sourcePath: path.join(sourceRoot, 'top.md'), component: 'source' }, config);
    registerLogicalPage({ uri: 'daily-digest/a', title: 'Daily', sourcePath: path.join(sourceRoot, 'daily-digest', 'a.md'), component: 'source' }, config);
    registerLogicalPage({ uri: 'recruit/interview-questions/foo', title: 'Foo', sourcePath: path.join(sourceRoot, 'recruit', 'interview-questions', 'foo.md'), component: 'source' }, config);

    const pages = await scanPages(contentDir);
    const tree = buildPageTree(pages);

    assert.deepEqual(pages.map(page => page.slug).sort(), [
      'p/daily-digest/a',
      'p/recruit/interview-questions/foo',
      'p/top',
    ]);
    assert.equal(pages.some(page => page.slug === 'bare'), false);
    assert.deepEqual(tree.topLevel.map(page => page.slug), ['p/top']);
    assert.deepEqual(tree.folders.map(folder => folder.path), ['daily-digest', 'recruit/interview-questions']);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('injectNavSidebar expands active folder and escapes folder labels', () => {
  const html = injectNavSidebar('<html><body><!-- NAV_SIDEBAR --></body></html>', [
    { slug: 'top', title: 'Top', date: '2026-06-14' },
    { slug: 'daily-digest/a', title: 'Daily A', date: '2026-06-13' },
    { slug: 'safe/<script>/page', title: 'Unsafe Folder', date: '2026-06-12' },
  ], 'daily-digest/a', '/pages');

  assert.match(html, /<details open><summary><svg class="i"[^>]*stroke="currentColor"[^>]*><path d="M3 7/);
  assert.match(html, /<span class="nav-folder-name">daily-digest<\/span>/);
  assert.match(html, /<li class="active"><a href="\/pages\/daily-digest\/a"><svg class="i"[^>]*stroke="currentColor"[^>]*><path d="M15 2/);
  assert.match(html, /<span>Daily A<\/span><\/a><\/li>/);
  assert.match(html, /safe \/ &lt;script&gt;/);
  assert.doesNotMatch(html, /<span class="nav-folder-name">safe \/ <script>/);
});

test('injectNavSidebar highlights p-prefixed logical pages for canonical routes', () => {
  const html = injectNavSidebar('<html><body><!-- NAV_SIDEBAR --></body></html>', [
    { slug: 'p/visual', title: 'Visual', date: '2026-07-01' },
  ], 'visual', '/pages');

  assert.match(html, /<li class="active"><a href="\/pages\/p\/visual">/);
});

test('viewer chrome uses inline SVG icons and no emoji theme fallback', async () => {
  const html = pageTemplate({
    title: 'Icons',
    description: '',
    date: '',
    tags: [],
    bodyHtml: '<p>Body</p>',
    tocItems: [],
    baseUrl: '/pages',
    slug: 'icons',
  });
  const css = await readFile(new URL('../assets/style.css', import.meta.url), 'utf8');

  assert.match(html, /<button class="theme-toggle icon-btn" aria-label="Toggle dark mode">/);
  assert.match(html, /<span class="theme-icon theme-icon-moon"><svg class="i"[^>]*stroke="currentColor"/);
  assert.match(html, /<span class="theme-icon theme-icon-sun"><svg class="i"[^>]*stroke="currentColor"/);
  const legacyThemeIconPattern = new RegExp('\\u{1f319}|\\u{2600}\\u{fe0f}|theme-icon' + '::before', 'u');
  assert.doesNotMatch(css, legacyThemeIconPattern);
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
