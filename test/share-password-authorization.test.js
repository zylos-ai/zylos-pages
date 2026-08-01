import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-auth-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-auth-content-'));
const custodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-auth-keys-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { createShareAuthorization } = await import('../src/security/share-authorization.js');
const { SharePasswordRateLimiter } = await import('../src/security/share-password-rate-limit.js');
const {
  createShare,
  createShareAssetSignature,
  disableSharePassword,
  setSharePassword,
  shareAssetExpiresAt,
  verifyShareAssetSignature,
} = await import('../src/sharing/share-manager.js');
const { createSharePasswordKeyring } = await import('../src/sharing/share-password-keyring.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');

const keyFile = path.join(custodyDir, 'keys.json');
const keyring = createSharePasswordKeyring(keyFile, { keyId: 'test-key', key: Buffer.alloc(32, 0x42) });
const ownerPasswordHash = hashPassword('owner-secret');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.rmSync(custodyDir, { recursive: true, force: true });
});

function cookieValue(setCookie, name) {
  const match = setCookie?.match(new RegExp(`${name}=([^;,]+)`));
  return match ? `${name}=${match[1]}` : '';
}

async function makeServer({ authEnabled = true } = {}) {
  const sourcePath = path.join(contentDir, 'page.md');
  fs.writeFileSync(sourcePath, '# Protected source\n\nprivate body\n');
  const config = {
    contentDir,
    auth: { enabled: authEnabled, password: authEnabled ? ownerPasswordHash : null },
    sharing: {
      enabled: true,
      passwordKeyFile: keyFile,
      passwordRateLimit: { windowMs: 60_000, tokenMax: 4, ipMax: 12 },
    },
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  registerLogicalPage({
    uri: 'protected',
    title: 'Protected',
    sourcePath,
    component: 'content',
  }, config);

  const app = express();
  setupAuth(app, config.auth, config.sharing);
  setupShareApi(app, config.sharing, config);
  // These probes sit behind the real auth middleware and pin the authority
  // conveyed to write surfaces without making the test depend on their body
  // parsing/storage details.
  const probe = (_req, res) => res.json({
    authenticated: res.locals.authenticated === true,
    viewerType: res.locals.viewerType || null,
    canWriteAttachments: res.locals.shareCanWriteAttachments === true,
    tokenId: res.locals.shareContext?.tokenId || null,
  });
  app.post('/api/attachments/protected/items/item', probe);
  app.post('/api/state/protected/key', probe);
  app.get('/p/protected', probe);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function login(origin) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'owner-secret' }),
  });
  assert.equal(response.status, 302);
  return cookieValue(response.headers.get('set-cookie'), '__Secure-zylos_pages_session');
}

