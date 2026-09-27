import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-bridge-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache } = await import('../src/cache/pageCache.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupBridgeApi } = await import('../src/routes/bridge-api.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { getLogicalPageById, registerLogicalPage } = await import('../src/pages/page-store.js');
const { bridgePolicy, normalizePageSecurity } = await import('../src/security/page-capabilities.js');
const { insertAttachment } = await import('../src/attachments/attachment-store.js');
const { ensureAttachmentDirs, resolveFinalPath } = await import('../src/attachments/storage.js');
const { logger } = await import('../src/utils/logger.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function cookieHeader(setCookie) {
  return setCookie.split(/,\s*(?=__Secure-)/).map(value => value.split(';', 1)[0]).join('; ');
}

async function withServer(fn) {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-bridge-content-'));
  const config = {
    contentDir,
    security: { htmlArtifactSandboxEnabled: true, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    auth: { password: hashPassword('secret') },
    sharing: { enabled: true },
    externalFiles: { allowedSources: { content: contentDir } },
    attachments: { maxFileSizeBytes: 1024 },
    state: { maxKeysPerPage: 10, maxPageBytes: 1024 * 1024 },
    cache: { maxEntries: 20, ttlSeconds: 60 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  await writeFile(path.join(contentDir, 'bridge.html'), '<!doctype html><title>Bridge</title><h1>Bridge</h1>');
  await writeFile(path.join(contentDir, 'other.html'), '<!doctype html><title>Other</title><h1>Other</h1>');
  const page = registerLogicalPage({
    uri: 'bridge', title: 'Bridge', sourcePath: path.join(contentDir, 'bridge.html'), component: 'content',
    capabilities: ['state.read', 'state.write', 'attachment.read', 'attachment.write'],
  }, config);
  const other = registerLogicalPage({
    uri: 'other', title: 'Other', sourcePath: path.join(contentDir, 'other.html'), component: 'content',
    capabilities: ['state.read'],
  }, config);

  initCache(config.cache);
  const app = express();
  setupAuth(app, config.auth, config.sharing);
  setupShareApi(app, config.sharing, config);
  setupRawApi(app, config);
  setupBridgeApi(app, config);
  app.get('/:slug(*)', pageRoute(config));
  const server = await new Promise(resolve => {
    const value = http.createServer(app);
    value.listen(0, '127.0.0.1', () => resolve(value));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    const ownerCookie = cookieHeader(login.headers.get('set-cookie'));
    await fn({ origin, config, page, other, ownerCookie });
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(contentDir, { recursive: true, force: true });
  }
}

function bridge(origin, pageId, cookie, operation, input, extra = {}) {
  return fetch(`${origin}/api/bridge/${pageId}`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify({ operation, input, ...(extra.body || {}) }),
  });
}

test('capability policy defaults closed and read capability forces outbound denial', () => {
  assert.deepEqual(normalizePageSecurity(), { capabilities: [], outboundDenied: false, scriptsEnabled: true });
  const normalized = normalizePageSecurity({ capabilities: ['state.read'], outboundDenied: false });
  assert.equal(normalized.outboundDenied, true);
  assert.equal(bridgePolicy({ type: 'html', scriptsEnabled: true, outboundDenied: false, capabilities: ['state.read'] }).enabled, false);
  assert.equal(bridgePolicy({ type: 'html', scriptsEnabled: false, outboundDenied: true, capabilities: ['state.read'] }).enabled, false);
  assert.throws(() => normalizePageSecurity({ capabilities: ['dashboard.read'] }), /unsupported capability/);
});

test('page security metadata is visible and legacy rows migrate to closed defaults', async () => {
  await withServer(async ({ page }) => {
    const stored = getLogicalPageById(page.pageId);
    assert.deepEqual(stored.capabilities, ['attachment.read', 'attachment.write', 'state.read', 'state.write']);
    assert.equal(stored.outboundDenied, true);
    assert.equal(stored.scriptsEnabled, true);
    const columns = new Set(getPagesDb().prepare('PRAGMA table_info(logical_pages)').all().map(column => column.name));
    assert.ok(columns.has('capabilities_json'));
    assert.ok(columns.has('outbound_denied'));
    assert.ok(columns.has('scripts_enabled'));
  });
});

test('owner bridge operations are page-bound, schema-checked, and cover state and attachments', async () => {
  await withServer(async ({ origin, page, other, ownerCookie }) => {
    let response = await bridge(origin, page.pageId, ownerCookie, 'state.set', { key: 'counter', value: { n: 1 } });
    assert.equal(response.status, 200);
    response = await bridge(origin, page.pageId, ownerCookie, 'state.get', { key: 'counter' });
    assert.deepEqual((await response.json()).result, { found: true, value: { n: 1 } });

    response = await bridge(origin, other.pageId, ownerCookie, 'state.get', { key: 'counter' });
    assert.deepEqual((await response.json()).result, { found: false });

    response = await bridge(origin, page.pageId, ownerCookie, 'state.get', { key: 'counter', pageId: other.pageId });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');

    response = await bridge(origin, page.pageId, ownerCookie, 'attachment.put', {
      key: 'photos', filename: 'photo.jpg', mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64'),
    });
    assert.equal(response.status, 200);
    const attachment = (await response.json()).result.attachment;

    response = await bridge(origin, page.pageId, ownerCookie, 'attachment.list', { key: 'photos' });
    assert.equal((await response.json()).result.attachments.length, 1);
    response = await bridge(origin, page.pageId, ownerCookie, 'attachment.get', { attachmentId: attachment.attachmentId });
    assert.equal((await response.json()).result.dataBase64, JPEG.toString('base64'));
    response = await bridge(origin, page.pageId, ownerCookie, 'attachment.delete', { attachmentId: attachment.attachmentId });
    assert.equal(response.status, 200);
  });
});

test('bridge rejects missing origin, undeclared operations, read-only share writes, and revoked shares', async () => {
  await withServer(async ({ origin, page, ownerCookie }) => {
    let response = await fetch(`${origin}/api/bridge/${page.pageId}`, {
      method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'state.get', input: { key: 'x' } }),
    });
    assert.equal(response.status, 403);

    response = await bridge(origin, page.pageId, ownerCookie, 'page.share', {});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_operation');

    const share = createShare('bridge', '24h');
    const opened = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(opened.status, 200);
    const shareCookie = cookieHeader(opened.headers.get('set-cookie'));
    response = await bridge(origin, page.pageId, shareCookie, 'state.get', { key: 'x' });
    assert.equal(response.status, 200);
    response = await bridge(origin, page.pageId, shareCookie, 'state.set', { key: 'x', value: 'secret' });
    assert.equal(response.status, 403);
    response = await bridge(origin, page.pageId, shareCookie, 'attachment.put', {
      key: 'photos', filename: 'denied.jpg', mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64'),
    });
    assert.equal(response.status, 403);

    const writable = createShare('bridge', '24h', { canWriteAttachments: true });
    const writableOpened = await fetch(`${origin}/s/${writable.tokenId}`, { redirect: 'manual' });
    const writableCookie = cookieHeader(writableOpened.headers.get('set-cookie'));
    response = await bridge(origin, page.pageId, writableCookie, 'state.set', { key: 'x', value: 'allowed' });
    assert.equal(response.status, 200);
    response = await bridge(origin, page.pageId, writableCookie, 'attachment.put', {
      key: 'photos', filename: 'allowed.jpg', mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64'),
    });
    assert.equal(response.status, 200);

    revokeShare(share.tokenId);
    response = await bridge(origin, page.pageId, shareCookie, 'state.get', { key: 'x' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /\/login/);
  });
});

test('bridge audit records metadata without request values', async () => {
  await withServer(async ({ origin, page, ownerCookie }) => {
    const lines = [];
    const original = logger.info;
    logger.info = (message, fields) => { if (message === 'page bridge audit') lines.push(fields); };
    try {
      const response = await bridge(origin, page.pageId, ownerCookie, 'state.set', { key: 'private-key', value: 'never-log-me' });
      assert.equal(response.status, 200);
    } finally {
      logger.info = original;
    }
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['capability', 'operation', 'pageId', 'result', 'status', 'tokenId', 'viewer'].sort());
    assert.doesNotMatch(JSON.stringify(lines[0]), /private-key|never-log-me/);
  });
});

test('bridge rejects requests and responses above fixed byte ceilings', async () => {
  await withServer(async ({ origin, page, ownerCookie }) => {
    let response = await fetch(`${origin}/api/bridge/${page.pageId}`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'state.get', input: { key: 'x', padding: 'x'.repeat(7 * 1024 * 1024) } }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'request_too_large');

    const attachmentId = 'a'.repeat(32);
    const storedFilename = `${attachmentId}.jpg`;
    await ensureAttachmentDirs(page.pageId);
    await writeFile(resolveFinalPath(page.pageId, storedFilename), Buffer.alloc(6 * 1024 * 1024));
    insertAttachment({
      attachmentId,
      pageId: page.pageId,
      itemKey: 'large',
      originalFilename: 'large.jpg',
      storedFilename,
      mimeType: 'image/jpeg',
      sizeBytes: 6 * 1024 * 1024,
      createdAt: Date.now(),
    });
    response = await bridge(origin, page.pageId, ownerCookie, 'attachment.get', { attachmentId });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'response_too_large');
  });
});
