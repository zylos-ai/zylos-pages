import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-asset-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache } = await import('../src/cache/pageCache.js');
const { setupAssetRoute } = await import('../src/routes/asset.js');
const { adminRoute } = await import('../src/routes/admin.js');
const { setupLogicalAssetRoute } = await import('../src/routes/logical-assets.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupStateApi } = await import('../src/routes/state-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { securityHeaders } = await import('../src/security/headers.js');
const { SHARE_SCOPE_COOKIE_NAME, createShare, createShareScopeCookie, revokeShare } = await import('../src/sharing/share-manager.js');

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
    externalFiles: { allowedSources: { content: contentDir } },
  };
}

function registerPage(config, uri, sourcePath, title = uri) {
  return registerLogicalPage({
    uri,
    title,
    sourcePath,
    component: 'content',
  }, config);
}

async function makeContentDir() {
  return mkdtemp(path.join(os.tmpdir(), 'zylos-pages-asset-content-'));
}

async function withServer(config, fn) {
  initCache({ maxEntries: 50, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  setupAuth(app, config.auth || { enabled: false, password: null });
  setupShareApi(app, config.sharing || { enabled: true, allowPermanent: false }, config);
  setupStateApi(app);
  app.get('/', (_req, res) => res.send('root'));
  setupLogicalAssetRoute(app, config);
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

function signedAssetPath(html, assetName) {
  const match = html.match(new RegExp(`["']([^"']*/assets/[^"']*path=[^"']*${assetName}[^"']*)["']`));
  assert.ok(match, `signed asset URL for ${assetName} should be present`);
  return match[1].replace(/&amp;/g, '&');
}

function expectLoginRedirect(response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?/);
}

function expectAssetDenied(response) {
  assert.equal(response.status, 403);
}

function logicalAssetPath(html, assetName) {
  const match = html.match(new RegExp(`["']([^"']*/assets/[^"']*path=[^"']*${assetName}[^"']*)["']`));
  assert.ok(match, `logical asset URL for ${assetName} should be present`);
  return match[1].replace(/&amp;/g, '&');
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

test('logical asset route serves registered page assets with MIME, ETag, 304, and size limit', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const pagePath = path.join(contentDir, 'page.md');
    await writeFile(pagePath, '# Page\n');
    await writeFile(path.join(contentDir, 'image.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(path.join(contentDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(contentDir, 'style.css'), 'body { color: red; }\n');
    await writeFile(path.join(contentDir, 'doc.pdf'), Buffer.from('%PDF-1.4\n'));
    await writeFile(path.join(contentDir, 'large.jpg'), Buffer.alloc(1025));
    await writeFile(path.join(contentDir, 'tool.exe'), 'not allowed');
    registerPage(config, 'page', pagePath, 'Page');

    await withServer(config, async ({ origin }) => {
      let res = await fetch(`${origin}/assets/page?path=image.jpg`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
      const etag = res.headers.get('etag');
      assert.ok(etag);

      res = await fetch(`${origin}/assets/p/page?path=image.jpg`);
      assert.equal(res.status, 200);
      assert.equal(Buffer.from(await res.arrayBuffer()).toString('hex'), 'ffd8ff');

      res = await fetch(`${origin}/assets/page?path=image.jpg`, { headers: { 'If-None-Match': etag } });
      assert.equal(res.status, 304);
      assert.equal(res.headers.get('etag'), etag);

      res = await fetch(`${origin}/assets/page?path=image.png`);
      assert.equal(res.headers.get('content-type'), 'image/png');

      res = await fetch(`${origin}/assets/page?path=style.css`);
      assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');

      res = await fetch(`${origin}/assets/page?path=doc.pdf`);
      assert.equal(res.headers.get('content-type'), 'application/pdf');

      res = await fetch(`${origin}/assets/page?path=large.jpg`);
      assert.equal(res.status, 413);

      res = await fetch(`${origin}/assets/page?path=tool.exe`);
      assert.equal(res.status, 404);

      res = await fetch(`${origin}/assets/missing?path=image.jpg`);
      assert.equal(res.status, 404);

      res = await fetch(`${origin}/image.jpg`);
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('root route serves admin console and /admin is not mounted', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const app = express();
    app.get('/', adminRoute());
    setupLogicalAssetRoute(app, config);
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
      const root = await fetch(`${origin}/`);
      assert.equal(root.status, 200);
      assert.match(await root.text(), /id="pages-admin-root"/);

      const oldAdmin = await fetch(`${origin}/admin`, { redirect: 'manual' });
      assert.equal(oldAdmin.status, 404);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('asset route follows auth wall, session auth, and method boundaries', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    const pagePath = path.join(contentDir, 'private.md');
    await writeFile(pagePath, '# Private\n');
    await writeFile(path.join(contentDir, 'private.jpg'), 'private');
    registerPage(config, 'private', pagePath, 'Private');

    await withServer(config, async ({ origin }) => {
      let res = await fetch(`${origin}/private.jpg`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/assets/private?path=private.jpg`, { redirect: 'manual' });
      expectLoginRedirect(res);

      const cookie = sessionCookie(await login(origin));
      res = await fetch(`${origin}/assets/private?path=private.jpg`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'private');

      res = await fetch(`${origin}/private.jpg`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 404);

      res = await fetch(`${origin}/assets/private?path=private.jpg`, { method: 'PUT', redirect: 'manual' });
      expectLoginRedirect(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('authenticated /p view resolves out-of-directory assets within allowed roots and rejects escapes', async () => {
  const contentDir = await makeContentDir();
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-owner-source-'));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-owner-outside-'));
  let outsideSibling;
  try {
    const slug = `owner-assets-${Date.now()}`;
    const docsDir = path.join(sourceRoot, 'docs');
    const sharedDir = path.join(sourceRoot, 'shared');
    await mkdir(docsDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await writeFile(path.join(docsDir, 'guide.md'), '# Guide\n![Logo](../shared/logo.png)\n');
    await writeFile(path.join(sharedDir, 'logo.png'), 'logo');
    await writeFile(path.join(sharedDir, 'real.txt'), 'not actually png');
    await symlink(path.join(sharedDir, 'real.txt'), path.join(sharedDir, 'fake.png'));
    await writeFile(path.join(outsideRoot, 'secret.png'), 'secret');
    await symlink(path.join(outsideRoot, 'secret.png'), path.join(sharedDir, 'escape.png'));
    outsideSibling = path.join(sourceRoot, '..', `${slug}-outside.png`);
    await writeFile(outsideSibling, 'outside root');

    const config = {
      ...baseConfig(contentDir, { enabled: true, password: hashPassword('secret') }),
      sourceRegistry: {
        allowedSources: {
          docs: sourceRoot,
        },
      },
    };
    registerLogicalPage({
      uri: slug,
      title: 'Owner Assets',
      sourcePath: path.join(docsDir, 'guide.md'),
      component: 'docs',
    }, config);

    await withServer(config, async ({ origin }) => {
      let res = await fetch(`${origin}/p/${slug}`, { redirect: 'manual' });
      expectLoginRedirect(res);

      const cookie = sessionCookie(await login(origin));
      res = await fetch(`${origin}/p/${slug}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = await res.text();
      const assetUrl = logicalAssetPath(body, 'logo.png');
      assert.match(assetUrl, new RegExp(`/assets/${slug}\\?path=\\.\\.\\%2Fshared\\%2Flogo\\.png`));

      res = await fetch(`${origin}${assetUrl}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'logo');

      const assetBase = `${origin}/assets/${slug}`;
      for (const badPath of [
        `../../${path.basename(outsideSibling)}`,
        '../shared/escape.png',
        '../shared/fake.png',
        '/tmp/absolute.png',
        `../shared/logo.png${String.fromCharCode(0)}`,
      ]) {
        res = await fetch(`${assetBase}?path=${encodeURIComponent(badPath)}`, {
          headers: { Cookie: cookie },
          redirect: 'manual',
        });
        assert.equal(res.status, 400, `${badPath} should be rejected`);
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
    if (outsideSibling) await rm(outsideSibling, { force: true });
  }
});

test('share page access renders in place and signs referenced assets', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    const pagePath = path.join(contentDir, 'renovation-checklist.html');
    await writeFile(pagePath, '<!doctype html><img src="kitchen-ref.jpg">');
    await writeFile(path.join(contentDir, 'kitchen-ref.jpg'), 'kitchen image');
    await writeFile(path.join(contentDir, 'direct-token.jpg'), 'direct token image');
    await mkdir(path.join(contentDir, 'docs'));
    await writeFile(path.join(contentDir, 'docs', 'nested.jpg'), 'nested image');
    registerPage(config, 'renovation-checklist', pagePath, 'Renovation checklist');
    const share = createShare('renovation-checklist', '24h', { allowPermanent: false });
    const assetToken = createShare('direct-token.jpg', '24h', { allowPermanent: false }).token;

    await withServer(config, async ({ origin }) => {
      const redirect = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
      assert.equal(redirect.status, 200);
      assert.equal(redirect.headers.get('location'), null);
      const body = await redirect.text();
      assert.match(body, /<base href="\/renovation-checklist">/);
      const setCookie = redirect.headers.get('set-cookie');
      assert.match(setCookie, /__Host-share_access=/);
      assert.doesNotMatch(setCookie, /__Host-share_scope=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /Secure/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Path=\//);
      assert.match(setCookie, /Max-Age=\d+/);

      const signedPath = signedAssetPath(body, 'kitchen-ref.jpg');
      let res = await fetch(`${origin}${signedPath}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'kitchen image');
      assert.equal(res.headers.get('cache-control'), 'no-store');

      res = await fetch(`${origin}/kitchen-ref.jpg?token=${encodeURIComponent(share.token)}`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/direct-token.jpg?token=${encodeURIComponent(assetToken)}`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/docs/nested.jpg`, {
        redirect: 'manual',
        headers: { Cookie: cookieHeader(setCookie) },
      });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('signed share assets allow page assets while isolating unsigned siblings', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    await mkdir(path.join(contentDir, 'docs'));
    await mkdir(path.join(contentDir, 'other'));
    await mkdir(path.join(contentDir, 'shared'));
    const pagePath = path.join(contentDir, 'docs', 'guide.html');
    await writeFile(pagePath, '<!doctype html><img src="diagram.png"><img src="../shared/logo.png">');
    await writeFile(path.join(contentDir, 'docs', 'diagram.png'), 'diagram');
    await writeFile(path.join(contentDir, 'shared', 'logo.png'), 'logo');
    await writeFile(path.join(contentDir, 'shared', 'secret.png'), 'secret');
    await writeFile(path.join(contentDir, 'root.png'), 'root');
    await writeFile(path.join(contentDir, 'other', 'secret.png'), 'secret');
    registerPage(config, 'docs/guide', pagePath, 'Guide');
    const token = createShare('docs/guide', '24h', { allowPermanent: false }).token;

    await withServer(config, async ({ origin }) => {
      const page = await fetch(`${origin}/docs/guide?token=${encodeURIComponent(token)}`);
      assert.equal(page.status, 200);
      const body = await page.text();
      const signedPath = signedAssetPath(body, 'diagram.png');
      const sharedPath = signedAssetPath(body, 'logo.png');

      let res = await fetch(`${origin}${signedPath}`);
      assert.equal(res.status, 200);

      res = await fetch(`${origin}${sharedPath}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'logo');

      const tamperedPath = sharedPath.replace('logo.png', 'secret.png');
      res = await fetch(`${origin}${tamperedPath}`, { redirect: 'manual' });
      assert.equal(res.status, 403);

      res = await fetch(`${origin}/root.png`, { redirect: 'manual' });
      expectAssetDenied(res);

      res = await fetch(`${origin}/other/secret.png`, { redirect: 'manual' });
      expectAssetDenied(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('signed share assets work for p-prefixed logical page shares', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    await mkdir(path.join(contentDir, 'docs'));
    const pagePath = path.join(contentDir, 'docs', 'prefixed.html');
    await writeFile(pagePath, '<!doctype html><img src="hero.png">');
    await writeFile(path.join(contentDir, 'docs', 'hero.png'), 'hero');
    registerPage(config, 'docs/prefixed', pagePath, 'Prefixed');
    const share = createShare('p/docs/prefixed', '24h', { allowPermanent: false });

    await withServer(config, async ({ origin }) => {
      const page = await fetch(`${origin}/s/${share.tokenId}`);
      assert.equal(page.status, 200);
      const signedPath = signedAssetPath(await page.text(), 'hero.png');

      const res = await fetch(`${origin}${signedPath}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hero');
      assert.equal(res.headers.get('cache-control'), 'no-store');
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

test('revoked share invalidates existing signed asset URLs', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    const pagePath = path.join(contentDir, 'shared.html');
    await writeFile(pagePath, '<!doctype html><img src="asset.jpg">');
    await writeFile(path.join(contentDir, 'asset.jpg'), 'asset');
    registerPage(config, 'shared', pagePath, 'Shared');
    const share = createShare('shared', '24h', { allowPermanent: false });

    await withServer(config, async ({ origin }) => {
      const page = await fetch(`${origin}/shared?token=${encodeURIComponent(share.token)}`);
      assert.equal(page.status, 200);
      const signedPath = signedAssetPath(await page.text(), 'asset.jpg');

      let res = await fetch(`${origin}${signedPath}`);
      assert.equal(res.status, 200);

      assert.equal(revokeShare(share.tokenId), true);
      res = await fetch(`${origin}${signedPath}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('asset route rejects traversal, null byte, and double-encoded traversal', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const pagePath = path.join(contentDir, 'page.md');
    await writeFile(pagePath, '# Page\n');
    registerPage(config, 'page', pagePath, 'Page');
    const share = createShare('page', '24h', { allowPermanent: false });
    const cookie = `${SHARE_SCOPE_COOKIE_NAME}=${createShareScopeCookie('page', share.tokenId, Date.now() + 3600_000).value}`;
    await withServer(config, async ({ origin }) => {
      let res = await rawGet(origin, '/assets/page?path=%2e%2e%2Fsecret.jpg');
      assert.equal(res.statusCode, 400);

      res = await rawGet(origin, '/assets/page?path=bad%00slug.jpg');
      assert.equal(res.statusCode, 400);

      res = await rawGet(origin, '/assets/page?path=%252e%252e%2Fsecret.jpg');
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

test('login clears legacy share-scope cookie without overwriting session cookie', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, { enabled: true, password: hashPassword('secret') });
    const pagePath = path.join(contentDir, 'shared.html');
    await writeFile(pagePath, '<!doctype html><h1>Shared</h1>');
    registerPage(config, 'shared', pagePath, 'Shared');
    const token = createShare('shared', '24h', { allowPermanent: false }).token;

    await withServer(config, async ({ origin }) => {
      await fetch(`${origin}/shared?token=${encodeURIComponent(token)}`);
      const legacy = createShareScopeCookie('shared', createShare('shared', '24h', { allowPermanent: false }).tokenId, Date.now() + 3600_000).value;
      const shareCookie = `${SHARE_SCOPE_COOKIE_NAME}=${legacy}`;
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
    const config = baseConfig(contentDir);
    const fooPath = path.join(contentDir, 'foo.md');
    const artifactPath = path.join(contentDir, 'artifact.html');
    await writeFile(fooPath, '# Foo\n');
    await writeFile(artifactPath, '<!doctype html><head><title>A</title></head><h1>A</h1>');
    registerPage(config, 'foo', fooPath, 'Foo');
    registerPage(config, 'artifact', artifactPath, 'Artifact');

    await withServer(config, async ({ origin }) => {
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
