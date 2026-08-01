import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-data-'));
process.env.PAGES_DATA_DIR = dataDir;
assertIsolatedPagesDataDir(dataDir);

const express = (await import('express')).default;
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupStateApi, RAW_BODY_LIMIT_BYTES, VALUE_JSON_LIMIT_BYTES } = await import('../src/routes/state-api.js');
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage, updateLogicalPage } = await import('../src/pages/page-store.js');
const {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  setStateValue,
} = await import('../src/state/state-store.js');
const { consumeShareWriteQuota, resetShareWriteQuota } = await import('../src/security/share-write-limit.js');

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

async function withServer(authConfig, fn, overrides = {}) {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-content-'));
  await writeFile(path.join(contentDir, 'short-state.html'), '<!doctype html><h1>Short state</h1>');
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
    ...overrides,
  };
  registerLogicalPage({
    uri: 'short-state',
    title: 'Short state',
    sourcePath: path.join(contentDir, 'short-state.html'),
    component: 'content',
  }, config);
  setupAuth(app, authConfig || { enabled: false, password: null });
  setupShareApi(app, { enabled: true }, config);
  setupStateApi(app, config);
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
    .split(/,\s*(?=__Secure-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

async function openShare(origin, tokenId) {
  const response = await fetch(`${origin}/s/${tokenId}`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  return cookieHeader(response.headers.get('set-cookie'));
}

async function captureStateAuditLines(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.msg === 'state mutation audit') lines.push(parsed);
      } catch { /* not a structured state audit line */ }
    }
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

async function createExpiredShareToken(slug) {
  const share = createShare(slug, '24h');
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
  const pageId = crypto.randomUUID();
  const values = {
    bool: true,
    number: 42,
    string: 'hello',
    nullValue: null,
    object: { nested: [1, 2, 3] },
    array: ['a', 'b'],
  };

  for (const [key, value] of Object.entries(values)) {
    setStateValue(pageId, key, value);
    assert.deepEqual(getStateValue(pageId, key), { found: true, value });
  }

  assert.deepEqual(getStateValue(pageId, 'missing'), { found: false });
  assert.deepEqual(getArtifactState(crypto.randomUUID()), {});
  assert.deepEqual(getArtifactState(pageId), {
    array: ['a', 'b'],
    bool: true,
    nullValue: null,
    number: 42,
    object: { nested: [1, 2, 3] },
    string: 'hello',
  });
});

test('state store delete and upsert behavior', () => {
  const pageId = crypto.randomUUID();
  setStateValue(pageId, 'key', 'first');
  setStateValue(pageId, 'key', 'second');
  assert.deepEqual(getStateValue(pageId, 'key'), { found: true, value: 'second' });

  deleteStateValue(pageId, 'key');
  deleteStateValue(pageId, 'key');
  assert.deepEqual(getStateValue(pageId, 'key'), { found: false });
});

test('state store isolates page identities', () => {
  const pageOne = crypto.randomUUID();
  const pageTwo = crypto.randomUUID();
  setStateValue(pageOne, 'shared', true);
  setStateValue(pageTwo, 'shared', false);

  assert.deepEqual(getStateValue(pageOne, 'shared'), { found: true, value: true });
  assert.deepEqual(getStateValue(pageTwo, 'shared'), { found: true, value: false });
});

test('state API works with auth disabled and supports CRUD', async () => {
  await registerStatePage('api-crud');
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
  await registerStatePage('api-null');
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
  await registerStatePage('csrf');
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

    // The literal `Origin: null` sent by opaque-origin contexts is not the
    // same as a missing Origin and must stay rejected: the WeChat unlock
    // exception is route-local to share unlock and must not reach this gate.
    res = await fetch(`${origin}/api/state/csrf/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Origin: 'null' }),
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

test('state API rejects an unregistered artifact instead of creating a namespace', async () => {
  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    const artifact = 'definitely-not-a-registered-page';
    const db = getPagesDb();
    const before = db.prepare('SELECT COUNT(*) AS n FROM artifact_state').get().n;

    let res = await fetch(`${origin}/api/state/${artifact}`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Artifact not found' });

    res = await fetch(`${origin}/api/state/${artifact}/key`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Artifact not found' });

    res = await fetch(`${origin}/api/state/${artifact}/key`, {
      method: 'DELETE',
      headers: sameOriginHeaders(origin),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Artifact not found' });

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM artifact_state').get().n,
      before,
      'the rejected name must not leave an unowned state row'
    );
  });
});

test('state follows page_id across a logical page rename', async () => {
  const page = await registerStatePage('state-before-rename');

  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/state-before-rename/checklist`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin),
      body: JSON.stringify({ value: { done: true } }),
    });
    assert.equal(res.status, 200);

    updateLogicalPage(page.pageId, { uri: 'state-after-rename' });

    res = await fetch(`${origin}/api/state/state-after-rename/checklist`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, key: 'checklist', value: { done: true } });

    res = await fetch(`${origin}/api/state/state-before-rename/checklist`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Artifact not found' });
  });
});

