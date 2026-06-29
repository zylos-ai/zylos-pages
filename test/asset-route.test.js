import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-asset-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache } = await import('../src/cache/pageCache.js');
const { setupAssetRoute } = await import('../src/routes/asset.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupStateApi } = await import('../src/routes/state-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { securityHeaders } = await import('../src/security/headers.js');
const {
  SHARE_SCOPE_COOKIE_NAME,
  createShare,
  createShareScopeCookie,
  revokeShare,
} = await import('../src/sharing/share-manager.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function baseConfig(contentDir, auth = { enabled: false, password: null }) {
  return {
    contentDir,
    security: {
      allowRawHtml: false,
      maxFileSizeBytes: 1024,
      renderTimeoutMs: 5000,
    },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
    auth,
  };
}

async function makeContentDir() {
  return mkdtemp(path.join(os.tmpdir(), 'zylos-pages-asset-content-'));
}

async function withServer(config, fn) {
  initCache({ maxEntries: 50, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  setupAuth(app, config.auth || { enabled: false, password: null });
  setupShareApi(app, config.sharing || { enabled: true, allowPermanent: false });
  setupStateApi(app);
  app.get('/', (_req, res) => res.send('root'));
  setupAssetRoute(app, config);
  app.get('/:slug(*)', pageRoute(config));
  app.use((err, req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status >= 400 && status < 500 ? status : 500).send(err.message || 'Internal Server Error');
  });

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ origin });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function login(origin, extraHeaders = {}) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams({ password: 'secret' }),
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie');
}

function sessionCookie(setCookieHeader) {
  const match = setCookieHeader.match(/__Host-zylos_pages_session=([^;,]+)/);
  assert.ok(match, 'session cookie should be present');
  return `__Host-zylos_pages_session=${match[1]}`;
}

function shareScopeCookie(setCookieHeader) {
  const match = setCookieHeader.match(/__Host-share_scope=([^;,]+)/);
  assert.ok(match, 'share-scope cookie should be present');
  return `${SHARE_SCOPE_COOKIE_NAME}=${match[1]}`;
}

