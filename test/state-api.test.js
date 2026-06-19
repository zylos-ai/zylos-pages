import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { setupStateApi, RAW_BODY_LIMIT_BYTES, VALUE_JSON_LIMIT_BYTES } = await import('../src/routes/state-api.js');
const {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  setStateValue,
} = await import('../src/state/state-store.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function withServer(authConfig, fn) {
  const app = express();
  setupAuth(app, authConfig || { enabled: false, password: null });
  setupStateApi(app);
  app.get('/', (_req, res) => res.send('root'));

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

test('state API auth wall redirects unauthenticated and share-token API requests', async () => {
  await withServer(authConfig(), async ({ origin }) => {
    let res = await fetch(`${origin}/api/state/auth-wall`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?/);

    res = await fetch(`${origin}/api/state/auth-wall?token=not-used-on-api`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?/);

    const cookie = await login(origin);
    res = await fetch(`${origin}/api/state/auth-wall`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
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
