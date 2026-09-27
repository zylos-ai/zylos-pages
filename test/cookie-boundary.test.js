import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
  filterPagesCookieHeader,
  pagesCookieHeader,
  setupCookieBoundary,
} from '../src/security/cookie-boundary.js';

test('cookie boundary retains only recognized Pages cookies', () => {
  const shareName = `__Secure-share_access.${'a'.repeat(32)}`;
  assert.equal(filterPagesCookieHeader([
    'dashboard_session=dashboard-secret',
    'wc_session=console-secret',
    '__Secure-zylos_pages_session=owner-secret',
    '__Secure-share_access=legacy-share',
    `${shareName}=named-share`,
    `__Secure-share_access.${'g'.repeat(32)}=lookalike`,
    '__Secure-share_access.extra=lookalike',
  ].join('; ')), [
    '__Secure-zylos_pages_session=owner-secret',
    '__Secure-share_access=legacy-share',
    `${shareName}=named-share`,
  ].join('; '));
});

test('cookie boundary preserves recognized duplicates for fail-closed validation', () => {
  const name = `__Secure-share_access.${'b'.repeat(32)}`;
  assert.equal(
    filterPagesCookieHeader(`${name}=first; unrelated=value; ${name}=second`),
    `${name}=first; ${name}=second`,
  );
});

test('cookie boundary removes Cookie from normal and raw request headers', async () => {
  const app = express();
  setupCookieBoundary(app);
  setupCookieBoundary(app);
  app.get('/inspect', (req, res) => {
    res.json({
      cookieHeader: req.headers.cookie ?? null,
      rawCookieHeader: req.rawHeaders.some((value, index) =>
        index % 2 === 0 && String(value).toLowerCase() === 'cookie'),
      pagesCookieHeader: pagesCookieHeader(req),
    });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/inspect`, {
      headers: {
        Cookie: 'wc_session=console-secret; __Secure-zylos_pages_session=owner-secret',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      cookieHeader: null,
      rawCookieHeader: false,
      pagesCookieHeader: '__Secure-zylos_pages_session=owner-secret',
    });
  } finally {
    server.close();
  }
});