test('state API rejects legacy share-token CRUD for the matching artifact', async () => {
  await registerStatePage('shared-state');
  const token = createShare('shared-state', '24h').token;

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
  const share = createShare('short-state', '24h');

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

// Negative control for the attachment capability added in 0.7.9.
//
// State CRUD is a *base* ability of any share on its matching page — it is what
// makes a shared interactive page able to remember a ticked checkbox, and it
// has been the contract since v0.3.0. `canWriteAttachments` governs one thing
// only: persistent file storage. This test exists so that a future change
// cannot quietly widen that bit into a general "may this link write anything"
// switch, in either direction: turning it on must not be required for state
// CRUD, and turning it off must not take state CRUD away.
test('the attachment capability does not govern state CRUD, in either position', async () => {
  await registerStatePage('capability-independence');

  for (const canWriteAttachments of [false, true]) {
    const share = createShare('capability-independence', '24h', { canWriteAttachments });

    await withServer(authConfig(), async ({ origin }) => {
      const redirect = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
      assert.equal(redirect.status, 200);
      const cookies = cookieHeader(redirect.headers.get('set-cookie'));

      const key = `state-${canWriteAttachments}`;
      let res = await fetch(`${origin}/api/state/capability-independence/${key}`, {
        method: 'PUT',
        headers: sameOriginHeaders(origin, { Cookie: cookies }),
        body: JSON.stringify({ value: { done: true } }),
      });
      assert.equal(res.status, 200, `state PUT must not depend on canWriteAttachments=${canWriteAttachments}`);

      res = await fetch(`${origin}/api/state/capability-independence/${key}`, {
        method: 'DELETE',
        headers: sameOriginHeaders(origin, { Cookie: cookies }),
      });
      assert.equal(res.status, 200, `state DELETE must not depend on canWriteAttachments=${canWriteAttachments}`);
    });
  }
});

test('state API share-token scope mismatch falls through to auth wall', async () => {
  await registerStatePage('scope-source');
  const token = createShare('scope-source', '24h').token;

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
  const token = createShare('share-csrf', '24h').token;

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
  const revoked = createShare('revoked-state', '24h');
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
  await registerStatePage('auth-wall');
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
  const token = createShare('shared-page', '24h').token;
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
  await registerStatePage('body');
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
  await registerStatePage('limits');
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

test('share state ceilings count new keys and replacement UTF-8 bytes atomically', async () => {
  resetShareWriteQuota();
  await registerStatePage('share-ceilings');
  const share = createShare('share-ceilings', '24h');
  const state = {
    maxKeysPerPage: 2,
    maxPageBytes: 10,
    shareWriteRateLimit: { windowMs: 60_000, max: 100, ipMax: 100 },
  };

  await withServer(authConfig(), async ({ origin }) => {
    const cookies = await openShare(origin, share.tokenId);
    const put = (key, value) => fetch(`${origin}/api/state/share-ceilings/${key}`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Cookie: cookies }),
      body: JSON.stringify({ value }),
    });

    // JSON strings include their quotes: "éé" is 6 UTF-8 bytes and "x" is 3.
    const audits = await captureStateAuditLines(async () => {
      assert.equal((await put('a', 'éé')).status, 200);
      assert.equal((await put('b', 'x')).status, 200);
      assert.equal((await put('c', 0)).status, 409, 'a third key must exceed the key ceiling');

      // Updating an existing key does not consume another key, but its old bytes
      // must be subtracted before the new value is admitted: 9 - 6 + 8 = 11.
      assert.equal((await put('a', 'ééé')).status, 409);
    });
    assert.ok(audits.some(line => line.reason === 'quota_keys' && line.status === 409));
    assert.ok(audits.some(line => line.reason === 'quota_bytes' && line.status === 409));
    const unchanged = await fetch(`${origin}/api/state/share-ceilings/a`, {
      headers: { Cookie: cookies },
    });
    assert.deepEqual(await unchanged.json(), { ok: true, key: 'a', value: 'éé' });

    assert.equal((await put('a', 'yy')).status, 200, 'a same-size replacement stays within both ceilings');
  }, { state });
});

test('owner state writes bypass share ceilings and share rate limits', async () => {
  resetShareWriteQuota();
  await registerStatePage('owner-exempt');
  const state = {
    maxKeysPerPage: 0,
    maxPageBytes: 0,
    shareWriteRateLimit: { windowMs: 60_000, max: 0, ipMax: 0 },
  };

  await withServer(authConfig(), async ({ origin }) => {
    const ownerCookie = await login(origin);
    for (const key of ['one', 'two']) {
      const res = await fetch(`${origin}/api/state/owner-exempt/${key}`, {
        method: 'PUT',
        headers: sameOriginHeaders(origin, { Cookie: ownerCookie }),
        body: JSON.stringify({ value: 'owner data' }),
      });
      assert.equal(res.status, 200);
    }
  }, { state });
});

test('share state rate limits have token and IP dimensions and separate set/delete buckets', async () => {
  resetShareWriteQuota();
  await registerStatePage('state-rate');
  const first = createShare('state-rate', '24h');
  const second = createShare('state-rate', '24h');
  const state = {
    maxKeysPerPage: 50,
    maxPageBytes: 1024 * 1024,
    shareWriteRateLimit: { windowMs: 60_000, max: 1, ipMax: 100 },
  };
  consumeShareWriteQuota(first.tokenId, 'upload', { windowMs: 60_000, max: 0, ipMax: 100 }, '127.0.0.1');

  await withServer(authConfig(), async ({ origin }) => {
    const cookies = await openShare(origin, first.tokenId);
    const put = key => fetch(`${origin}/api/state/state-rate/${key}`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Cookie: cookies }),
      body: JSON.stringify({ value: true }),
    });
    assert.equal((await put('one')).status, 200);
    const tokenLimited = await put('two');
    assert.equal(tokenLimited.status, 429);

    // Delete has its own bucket; exhausting state:set must not drain it.
    assert.equal((await fetch(`${origin}/api/state/state-rate/one`, {
      method: 'DELETE', headers: { Origin: origin, Cookie: cookies },
    })).status, 200);

  }, { state });

  resetShareWriteQuota();
  const ipState = { ...state, shareWriteRateLimit: { windowMs: 60_000, max: 100, ipMax: 1 } };
  await withServer(authConfig(), async ({ origin }) => {
    const firstCookies = await openShare(origin, first.tokenId);
    const secondCookies = await openShare(origin, second.tokenId);
    const put = (key, cookies) => fetch(`${origin}/api/state/state-rate/${key}`, {
      method: 'PUT',
      headers: sameOriginHeaders(origin, { Cookie: cookies }),
      body: JSON.stringify({ value: true }),
    });
    assert.equal((await put('ip-one', firstCookies)).status, 200);
    assert.equal((await put('ip-two', secondCookies)).status, 429, 'a second token from the same IP hits the IP ceiling');
  }, { state: ipState });
});

