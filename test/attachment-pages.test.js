import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-file-pages-data-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-file-pages-content-'));
const custodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-file-pages-keys-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache, getCacheStats } = await import('../src/cache/pageCache.js');
const { setupAttachmentApi } = await import('../src/routes/attachment-api.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupStateApi } = await import('../src/routes/state-api.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { securityHeaders } = await import('../src/security/headers.js');
const { setupLogicalAssetRoute } = await import('../src/routes/logical-assets.js');
const { getPage } = await import('../src/services/pageService.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const {
  listLogicalPagesForNavigation,
  registerLogicalPage,
  searchLogicalPages,
} = await import('../src/pages/page-store.js');
const {
  createPasswordProtectedShare,
  createShare,
  revokeShare,
} = await import('../src/sharing/share-manager.js');
const { createSharePasswordKeyring } = await import('../src/sharing/share-password-keyring.js');

const keyFile = path.join(custodyDir, 'keys.json');
const keyring = createSharePasswordKeyring(keyFile, { keyId: 'attachment-test-key', key: Buffer.alloc(32, 0x31) });
const resumeBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024, 0x52)]);
const sources = {
  resume: path.join(contentDir, 'resume.pdf'),
  contract: path.join(contentDir, 'contract.bin'),
  suffix: path.join(contentDir, 'suffix.bin'),
  svg: path.join(contentDir, 'active.svg'),
  htmlLike: path.join(contentDir, 'payload.bin'),
};
fs.writeFileSync(sources.resume, resumeBytes);
fs.writeFileSync(sources.contract, Buffer.from('contract-v1\n'));
fs.writeFileSync(sources.suffix, Buffer.from('exact-download-uri\n'));
fs.writeFileSync(sources.svg, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
fs.writeFileSync(sources.htmlLike, Buffer.from('<!doctype html><script>globalThis.pwned=true</script>'));

const config = {
  contentDir,
  auth: { password: hashPassword('owner-secret') },
  sharing: {
    enabled: true,
    passwordKeyFile: keyFile,
    passwordRateLimit: { windowMs: 60_000, tokenMax: 20, ipMax: 40 },
  },
  externalFiles: { enabled: true, allowedSources: { content: contentDir } },
  security: {
    allowRawHtml: false,
    maxFileSizeBytes: 1024 * 1024,
    maxAttachmentSizeBytes: 4 * 1024 * 1024,
    renderTimeoutMs: 5000,
  },
  attachments: { maxFileSizeBytes: 1024 },
  state: {},
  toc: { minHeadings: 3 },
  theme: { codeTheme: 'github-dark' },
};

for (const [key, sourcePath] of Object.entries(sources)) {
  const uri = key === 'suffix' ? 'archive/download' : key;
  registerLogicalPage({ uri, title: `File ${uri}`, sourcePath, component: 'content' }, config);
}

initCache({ maxEntries: 20, ttlSeconds: 60 });
const app = express();
app.use(securityHeaders());
setupAuth(app, config.auth, config.sharing);
setupShareApi(app, config.sharing, config);
setupRawApi(app, config);
setupStateApi(app, config);
setupAttachmentApi(app, config);
setupLogicalAssetRoute(app, config);
app.get('/:slug(*)', pageRoute(config));
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.rmSync(custodyDir, { recursive: true, force: true });
});

function cookieValue(setCookie, name) {
  const match = setCookie?.match(new RegExp(`${name}=([^;,]+)`));
  return match ? `${name}=${match[1]}` : '';
}

async function login() {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'owner-secret' }),
  });
  assert.equal(response.status, 302);
  return cookieValue(response.headers.get('set-cookie'), '__Secure-zylos_pages_session');
}

