import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pageTemplate, htmlArtifactTemplate } from '../src/templates/pageTemplate.js';

const playwrightPath = process.env.PAGES_PLAYWRIGHT_CORE_PATH;
const chromiumPath = process.env.PAGES_CHROMIUM_PATH;
const available = playwrightPath && chromiumPath && fs.existsSync(playwrightPath) && fs.existsSync(chromiumPath);
const options = { skip: available ? false : 'set browser paths for browser coverage', timeout: 120_000 };
const oldShare = { tokenId: 'old-link', shortUrl: 'https://example.test/s/old-link',
  createdAt: 1700000000000, expiresAt: 0, canWriteAttachments: false, protection: { type: 'none' } };
const newShare = { ...oldShare, tokenId: 'new-link', shortUrl: 'https://example.test/s/new-link',
  protection: { type: 'password' } };

async function fixture(run) {
  const assets = path.resolve(import.meta.dirname, '../assets');
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/_assets/')) {
      const name = path.basename(pathname);
      if (['style.css', 'share.js'].includes(name)) {
        response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
        response.end(fs.readFileSync(path.join(assets, name))); return;
      }
      response.end(''); return;
    }
    response.setHeader('Content-Type', 'text/html');
    const props = { title: 'Release notes', baseUrl: '', slug: 'release-notes' };
    response.end(pathname === '/html'
      ? htmlArtifactTemplate({ ...props, iframeSrc: '/frame', sandboxed: true })
      : pageTemplate({ ...props, description: '', tags: [], tocItems: [], bodyHtml: '<p>Release notes</p>' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = createRequire(import.meta.url)(playwrightPath);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    await run(browser, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function mockApi(page, state) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      if (state.revokeFailed) return route.fulfill({ status: 403, json: { ok: false, error: 'Revoke denied' } });
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('/password')) {
        const tokenId = pathname.split('/')[3];
        state.shares = state.shares.map(share => share.tokenId === tokenId ? { ...share, protection: { type: 'none' } } : share);
      } else if (pathname.startsWith('/api/share/')) {
        state.shares = state.shares.filter(share => share.tokenId !== pathname.split('/')[3]);
      } else state.shares = [];
      if (state.failAfterMutation) state.listFailed = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'POST') {
      state.posts++;
      state.body = request.postDataJSON();
      if (state.createFailed) return route.fulfill({ status: 403, json: { error: 'Creation denied' } });
      const createdShare = { ...newShare, protection: { type: state.body.protection.type } };
      state.shares = [...state.shares, createdShare];
      state.created = true;
      return route.fulfill({ json: { ok: true, ...createdShare, url: newShare.shortUrl,
        protection: state.body.protection.type === 'password'
          ? { type: 'password', password: 'fixture-password' } : { type: 'none' } } });
    }
    if (state.listFailed || (state.failAfterCreate && state.created)) {
      return route.fulfill({ status: 503, json: { ok: true, shares: [] } });
    }
    return route.fulfill({ json: { ok: true, shares: state.shares } });
  });
  await page.addInitScript(() => {
    window.copied = [];
    window.copyDenied = false;
    window.fallbackAllowed = false;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (window.copyDenied) throw new Error('denied');
      window.copied.push(text);
    } } });
    document.execCommand = () => window.fallbackAllowed;
  });
}

