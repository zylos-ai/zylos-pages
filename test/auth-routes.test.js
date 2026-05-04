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
  }, '/pages');
  app.get('/', (_req, res) => res.send('root'));
  app.get('/pages/', (_req, res) => res.send('base root'));
  app.get('/pages/:slug(*)', (req, res) => res.send(`base page:${req.params.slug || req.params[0]}`));
  app.get('/:slug(*)', (req, res) => res.send(`page:${req.params.slug || req.params[0]}`));

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('base-prefixed login route renders instead of redirecting to itself', async () => {
  const { server, origin } = await makeServer();
  try {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/pages/login?next=%2Fpages%2F');

    const login = await fetch(`${origin}/pages/login?next=%2Fpages%2F`, {
      redirect: 'manual',
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /Zylos Pages/);
    assert.match(body, /action="\/pages\/login"/);

    const directLogin = await fetch(`${origin}/login`, { redirect: 'manual' });
    assert.equal(directLogin.status, 200);
  } finally {
    server.close();
  }
});

test('auth redirect next target supports stripped and unstripped base paths', async () => {
  const { server, origin } = await makeServer();
  try {
    const stripped = await fetch(`${origin}/example`, { redirect: 'manual' });
    assert.equal(stripped.status, 302);
    assert.equal(stripped.headers.get('location'), '/pages/login?next=%2Fpages%2Fexample');

    const unstripped = await fetch(`${origin}/pages/example`, { redirect: 'manual' });
    assert.equal(unstripped.status, 302);
    assert.equal(unstripped.headers.get('location'), '/pages/login?next=%2Fpages%2Fexample');
  } finally {
    server.close();
  }
});
