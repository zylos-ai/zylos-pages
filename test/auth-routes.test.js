import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-test-'));
process.env.PAGES_DATA_DIR = tmpDir;

const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const express = (await import('express')).default;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeServer(authConfig = {
  enabled: true,
  password: hashPassword('secret'),
}) {
  const app = express();
  setupAuth(app, authConfig);
  app.get('/_assets/style.css', (_req, res) => res.type('text/css').send('body{}'));
  app.get('/s/:tokenId', (_req, res) => res.send('share'));
  app.get('/assets/:uri(*)', (_req, res) => res.send('signed asset'));
  app.get('/api/raw/:slug(*)', (_req, res) => res.send('raw'));
  app.get('/api/state/:artifact(*)', (_req, res) => res.json({ ok: true }));
  app.get('/api/attachments/:artifact/:key', (_req, res) => res.json({ attachments: [] }));
  app.get('/api/pages', (_req, res) => res.json({ pages: [] }));
  app.get('/api/shares/:slug(*)', (_req, res) => res.json({ shares: [] }));
  app.post('/api/share', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.send('root'));
  app.get('/:slug(*)', (req, res) => res.send(`page:${req.params.slug || req.params[0]}`));

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('auth enabled without password fails closed while allowing only public assets and explicit share paths', async () => {
  const { server, origin } = await makeServer({ enabled: true, password: null });
  try {
    const allowed = [
      '/_assets/style.css',
      '/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '/assets/docs/page?path=diagram.png&exp=9999999999999&sig=test',
    ];

    for (const requestPath of allowed) {
      const response = await fetch(`${origin}${requestPath}`, { redirect: 'manual' });
      assert.equal(response.status, 200, `${requestPath} should be allowed`);
    }

    const protectedGets = [
      '/',
      '/docs/page',
      '/image.jpg',
      '/login',
      '/api/raw/docs/page',
      '/api/state/docs/page',
      '/api/attachments/docs/page/key',
      '/api/pages',
      '/api/shares/docs/page',
    ];

    for (const requestPath of protectedGets) {
      const response = await fetch(`${origin}${requestPath}`, { redirect: 'manual' });
      assert.equal(response.status, 503, `${requestPath} should fail closed`);
      assert.equal(await response.text(), 'Authentication is not configured.');
    }

    const shareCreate = await fetch(`${origin}/api/share`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin },
    });
    assert.equal(shareCreate.status, 503);

    const logout = await fetch(`${origin}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin },
    });
    assert.equal(logout.status, 503);
  } finally {
    server.close();
  }
});

test('login route uses root-relative paths for direct local access', async () => {
  const { server, origin } = await makeServer();
  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login?next=%2F');

    const login = await fetch(`${origin}/login?next=%2F`, {
      redirect: 'manual',
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /Zylos Pages/);
    assert.match(body, /action="\/login"/);
    assert.match(body, /href="\/_assets\/style\.css/);
  } finally {
    server.close();
  }
});

test('auth redirect uses x-forwarded-prefix for stripped Caddy access', async () => {
  const { server, origin } = await makeServer();
  try {
    const stripped = await fetch(`${origin}/example`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/pages' },
    });
    assert.equal(stripped.status, 302);
    assert.equal(stripped.headers.get('location'), '/pages/login?next=%2Fpages%2Fexample');

    const login = await fetch(`${origin}/login?next=%2Fpages%2Fexample`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/pages' },
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/pages\/login"/);
    assert.match(body, /href="\/pages\/_assets\/style\.css/);
  } finally {
    server.close();
  }
});

test('auth redirect next target supports nested direct paths', async () => {
  const { server, origin } = await makeServer();
  try {
    const nested = await fetch(`${origin}/docs/example`, { redirect: 'manual' });
    assert.equal(nested.status, 302);
    assert.equal(nested.headers.get('location'), '/login?next=%2Fdocs%2Fexample');
  } finally {
    server.close();
  }
});

test('unsafe x-forwarded-prefix falls back to direct local paths', async () => {
  const { server, origin } = await makeServer();
  try {
    const withQuery = await fetch(`${origin}/example`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/pages?next=//evil.test' },
    });
    assert.equal(withQuery.status, 302);
    assert.equal(withQuery.headers.get('location'), '/login?next=%2Fexample');

    const withHtml = await fetch(`${origin}/login`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Prefix': '/pages\"><base href=\"//evil.test/">' },
    });
    assert.equal(withHtml.status, 200);
    const body = await withHtml.text();
    assert.match(body, /action="\/login"/);
    assert.doesNotMatch(body, /evil\.test/);
  } finally {
    server.close();
  }
});

test('login next target cannot escape forwarded prefix with dot segments', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/pages',
      },
      body: new URLSearchParams({
        password: 'secret',
        next: '/pages/../sensitive',
      }),
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/pages/');
  } finally {
    server.close();
  }
});

test('remember-me login sets 30-day cookie', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret', remember: 'on' }),
    });
    assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /Max-Age=2592000/);
  } finally {
    server.close();
  }
});

test('regular login sets 24-hour cookie', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    assert.equal(response.status, 302);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /Max-Age=86400/);
  } finally {
    server.close();
  }
});

test('session persists in SQLite (survives validation after store reinit)', async () => {
  const { server, origin } = await makeServer();
  try {
    const loginRes = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret', remember: 'on' }),
    });
    const cookie = loginRes.headers.get('set-cookie');
    const tokenMatch = cookie.match(/__Host-zylos_pages_session=([^;]+)/);
    assert.ok(tokenMatch, 'session cookie should be set');

    const authedRes = await fetch(`${origin}/`, {
      redirect: 'manual',
      headers: { Cookie: `__Host-zylos_pages_session=${tokenMatch[1]}` },
    });
    assert.equal(authedRes.status, 200);
  } finally {
    server.close();
  }
});

test('login page shows remember-me checkbox', async () => {
  const { server, origin } = await makeServer();
  try {
    const res = await fetch(`${origin}/login`);
    const body = await res.text();
    assert.match(body, /type="checkbox".*name="remember"/);
    assert.match(body, /Remember me/);
  } finally {
    server.close();
  }
});
