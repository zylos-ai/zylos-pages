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
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage, unregisterLogicalPageById } = await import('../src/pages/page-store.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Secure-|__Host-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

function shareAccessCookie(setCookie) {
  const match = setCookie?.match(/(__Secure-share_access\.[a-f0-9]{32})=([^;,]+)/);
  return match ? `${match[1]}=${match[2]}` : '';
}

function makeServer({ auth = false, authConfig = null, sharingEnabled = true, shareViewer = false } = {}) {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-content-'));
  fs.mkdirSync(path.join(contentDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'docs', 'page.html'), '<!doctype html><head><title>Shared page</title></head><h1>Shared page</h1>');
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  registerLogicalPage({
    uri: 'docs/page',
    title: 'Shared page',
    sourcePath: path.join(contentDir, 'docs', 'page.html'),
    component: 'content',
  }, config);
  if (auth || authConfig) {
    setupAuth(app, authConfig || {
      enabled: true,
      password: hashPassword('secret'),
    }, { enabled: sharingEnabled });
  }
  if (shareViewer) {
    app.use((_req, res, next) => {
      res.locals.viewerType = 'share';
      next();
    });
  }
  if (sharingEnabled) {
    setupShareApi(app, { enabled: true }, config);
  }
  app.get(['/docs/page', '/p/docs/page'], (req, res) => {
    if (req.query.locals === '1') {
      return res.status(200).json({
        viewerType: res.locals.viewerType || null,
        authenticated: res.locals.authenticated === true,
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
      resolve({ server, origin: `http://127.0.0.1:${port}`, contentDir });
    });
  });
}

async function login(origin) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'secret' }),
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie');
}

