import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { hashPassword, setupAuth } from '../src/security/auth.js';

function makeServer() {
  const app = express();
  setupAuth(app, {
    enabled: true,
    password: hashPassword('secret'),
  });
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