async function createProtected(origin, ownerCookie, password = 'viewer-secret') {
  const response = await fetch(`${origin}/api/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Forwarded-Proto': 'http',
      Cookie: ownerCookie,
    },
    body: JSON.stringify({
      slug: 'p/protected',
      duration: '24h',
      canWriteAttachments: true,
      protection: { type: 'password', mode: 'provided', password },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  return response.json();
}

test('protected HTML and markdown share one proof boundary while owner keeps precedence', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const share = await createProtected(origin, ownerCookie);
    assert.deepEqual(share.protection, { type: 'password', password: 'viewer-secret' });

    // The browser challenge ships as 200 (webviews swallow non-2xx documents)
    // while X-Zylos-Share-Error keeps the auth state machine-readable.
    let response = await fetch(share.shortUrl, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
    assert.equal(response.headers.get('set-cookie'), null, 'challenge must not mint a session');
    const challengeHtml = await response.text();
    assert.match(challengeHtml, /Unlock shared page/);
    assert.doesNotMatch(challengeHtml, /private body/, 'challenge must not leak document content');

    response = await fetch(`${share.shortUrl}.md`, {
      headers: { 'X-Zylos-Share-Password': 'wrong-secret' },
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    assert.equal((await response.json()).code, 'invalid_password');

    response = await fetch(`${share.shortUrl}.md`, {
      headers: { 'X-Zylos-Share-Password': 'viewer-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null, 'Agent header must never mint a browser cookie');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await response.text(), /private body/);

    response = await fetch(share.shortUrl, {
      method: 'HEAD',
      headers: { 'X-Zylos-Share-Password': 'viewer-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);

    response = await fetch(share.shortUrl, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null, 'owner precedence must not mint a share cookie');
    const ownerHtml = await response.text();
    assert.doesNotMatch(ownerHtml, /data-viewer="share"/);
  } finally {
    server.close();
  }
});

test('unlock requires same-origin CSRF, CAS-mints a scoped session, and header cannot authorize writes', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const share = await createProtected(origin, ownerCookie);
    const header = { 'X-Zylos-Share-Password': 'viewer-secret' };

    for (const target of [
      '/api/attachments/protected/items/item',
      '/api/state/protected/key',
      `/api/share/${share.tokenId}/password/reveal`,
    ]) {
      const response = await fetch(`${origin}${target}`, {
        method: 'POST',
        redirect: 'manual',
        headers: header,
      });
      assert.equal(response.status, 302, `header must not authorize ${target}`);
      assert.match(response.headers.get('location'), /^\/login/);
    }
    let response = await fetch(`${origin}/p/protected`, {
      redirect: 'manual',
      headers: header,
    });
    assert.equal(response.status, 302, 'header must not authorize the generic page route');

    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 403, 'unlock without Origin/Referer must fail before KDF');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/s/${share.tokenId}`);
    const shareCookie = cookieValue(response.headers.get('set-cookie'), '__Secure-share_access');
    assert.ok(shareCookie);

    response = await fetch(`${origin}/api/attachments/protected/items/item`, {
      method: 'POST',
      headers: { Cookie: shareCookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: false,
      viewerType: 'share',
      canWriteAttachments: true,
      tokenId: share.tokenId,
    });

    response = await fetch(`${origin}/api/state/protected/key`, {
      method: 'POST',
      headers: { Cookie: shareCookie },
    });
    assert.equal(response.status, 200, 'browser session keeps the existing scoped state behavior');
    assert.equal((await response.json()).viewerType, 'share');
  } finally {
    server.close();
  }
});

test('unlock accepts the literal null Origin as a route-local exception with every other gate intact', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const share = await createProtected(origin, ownerCookie);
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

    // Opaque-origin webview shape (WeChat): literal "null" Origin, no Referer,
    // correct password — must mint the same session as the same-origin path.
    let response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/s/${share.tokenId}`);
    const setCookie = response.headers.get('set-cookie');
    assert.ok(cookieValue(setCookie, '__Secure-share_access'), 'null-origin unlock must mint the share session');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(await response.text(), /private body/, 'unlock response must not carry document content');

    // Wrong password through the null-origin path still fails closed: the
    // re-displayed challenge is 200 for webview compatibility but carries the
    // error marker and never mints a session.
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null' },
      body: new URLSearchParams({ password: 'wrong-secret' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-zylos-share-error'), 'invalid_password');
    assert.equal(response.headers.get('set-cookie'), null, 'failed unlock must not mint a session');
    assert.match(await response.text(), /Incorrect password/);

    // The relaxation is literal-null only: real cross-site Origins stay rejected...
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'https://evil.example' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 403);

    // ...null plus a cross-site Referer stays rejected...
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null', Referer: 'https://evil.example/page' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 403);

    // ...null plus a malformed Referer stays rejected...
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null', Referer: 'not a url' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 403);

    // ...and a missing Origin is NOT normalized to null: both-missing stays rejected
    // (asserted with the correct password so the rejection is attributable to CSRF).
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: form,
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 403);

    // Route-local means route-local: the same null Origin on mutation routes
    // keeps the strict check even with owner authority attached.
    response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', Cookie: ownerCookie },
      body: JSON.stringify({ slug: 'p/protected', duration: '24h' }),
    });
    assert.equal(response.status, 403, 'null-origin exception must not leak to share creation');
    response = await fetch(`${origin}/api/share/${share.tokenId}/password/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null', Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403, 'null-origin exception must not leak to password mutation');
  } finally {
    server.close();
  }
});

