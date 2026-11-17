#!/usr/bin/env node
// Isolated, repeatable owner-list benchmark. No service entry point, live
// configuration, watchers, installs, or network access outside loopback.
// Usage: node scripts/benchmark-page-lists.js --baseline
//        node scripts/benchmark-page-lists.js --source . --label after --assert-bounded
// Artifacts remain under build/page-lists-* for inspection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const baseline = args.includes('--baseline');
const label = value('--label', baseline ? '8a7881d' : 'after');
const count = 2400;
const currentUri = 'deep/level/two/current';
const round = n => Math.round(n * 100) / 100;
const entries = data => data.items || data.pages || [];

async function worker() {
  const source = path.resolve(value('--source', repo));
  const output = path.resolve(value('--output'));
  const dataDir = path.join(output, 'data');
  const contentDir = path.join(output, 'content');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  process.env.PAGES_DATA_DIR = dataDir;
  fs.writeFileSync(path.join(contentDir, 'fixture.md'), '# Benchmark document\n\nA small fixed document for measuring owner navigation.\n');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    contentDir, sharing: { enabled: false }, externalFiles: { enabled: false, allowedSources: {} },
    auth: { password: null }, cache: { enabled: true, maxEntries: 10 },
  }));
  const load = relative => import(pathToFileURL(path.join(source, relative)));
  const { default: express } = await load('node_modules/express/index.js');
  const { getConfig } = await load('src/lib/config.js');
  const { getPagesDb, closePagesDb } = await load('src/db/pages-db.js');
  const { initPageStore, registerLogicalPage } = await load('src/pages/page-store.js');
  const { initCache } = await load('src/cache/pageCache.js');
  const { getPage } = await load('src/services/pageService.js');
  const { setupAuth, hashPassword } = await load('src/security/auth.js');
  const { adminRoute } = await load('src/routes/admin.js');
  const { pageRoute } = await load('src/routes/pages.js');
  const { setupPageApi } = await load('src/routes/page-api.js');
  const config = getConfig();
  config.auth.password = hashPassword('isolated-benchmark-password');
  initPageStore();
  initCache(config.cache);
  const uris = [];
  for (let i = 0; i < 120; i++) uris.push(`root-${String(i).padStart(3, '0')}`);
  for (let f = 0; f < 64; f++) {
    for (let i = 0; i < 30; i++) uris.push(`folder-${String(f).padStart(2, '0')}/page-${String(i).padStart(3, '0')}`);
  }
  for (let i = 0; i < 240; i++) uris.push(`bulk/page-${String(i).padStart(3, '0')}`);
  for (let i = 0; i < 119; i++) uris.push(`deep/level/two/page-${String(i).padStart(3, '0')}`);
  uris.push(currentUri);
  if (uris.length !== count) throw new Error('Fixture size changed');
  getPagesDb().transaction(() => {
    uris.forEach((uri, i) => registerLogicalPage({
      uri, title: `Needle document ${String(i).padStart(4, '0')}`,
      sourcePath: path.join(contentDir, 'fixture.md'),
    }, config));
  })();
  const app = express();
  setupAuth(app, config.auth, config.sharing);
  app.use('/_assets', express.static(path.join(source, 'assets')));
  setupPageApi(app, config);
  app.get('/', adminRoute());
  app.get('/:slug(*)', pageRoute(config));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=isolated-benchmark-password', redirect: 'manual',
    });
    const cookie = login.headers.getSetCookie().find(item => item.startsWith('__Secure-zylos_pages_session='))?.split(';')[0];
    if (!cookie) throw new Error('Isolated owner login did not issue a session cookie');
    const request = async route => {
      const start = performance.now();
      const response = await fetch(`${base}${route}`, { headers: { cookie } });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`${route}: HTTP ${response.status}`);
      return { bytes: Buffer.byteLength(text), requestMs: round(performance.now() - start), text };
    };
    // Render once before measurements: timings compare list handling rather
    // than a one-time markdown worker/highlighter initialization.
    await getPage(`p/${currentUri}`, config);
    const admin = await request('/');
    const sidebar = await request(`/p/${currentUri}`);
    const rootList = await request('/api/pages?folder=&offset=0&limit=50');
    const folderList = await request('/api/pages?folder=bulk&offset=0&limit=50');
    const searchList = await request('/api/pages?q=Needle&offset=0&limit=50');
    const rootData = JSON.parse(rootList.text);
    const folderData = JSON.parse(folderList.text);
    const searchData = JSON.parse(searchList.text);
    const sidebarHtml = sidebar.text.match(/<aside\b[^>]*class="[^"]*nav-sidebar[\s\S]*?<\/aside>/)?.[0] || '';
    let playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
    if (!playwrightPath || !process.env.PAGES_CHROMIUM_PATH) throw new Error('Set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for browser benchmarks');
    if (fs.statSync(playwrightPath).isDirectory()) playwrightPath = path.join(playwrightPath, 'index.mjs');
    const { chromium } = await import(pathToFileURL(playwrightPath));
    browser = await chromium.launch({ executablePath: process.env.PAGES_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    async function browserInitial(route, selector) {
      const context = await browser.newContext({ extraHTTPHeaders: { cookie } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const responses = [];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (new URL(response.url()).pathname === '/api/pages') responses.push((async () => ({
          url: new URL(response.url()).pathname + new URL(response.url()).search,
          status: response.status(), bytes: (await response.body()).length,
          requestMs: round((await response.finished(), response.request().timing().responseEnd)),
          items: entries(await response.json()).length,
        }))());
      });
      const start = performance.now();
      await page.goto(`${base}${route}`);
      if (route !== '/') await page.locator('.nav-toggle').click();
      await page.locator(selector).first().waitFor();
      const firstUsableMs = round(performance.now() - start);
      await page.waitForLoadState('networkidle');
      const initial = {
        firstUsableMs,
        renderedRows: await page.locator(route === '/' ? '.tree-row' : '.nav-sidebar .page-nav-list li').count(),
        renderedPageLinks: await page.locator(route === '/' ? '.tree-doc .tree-title' : '.nav-sidebar .page-nav-list a[href*="/p/"]').count(),
        listRequests: await Promise.all(responses), errors,
        document: await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          return { transferBytes: nav.transferSize, bodyBytes: nav.encodedBodySize, requestMs: Math.round(nav.responseEnd * 100) / 100 };
        }),
      };
      return { page, context, initial };
    }
    const adminBrowser = await browserInitial('/', '.tree-row');
    const sidebarBrowser = await browserInitial(`/p/${currentUri}`, `.nav-sidebar a[href$="/p/${currentUri}"]`);
    const initialCurrentPageReachable = await sidebarBrowser.page.locator(`.nav-sidebar a[href$="/p/${currentUri}"]`).isVisible();
    const traversals = {};
    const interactions = {};
    if (args.includes('--exercise')) {
      for (const [name, query, expected] of [['root', 'folder=', 186], ['bulk', 'folder=bulk', 240], ['search', 'q=Needle', count]]) {
        const seen = new Set();
        let offset = 0;
        let requests = 0;
        let bounded = true;
        do {
          const data = JSON.parse((await request(`/api/pages?${query}&limit=50&offset=${offset}`)).text);
          const batch = entries(data);
          bounded &&= batch.length <= 50;
          batch.forEach(item => seen.add(item.kind === 'folder' ? `folder:${item.path}` : `page:${item.uri}`));
          requests++;
          const next = data.nextOffset;
          if (next === undefined || next === null) break;
          if (!Number.isInteger(next) || next <= offset || requests > 100) throw new Error(`Non-progressing ${name} pagination`);
          offset = next;
        } while (true);
        traversals[name] = { requests, uniqueItems: seen.size, expected, bounded, complete: seen.size === expected };
      }
      const ensure = (ok, message) => { if (!ok) throw new Error(message); };
      const waitCount = async (locator, expected) => {
        const deadline = performance.now() + 5000;
        while (await locator.count() !== expected && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        ensure(await locator.count() === expected, `Expected ${expected} rows; saw ${await locator.count()}`);
      };
      const exercise = async (name, action) => {
        try { await action(); interactions[name] = { status: 'pass' }; }
        catch (error) { interactions[name] = { status: 'fail', reason: error.message.slice(0, 2000) }; }
        fs.writeFileSync(path.join(output, 'interactions-progress.json'), JSON.stringify(interactions, null, 2));
      };
      const adminPage = adminBrowser.page;
      const bulkRow = () => adminPage.locator('.tree-folder').filter({ has: adminPage.locator('.tree-name', { hasText: /^bulk$/ }) });
      const bulkGroup = () => bulkRow().locator('..');
      await exercise('adminRootLoadMore', async () => {
        const more = adminPage.locator('.doc-tree > .load-more');
        ensure(await more.count() === 1, 'Root Load more button missing');
        ensure(await adminPage.locator('.tree-row').count() === 50, 'Initial root is not 50 rows');
        await more.click();
        await waitCount(adminPage.locator('.tree-row'), 100);
      });
      await exercise('adminBulkFolderLoadMore', async () => {
        ensure(await bulkRow().count() === 1, 'Bulk folder missing');
        if (await bulkRow().getAttribute('aria-expanded') !== 'true') await bulkRow().click();
        await waitCount(bulkGroup().locator('.tree-doc'), 50);
        await bulkGroup().locator('.load-more').click();
        await waitCount(bulkGroup().locator('.tree-doc'), 100);
      });
      await exercise('adminExpandedFolderRestoredAfterReload', async () => {
        await adminPage.reload();
        await bulkRow().waitFor({ timeout: 5000 });
        ensure(await bulkRow().getAttribute('aria-expanded') === 'true', 'Explicitly expanded folder was not restored');
        await waitCount(bulkGroup().locator('.tree-doc'), 50);
      });
      await exercise('adminExpandedFolderBeyondFirstBatchRestored', async () => {
        const more = adminPage.locator('.doc-tree > .load-more');
        ensure(await more.count() === 1, 'Root Load more button missing');
        await more.click();
        const row = () => adminPage.locator('.tree-folder').filter({ has: adminPage.locator('.tree-name', { hasText: /^folder-63$/ }) });
        await row().waitFor();
        if (await row().getAttribute('aria-expanded') !== 'true') await row().click();
        await waitCount(row().locator('..').locator('.tree-doc'), 30);
        await adminPage.reload();
        await row().waitFor();
        ensure(await row().getAttribute('aria-expanded') === 'true', 'Folder beyond first root batch was not restored');
        await waitCount(row().locator('..').locator('.tree-doc'), 30);
        ensure(await adminPage.locator('.tree-folder').count() <= 52, 'Restoring a branch eagerly loaded the full root');
      });
      await exercise('adminSearchLoadMore', async () => {
        await adminPage.locator('.admin-search input').fill('Needle');
        await adminPage.locator('.admin-search').evaluate(form => form.requestSubmit());
        await waitCount(adminPage.locator('.tree-doc'), 50);
        await adminPage.locator('.doc-tree > .load-more').click();
        await waitCount(adminPage.locator('.tree-doc'), 100);
        const urls = await adminPage.locator('.tree-title').evaluateAll(nodes => nodes.map(node => node.href));
        ensure(new Set(urls).size === 100, 'Duplicate search rows');
        await adminPage.locator('.doc-tree > .load-more').click();
        await waitCount(adminPage.locator('.tree-doc'), 150);
      });
      const navPage = sidebarBrowser.page;
      const navRoot = navPage.locator('.nav-sidebar .page-nav-list');
      const navBulk = () => navRoot.locator(':scope > li.nav-folder').filter({ has: navPage.locator('.nav-folder-name', { hasText: /^bulk$/ }) });
      await exercise('sidebarDeepCurrentPath', async () => {
        ensure(await navPage.locator(`.nav-sidebar li.active a[href$="/p/${currentUri}"]`).isVisible(), 'Current page is not active and visible');
        ensure(await navPage.locator('.nav-sidebar details[open]').count() >= 3, 'Current ancestors are not expanded separately');
      });
      await exercise('sidebarRootLoadMore', async () => {
        const more = navRoot.locator(':scope > li > .nav-load-more');
        ensure(await more.count() === 1, 'Sidebar root Load more button missing');
        const before = await navRoot.locator(':scope > li:not(:has(> button))').count();
        await more.click();
        // Current-path ancestors are pinned even outside the root batch.
        await waitCount(navRoot.locator(':scope > li:not(:has(> button))'), before + 50);
      });
      await exercise('sidebarBulkFolderLoadMore', async () => {
        ensure(await navBulk().count() === 1, 'Sidebar bulk folder missing');
        await navBulk().locator('summary').click();
        await waitCount(navBulk().locator('a'), 50);
        await navBulk().locator('.nav-load-more').click();
        await waitCount(navBulk().locator('a'), 100);
      });
      await exercise('sidebarSearchLoadMore', async () => {
        const input = navPage.locator('.nav-search input');
        ensure(await input.count() === 1, 'Sidebar search form missing');
        await input.fill('Needle');
        await navPage.locator('.nav-search').evaluate(form => form.requestSubmit());
        await waitCount(navRoot.locator('a'), 50);
        await navRoot.locator('.nav-load-more').click();
        await waitCount(navRoot.locator('a'), 100);
        await navRoot.locator('.nav-load-more').click();
        await waitCount(navRoot.locator('a'), 150);
        const urls = await navRoot.locator('a').evaluateAll(nodes => nodes.map(node => node.href));
        ensure(new Set(urls).size === 150, 'Duplicate sidebar search rows');
      });
    }
    // The same assertions execute on old and new code. Old API responses use
    // pages rather than items, so the negative control fails on actual counts
    // and transferred HTML, not merely a newly absent endpoint/field.
    const checks = {
      rootResponseBounded: entries(rootData).length <= 50,
      folderResponseBounded: entries(folderData).length <= 50,
      searchResponseBounded: entries(searchData).length <= 50,
      adminInitialRowsBounded: adminBrowser.initial.renderedRows <= 50,
      adminInitialJsonBounded: adminBrowser.initial.listRequests.every(r => r.items <= 50),
      sidebarHtmlBounded: (sidebarHtml.match(/<a\b/g) || []).length <= 50 && Buffer.byteLength(sidebarHtml) < 100_000,
      sidebarDoesNotEmbedAllPages: !sidebarHtml.includes('Needle document 2000'),
      searchRetainsMoreThan100Matches: (searchData.matchedTotal ?? searchData.total) > 100,
      currentPageReachable: initialCurrentPageReachable,
      noBrowserErrors: !adminBrowser.initial.errors.length && !sidebarBrowser.initial.errors.length,
      ...(args.includes('--exercise') ? {
        allPagedTraversalsComplete: Object.values(traversals).every(run => run.complete && run.bounded),
        allBrowserInteractionsPass: Object.values(interactions).every(run => run.status === 'pass'),
      } : {}),
    };
    const clean = ({ text, ...metric }) => metric;
    const result = {
      label, source, fixture: { pages: count, topFolders: 66, rootPages: 120, bulkPages: 240, deepCurrentPage: currentUri },
      methodology: 'Fresh browser context; loopback HTTP without compression; source-specific assets; identical isolated SQLite fixture; markdown renderer warmed before requests; wall times indicative, not thresholds.',
      adminHtml: clean(admin), sidebarDocument: clean(sidebar),
      sidebarHtml: { bytes: Buffer.byteLength(sidebarHtml), pageLinks: (sidebarHtml.match(/<a\b/g) || []).length },
      rootList: { ...clean(rootList), items: entries(rootData).length, total: rootData.total, matchedTotal: rootData.matchedTotal },
      folderList: { ...clean(folderList), items: entries(folderData).length, total: folderData.total, matchedTotal: folderData.matchedTotal },
      searchList: { ...clean(searchList), items: entries(searchData).length, total: searchData.total, matchedTotal: searchData.matchedTotal },
      adminBrowser: adminBrowser.initial, sidebarBrowser: sidebarBrowser.initial, traversals, interactions, checks,
    };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'admin.html'), admin.text);
    fs.writeFileSync(path.join(output, 'sidebar-document.html'), sidebar.text);
    console.log(`BENCHMARK_RESULT ${JSON.stringify({ output, checks })}`);
    if (args.includes('--assert-bounded') && Object.values(checks).some(ok => !ok)) process.exitCode = 1;
    await adminBrowser.context.close();
    await sidebarBrowser.context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    closePagesDb();
  }
}

if (args.includes('--worker')) {
  await worker();
} else {
  fs.mkdirSync(path.join(repo, 'build'), { recursive: true });
  const output = fs.mkdtempSync(path.join(repo, `build/page-lists-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}-`));
  let source = path.resolve(value('--source', repo));
  if (baseline) {
    source = path.join(output, 'source');
    fs.mkdirSync(source);
    const archive = spawnSync('git', ['archive', '8a7881d'], { cwd: repo, maxBuffer: 40 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(archive.stderr.toString());
    const unpack = spawnSync('tar', ['-x', '-C', source], { input: archive.stdout });
    if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  }
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args.filter(x => x !== '--baseline'), '--worker', '--source', source, '--output', output, '--label', label], { cwd: repo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, 'run.log'), run.stdout + run.stderr);
  console.log(run.stdout.split('\n').filter(line => line.startsWith('BENCHMARK_RESULT ')).join('\n'));
  if (run.status !== 0 && !run.stdout.includes('BENCHMARK_RESULT ')) console.error((run.stderr || run.stdout).slice(-4000));
  process.exitCode = run.status ?? 1;
}
