import assert from 'node:assert/strict';
import test from 'node:test';

const { consumeShareWriteQuota, resetShareWriteQuota, DEFAULT_SHARE_WRITE_LIMIT } =
  await import('../src/security/share-write-limit.js');

const LIMIT = { windowMs: 60_000, max: 2, ipMax: 3 };

test.beforeEach(() => resetShareWriteQuota());

test('a token is rationed per operation, and the two operations do not share a budget', () => {
  const now = 1_000;
  assert.equal(consumeShareWriteQuota('tok', 'upload', LIMIT, null, now).allowed, true);
  assert.equal(consumeShareWriteQuota('tok', 'upload', LIMIT, null, now).allowed, true);

  const exhausted = consumeShareWriteQuota('tok', 'upload', LIMIT, null, now);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.dimension, 'token');

  // Deletes must still be possible after uploads are spent — otherwise a burst
  // of uploads would strand the very files it just created.
  assert.equal(consumeShareWriteQuota('tok', 'delete', LIMIT, null, now).allowed, true);
});

test('separate tokens do not consume each other budgets', () => {
  const now = 1_000;
  consumeShareWriteQuota('a', 'upload', LIMIT, null, now);
  consumeShareWriteQuota('a', 'upload', LIMIT, null, now);
  assert.equal(consumeShareWriteQuota('a', 'upload', LIMIT, null, now).allowed, false);
  assert.equal(consumeShareWriteQuota('b', 'upload', LIMIT, null, now).allowed, true);
});

test('the IP dimension catches a burst spread across several tokens', () => {
  const now = 1_000;
  // Each token is well inside its own allowance; only the shared source is not.
  assert.equal(consumeShareWriteQuota('t1', 'upload', LIMIT, '203.0.113.7', now).allowed, true);
  assert.equal(consumeShareWriteQuota('t2', 'upload', LIMIT, '203.0.113.7', now).allowed, true);
  assert.equal(consumeShareWriteQuota('t3', 'upload', LIMIT, '203.0.113.7', now).allowed, true);

  const limited = consumeShareWriteQuota('t4', 'upload', LIMIT, '203.0.113.7', now);
  assert.equal(limited.allowed, false);
  assert.equal(limited.dimension, 'ip');

  // A different source is unaffected — the IP bucket must not be a global cap.
  assert.equal(consumeShareWriteQuota('t5', 'upload', LIMIT, '198.51.100.2', now).allowed, true);
});

test('an exhausted token still charges the IP bucket, so it cannot be used as a shield', () => {
  const now = 1_000;
  for (let i = 0; i < 4; i += 1) {
    consumeShareWriteQuota('noisy', 'upload', LIMIT, '203.0.113.9', now);
  }
  // 'noisy' burned 4 attempts; ipMax is 3, so a fresh token from the same
  // source must already be over the IP ceiling.
  const next = consumeShareWriteQuota('fresh', 'upload', LIMIT, '203.0.113.9', now);
  assert.equal(next.allowed, false);
  assert.equal(next.dimension, 'ip');
});

test('the window expires and the budget returns', () => {
  const start = 1_000;
  consumeShareWriteQuota('tok', 'upload', LIMIT, null, start);
  consumeShareWriteQuota('tok', 'upload', LIMIT, null, start);
  assert.equal(consumeShareWriteQuota('tok', 'upload', LIMIT, null, start).allowed, false);

  const afterWindow = start + LIMIT.windowMs + 1;
  const revived = consumeShareWriteQuota('tok', 'upload', LIMIT, null, afterWindow);
  assert.equal(revived.allowed, true);
  assert.equal(revived.remaining, LIMIT.max - 1);
});

test('retryAfterSeconds is a usable positive number', () => {
  const now = 1_000;
  consumeShareWriteQuota('tok', 'upload', LIMIT, null, now);
  consumeShareWriteQuota('tok', 'upload', LIMIT, null, now);
  const denied = consumeShareWriteQuota('tok', 'upload', LIMIT, null, now + 30_000);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60);
});

test('a malformed limit falls back to the shipped defaults rather than to no limit', () => {
  const now = 1_000;
  const broken = { windowMs: -5, max: 'lots', ipMax: null };
  for (let i = 0; i < DEFAULT_SHARE_WRITE_LIMIT.max; i += 1) {
    assert.equal(consumeShareWriteQuota('tok', 'upload', broken, null, now).allowed, true);
  }
  assert.equal(consumeShareWriteQuota('tok', 'upload', broken, null, now).allowed, false);
});