function cookieHeader(setCookieHeader) {
  return setCookieHeader
    .split(/,\s*(?=__Host-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

function expectLoginRedirect(response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?/);
}

function expectAssetDenied(response) {
  assert.equal(response.status, 403);
}

async function rawGet(origin, requestPath) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: 'GET',
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('asset route serves allowlisted assets with MIME, ETag, 304, and size limit', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'image.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(path.join(contentDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(contentDir, 'style.css'), 'body { color: red; }\n');
    await writeFile(path.join(contentDir, 'doc.pdf'), Buffer.from('%PDF-1.4\n'));
    await writeFile(path.join(contentDir, 'large.jpg'), Buffer.alloc(1025));
    await writeFile(path.join(contentDir, 'tool.exe'), 'not allowed');

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      let res = await fetch(`${origin}/image.jpg`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
      const etag = res.headers.get('etag');
      assert.ok(etag);

      res = await fetch(`${origin}/image.jpg`, { headers: { 'If-None-Match': etag } });
      assert.equal(res.status, 304);
      assert.equal(res.headers.get('etag'), etag);

      res = await fetch(`${origin}/image.png`);
      assert.equal(res.headers.get('content-type'), 'image/png');

      res = await fetch(`${origin}/style.css`);
      assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');

      res = await fetch(`${origin}/doc.pdf`);
      assert.equal(res.headers.get('content-type'), 'application/pdf');

      res = await fetch(`${origin}/large.jpg`);
      assert.equal(res.status, 413);

      res = await fetch(`${origin}/tool.exe`);
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('asset route follows auth wall, session auth, and method boundaries', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'private.jpg'), 'private');

    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      let res = await fetch(`${origin}/private.jpg`, { redirect: 'manual' });
      expectAssetDenied(res);

      const cookie = sessionCookie(await login(origin));
      res = await fetch(`${origin}/private.jpg`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'private');

      res = await fetch(`${origin}/private.jpg`, { method: 'PUT', redirect: 'manual' });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('share page access sets scoped cookie and asset request uses cookie without token', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'renovation-checklist.html'), '<!doctype html><img src="kitchen-ref.jpg">');
    await writeFile(path.join(contentDir, 'kitchen-ref.jpg'), 'kitchen image');
    await writeFile(path.join(contentDir, 'direct-token.jpg'), 'direct token image');
    await mkdir(path.join(contentDir, 'docs'));
    await writeFile(path.join(contentDir, 'docs', 'nested.jpg'), 'nested image');
    const share = createShare('renovation-checklist', '24h', { allowPermanent: false });
    const assetToken = createShare('direct-token.jpg', '24h', { allowPermanent: false }).token;

    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      const redirect = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/renovation-checklist');
      assert.doesNotMatch(redirect.headers.get('location'), /token=/);

      const page = await fetch(`${origin}/renovation-checklist`, {
        headers: { Cookie: cookieHeader(redirect.headers.get('set-cookie')) },
      });
      assert.equal(page.status, 200);
      const setCookie = redirect.headers.get('set-cookie');
      assert.match(setCookie, /__Host-share_scope=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /Secure/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Path=\//);
      assert.match(setCookie, /Max-Age=\d+/);
      const cookie = shareScopeCookie(setCookie);

      let res = await fetch(`${origin}/kitchen-ref.jpg`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'kitchen image');
      assert.equal(res.headers.get('cache-control'), 'no-store');

      res = await fetch(`${origin}/kitchen-ref.jpg?token=${encodeURIComponent(share.token)}`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/direct-token.jpg?token=${encodeURIComponent(assetToken)}`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/docs/nested.jpg`, {
        redirect: 'manual',
        headers: { Cookie: cookie },
      });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('nested share-scope cookie isolates root and sibling directory assets', async () => {
  const contentDir = await makeContentDir();
  try {
    await mkdir(path.join(contentDir, 'docs'));
    await mkdir(path.join(contentDir, 'other'));
    await writeFile(path.join(contentDir, 'docs', 'guide.html'), '<!doctype html><img src="diagram.png">');
    await writeFile(path.join(contentDir, 'docs', 'diagram.png'), 'diagram');
    await writeFile(path.join(contentDir, 'root.png'), 'root');
    await writeFile(path.join(contentDir, 'other', 'secret.png'), 'secret');
    const token = createShare('docs/guide', '24h', { allowPermanent: false }).token;

    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      const page = await fetch(`${origin}/docs/guide?token=${encodeURIComponent(token)}`);
      assert.equal(page.status, 200);
      const cookie = shareScopeCookie(page.headers.get('set-cookie'));

      let res = await fetch(`${origin}/docs/diagram.png`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);

      res = await fetch(`${origin}/root.png`, { redirect: 'manual', headers: { Cookie: cookie } });
      expectAssetDenied(res);

      res = await fetch(`${origin}/other/secret.png`, { redirect: 'manual', headers: { Cookie: cookie } });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('expired and tampered share-scope cookies fall through to auth wall', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'image.jpg'), 'image');
    const expiredShare = createShare('page', '24h', { allowPermanent: false });
    const validShare = createShare('page', '24h', { allowPermanent: false });
    const expired = createShareScopeCookie('page', expiredShare.tokenId, Date.now() - 1000).value;
    const valid = createShareScopeCookie('page', validShare.tokenId, Date.now() + 3600_000).value;
    const tampered = valid.replace(/[0-9a-f]$/, (char) => char === '0' ? '1' : '0');

    await new Promise(resolve => setTimeout(resolve, 5));
    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      let res = await fetch(`${origin}/image.jpg`, {
        redirect: 'manual',
        headers: { Cookie: `${SHARE_SCOPE_COOKIE_NAME}=${expired}` },
      });
      expectAssetDenied(res);

      res = await fetch(`${origin}/image.jpg`, {
        redirect: 'manual',
        headers: { Cookie: `${SHARE_SCOPE_COOKIE_NAME}=${tampered}` },
      });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('revoked share invalidates existing share-scope asset cookie', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'shared.html'), '<!doctype html><img src="asset.jpg">');
    await writeFile(path.join(contentDir, 'asset.jpg'), 'asset');
    const share = createShare('shared', '24h', { allowPermanent: false });

    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      const page = await fetch(`${origin}/shared?token=${encodeURIComponent(share.token)}`);
      assert.equal(page.status, 200);
      const cookie = shareScopeCookie(page.headers.get('set-cookie'));

      let res = await fetch(`${origin}/asset.jpg`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);

      assert.equal(revokeShare(share.tokenId), true);
      res = await fetch(`${origin}/asset.jpg`, {
        redirect: 'manual',
        headers: { Cookie: cookie },
      });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('asset route rejects traversal, null byte, and double-encoded traversal', async () => {
  const contentDir = await makeContentDir();
  try {
    const share = createShare('page', '24h', { allowPermanent: false });
    const cookie = `${SHARE_SCOPE_COOKIE_NAME}=${createShareScopeCookie('page', share.tokenId, Date.now() + 3600_000).value}`;
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      let res = await rawGet(origin, '/%2e%2e/secret.jpg');
      assert.equal(res.statusCode, 400);

      res = await rawGet(origin, '/bad%00slug.jpg');
      assert.equal(res.statusCode, 400);

      res = await rawGet(origin, '/%252e%252e/secret.jpg');
      assert.equal(res.statusCode, 400);

      res = await fetch(`${origin}/%E0%A4%A.jpg`, {
        redirect: 'manual',
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 400);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('login clears share-scope cookie without overwriting session cookie', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'shared.html'), '<!doctype html><h1>Shared</h1>');
    const token = createShare('shared', '24h', { allowPermanent: false }).token;

    await withServer(baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }), async ({ origin }) => {
      const page = await fetch(`${origin}/shared?token=${encodeURIComponent(token)}`);
      const shareCookie = shareScopeCookie(page.headers.get('set-cookie'));
      const loginCookies = await login(origin, { Cookie: shareCookie });
      assert.match(loginCookies, /__Host-zylos_pages_session=/);
      assert.match(loginCookies, /__Host-share_scope=;/);
      assert.match(loginCookies, /Max-Age=0/);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('markdown, html artifact, extension redirects, and state API still work with asset route registered', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'foo.md'), '# Foo\n');
    await writeFile(path.join(contentDir, 'artifact.html'), '<!doctype html><head><title>A</title></head><h1>A</h1>');

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      let res = await fetch(`${origin}/foo`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Foo/);

      res = await fetch(`${origin}/artifact`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /html-artifact-frame/);

      res = await fetch(`${origin}/artifact?raw=1`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /window\.__PAGES_BASE/);

      res = await fetch(`${origin}/foo.md`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/foo');

      res = await fetch(`${origin}/artifact.html`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/artifact');

      res = await fetch(`${origin}/api/state/check`);
      assert.equal(res.status, 200);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});
