import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-test-'));
process.env.PAGES_DATA_DIR = tmpDir;

const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { createShareScopeCookie } = await import('../src/sharing/share-manager.js');
const express = (await import('express')).default;

// Set-Cookie headers arrive joined by ", " — split on the cookie-name boundary.
function splitSetCookie(header) {
  return header.split(/,\s*(?=__Secure-|__Host-)/);
}

function findCookie(header, name) {
  const cookie = splitSetCookie(header).find(entry => entry.startsWith(`${name}=`));
  assert.ok(cookie, `${name} should be present in Set-Cookie`);
  return cookie;
}

function cookieValue(cookie) {
  return cookie.split(';', 1)[0].split('=').slice(1).join('=');
}

// Attributes except Max-Age, which differs between issuing and clearing.
function cookieAttributes(cookie) {
  return new Set(
    cookie.split(';').slice(1)
      .map(part => part.trim())
      .filter(part => part && !/^Max-Age=/i.test(part))
  );
}

async function logout(origin, extraHeaders = {}) {
  const response = await fetch(`${origin}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, ...extraHeaders },
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie');
}

async function loginCookies(origin, extraHeaders = {}) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams({ password: 'secret' }),
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie');
}

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

test('session cookie Path is bound to the forwarded prefix (issue #104)', async () => {
  const { server, origin } = await makeServer();
  try {
    const prefixed = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/coco/pages',
      },
      body: new URLSearchParams({ password: 'secret' }),
    });
    assert.equal(prefixed.status, 302);
    const prefixedCookie = prefixed.headers.get('set-cookie');
    assert.match(prefixedCookie, /__Secure-zylos_pages_session=[^;]+;[^,]*Path=\/coco\/pages/);

    const direct = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    assert.equal(direct.status, 302);
    const directCookie = direct.headers.get('set-cookie');
    assert.match(directCookie, /__Secure-zylos_pages_session=[^;]+;[^,]*Path=\/;/);
  } finally {
    server.close();
  }
});

test('login expires legacy host-wide __Host- cookies (issue #104)', async () => {
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
    assert.match(cookie, /__Host-zylos_pages_session=;[^,]*Path=\/;[^,]*Max-Age=0/);
    assert.match(cookie, /__Host-share_access=;[^,]*Path=\/;[^,]*Max-Age=0/);
    assert.match(cookie, /__Host-share_scope=;[^,]*Path=\/;[^,]*Max-Age=0/);
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
    const tokenMatch = cookie.match(/__Secure-zylos_pages_session=([^;]+)/);
    assert.ok(tokenMatch, 'session cookie should be set');

    const authedRes = await fetch(`${origin}/`, {
      redirect: 'manual',
      headers: { Cookie: `__Secure-zylos_pages_session=${tokenMatch[1]}` },
    });
    assert.equal(authedRes.status, 200);
  } finally {
    server.close();
  }
});

// Logout must clear every credential cookie this browser can be carrying:
// the login session, the share-access session, and the retired share-scope
// cookie. Login already cleared all three; logout used to skip share_scope.
test('logout clears session, share-access, and share-scope cookies at the mount path', async () => {
  const { server, origin } = await makeServer();
  try {
    for (const [prefix, expectedPath] of [[null, '/'], ['/coco/pages', '/coco/pages']]) {
      const header = await logout(origin, prefix ? { 'X-Forwarded-Prefix': prefix } : {});

      for (const name of ['__Secure-zylos_pages_session', '__Secure-share_access', '__Secure-share_scope']) {
        const cookie = findCookie(header, name);
        assert.equal(cookieValue(cookie), '', `${name} should be cleared`);
        assert.match(cookie, /Max-Age=0/, `${name} should expire immediately`);
        assert.ok(
          cookieAttributes(cookie).has(`Path=${expectedPath}`),
          `${name} should be cleared at Path=${expectedPath}, got: ${cookie}`
        );
      }

      // Negative control: clearing at the wrong Path leaves the real cookie
      // alive, so on a prefixed mount no __Secure- cookie may use Path=/.
      if (prefix) {
        for (const cookie of splitSetCookie(header)) {
          if (!cookie.startsWith('__Secure-')) continue;
          assert.ok(
            !cookieAttributes(cookie).has('Path=/'),
            `prefixed logout must not clear at Path=/, got: ${cookie}`
          );
        }
      }
    }
  } finally {
    server.close();
  }
});

// A clear only expires the cookie when its attributes match the ones used to
// issue it, so compare against the real issuing headers rather than literals.
test('logout clear headers match the attributes each cookie is issued with', async () => {
  const { server, origin } = await makeServer();
  try {
    const cookiePath = '/coco/pages';
    const headers = { 'X-Forwarded-Prefix': cookiePath };
    const cleared = await logout(origin, headers);
    const issuedSession = findCookie(await loginCookies(origin, headers), '__Secure-zylos_pages_session');
    const tokenId = 'a'.repeat(32);
    const expiresAt = Date.now() + 3600_000;

    // share_access issuance needs a real share row, so its parity check lives
    // in share-api.test.js where a share link is actually visited.
    const pairs = [
      ['__Secure-zylos_pages_session', issuedSession],
      ['__Secure-share_scope', createShareScopeCookie('page', tokenId, expiresAt, cookiePath).header],
    ];

    for (const [name, issued] of pairs) {
      assert.deepEqual(
        cookieAttributes(findCookie(cleared, name)),
        cookieAttributes(issued),
        `${name} clear attributes should match its issuing attributes`
      );
    }
  } finally {
    server.close();
  }
});

// Negative control for the two tests above: the "cleared" assertions must be
// able to fail. Login issues a live session cookie, so running them against a
// login response has to reject it.
test('login issues a live session cookie, so the cleared-cookie assertions discriminate', async () => {
  const { server, origin } = await makeServer();
  try {
    const session = findCookie(await loginCookies(origin), '__Secure-zylos_pages_session');
    assert.notEqual(cookieValue(session), '', 'login must issue a non-empty session cookie');
    assert.doesNotMatch(session, /Max-Age=0/, 'login must not expire the session cookie');
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