async function createShareViaApi(origin, cookie, body = {}) {
  const response = await fetch(`${origin}/api/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Forwarded-Proto': 'http',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ slug: 'p/docs/page', duration: '24h', ...body }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function patchShare(origin, tokenId, canWriteAttachments, cookie) {
  return fetch(`${origin}/api/share/${tokenId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ canWriteAttachments }),
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
      body: JSON.stringify({ slug: 'p/docs/page', duration: '24h' }),
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

test('create share grants attachment writes only when asked, and only for a real boolean', async () => {
  const { server, origin } = await makeServer();
  try {
    async function create(payload) {
      return fetch(`${origin}/api/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Forwarded-Proto': 'http',
        },
        body: JSON.stringify({ slug: 'p/docs/page', duration: '24h', ...payload }),
      });
    }

    // Explicit opt-in.
    let response = await create({ canWriteAttachments: true });
    assert.equal(response.status, 200);
    const writable = await response.json();
    assert.equal(writable.canWriteAttachments, true);

    // Omitted means read-only — the default must never drift.
    response = await create({});
    assert.equal(response.status, 200);
    const readOnly = await response.json();
    assert.equal(readOnly.canWriteAttachments, false);

    // A truthy non-boolean is a client bug, not consent. It must not be
    // silently coerced in either direction.
    for (const bad of ['true', 1, {}]) {
      response = await create({ canWriteAttachments: bad });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid canWriteAttachments' });
    }

    const list = await fetch(`${origin}/api/shares/p/docs/page`, {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    const listedWritable = listed.shares.find(share => share.tokenId === writable.tokenId);
    const listedReadOnly = listed.shares.find(share => share.tokenId === readOnly.tokenId);
    assert.equal(listedWritable.canWriteAttachments, true);
    assert.equal(listedReadOnly.canWriteAttachments, false);
    assert.equal(listedWritable.shortUrl, `${origin}/s/${listedWritable.tokenId}`);
  } finally {
    server.close();
  }
});

test('create share rejects unregistered content slugs', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'p/docs/missing', duration: '24h' }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Page not found' });
  } finally {
    server.close();
  }
});

test('patch toggles the attachment capability in both directions on the same link', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const cookie = await login(origin);

    async function storedFlag(tokenId) {
      const list = await fetch(`${origin}/api/shares/p/docs/page`, { headers: { Cookie: cookie } });
      assert.equal(list.status, 200);
      const found = (await list.json()).shares.find(share => share.tokenId === tokenId);
      assert.ok(found, 'share must still be listed');
      return found.canWriteAttachments;
    }

    // The point of #51: change the capability without changing the URL.
    const share = await createShareViaApi(origin, cookie);
    assert.equal(await storedFlag(share.tokenId), false);

    let response = await patchShare(origin, share.tokenId, true, cookie);
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.canWriteAttachments, true);
    assert.equal(await storedFlag(share.tokenId), true);

    response = await patchShare(origin, share.tokenId, false, cookie);
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.canWriteAttachments, false);
    assert.equal(await storedFlag(share.tokenId), false);
  } finally {
    server.close();
  }
});

// A tombstoned row (page unregistered) is an audit record, not a live share.
// The permission UPDATE used to check only revoked/expiry, which a tombstone
// passes — so the row was written and the API reported 404 over a mutation
// that had already happened. On an ordinary row that was false → false, but a
// legacy or hand-edited row carrying 1 would be silently changed.
test('patch on a tombstoned share is refused without mutating the row', async () => {
  const { server, origin, contentDir } = await makeServer({ auth: true });
  try {
    const cookie = await login(origin);
    // A page of its own: this test unregisters it, and the shared `docs/page`
    // fixture has to survive for everything after it.
    const sourcePath = path.join(contentDir, 'docs', 'doomed.html');
    fs.writeFileSync(sourcePath, '<!doctype html><head><title>Doomed</title></head><h1>Doomed</h1>');
    const page = registerLogicalPage({
      uri: 'docs/doomed',
      title: 'Doomed',
      sourcePath,
      component: 'content',
    }, { contentDir, externalFiles: { allowedSources: { content: contentDir } } });
    const share = createShare('docs/doomed', '24h');
    const db = getPagesDb();

    // Force the state a silent write would destroy.
    const seeded = db.prepare('UPDATE shares SET can_write_attachments = 1 WHERE token_id = ?')
      .run(share.tokenId).changes;
    assert.equal(seeded, 1, 'fixture must actually set the flag it is guarding');

    unregisterLogicalPageById(page.pageId);

    const response = await patchShare(origin, share.tokenId, false, cookie);
    assert.equal(response.status, 404);

    const row = db.prepare('SELECT can_write_attachments FROM shares WHERE token_id = ?').get(share.tokenId);
    assert.equal(row.can_write_attachments, 1, 'the refused request must not have written anything');
  } finally {
    server.close();
  }
});

test('share viewers cannot patch share attachment permission', async () => {
  const share = createShare('docs/page', '24h');
  const { server, origin } = await makeServer({ shareViewer: true });
  try {
    const response = await patchShare(origin, share.tokenId, true);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Share viewers cannot update shares' });
  } finally {
    server.close();
  }
});

test('patch rejects revoked, expired, malformed and unknown tokens in both directions', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const cookie = await login(origin);

    const revoked = await createShareViaApi(origin, cookie);
    revokeShare(revoked.tokenId);
    let response = await patchShare(origin, revoked.tokenId, false, cookie);
    assert.equal(response.status, 404);

    const expired = await createShareViaApi(origin, cookie);
    getPagesDb().prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?').run(Date.now() - 1000, expired.tokenId);
    response = await patchShare(origin, expired.tokenId, false, cookie);
    assert.equal(response.status, 404);

    response = await patchShare(origin, 'bad-token', false, cookie);
    assert.equal(response.status, 400);

    response = await patchShare(origin, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, cookie);
    assert.equal(response.status, 404);

    response = await fetch(`${origin}/api/share/${expired.tokenId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: JSON.stringify({ canWriteAttachments: 'yes' }),
    });
    assert.equal(response.status, 400);

    // Granting is refused on exactly the same rows as withdrawing — a dead
    // token cannot be brought back to life by upgrading it.
    response = await patchShare(origin, revoked.tokenId, true, cookie);
    assert.equal(response.status, 404);
    response = await patchShare(origin, expired.tokenId, true, cookie);
    assert.equal(response.status, 404);
    response = await patchShare(origin, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, cookie);
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('short share URL sets access cookie and renders clean page in place', async () => {
  const { server, origin } = await makeServer();
  try {
    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'p/docs/page', duration: '24h' }),
    });
    const share = await create.json();

    const redirect = await fetch(share.url, { redirect: 'manual' });
    assert.equal(redirect.status, 200);
    assert.equal(redirect.headers.get('location'), null);
    const setCookie = redirect.headers.get('set-cookie');
    assert.match(setCookie, /__Secure-share_access\.[a-f0-9]{32}=/);
    assert.doesNotMatch(setCookie, /__Secure-share_scope=/);
    assert.match(await redirect.text(), /<base href="\/p\/docs\/page">/);
  } finally {
    server.close();
  }
});

test('short share URL remains accessible when the owner password is missing', async () => {
  const share = createShare('docs/page', '24h');
  const { server, origin } = await makeServer({
    authConfig: { password: null },
  });
  try {
    const response = await fetch(`${origin}/s/${share.tokenId}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Shared page/);
    assert.doesNotMatch(body, /Authentication is not configured/);
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
    assert.match(cookie, /__Secure-zylos_pages_session=/);

    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
        Cookie: cookie,
      },
      body: JSON.stringify({ slug: 'p/docs/page', duration: '24h' }),
    });
    assert.equal(create.status, 200);
    const share = await create.json();

    const direct = await fetch(share.url, { redirect: 'manual' });
    assert.equal(direct.status, 200);
    assert.doesNotMatch(await direct.text(), /login/);
    const cookies = cookieHeader(direct.headers.get('set-cookie'));

    const page = await fetch(`${origin}/p/docs/page`, {
      redirect: 'manual',
      headers: { Cookie: cookies },
    });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'plain');
  } finally {
    server.close();
  }
});

// The capability must reach res.locals, and it must not drag `authenticated`
// up with it. A writable share is still an unauthenticated viewer that happens
// to hold one extra, narrowly scoped permission — if `authenticated` ever went
// true here, every auth-only surface in the app would open at once.
test('a writable share cookie carries the capability without becoming authenticated', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie');

    async function localsFor(payload) {
      const create = await fetch(`${origin}/api/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Forwarded-Proto': 'http',
          Cookie: cookie,
        },
        body: JSON.stringify({ slug: 'p/docs/page', duration: '24h', ...payload }),
      });
      assert.equal(create.status, 200);
      const share = await create.json();

      const direct = await fetch(share.url, { redirect: 'manual' });
      assert.equal(direct.status, 200);
      const cookies = cookieHeader(direct.headers.get('set-cookie'));

      const appCheck = await fetch(`${origin}/p/docs/page?locals=1`, {
        headers: { Cookie: cookies },
      });
      assert.equal(appCheck.status, 200);
      return appCheck.json();
    }

    assert.deepEqual(await localsFor({ canWriteAttachments: true }), {
      viewerType: 'share',
      authenticated: false,
      shareCanWriteAttachments: true,
    });

    assert.deepEqual(await localsFor({}), {
      viewerType: 'share',
      authenticated: false,
      shareCanWriteAttachments: false,
    });
  } finally {
    server.close();
  }
});

