import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-list-'));
process.env.PAGES_DATA_DIR = dataDir;
assertIsolatedPagesDataDir(dataDir);
const contentDir = path.join(dataDir, 'content');
await mkdir(contentDir);
const config = { contentDir, externalFiles: { enabled: true, allowedSources: { content: contentDir } } };
await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
const sourcePath = path.join(contentDir, 'page.md');
await writeFile(sourcePath, '# Page');
const { registerLogicalPage, searchLogicalPages } = await import('../src/pages/page-store.js');
const { scanPages } = await import('../src/pages/navigation.js');
const { setupPageApi } = await import('../src/routes/page-api.js');
const { adminRoute } = await import('../src/routes/admin.js');
const express = (await import('express')).default;
for (let i = 0; i < 520; i++) {
  registerLogicalPage({ uri: `folder${Math.floor(i / 20)}/page${String(i).padStart(3, '0')}`,
    title: `Page ${String(i).padStart(3, '0')}`, sourcePath, component: 'content' }, config);
}

test.after(async () => { await rm(dataDir, { recursive: true, force: true }); });

async function withServer(run) {
  const app = express();
  const router = express.Router();
  router.use('/_assets', express.static(path.resolve('assets')));
  setupPageApi(router, config);
  router.get('/', adminRoute());
  for (const base of ['/one', '/two']) {
    app.use(base, (req, _res, next) => { req.headers['x-forwarded-prefix'] = base; next(); }, router);
  }
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('empty search returns 520 pages and agrees with navigation; title search stays capped', async () => {
  const pages = searchLogicalPages('');
  assert.equal(pages.length, 520);
  assert.equal(searchLogicalPages('   ').length, 520);
  assert.equal(searchLogicalPages('Page').length, 100);
  assert.equal(searchLogicalPages('Page 519').length, 1);
  const navigation = await scanPages(contentDir);
  assert.deepEqual(navigation.map(page => page.slug).sort(), pages.map(page => `p/${page.uri}`).sort());
});

test('page list API returns all pages and total with mounted browser URLs', async () => {
  await withServer(async origin => {
    const res = await fetch(`${origin}/one/api/pages`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pages.length, 520);
    assert.equal(body.total, 520);
    assert.ok(body.pages.every(page => page.url === `/one/p/${page.uri}`));
    const filtered = await (await fetch(`${origin}/one/api/pages?q=Page`)).json();
    assert.equal(filtered.pages.length, 100);
  });
});

test('CLI lists all pages by default and applies a positive --limit after URI sorting', () => {
  const run = (...args) => spawnSync(process.execPath, ['src/cli/pages.js', 'list', ...args, '--json'], {
    env: { ...process.env, PAGES_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  const all = run();
  assert.equal(all.status, 0, all.stderr);
  const entries = JSON.parse(all.stdout).entries;
  assert.equal(entries.length, 520);
  const limited = run('--limit', '7');
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(JSON.parse(limited.stdout).entries, entries.slice(0, 7));
  assert.equal(JSON.parse(run('--limit', '1000').stdout).entries.length, 520);
  assert.equal(JSON.parse(run('--q', 'Page').stdout).entries.length, 100);
  assert.equal(JSON.parse(run('--q', 'Page', '--limit', '3').stdout).entries.length, 3);
  for (const value of ['0', '-1', '1.5', 'nope']) {
    const invalid = run('--limit', value);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /positive integer/);
  }
});

test('Chromium renders 520 pages and keeps folder state across reload/search with instance isolation', {
  skip: !process.env.PAGES_PLAYWRIGHT_CORE_PATH || !process.env.PAGES_CHROMIUM_PATH,
  timeout: 30_000,
}, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.PAGES_PLAYWRIGHT_CORE_PATH);
  const browser = await chromium.launch({ executablePath: process.env.PAGES_CHROMIUM_PATH,
    headless: true, args: ['--no-sandbox'] });
  try {
    await withServer(async origin => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/one/`);
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 520);
      assert.equal(await page.locator('.admin-count').textContent(), '520 pages');
      assert.equal(await page.locator('.tree-folder').count(), 26);
      const folder = page.locator('.tree-folder').filter({ hasText: /^folder0/ });
      await folder.click();
      assert.equal(await folder.getAttribute('aria-expanded'), 'false');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('zylos-pages:collapsedFolders:/one')).includes('folder0'));
      const artifacts = path.resolve('build/acceptance-207-209');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, 'collapsed-before-reload.png') });
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 500);
      assert.equal(await folder.getAttribute('aria-expanded'), 'false');
      await page.screenshot({ path: path.join(artifacts, 'collapsed-after-reload.png') });
      await page.getByRole('textbox', { name: 'Search pages by title' }).fill('Page 519');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 1);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('zylos-pages:collapsedFolders:/one'))), ['folder0']);
      await page.getByRole('button', { name: 'Clear search', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 500);
      assert.equal(await folder.getAttribute('aria-expanded'), 'false');
      await page.goto(`${origin}/two/`);
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 520);
      assert.equal(await folder.getAttribute('aria-expanded'), 'true');
      await page.goto(`${origin}/one/`);
      await page.waitForFunction(() => document.querySelectorAll('.tree-doc').length === 500);
      assert.equal(await folder.getAttribute('aria-expanded'), 'false');
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally { await browser.close(); }
});
