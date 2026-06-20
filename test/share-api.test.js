import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-test-'));
process.env.PAGES_DATA_DIR = tmpDir;

const express = (await import('express')).default;
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Host-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

function makeServer({ auth = false, sharingEnabled = true } = {}) {
  const app = express();
  if (auth) {
    setupAuth(app, {
      enabled: true,
      password: hashPassword('secret'),
    }, { enabled: sharingEnabled });
  }
  if (sharingEnabled) {
    setupShareApi(app, { enabled: true, allowPermanent: false });
  }
  app.get('/docs/page', (req, res) => {
    if (req.query.locals === '1') {
      return res.status(200).json({
        viewerType: res.locals.viewerType || null,
        shareCanWriteAttachments: res.locals.shareCanWriteAttachments === true,
      });
    }
    res.status(200).send(req.query.token ? 'shared' : 'plain');
  });
  app.get('/s/:tokenId', (_req, res) => {
    res.status(200).send('protected fallback route');
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('create share returns short URL only', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'docs/page', duration: '24h' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.match(body.tokenId, /^[a-f0-9]{32}$/);
    assert.equal(body.url, `${origin}/s/${body.tokenId}`);
    assert.equal(body.shortUrl, body.url);
    assert.equal(body.canWriteAttachments, false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'longUrl'), false);
  } finally {
    server.close();
  }
});

test('create and list editable attachment shares', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'docs/page', duration: '24h', canWriteAttachments: true }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.canWriteAttachments, true);

    const list = await fetch(`${origin}/api/shares/docs/page`);
    assert.equal(list.status, 200);
    const listed = await list.json();
    const created = listed.shares.find(share => share.tokenId === body.tokenId);
    assert.ok(created);
    assert.equal(created.canWriteAttachments, true);
  } finally {
    server.close();
  }
});

test('short share URL sets share cookies and redirects to clean page URL', async () => {
  const { server, origin } = await makeServer();
  try {
    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'docs/page', duration: '24h' }),
    });
    const share = await create.json();

    const redirect = await fetch(share.url, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/docs/page');
    const setCookie = redirect.headers.get('set-cookie');
    assert.match(setCookie, /__Host-share_access=/);
    assert.match(setCookie, /__Host-share_scope=/);
    assert.doesNotMatch(redirect.headers.get('location'), /token=/);
  } finally {
    server.close();
  }
});

test('auth middleware allows short share URL cookies to access target page', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /__Host-zylos_pages_session=/);

    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
        Cookie: cookie,
      },
      body: JSON.stringify({ slug: 'docs/page', duration: '24h' }),
    });
    assert.equal(create.status, 200);
    const share = await create.json();

    const redirect = await fetch(share.url, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.doesNotMatch(redirect.headers.get('location'), /login/);
    assert.equal(redirect.headers.get('location'), '/docs/page');
    const cookies = cookieHeader(redirect.headers.get('set-cookie'));

    const page = await fetch(`${origin}/docs/page`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'plain');
  } finally {
    server.close();
  }
});

test('auth middleware carries editable share permission on short share cookies', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie');

    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
        Cookie: cookie,
      },
      body: JSON.stringify({ slug: 'docs/page', duration: '24h', canWriteAttachments: true }),
    });
    assert.equal(create.status, 200);
    const share = await create.json();

    const redirect = await fetch(share.url, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const cookies = cookieHeader(redirect.headers.get('set-cookie'));

    const appCheck = await fetch(`${origin}/docs/page?locals=1`, {
      headers: { Cookie: cookies },
    });
    assert.equal(appCheck.status, 200);
    assert.deepEqual(await appCheck.json(), {
      viewerType: 'share',
      shareCanWriteAttachments: true,
    });
  } finally {
    server.close();
  }
});

test('short share URL does not bypass auth when sharing is disabled', async () => {
  const { server, origin } = await makeServer({ auth: true, sharingEnabled: false });
  try {
    const response = await fetch(`${origin}/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      '/login?next=%2Fs%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  } finally {
    server.close();
  }
});