test('null-origin unlock shares the pre-KDF limiter and the mount-path cookie interference is bounded', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const shareA = await createProtected(origin, ownerCookie);
    const shareB = await createProtected(origin, ownerCookie, 'other-secret');
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

    // tokenMax is 4: four null-origin attempts consume the budget, the fifth
    // is rejected by the limiter before the KDF — the relaxation opens no
    // brute-force bypass.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rejected = await fetch(`${shareA.shortUrl}/unlock`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...form, Origin: 'null' },
        body: new URLSearchParams({ password: 'wrong-secret' }),
      });
      assert.equal(rejected.status, 200, 'browser re-display is 200 but stays a challenge');
      assert.equal(rejected.headers.get('x-zylos-share-error'), 'invalid_password');
      assert.equal(rejected.headers.get('set-cookie'), null);
    }
    let response = await fetch(`${shareA.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null' },
      body: new URLSearchParams({ password: 'viewer-secret' }),
    });
    assert.equal(response.status, 429, 'exhausted token budget must reject even the correct password');

    // Discriminating control for the accepted low-impact interference: the
    // share session cookie is mount-path scoped and shared by name, so a later
    // unlock of B replaces A's browser session — A falls back to the password
    // challenge instead of leaking anything.
    response = await fetch(`${shareB.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...form, Origin: 'null' },
      body: new URLSearchParams({ password: 'other-secret' }),
    });
    assert.equal(response.status, 303);
    const cookieB = cookieValue(response.headers.get('set-cookie'), '__Secure-share_access');
    assert.ok(cookieB);
    assert.match(response.headers.get('set-cookie'), /Path=\//, 'cookie stays mount-path scoped (the documented interference surface)');

    response = await fetch(shareA.shortUrl, { redirect: 'manual', headers: { Cookie: cookieB } });
    assert.equal(response.status, 200, 'challenge re-prompt ships as 200 for webviews');
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required', 'B\'s session must not authorize A — interference is re-prompt only');
    const reprompt = await response.text();
    assert.match(reprompt, /Unlock shared page/);
    assert.doesNotMatch(reprompt, /private body/, 'foreign session must not leak A\'s content');
  } finally {
    server.close();
  }
});

test('dedicated limiter rejects before invoking the KDF', async () => {
  const share = createShare('protected', '24h');
  await setSharePassword(share.tokenId, 'limiter-secret', keyring);
  let calls = 0;
  const authorizer = createShareAuthorization({
    rateLimiter: new SharePasswordRateLimiter({ windowMs: 60_000, tokenMax: 1, ipMax: 10 }),
    verifyPassword: async () => {
      calls += 1;
      return { valid: false };
    },
  });
  const req = { ip: '203.0.113.10', socket: {}, headers: {} };
  assert.equal((await authorizer.verifyProof(req, share.tokenId, 'wrong')).code, 'invalid_password');
  assert.equal((await authorizer.verifyProof(req, share.tokenId, 'wrong-again')).code, 'rate_limited');
  assert.equal(calls, 1, 'exhausted request must not reach the KDF');
});

test('dedicated limiter prunes expired client buckets under sustained address churn', () => {
  let current = 1_000;
  const limiter = new SharePasswordRateLimiter({
    windowMs: 10,
    tokenMax: 2_000,
    ipMax: 1,
    now: () => current,
  });
  for (let index = 0; index < 1_001; index += 1) {
    assert.equal(limiter.consume({ tokenId: 'stable-token', clientIp: `client-${index}` }).allowed, true);
  }
  assert.ok(limiter.ipBuckets.size > 1_000);
  current += 11;
  limiter.consume({ tokenId: 'stable-token', clientIp: 'fresh-client' });
  assert.equal(limiter.ipBuckets.size, 1, 'expired address buckets must not accumulate forever');
});