async function unlock(share, password) {
  const response = await fetch(`${origin}/s/${share.tokenId}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ password }),
  });
  assert.equal(response.status, 303);
  return cookieValue(response.headers.get('set-cookie'), '__Secure-share_access');
}

function assertDownloadHeaders(response, expectedType) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), expectedType);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.ok(response.headers.get('etag'));
  assert.ok(response.headers.get('last-modified'));
}

test('registration, navigation metadata, owner page, and multi-MB streaming stay outside render cache', async () => {
  const ownerCookie = await login();
  const listed = searchLogicalPages();
  assert.equal(listed.find(page => page.uri === 'resume').type, 'attachment');
  assert.equal(listLogicalPagesForNavigation().find(page => page.slug === 'p/resume').type, 'attachment');

  let response = await fetch(`${origin}/p/resume`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 200);
  const landing = await response.text();
  assert.match(landing, /Download file/);
  assert.doesNotMatch(landing, /Copy Markdown|api\/raw|Allow photo upload\/delete/);
  assert.equal(getCacheStats().size, 0, 'attachment landing pages must not populate the render cache');

  response = await fetch(`${origin}/p/resume/download`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 200);
  assertDownloadHeaders(response, 'application/pdf');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), resumeBytes);
  assert.equal(getCacheStats().size, 0, 'attachment downloads must not populate the render cache');

  const head = await fetch(`${origin}/p/resume/download`, { method: 'HEAD', headers: { Cookie: ownerCookie } });
  assert.equal(head.status, 200);
  assertDownloadHeaders(head, 'application/pdf');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  await assert.rejects(() => getPage('p/resume', config, ''), /cannot enter the render pipeline/);
});

test('an exact attachment URI ending in /download wins before suffix routing', async () => {
  const ownerCookie = await login();
  let response = await fetch(`${origin}/p/archive/download`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Download file/);

  response = await fetch(`${origin}/p/archive/download/download`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 200);
  assertDownloadHeaders(response, 'application/octet-stream');
  assert.equal(await response.text(), 'exact-download-uri\n');
});

test('unknown, SVG, and HTML-like bytes are always downloads and never inline content', async () => {
  const ownerCookie = await login();
  for (const [uri, expectedType] of [
    ['contract', 'application/octet-stream'],
    ['svg', 'image/svg+xml'],
    ['htmlLike', 'application/octet-stream'],
  ]) {
    const response = await fetch(`${origin}/p/${uri}/download`, { headers: { Cookie: ownerCookie } });
    assert.equal(response.status, 200, uri);
    assertDownloadHeaders(response, expectedType);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
  }
});

test('raw, state, embedded attachment, and logical asset APIs exclude attachment pages', async () => {
  const ownerCookie = await login();
  let response = await fetch(`${origin}/api/raw/p/resume`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 404);
  response = await fetch(`${origin}/api/state/resume`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 404);
  response = await fetch(`${origin}/api/attachments/resume/items`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 404);
  response = await fetch(`${origin}/assets/resume?path=resume.pdf`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 404);
});

test('unprotected share streams bytes, then expiry and revocation make both page and download inaccessible', async () => {
  const share = createShare('p/contract', '24h');
  let response = await fetch(`${origin}/s/${share.tokenId}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Download file/);
  response = await fetch(`${origin}/s/${share.tokenId}/download`);
  assert.equal(response.status, 200);
  assertDownloadHeaders(response, 'application/octet-stream');
  assert.equal(await response.text(), 'contract-v1\n');

  getPagesDb().prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?')
    .run(Date.now() - 1, share.tokenId);
  for (const suffix of ['', '/download']) {
    response = await fetch(`${origin}/s/${share.tokenId}${suffix}`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  }

  const revoked = createShare('p/contract', '24h');
  assert.equal(revokeShare(revoked.tokenId), true);
  for (const suffix of ['', '/download']) {
    response = await fetch(`${origin}/s/${revoked.tokenId}${suffix}`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  }
});

test('password challenge, header proof, scoped cookie, wrong scope, and malformed token all fail or pass at one boundary', async () => {
  const protectedResume = await createPasswordProtectedShare(
    'p/resume', '24h', { password: 'resume-secret' }, keyring,
  );
  const protectedContract = await createPasswordProtectedShare(
    'p/contract', '24h', { password: 'contract-secret' }, keyring,
  );

  let response = await fetch(`${origin}/s/${protectedResume.tokenId}/download`);
  assert.equal(response.status, 200, 'browser challenge remains webview-compatible');
  assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
  assert.match(response.headers.get('content-type'), /text\/html/);

  response = await fetch(`${origin}/s/${protectedResume.tokenId}/download`, {
    headers: { 'X-Zylos-Share-Password': 'wrong' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-zylos-share-error'), 'invalid_password');

  response = await fetch(`${origin}/s/${protectedResume.tokenId}/download`, {
    headers: { 'X-Zylos-Share-Password': 'resume-secret' },
  });
  assert.equal(response.status, 200);
  assertDownloadHeaders(response, 'application/pdf');
  assert.equal((await response.arrayBuffer()).byteLength, resumeBytes.length);

  const resumeCookie = await unlock(protectedResume, 'resume-secret');
  response = await fetch(`${origin}/s/${protectedResume.tokenId}/download`, {
    headers: { Cookie: resumeCookie },
  });
  assert.equal(response.status, 200);

  response = await fetch(`${origin}/s/${protectedContract.tokenId}/download`, {
    headers: { Cookie: resumeCookie },
  });
  assert.equal(response.status, 200, 'wrong-scope cookie falls back to the browser challenge');
  assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
  assert.doesNotMatch(await response.text(), /contract-v1/);

  response = await fetch(`${origin}/s/not-a-token/download`, { redirect: 'manual' });
  assert.equal(response.status, 302, 'malformed public path must fall back to the owner auth wall');
  assert.match(response.headers.get('location'), /^\/login/);
});

test('attachment size ceiling applies at registration and is rechecked before download', async () => {
  const oversized = path.join(contentDir, 'oversized.bin');
  fs.writeFileSync(oversized, Buffer.alloc(config.security.maxAttachmentSizeBytes + 1));
  assert.throws(
    () => registerLogicalPage({ uri: 'oversized', title: 'Oversized', sourcePath: oversized, component: 'content' }, config),
    error => error.code === 'source_too_large' && error.statusCode === 413,
  );

  const ownerCookie = await login();
  fs.appendFileSync(sources.contract, Buffer.alloc(config.security.maxAttachmentSizeBytes));
  const response = await fetch(`${origin}/p/contract/download`, { headers: { Cookie: ownerCookie } });
  assert.equal(response.status, 413);
});
