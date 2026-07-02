import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupStateApi, RAW_BODY_LIMIT_BYTES, VALUE_JSON_LIMIT_BYTES } = await import('../src/routes/state-api.js');
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  setStateValue,
} = await import('../src/state/state-store.js');

const pagesDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-pages-'));

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(pagesDir, { recursive: true, force: true });
});

// Shares are keyed by page_id, so every shared artifact needs a registered page.
async function registerStatePage(uri) {
  const sourcePath = path.join(pagesDir, `${uri}.html`);
  await writeFile(sourcePath, `<!doctype html><h1>${uri}</h1>`);
  return registerLogicalPage({
    uri,
    title: uri,
    sourcePath,
    component: 'pages',
  }, { externalFiles: { allowedSources: { pages: pagesDir } } });
}

async function withApp(app, fn) {
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

async function withServer(authConfig, fn) {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-content-'));
  await writeFile(path.join(contentDir, 'short-state.html'), '<!doctype html><h1>Short state</h1>');
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  registerLogicalPage({
    uri: 'short-state',
    title: 'Short state',
    sourcePath: path.join(contentDir, 'short-state.html'),
    component: 'content',
  }, config);
  setupAuth(app, authConfig || { enabled: false, password: null });
  setupShareApi(app, { enabled: true, allowPermanent: false }, config);
  setupStateApi(app);
  app.get('/', (_req, res) => res.send('root'));
  try {
    await withApp(app, fn);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
}

async function login(origin) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'secret' }),
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

function authConfig() {
  return {
    enabled: true,
    password: hashPassword('secret'),
  };
}

function sameOriginHeaders(origin, extra = {}) {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Host-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

async function createExpiredShareToken(slug) {
  const share = createShare(slug, '24h', { allowPermanent: false });
  const expiresAt = Date.now() - 1000;
  const db = getPagesDb();
  const secret = db.prepare('SELECT value FROM share_meta WHERE key = ?').get('secret').value;
  db.prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?').run(expiresAt, share.tokenId);
  const payload = `${share.pageId}:${expiresAt}:${share.tokenId}`;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

function expectLoginRedirect(response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?/);
}

test('state store round-trips JSON value types and explicit presence results', () => {
  const artifact = 'store-roundtrip';
  const values = {
    bool: true,
    number: 42,
    string: 'hello',
    nullValue: null,
    object: { nested: [1, 2, 3] },
    array: ['a', 'b'],
  };

  for (const [key, value] of Object.entries(values)) {
    setStateValue(artifact, key, value);
    assert.deepEqual(getStateValue(artifact, key), { found: true, value });
  }

  assert.deepEqual(getStateValue(artifact, 'missing'), { found: false });
  assert.deepEqual(getArtifactState('unknown-artifact'), {});
  assert.deepEqual(getArtifactState(artifact), {
    array: ['a', 'b'],
    bool: true,
    nullValue: null,
    number: 42,
    object: { nested: [1, 2, 3] },
    string: 'hello',
  });
});

test('state store delete and upsert behavior', () => {
  const artifact = 'store-upsert-delete';
  setStateValue(artifact, 'key', 'first');
  setStateValue(artifact, 'key', 'second');
  assert.deepEqual(getStateValue(artifact, 'key'), { found: true, value: 'second' });

  deleteStateValue(artifact, 'key');
  deleteStateValue(artifact, 'key');
  assert.deepEqual(getStateValue(artifact, 'key'), { found: false });
});

test('state store isolates artifact namespaces', () => {
  setStateValue('artifact-one', 'shared', true);
  setStateValue('artifact-two', 'shared', false);

  assert.deepEqual(getStateValue('artifact-one', 'shared'), { found: true, value: true });
  assert.deepEqual(getStateValue('artifact-two', 'shared'), { found: true, value: false });
});

test('state API works with auth disabled and supports CRUD', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    const artifact = 'api-crud';

    let res = await fetch(`${origin}/api/state/${artifact}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, state: {} });

    res = await fetch(`${origin}/api/state/${artifact}/key1`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'key1', value: true });

    res = await fetch(`${origin}/api/state/${artifact}/key1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'key1', value: true });

    res = await fetch(`${origin}/api/state/${artifact}/key2`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: { nested: [1, 2, 3] } }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${origin}/api/state/${artifact}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      state: {
        key1: true,
        key2: { nested: [1, 2, 3] },
      },
    });

    res = await fetch(`${origin}/api/state/${artifact}/key1`, {
      method: 'DELETE',
      headers: { Origin: origin },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    res = await fetch(`${origin}/api/state/${artifact}/key1`);
    assert.equal(res.status, 404);
  });
});

test('state API distinguishes stored null from missing key', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    const res = await fetch(`${origin}/api/state/api-null/null-key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: null }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'null-key', value: null });

    const getNull = await fetch(`${origin}/api/state/api-null/null-key`);
    assert.equal(getNull.status, 200);
    assert.deepEqual(await getNull.json(), { ok: true, key: 'null-key', value: null });

    const missing = await fetch(`${origin}/api/state/api-null/missing`);
    assert.equal(missing.status, 404);
  });
});

test('state API CSRF checks mutating requests only', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/csrf/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${origin}/api/state/csrf/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Origin: 'https://evil.test' }),
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 403);

    res = await fetch(`${origin}/api/state/csrf/key2`, {
      method: 'PUT',
      headers: { Referer: `${origin}/page`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${origin}/api/state/csrf/key2`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 403);

    res = await fetch(`${origin}/api/state/csrf`);
    assert.equal(res.status, 200);
  });
});