test('unlock rejects an oversized multibyte body by bytes', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const share = await createProtected(origin, ownerCookie);
    const response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: `password=${'界'.repeat(1_500)}`,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'invalid_request');
  } finally {
    server.close();
  }
});

test('asset signatures bind every nonzero credential generation while legacy generation zero stays compatible', async () => {
  const share = createShare('protected', '24h');
  const expiresAt = shareAssetExpiresAt(share.expiresAt);
  const input = { uri: 'protected', realPath: '/tmp/protected.png', expiresAt, tokenId: share.tokenId };
  const legacy = createShareAssetSignature(input);
  assert.equal(verifyShareAssetSignature({ ...input, sig: legacy }).valid, true);

  const protectedV1 = await setSharePassword(share.tokenId, 'asset-secret-one', keyring);
  assert.equal(verifyShareAssetSignature({ ...input, sig: legacy }).valid, false);
  const signatureV1 = createShareAssetSignature({ ...input, credentialVersion: protectedV1.credentialVersion });
  assert.equal(verifyShareAssetSignature({ ...input, sig: signatureV1 }).valid, true);

  const protectedV2 = await setSharePassword(share.tokenId, 'asset-secret-two', keyring);
  assert.equal(verifyShareAssetSignature({ ...input, sig: signatureV1 }).valid, false);
  const signatureV2 = createShareAssetSignature({ ...input, credentialVersion: protectedV2.credentialVersion });
  assert.equal(verifyShareAssetSignature({ ...input, sig: signatureV2 }).valid, true);

  const disabled = disableSharePassword(share.tokenId);
  assert.equal(verifyShareAssetSignature({ ...input, sig: signatureV2 }).valid, false);
  const signatureV3 = createShareAssetSignature({ ...input, credentialVersion: disabled.credentialVersion });
  assert.equal(verifyShareAssetSignature({ ...input, sig: signatureV3 }).valid, true);
});

test('owner lifecycle endpoints reveal only explicitly and invalidate old proof on rotate and disable', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    let response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ slug: 'p/protected', duration: '24h' }),
    });
    assert.equal(response.status, 200);
    const share = await response.json();
    assert.deepEqual(share.protection, { type: 'none' });

    response = await fetch(`${origin}/api/share/${share.tokenId}/password/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ mode: 'generated' }),
    });
    assert.equal(response.status, 200);
    const enabled = await response.json();
    const firstPassword = enabled.protection.password;
    assert.match(firstPassword, /^[0-9]{6}$/);

    response = await fetch(`${origin}/api/shares/p/protected`, { headers: { Cookie: ownerCookie } });
    const listed = await response.json();
    assert.equal(JSON.stringify(listed).includes(firstPassword), false, 'ordinary list must not contain plaintext');
    assert.equal(listed.shares.find(item => item.tokenId === share.tokenId).protection.type, 'password');

    response = await fetch(`${origin}/api/share/${share.tokenId}/password/reveal`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).protection.password, firstPassword);

    response = await fetch(`${origin}/s/${share.tokenId}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams({ password: firstPassword }),
    });
    const oldSession = cookieValue(response.headers.get('set-cookie'), '__Secure-share_access');
    assert.ok(oldSession);

    response = await fetch(`${origin}/api/share/${share.tokenId}/password/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ mode: 'provided', password: 'rotated-secret' }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${origin}/s/${share.tokenId}.md`, {
      headers: { 'X-Zylos-Share-Password': firstPassword },
    });
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/s/${share.tokenId}.md`, {
      headers: { 'X-Zylos-Share-Password': 'rotated-secret' },
    });
    assert.equal(response.status, 200);
    response = await fetch(`${origin}/p/protected`, { redirect: 'manual', headers: { Cookie: oldSession } });
    assert.equal(response.status, 302, 'rotation must invalidate the old browser session');

    response = await fetch(`${origin}/api/share/${share.tokenId}/password`, {
      method: 'DELETE',
      headers: { Origin: origin, Cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).protection, { type: 'none' });
    response = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /__Secure-share_access=/);
  } finally {
    server.close();
  }
});

test('provided password length boundary: 4 bytes is accepted, 3 bytes is refused', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    let response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ slug: 'p/protected', duration: '24h' }),
    });
    assert.equal(response.status, 200);
    const share = await response.json();

    response = await fetch(`${origin}/api/share/${share.tokenId}/password/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ mode: 'provided', password: '123' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_password');

    response = await fetch(`${origin}/api/share/${share.tokenId}/password/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: ownerCookie },
      body: JSON.stringify({ mode: 'provided', password: '1234' }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${origin}/s/${share.tokenId}.md`, {
      headers: { 'X-Zylos-Share-Password': '1234' },
    });
    assert.equal(response.status, 200, 'the 4-byte password must actually unlock the share');
  } finally {
    server.close();
  }
});