test('legacy long share token bypass is rejected while short links still work', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const share = createShare('docs/page', '24h');

    let response = await fetch(`${origin}/docs/page?token=${encodeURIComponent(share.token)}`, {
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      `/login?next=${encodeURIComponent(`/docs/page?token=${encodeURIComponent(share.token)}`)}`
    );

    response = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /__Secure-share_access\.[a-f0-9]{32}=/);
  } finally {
    server.close();
  }
});

test('login session takes precedence over share-access cookie on /p/ routes (#102)', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const sessionCookie = await login(origin);
    assert.match(sessionCookie, /__Secure-zylos_pages_session=/);

    const share = await createShareViaApi(origin, cookieHeader(sessionCookie), {
      slug: 'p/docs/page',
      duration: '24h',
    });
    const shareVisit = await fetch(share.url, { redirect: 'manual' });
    assert.equal(shareVisit.status, 200);
    const shareCookie = cookieHeader(shareVisit.headers.get('set-cookie'));
    assert.match(shareCookie, /__Secure-share_access\.[a-f0-9]{32}=/);

    // Both cookies present — the login session must win: authenticated view,
    // never the shell-less share view.
    const both = `${cookieHeader(sessionCookie)}; ${shareCookie}`;
    const page = await fetch(`${origin}/p/docs/page?locals=1`, {
      redirect: 'manual',
      headers: { Cookie: both },
    });
    assert.equal(page.status, 200);
    const locals = await page.json();
    assert.equal(locals.authenticated, true);
    assert.equal(locals.viewerType, null);
  } finally {
    server.close();
  }
});

test('share-access cookie still grants the share view when unauthenticated (#102)', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const sessionCookie = await login(origin);
    const share = await createShareViaApi(origin, cookieHeader(sessionCookie), {
      slug: 'p/docs/page',
      duration: '24h',
    });
    const shareVisit = await fetch(share.url, { redirect: 'manual' });
    const shareCookie = cookieHeader(shareVisit.headers.get('set-cookie'));

    // Share cookie only (no login session): the /p/ logical route must keep
    // serving the share view — share pages carry <base href=".../p/<uri>">,
    // so anchor/TOC navigation from a share lands here.
    const page = await fetch(`${origin}/p/docs/page?locals=1`, {
      redirect: 'manual',
      headers: { Cookie: shareCookie },
    });
    assert.equal(page.status, 200);
    const locals = await page.json();
    assert.equal(locals.authenticated, false);
    assert.equal(locals.viewerType, 'share');

    // ...but any other page stays protected (URI pinning).
    const other = await fetch(`${origin}/p/docs/other?locals=1`, {
      redirect: 'manual',
      headers: { Cookie: shareCookie },
    });
    assert.equal(other.status, 302);
    assert.match(other.headers.get('location'), /^\/login\?next=/);
  } finally {
    server.close();
  }
});

