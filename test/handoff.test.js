import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { HandoffStore, HANDOFF_MAX_VALUE_BYTES } from '../src/handoff/handoff-store.js';
import { HANDOFF_BODY_LIMIT_BYTES, setupHandoffRoutes } from '../src/routes/handoff.js';

function csrfFrom(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, 'form must include a CSRF token');
  return match[1];
}

async function withServer(store, fn, config = {}) {
  const app = express();
  setupHandoffRoutes(app, config, store);
  const server = await new Promise(resolve => {
    const value = http.createServer(app);
    value.listen(0, '127.0.0.1', () => resolve(value));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await fn(origin); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function form(origin, id) {
  const response = await fetch(`${origin}/handoff/${id}`);
  return { response, html: await response.text() };
}

async function submit(origin, id, csrf, value, headers = {}) {
  return fetch(`${origin}/handoff/${id}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ csrf, value }),
  });
}

test('one-time form submits and await atomically consumes without reflecting the value', async () => {
  const store = new HandoffStore();
  const created = store.create({ label: '<API token>' });
  await withServer(store, async origin => {
    const opened = await form(origin, created.id);
    assert.equal(opened.response.status, 200);
    assert.match(opened.response.headers.get('cache-control'), /no-store/);
    assert.match(opened.html, /&lt;API token&gt;/);
    assert.doesNotMatch(opened.html, /<API token>/);
    const csrf = csrfFrom(opened.html);
    const waiting = store.awaitAndConsume(created.id, created.manageToken);
    const secret = 'correct horse battery staple';
    const response = await submit(origin, created.id, csrf, secret);
    const resultHtml = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(resultHtml, new RegExp(secret));
    assert.equal(await waiting, secret);
    assert.equal(store.status(created.id, created.manageToken).state, 'consumed');
    assert.equal((await form(origin, created.id)).response.status, 404);
  });
});

test('exactly one concurrent submission and consumption can succeed', async () => {
  const store = new HandoffStore();
  const created = store.create();
  const csrf = store.formCsrfToken(created.id);
  const submitted = await Promise.allSettled([
    Promise.resolve().then(() => store.submit(created.id, csrf, 'first')),
    Promise.resolve().then(() => store.submit(created.id, csrf, 'second')),
  ]);
  assert.equal(submitted.filter(result => result.status === 'fulfilled').length, 1);
  const consumed = await Promise.allSettled([
    Promise.resolve().then(() => store.consume(created.id, created.manageToken)),
    Promise.resolve().then(() => store.consume(created.id, created.manageToken)),
  ]);
  assert.equal(consumed.filter(result => result.status === 'fulfilled').length, 1);
});

test('POST rejects missing/cross-origin proof, wrong CSRF, media type, empty and oversized values', async () => {
  for (const scenario of [
    { expected: 403, headers: { Origin: '' } },
    { expected: 403, headers: { Origin: 'https://evil.example' } },
    { expected: 403, csrf: 'wrong' },
    { expected: 415, headers: { 'Content-Type': 'application/json' } },
    { expected: 400, value: '' },
    { expected: 413, value: 'x'.repeat(HANDOFF_MAX_VALUE_BYTES + 1) },
  ]) {
    const store = new HandoffStore();
    const created = store.create();
    await withServer(store, async origin => {
      const csrf = scenario.csrf ?? csrfFrom((await form(origin, created.id)).html);
      const response = await submit(origin, created.id, csrf, scenario.value ?? 'secret', scenario.headers);
      assert.equal(response.status, scenario.expected);
      assert.equal(store.status(created.id, created.manageToken).state, 'waiting');
    });
  }
});

test('raw request body limit rejects before retaining a value', async () => {
  const store = new HandoffStore();
  const created = store.create();
  await withServer(store, async origin => {
    const response = await fetch(`${origin}/handoff/${created.id}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'x'.repeat(HANDOFF_BODY_LIMIT_BYTES + 1),
    });
    assert.equal(response.status, 413);
    assert.equal(store.status(created.id, created.manageToken).state, 'waiting');
  });
});

test('per-session per-IP submission rate limit returns Retry-After', async () => {
  const store = new HandoffStore();
  const created = store.create();
  await withServer(store, async origin => {
    const csrf = csrfFrom((await form(origin, created.id)).html);
    const first = await submit(origin, created.id, 'wrong', 'secret');
    assert.equal(first.status, 403);
    const limited = await submit(origin, created.id, csrf, 'secret');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  }, { rateLimit: { windowMs: 60_000, max: 1 } });
});

test('expiry and revoke scrub values, reject waiters, and cleanup is idempotent', async () => {
  let now = 1_000_000;
  const store = new HandoffStore({ now: () => now });
  const expiring = store.create({ ttlMs: 60_000 });
  const waiting = store.awaitAndConsume(expiring.id, expiring.manageToken);
  now += 60_000;
  assert.equal(store.status(expiring.id, expiring.manageToken).state, 'expired');
  await assert.rejects(waiting, { code: 'expired' });

  const revoked = store.create();
  store.submit(revoked.id, store.formCsrfToken(revoked.id), 'must disappear');
  assert.equal(store.revoke(revoked.id, revoked.manageToken), true);
  assert.equal(store.revoke(revoked.id, revoked.manageToken), false);
  assert.equal(store.status(revoked.id, revoked.manageToken).state, 'revoked');
  assert.equal(store.cleanup(), 2);
  assert.equal(store.cleanup(), 0);
  assert.throws(() => store.status(revoked.id, revoked.manageToken), { code: 'not_found' });
});

test('a new store after restart cannot revive an old handoff', () => {
  const beforeRestart = new HandoffStore();
  const created = beforeRestart.create();
  beforeRestart.submit(created.id, beforeRestart.formCsrfToken(created.id), 'ephemeral');
  const afterRestart = new HandoffStore();
  assert.equal(afterRestart.publicView(created.id), null);
  assert.throws(() => afterRestart.consume(created.id, created.manageToken), { code: 'not_found' });
});

test('labels are display text only and cannot add execution or callback surfaces', () => {
  const store = new HandoffStore();
  const created = store.create({ label: 'Run /tmp/x; callback=https://evil.example' });
  const status = store.status(created.id, created.manageToken);
  assert.deepEqual(Object.keys(status).sort(), ['consumedAt', 'createdAt', 'expiresAt', 'id', 'revokedAt', 'state', 'submittedAt']);
});