test('share modal consolidates results and preserves warning, password and copy failure paths', options, async () => {
  await fixture(async (browser, origin) => {
    for (const kind of ['markdown', 'html']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const state = { shares: [oldShare], posts: 0 };
      await mockApi(page, state);
      await page.goto(`${origin}/${kind}`);
      await page.locator('.share-btn').click();
      const warning = page.locator('.share-security-warning');
      await page.locator('.share-item').waitFor();
      assert.equal(await warning.isVisible(), false, 'an unprotected link alone needs no repeated warning');
      await page.locator('.share-password-input').check();
      await warning.waitFor({ state: 'visible' });
      assert.equal(await warning.evaluate(node => node.parentElement.className), 'share-create');
      await page.locator('.share-password-input').uncheck();
      assert.equal(await warning.isVisible(), false);
      await page.locator('.share-password-input').check();
      await page.locator('.share-editable-input').check();
      await page.locator('.share-generate-btn').click();
      const recent = page.locator('.share-item.is-new');
      await recent.waitFor();
      assert.equal(await page.locator('.share-result').count(), 0);
      assert.equal(await page.locator('.share-item').count(), 2);
      assert.equal(await page.locator('.share-item').first().getAttribute('class'), 'share-item is-new');
      assert.equal(await recent.locator('.share-item-copy-btn').count(), 1);
      assert.deepEqual(state.body, { slug: 'release-notes', duration: '24h', canWriteAttachments: true,
        protection: { type: 'password', mode: 'generated' } });
      await recent.locator('.share-item-copy-btn').click();
      await page.waitForFunction(() => window.copied.length === 1);
      assert.equal(await page.evaluate(() => window.copied[0]), newShare.shortUrl);
      await page.evaluate(() => { window.copyDenied = true; });
      await recent.locator('.share-item-copy-btn').click();
      await page.waitForFunction(() => document.activeElement?.classList.contains('share-link-input'));
      assert.equal(await recent.locator('.share-item-copy-btn').textContent(), 'Copy failed');
      assert.deepEqual(await recent.locator('.share-link-input').evaluate(node => [node.selectionStart, node.selectionEnd]),
        [0, newShare.shortUrl.length]);
      assert.equal(await page.locator('.share-created-password').count(), 0);
      const password = recent.locator('.share-password-secret');
      assert.equal(await password.isVisible(), true);
      assert.equal(await page.locator('.share-password-secret').count(), 1, 'password controls exist only in the protected link row');
      assert.notEqual(await password.locator('code').textContent(), 'fixture-password');
      await password.locator('.share-password-reveal-btn').click();
      await page.waitForFunction(() => document.querySelector('.share-item.is-new code').textContent === 'fixture-password');
      assert.equal(await password.locator('code').textContent(), 'fixture-password');
      await password.locator('.share-password-reveal-btn').click();
      await page.waitForFunction(() => document.querySelector('.share-item.is-new code').textContent !== 'fixture-password');
      await password.locator('.share-password-copy-btn').click();
      await page.waitForFunction(() => document.querySelector('.share-password-copy-btn').textContent === 'Copy failed');
      assert.equal(await password.locator('code').textContent(), 'fixture-password', 'failed secret copy remains manually selectable');
      assert.equal(await page.evaluate(() => window.getSelection().toString()), 'fixture-password');
      await page.locator('.share-password-input').uncheck();
      assert.equal(await warning.isVisible(), true, 'a protected link coexisting with an unprotected link remains contextual');
      await page.locator('.share-modal-close').click();
      assert.equal(await page.locator('.share-password-secret code').textContent(), '••••••••••••••••••••••');
      const previousShareRow = await page.locator('.share-item').first().elementHandle();
      await page.locator('.share-btn').click();
      // Reopening retains old rows until loadShares replaces the list.
      await page.waitForFunction(row => !row.isConnected, previousShareRow);
      await previousShareRow.dispose();
      assert.equal(await page.locator('.share-item.is-new').count(), 0);
      assert.equal(await page.locator('.share-password-secret code').textContent(), '••••••••••••••••••••••');

      state.shares = [newShare];
      await page.locator('.share-modal-close').click();
      await page.locator('.share-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.share-item').length === 1);
      assert.equal(await warning.isVisible(), false, 'protected-only list does not warn');
      await page.evaluate(() => { window.fallbackAllowed = true; });
      await page.locator('.share-item-copy-btn').click();
      await page.waitForFunction(() => document.querySelector('.share-item-copy-btn').textContent === 'Copied!');
      assert.equal(state.posts, 1);
      const dialogs = [];
      page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
      state.revokeFailed = true;
      const rejected = page.waitForEvent('dialog');
      await page.locator('.share-revoke-all-btn').click();
      await rejected;
      assert.equal(await page.locator('.share-item').count(), 1);
      state.revokeFailed = false;
      await page.locator('.share-revoke-all-btn').click();
      await page.getByText('No active shares', { exact: true }).waitFor();
      assert.equal(await page.locator('.share-password-secret').count(), 0);
      assert.deepEqual(dialogs, ['Revoke denied']);
      const hostileUrl = 'https://example.test/s/\"><img src=x onerror=alert(1)>';
      state.shares = [{ ...oldShare, shortUrl: hostileUrl }];
      await page.locator('.share-modal-close').click();
      await page.locator('.share-btn').click();
      await page.locator('.share-link-input').waitFor();
      assert.equal(await page.locator('.share-link-input').inputValue(), hostileUrl);
      assert.equal(await page.locator('.share-list-items img').count(), 0, 'URL text cannot inject markup');
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
});

test('share modal handles create rejection and failed refresh without losing or duplicating new links', options, async () => {
  await fixture(async (browser, origin) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const state = { shares: [oldShare], posts: 0, createFailed: true };
    await mockApi(page, state);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.goto(`${origin}/markdown`);
    await page.locator('.share-btn').click();
    await page.locator('.share-item').waitFor();
    await page.locator('.share-generate-btn').click();
    await page.waitForFunction(() => !document.querySelector('.share-generate-btn').disabled);
    assert.deepEqual(dialogs, ['Creation denied']);
    assert.equal(await page.locator('.share-item.is-new').count(), 0);
    state.createFailed = false;
    state.failAfterCreate = true;
    await page.locator('.share-password-input').check();
    await page.locator('.share-generate-btn').click();
    await page.locator('.share-item.is-new').waitFor();
    assert.match(await page.locator('.share-list-items').textContent(), /Failed to refresh shares/);
    assert.equal(await page.locator('.share-item.is-new .share-link-input').inputValue(), newShare.shortUrl);
    assert.equal(await page.locator('.share-created-password').count(), 0);
    const password = page.locator('.share-item.is-new .share-password-secret');
    assert.equal(await password.isVisible(), true);
    await password.locator('.share-password-copy-btn').click();
    await page.waitForFunction(() => window.copied.includes('fixture-password'));
    await password.locator('.share-password-reveal-btn').click();
    await page.waitForFunction(() => document.querySelector('.share-item.is-new code').textContent === 'fixture-password');
    assert.equal(await password.locator('code').textContent(), 'fixture-password', 'generated secret stays available when refresh fails');
    assert.equal(await page.locator('.share-security-warning').isVisible(), true, 'failed refresh retains the warning about a known unprotected link');
    assert.equal(await page.locator('.share-item').count(), 2, 'known links remain available alongside the created link');
    assert.equal(await page.locator('.share-revoke-all-btn').count(), 0, 'partial list cannot suggest a complete revoke-all view');
    assert.equal(state.posts, 2, 'failed refresh never retries creation');
    await page.locator('.share-modal-close').click();
    await page.locator('.share-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.share-item').length === 0);
    assert.match(await page.locator('.share-list-items').textContent(), /Failed to refresh/);
    state.failAfterCreate = false;
    state.shares = [];
    await page.locator('.share-modal-close').click();
    await page.locator('.share-btn').click();
    await page.getByText('No active shares', { exact: true }).waitFor();
    assert.equal(await page.locator('.share-security-warning').isVisible(), false);
    await page.locator('.share-password-input').uncheck();
    await page.locator('.share-generate-btn').click();
    await page.locator('.share-item.is-new').waitFor();
    assert.equal(await page.locator('.share-password-secret').count(), 0);
    assert.equal(await page.locator('.share-security-warning').isVisible(), false);
    assert.equal(await page.locator('.share-item-copy-btn').count(), 1);
    assert.equal(state.posts, 3);
  });
});