test('state API rejects legacy share-token CRUD for the matching artifact', async () => {
  await registerStatePage('shared-state');
  const token = createShare('shared-state', '24h', { allowPermanent: false }).token;

  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/shared-state?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/shared-state/checklist?token=${encodeURIComponent(token)}`, {
      method: 'PUT',
      redirect: 'manual',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: { done: true } }),
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/shared-state/checklist?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      redirect: 'manual',
      headers: { Origin: origin },
    });
    expectLoginRedirect(res);
  });
});

test('state API allows short-share cookie CRUD for the matching artifact', async () => {
  const share = createShare('short-state', '24h', { allowPermanent: false });

  await withServer(authConfig(), async ({ origin }) => {
    const redirect = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(redirect.status, 200);
    assert.equal(redirect.headers.get('location'), null);
    assert.match(await redirect.text(), /<base href="\/p\/short-state">/);
    const cookies = cookieHeader(redirect.headers.get('set-cookie'));

    let res = await fetch(`${origin}/api/state/short-state`, {
      headers: { Cookie: cookies },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, state: {} });

    res = await fetch(`${origin}/api/state/short-state/checklist`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Cookie: cookies }),
      body: JSON.stringify({ value: { done: true } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'checklist', value: { done: true } });

    res = await fetch(`${origin}/api/state/short-state/checklist`, {
      headers: { Cookie: cookies },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'checklist', value: { done: true } });
  });
});

test('state API share-token scope mismatch falls through to auth wall', async () => {
  await registerStatePage('scope-source');
  const token = createShare('scope-source', '24h', { allowPermanent: false }).token;

  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/other-artifact?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/other-artifact/key?token=${encodeURIComponent(token)}`, {
      method: 'PUT',
      redirect: 'manual',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    expectLoginRedirect(res);
  });
});

test('state API rejects legacy share-token mutating requests before CSRF handling', async () => {
  await registerStatePage('share-csrf');
  const token = createShare('share-csrf', '24h', { allowPermanent: false }).token;

  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/share-csrf/key?token=${encodeURIComponent(token)}`, {
      method: 'PUT',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: true }),
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/share-csrf/key?token=${encodeURIComponent(token)}`, {
      method: 'PUT',
      redirect: 'manual',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/share-csrf/key?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      redirect: 'manual',
    });
    expectLoginRedirect(res);
  });
});

test('state API invalid share tokens fall through to auth wall', async () => {
  await registerStatePage('revoked-state');
  await registerStatePage('expired-state');
  const revoked = createShare('revoked-state', '24h', { allowPermanent: false });
  revokeShare(revoked.tokenId);
  const expiredToken = await createExpiredShareToken('expired-state');

  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/revoked-state?token=${encodeURIComponent(revoked.token)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/expired-state?token=${encodeURIComponent(expiredToken)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/malformed-state?token=not-a-valid-share-token`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/missing-token`, { redirect: 'manual' });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/%E0%A4%A?token=not-a-valid-share-token`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get('location').startsWith('/login'));
  });
});

test('state API auth wall redirects unauthenticated and malformed-token API requests', async () => {
  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/auth-wall`, { redirect: 'manual' });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/state/auth-wall?token=not-a-valid-share-token`, { redirect: 'manual' });
    expectLoginRedirect(res);

    const cookie = await login(origin);
    res = await fetch(`${origin}/api/state/auth-wall`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
  });
});

test('legacy share tokens do not grant access to raw API or pages', async () => {
  await registerStatePage('shared-page');
  const token = createShare('shared-page', '24h', { allowPermanent: false }).token;
  const app = express();
  setupAuth(app, authConfig());
  setupRawApi(app, { contentDir: dataDir });
  app.get('/shared-page', (req, res) => {
    res.status(200).send(res.locals.viewerType === 'share' ? 'share-viewer' : 'auth-viewer');
  });

  await withApp(app, async ({ origin }) => {
    let res = await fetch(`${origin}/shared-page?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);

    res = await fetch(`${origin}/api/raw/shared-page?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    expectLoginRedirect(res);
  });
});

test('state API validates artifact IDs and keys', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/BadArtifact`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/bad__artifact`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/${'a'.repeat(101)}`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/valid-artifact/bad$key`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/valid-artifact/${'a'.repeat(101)}`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/valid-artifact/`);
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/valid-artifact/`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 400);
  });
});

test('state API validates request body shape and JSON', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/body/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: '{invalid',
    });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/body/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ other: true }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/body/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: 'null',
    });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/body/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: '"string"',
    });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/body/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: '[1,2,3]',
    });
    assert.equal(res.status, 400);
  });
});

test('state API enforces raw body and value JSON byte limits', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    const exactValue = 'a'.repeat(VALUE_JSON_LIMIT_BYTES - 2);
    assert.equal(Buffer.byteLength(JSON.stringify(exactValue), 'utf8'), VALUE_JSON_LIMIT_BYTES);

    let res = await fetch(`${origin}/api/state/limits/exact`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: exactValue }),
    });
    assert.equal(res.status, 200);

    const tooLargeValue = 'a'.repeat(VALUE_JSON_LIMIT_BYTES - 1);
    assert.equal(Buffer.byteLength(JSON.stringify(tooLargeValue), 'utf8'), VALUE_JSON_LIMIT_BYTES + 1);

    res = await fetch(`${origin}/api/state/limits/value-too-large`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: tooLargeValue }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${origin}/api/state/limits/body-too-large`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: 'a'.repeat(RAW_BODY_LIMIT_BYTES + 1) }),
    });
    assert.equal(res.status, 413);
  });
});