test('state mutation audit covers success, rate limit, CSRF, invalid input, unknown page and idempotent delete', async () => {
  resetShareWriteQuota();
  await registerStatePage('state-audit');
  const share = createShare('state-audit', '24h');
  const state = {
    maxKeysPerPage: 50,
    maxPageBytes: 1024 * 1024,
    shareWriteRateLimit: { windowMs: 60_000, max: 1, ipMax: 100 },
  };

  await withServer(authConfig(), async ({ origin }) => {
    const cookies = await openShare(origin, share.tokenId);
    const audits = await captureStateAuditLines(async () => {
      const put = (key, headers = sameOriginHeaders(origin, { Cookie: cookies })) =>
        fetch(`${origin}/api/state/state-audit/${key}`, {
          method: 'PUT', headers, body: JSON.stringify({ value: true }),
        });
      assert.equal((await put('ok')).status, 200);
      assert.equal((await put('limited')).status, 429);
      assert.equal((await put('csrf', { Cookie: cookies, 'Content-Type': 'application/json' })).status, 403);
      resetShareWriteQuota();
      assert.equal((await fetch(`${origin}/api/state/state-audit/invalid-json`, {
        method: 'PUT',
        headers: sameOriginHeaders(origin, { Cookie: cookies }),
        body: '{',
      })).status, 400);
      assert.equal((await fetch(`${origin}/api/state/state-audit/bad$key`, {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookies },
      })).status, 400);
      // Invalid requests are deliberately charged, so clear the in-memory
      // seam before exercising the distinct idempotent-success outcome.
      resetShareWriteQuota();
      assert.equal((await fetch(`${origin}/api/state/state-audit/missing`, {
        method: 'DELETE', headers: { Origin: origin, Cookie: cookies },
      })).status, 200);
    });

    const allowed = audits.find(line => line.action === 'set' && line.result === 'allowed');
    assert.equal(allowed.tokenId, share.tokenId);
    assert.equal(allowed.artifact, 'state-audit');
    assert.equal(allowed.key, 'ok');
    assert.ok(allowed.pageId);
    assert.ok(allowed.ip);
    assert.ok(audits.some(line => line.reason === 'rate_limited' && line.dimension === 'token'));
    assert.ok(audits.some(line => line.reason === 'csrf'));
    assert.ok(audits.some(line => line.reason === 'invalid_json'));
    assert.ok(audits.some(line => line.reason === 'invalid_params'));
    assert.ok(audits.some(line => line.reason === 'already_absent' && line.status === 200));
    assert.equal(audits.some(line => JSON.stringify(line).includes('__Secure-')), false);
  }, { state });

  await withServer({ enabled: false, password: null }, async ({ origin }) => {
    const audits = await captureStateAuditLines(async () => {
      assert.equal((await fetch(`${origin}/api/state/not-registered/key`, {
        method: 'DELETE', headers: { Origin: origin },
      })).status, 404);
    });
    assert.ok(audits.some(line => line.reason === 'unknown_page' && line.status === 404));
  });
});
