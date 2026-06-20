import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createRateLimiter } from '../src/security/rateLimit.js';

async function withServer(fn) {
  const app = express();
  app.set('trust proxy', ['loopback', '100.64.0.23']);
  app.use(createRateLimiter({
    windowMs: 60_000,
    max: 1,
    message: { error: 'limited' },
  }));
  app.get('/probe', (req, res) => {
    res.json({ ip: req.ip });
  });

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('rate limiter keys requests by forwarded client IP from trusted proxy chain', async () => {
  await withServer(async (baseUrl) => {
    const firstClient = await fetch(`${baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '203.0.113.10, 100.64.0.23' },
    });
    assert.equal(firstClient.status, 200);
    assert.equal((await firstClient.json()).ip, '203.0.113.10');

    const secondClient = await fetch(`${baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '203.0.113.11, 100.64.0.23' },
    });
    assert.equal(secondClient.status, 200);
    assert.equal((await secondClient.json()).ip, '203.0.113.11');

    const firstClientAgain = await fetch(`${baseUrl}/probe`, {
      headers: { 'X-Forwarded-For': '203.0.113.10, 100.64.0.23' },
    });
    assert.equal(firstClientAgain.status, 429);
  });
});