test('login and logout clear an existing share-access cookie (#102)', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const sessionCookie = await login(origin);
    const share = await createShareViaApi(origin, cookieHeader(sessionCookie), {
      slug: 'p/docs/page',
      duration: '24h',
    });
    const shareVisit = await fetch(share.url, { redirect: 'manual' });
    assert.match(shareVisit.headers.get('set-cookie'), /__Secure-share_access\.[a-f0-9]{32}=/);

    // Logging in clears any lingering share-access cookie.
    const shareCookie = shareAccessCookie(shareVisit.headers.get('set-cookie'));
    const shareCookieName = shareCookie.split('=', 1)[0];
    const relogin = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: shareCookie },
      body: new URLSearchParams({ password: 'secret' }),
    });
    assert.equal(relogin.status, 302);
    assert.match(relogin.headers.get('set-cookie'), new RegExp(`${shareCookieName.replace('.', '\\.')}=;[^,]*Max-Age=0`));

    // Logging out clears it too.
    const logout = await fetch(`${origin}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin, Cookie: `${cookieHeader(sessionCookie)}; ${shareCookie}` },
    });
    assert.equal(logout.status, 302);
    assert.match(logout.headers.get('set-cookie'), new RegExp(`${shareCookieName.replace('.', '\\.')}=;[^,]*Max-Age=0`));

    // Which stored cookie a Set-Cookie replaces is decided by name + Domain +
    // Path (RFC 6265 5.3); Secure is required on top only because the name
    // carries the __Secure- prefix. Compare those against the header the share
    // visit actually sent, rather than against hand-written literals.
    const attributes = (setCookie) => new Set(
      setCookie.split(/,\s*(?=__Secure-|__Host-)/)
        .find(entry => /^__Secure-share_access\.[a-f0-9]{32}=/.test(entry))
        .split(';').slice(1)
        .map(part => part.trim())
        .filter(part => part && !/^Max-Age=/i.test(part))
    );
    const identity = (setCookie) => new Set(
      [...attributes(setCookie)].filter(attribute => /^(Path=|Domain=|Secure$)/i.test(attribute))
    );
    const issuedIdentity = identity(shareVisit.headers.get('set-cookie'));
    const clearedIdentity = identity(logout.headers.get('set-cookie'));

    // Guard: without this, an extractor that stopped finding Path would leave
    // {Secure} on both sides — deepEqual passes, the Secure assertion passes,
    // and the Path half of the identity would silently stop being tested.
    assert.ok(
      [...issuedIdentity].some(attribute => /^Path=\S/i.test(attribute)),
      'share_access issuance should carry a non-empty Path'
    );

    assert.deepEqual(
      clearedIdentity,
      issuedIdentity,
      'share_access should be deleted under the identity it was issued with'
    );
    assert.ok(
      clearedIdentity.has('Secure'),
      '__Secure- prefixed names are rejected without the Secure attribute'
    );
  } finally {
    server.close();
  }
});

// Boundary that logout does and does not cover, pinned so it stops being
// folklore: logging out clears this browser's copy of the share-access
// cookie, but it is not a revocation — a client that keeps the cookie still
// has the access the public share link grants until the share is revoked.
test('logout clears the browser copy of a share session but does not revoke the share', async () => {
  const { server, origin } = await makeServer({ auth: true });
  try {
    const sessionCookie = await login(origin);
    const share = await createShareViaApi(origin, cookieHeader(sessionCookie), {
      slug: 'p/docs/page',
      duration: '24h',
    });
    const shareVisit = await fetch(share.url, { redirect: 'manual' });
    const shareCookie = shareAccessCookie(shareVisit.headers.get('set-cookie'));

    // Positive control: the retained cookie grants the shared page.
    const before = await fetch(`${origin}/p/docs/page`, {
      redirect: 'manual',
      headers: { Cookie: shareCookie },
    });
    assert.equal(before.status, 200);

    const logout = await fetch(`${origin}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin, Cookie: cookieHeader(sessionCookie) },
    });
    assert.equal(logout.status, 302);

    // Unchanged by logout — the share link is public until revoked.
    const after = await fetch(`${origin}/p/docs/page`, {
      redirect: 'manual',
      headers: { Cookie: shareCookie },
    });
    assert.equal(after.status, 200);

    // Revocation is what actually ends it.
    assert.equal(revokeShare(share.tokenId), true);
    const revoked = await fetch(`${origin}/p/docs/page`, {
      redirect: 'manual',
      headers: { Cookie: shareCookie },
    });
    assert.equal(revoked.status, 302);
    assert.match(revoked.headers.get('location'), /^\/login/);
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