test('share modal stays readable and contained across page types, themes and viewport widths', options, async () => {
  await fixture(async (browser, origin) => {
    const evidenceDir = process.env.PAGES_SHARE_EVIDENCE_DIR;
    if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
    for (const kind of ['markdown', 'html']) for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 920 } });
      page.setDefaultTimeout(5000);
      const state = { shares: [oldShare], posts: 0 };
      await mockApi(page, state);
      await page.goto(`${origin}/${kind}`);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('.share-btn').click();
      await page.locator('.share-item').waitFor();
      await page.locator('.share-password-input').check();
      await page.locator('.share-generate-btn').click();
      await page.locator('.share-item.is-new').waitFor();
      await page.waitForFunction(() => !document.querySelector('.share-generate-btn').disabled);
      const metrics = await page.locator('.share-link-input').first().evaluate(node => {
        const style = getComputedStyle(node);
        const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
          v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        const luminance = color => rgb(color).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
        const content = document.querySelector('.share-modal-content');
        return { contrast: (values[0] + 0.05) / (values[1] + 0.05), overflow: content.scrollWidth > content.clientWidth + 1,
          outside: [...document.querySelectorAll('#share-modal button, #share-modal input')].filter(el => el.getClientRects().length)
            .some(el => el.getBoundingClientRect().right > innerWidth || el.getBoundingClientRect().left < 0) };
      });
      assert.ok(metrics.contrast >= 4.5, JSON.stringify({ kind, width, theme, metrics }));
      assert.equal(metrics.overflow, false, JSON.stringify({ kind, width, theme, metrics }));
      assert.equal(metrics.outside, false, JSON.stringify({ kind, width, theme, metrics }));
      if (evidenceDir) {
        await page.screenshot({ path: path.join(evidenceDir, `${kind}-${width}-${theme}.png`), fullPage: true });
        await page.locator('.share-item.is-new .share-item-copy-btn').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidenceDir, `${kind}-${width}-${theme}-link.png`), fullPage: true });
      }
      await page.close();
    }
  });
});

test('successful mutations reconcile cached rows when the following refresh fails', options, async () => {
  await fixture(async (browser, origin) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const state = { shares: [newShare, { ...oldShare, protection: { type: 'password' } }], posts: 0, failAfterMutation: true };
    await mockApi(page, state);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${origin}/markdown`);
    await page.locator('.share-btn').click();
    await page.locator('.share-item').first().waitFor();
    await page.locator('.share-password-remove-btn').first().click();
    await page.getByText('Failed to refresh shares. Reopen to retry.', { exact: true }).waitFor();
    const changed = page.locator('.share-item').filter({ has: page.locator('[value="https://example.test/s/new-link"]') });
    assert.equal(await changed.locator('.share-protection-label').textContent(), 'Unprotected');
    assert.equal(await page.locator('.share-security-warning').isVisible(), true);
    await changed.locator('.share-revoke-link-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.share-item').length === 1);
    assert.equal(await page.locator('.share-security-warning').isVisible(), false);
    state.listFailed = false;
    await page.locator('.share-modal-close').click();
    await page.locator('.share-btn').click();
    await page.locator('.share-revoke-all-btn').waitFor();
    await page.locator('.share-revoke-all-btn').click();
    await page.getByText('Failed to refresh shares. Reopen to retry.', { exact: true }).waitFor();
    assert.equal(await page.locator('.share-item').count(), 0, 'revoked entries cannot reappear from the cache');
  });
});