test('unlock challenge status boundary: browser HTML is 200 while agent proof paths keep 401', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerCookie = await login(origin);
    const share = await createProtected(origin, ownerCookie);

    // (a) Credential-less browser navigation: 200 + styled unlock form.
    let response = await fetch(share.shortUrl, { redirect: 'manual' });
    assert.equal(response.status, 200, 'webviews swallow non-2xx documents — challenge must be 200');
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('set-cookie'), null, 'challenge must not mint a session');
    let html = await response.text();
    assert.match(html, /<form method="post" action="\/s\/[A-Za-z0-9_-]+\/unlock"/);
    assert.match(html, /name="password"[^>]*autocomplete="current-password"[^>]*required autofocus/);
    assert.match(html, /class="login-card"/, 'challenge uses the shared card layout');
    assert.match(html, /_assets\/style\.css/, 'challenge links the shared stylesheet');
    assert.doesNotMatch(html, /role="alert"/, 'initial challenge shows no error message');
    assert.doesNotMatch(html, /private body/, 'challenge must not leak document content');

    // (b) Wrong-password browser POST: 200 re-display with error marker, no session.
    response = await fetch(`${share.shortUrl}/unlock`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams({ password: 'wrong-secret' }),
    });
    assert.equal(response.status, 200, 'wrong-password re-display must also be 200');
    assert.equal(response.headers.get('x-zylos-share-error'), 'invalid_password');
    assert.equal(response.headers.get('set-cookie'), null, 'failed unlock must not mint a session');
    html = await response.text();
    assert.match(html, /role="alert"/);
    assert.match(html, /Incorrect password/);
    assert.doesNotMatch(html, /private body/);

    // (c) Agent proof paths keep 401. Wrong header on the HTML route:
    response = await fetch(share.shortUrl, {
      redirect: 'manual',
      headers: { 'X-Zylos-Share-Password': 'wrong-secret' },
    });
    assert.equal(response.status, 401, 'header proof must keep 401 even on the HTML route');
    assert.equal(response.headers.get('x-zylos-share-error'), 'invalid_password');
    assert.equal(response.headers.get('www-authenticate'), 'ZylosShare realm="pages-share"');
    assert.equal(response.headers.get('set-cookie'), null);

    // Wrong header on the raw markdown route:
    response = await fetch(`${share.shortUrl}.md`, {
      headers: { 'X-Zylos-Share-Password': 'wrong-secret' },
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    assert.equal((await response.json()).code, 'invalid_password');

    // Missing header on the raw markdown route:
    response = await fetch(`${share.shortUrl}.md`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'ZylosShare realm="pages-share"');
    assert.equal((await response.json()).code, 'password_required');
  } finally {
    server.close();
  }
});

test('protected creation is refused when the owner surface is unauthenticated', async () => {
  const { server, origin } = await makeServer({ authEnabled: false });
  try {
    const response = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        slug: 'p/protected',
        duration: '24h',
        protection: { type: 'password', mode: 'generated' },
      }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'protection_unavailable');
  } finally {
    server.close();
  }
});
