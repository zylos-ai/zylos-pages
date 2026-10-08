import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const playwrightCorePath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const browserAvailable = Boolean(
  playwrightCorePath && chromiumPath && fs.existsSync(playwrightCorePath) && fs.existsSync(chromiumPath),
);

test('Chromium provisions one bridge port, revokes it on navigation, and blocks enforceable egress', {
  skip: browserAvailable ? false : 'set PAGES_PLAYWRIGHT_CORE_PATH and PAGES_CHROMIUM_PATH for browser coverage',
  timeout: 30_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-browser-data-'));
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-browser-content-'));
  process.env.PAGES_DATA_DIR = dataDir;

  const require = createRequire(import.meta.url);
  const { chromium } = require(playwrightCorePath);
  const express = (await import('express')).default;
  const { initCache } = await import('../src/cache/pageCache.js');
  const { registerLogicalPage } = await import('../src/pages/page-store.js');
  const { setupBridgeApi } = await import('../src/routes/bridge-api.js');
  const { pageRoute } = await import('../src/routes/pages.js');
  const { setupAuth, hashPassword } = await import('../src/security/auth.js');
  const { securityHeaders } = await import('../src/security/headers.js');

  const pagePath = path.join(contentDir, 'browser-bridge.html');
  const targetPath = path.join(contentDir, 'browser-target.html');
  await writeFile(pagePath, '<!doctype html><html><head><title>Browser bridge</title></head><body><a id="target-link" href="/p/browser-target#done">target</a></body></html>');
  await writeFile(targetPath, '<!doctype html><html><head><title>Browser target</title></head><body id="done">target</body></html>');
  const config = {
    contentDir,
    publicBaseUrl: null,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
    auth: { password: hashPassword('secret') },
    externalFiles: { enabled: true, allowedSources: { content: contentDir } },
    state: { maxKeysPerPage: 50, maxPageBytes: 1048576 },
    attachments: { maxPerItem: 50, maxArtifactBytes: 1048576 },
  };

  registerLogicalPage({
    uri: 'browser-bridge', title: 'Browser bridge', sourcePath: pagePath, component: 'content',
    capabilities: ['state.read', 'state.write'], outboundDenied: true,
  }, config);
  registerLogicalPage({
    uri: 'browser-target', title: 'Browser target', sourcePath: targetPath, component: 'content',
  }, config);
  initCache({ maxEntries: 20, ttlSeconds: 60 });

  const hits = [];
  const egressServer = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(204).end();
  });
  egressServer.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise(resolve => egressServer.listen(0, '127.0.0.1', resolve));
  const egressOrigin = `http://127.0.0.1:${egressServer.address().port}`;

  const app = express();
  app.use(securityHeaders());
  app.use('/_assets', express.static(path.join(repoRoot(), 'assets')));
  setupAuth(app, config.auth);
  setupBridgeApi(app, config);
  app.get('/:slug(*)', pageRoute(config));
  const pagesServer = http.createServer(app);
  await new Promise(resolve => pagesServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${pagesServer.address().port}`;

  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/login`);
    await page.locator('input[name="password"]').fill('secret');
    await Promise.all([
      page.waitForURL(`${origin}/`),
      page.locator('form').press('Enter'),
    ]);

    await page.goto(`${origin}/browser-bridge`);
    const firstFrame = await waitForRawFrame(page);
    await firstFrame.waitForFunction(() => Boolean(window.zylosPages));
    await firstFrame.waitForFunction(async () => {
      try {
        await window.zylosPages.request('state.set', { key: 'browser', value: 'ready' });
        return true;
      } catch { return false; }
    });

    for (let index = 0; index < 8; index += 1) {
      await firstFrame.evaluate(() => parent.postMessage({ type: 'zylos-pages:bridge-ready' }, '*'));
    }
    const stored = await firstFrame.evaluate(() => window.zylosPages.request('state.get', { key: 'browser' }));
    assert.deepEqual(stored, { found: true, value: 'ready' });

    await firstFrame.evaluate(async target => {
      const settle = promise => Promise.race([
        promise.catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 750)),
      ]);
      await Promise.all([
        settle(fetch(`${target}/fetch`, { mode: 'no-cors' })),
        settle(new Promise(resolve => {
          const image = new Image();
          image.onload = image.onerror = resolve;
          image.src = `${target}/image`;
        })),
        settle(new Promise(resolve => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.onload = link.onerror = resolve;
          link.href = `${target}/style.css`;
          document.head.append(link);
        })),
        settle(new Promise(resolve => {
          const socket = new WebSocket(target.replace(/^http/, 'ws') + '/socket');
          socket.onopen = socket.onerror = resolve;
        })),
      ]);
      try { navigator.sendBeacon(`${target}/beacon`, 'blocked'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 300));
    }, egressOrigin);
    assert.deepEqual(hits, [], `outbound-denied CSP leaked requests: ${hits.join(', ')}`);

    const reloaded = firstFrame.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const iframe = document.querySelector('.html-artifact-frame');
      iframe.src = `${iframe.dataset.bridgeSrc}&browserReload=1`;
    });
    await reloaded;
    const reloadedFrame = firstFrame;
    await reloadedFrame.waitForFunction(() => Boolean(window.zylosPages));
    const rejection = await reloadedFrame.evaluate(async () => {
      try {
        await window.zylosPages.request('state.get', { key: 'browser' });
        return null;
      } catch (error) {
        return { code: error.code, message: error.message };
      }
    });
    assert.equal(rejection?.code, 'bridge_unavailable');

    await page.goto(`${origin}/browser-bridge`);
    const navigationFrame = await waitForRawFrame(page);
    await navigationFrame.waitForFunction(() => Boolean(window.zylosPages));
    await Promise.all([
      page.waitForURL(`${origin}/p/browser-target#done`),
      navigationFrame.locator('#target-link').click(),
    ]);
  } finally {
    await browser.close();
    await Promise.all([
      new Promise(resolve => pagesServer.close(resolve)),
      new Promise(resolve => egressServer.close(resolve)),
    ]);
    await rm(dataDir, { recursive: true, force: true });
    await rm(contentDir, { recursive: true, force: true });
  }
});

function repoRoot() {
  return path.resolve(import.meta.dirname, '..');
}

async function waitForRawFrame(page) {
  await page.waitForFunction(() => {
    const frame = document.querySelector('.html-artifact-frame');
    return Boolean(frame?.contentWindow);
  });
  for (let index = 0; index < 100; index += 1) {
    const frame = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url().includes('raw=1'));
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('raw artifact iframe did not load');
}
