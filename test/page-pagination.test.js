import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-pagination-'));
process.env.PAGES_DATA_DIR = dataDir;
const express = (await import('express')).default;
const { getPagesDb, closePagesDb } = await import('../src/db/pages-db.js');
const { initPageStore, listPageChildren, pageFolderExists } = await import('../src/pages/page-store.js');
const { setupPageApi } = await import('../src/routes/page-api.js');
initPageStore();
const db = getPagesDb();
const insert = db.prepare(`INSERT INTO logical_pages
  (page_id, uri, title, source_path, source_ext, page_type, created_at, updated_at)
  VALUES (?, ?, ?, '/isolated/source.md', '.md', 'markdown', 1, 1)`);
const seed = (uri, title = uri) => insert.run(uri, uri, title);
db.transaction(() => {
  seed('aaa/deep/one'); seed('aaa/two'); seed('bbb/one'); seed('root');
  seed('literal%_/nested/one', '100% _ \\ literal'); seed('literalAB/nested/one');
  seed('unicode/你好', 'Unicode');
  seed('api/registered'); seed('root/download');
  for (let i = 0; i < 225; i++) seed(`bulk/page-${String(i).padStart(3, '0')}`, `Match ${i}`);
})();
const total = 234;
test.after(() => { closePagesDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('SQL batches combine direct folders and pages, with descendant counts and stable boundaries', () => {
  const first = listPageChildren({ limit: 2 });
  assert.equal(first.total, total);
  assert.equal(first.folderTotal, total);
  assert.equal(first.matchedTotal, 9);
  assert.deepEqual(first.items, [
    { kind: 'folder', path: 'aaa', name: 'aaa', count: 2 },
    { kind: 'folder', path: 'api', name: 'api', count: 1 },
  ]);
  assert.equal(first.nextOffset, 2);
  const all = [];
  let offset = 0;
  do {
    const batch = listPageChildren({ folder: 'bulk', limit: 100, offset });
    assert.equal(batch.matchedTotal, 225);
    assert.equal(batch.total, total);
    assert.ok(batch.items.length <= 100);
    all.push(...batch.items.map(item => item.uri));
    offset = batch.nextOffset;
  } while (offset !== null);
  assert.equal(all.length, 225);
  assert.equal(new Set(all).size, 225);
  assert.equal(all[224], 'bulk/page-224');
  const nested = listPageChildren({ folder: 'aaa' });
  assert.equal(nested.matchedTotal, 2);
  assert.equal(nested.folderTotal, 2);
  assert.equal(nested.items[0].path, 'aaa/deep');
  assert.equal(nested.items[1].uri, 'aaa/two');
  assert.deepEqual(listPageChildren({ folder: 'missing' }).items, []);
  assert.equal(listPageChildren({ folder: 'bulk', offset: 999 }).nextOffset, null);
});

test('folder and search patterns escape wildcard and backslash characters literally', () => {
  assert.equal(listPageChildren({ folder: 'literal%_' }).items[0].count, 1);
  assert.equal(pageFolderExists('literal%_'), true);
  assert.equal(pageFolderExists('literal%'), false);
  assert.equal(pageFolderExists('bbb/one'), false);
  assert.equal(pageFolderExists(''), true);
  for (const query of ['%', '_', '\\', '100% _ \\']) {
    const result = listPageChildren({ query });
    assert.equal(result.matchedTotal, 1);
    assert.equal(result.items[0].uri, 'literal%_/nested/one');
  }
  const search = listPageChildren({ folder: 'missing', query: 'Match', offset: 100, limit: 100 });
  assert.equal(search.total, total);
  assert.equal(search.matchedTotal, 225);
  assert.equal(search.items.length, 100);
  assert.equal(search.nextOffset, 200);
});

async function serve(t, identity = { authenticated: true, viewerType: 'auth' }) {
  const app = express();
  if (identity) app.use((req, res, next) => { Object.assign(res.locals, identity); next(); });
  setupPageApi(app, {});
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (params, headers = {}) => fetch(`${origin}/api/pages?${new URLSearchParams(params)}`, { headers });
}

test('API pagination returns mapped pages and preserves legacy response shapes and cap', async t => {
  const get = await serve(t);
  const batch = await (await get({ folder: 'bulk', offset: '200', limit: '100' })).json();
  assert.equal(batch.ok, true);
  assert.equal(batch.items.length, 25);
  assert.equal(batch.items[0].url, '/p/bulk/page-200');
  assert.equal(batch.total, total);
  assert.equal(batch.folderTotal, 225);
  assert.equal(batch.matchedTotal, 225);
  assert.equal(batch.nextOffset, null);
  assert.equal((await (await get({})).json()).pages.length, total);
  assert.equal((await (await get({ q: 'Match' })).json()).pages.length, 100);
  assert.equal((await (await get({ q: 'Match', limit: '100' })).json()).matchedTotal, 225);
  assert.deepEqual(await (await get({ folderExists: 'aaa/deep' })).json(), { ok: true, exists: true });
});

test('new API modes reject anonymous and share viewers even without middleware', async t => {
  for (const identity of [null, { authenticated: false }, { authenticated: true, viewerType: 'share' }]) {
    const get = await serve(t, identity);
    for (const params of [{ folder: '' }, { limit: '50' }, { offset: '0' }, { folderExists: 'aaa' }, { viewPath: '/p/root' }]) {
      assert.equal((await get(params)).status, 403);
    }
  }
});

test('invalid pagination and folders return friendly 400s', async t => {
  const get = await serve(t);
  for (const params of [
    { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '-1' }, { offset: '-1' },
    { offset: '9007199254740992' }, { offset: 'abc' }, { folder: '/aaa' }, { folder: 'aaa/' },
    { folder: 'aaa//deep' }, { folder: '.' }, { folder: 'aaa/../bbb' }, { folder: 'aaa\\deep' },
    { folderExists: '../aaa' },
  ]) {
    const response = await get(params);
    assert.equal(response.status, 400, JSON.stringify(params));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  for (const suffix of ['folder=a&folder=b', 'limit=1&limit=2', 'q[x]=bad&limit=1']) {
    // Express's extended query parser also rejects structured values.
    const app = express();
    app.use((req, res, next) => { res.locals.authenticated = true; next(); });
    setupPageApi(app, {});
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/pages?${suffix}`)).status, 400);
  }
});

test('owner viewPath resolves only exact registered canonical or legacy paths under browser prefix', async t => {
  const get = await serve(t);
  for (const prefix of ['', '/pages']) {
    const headers = prefix ? { 'X-Forwarded-Prefix': prefix } : {};
    for (const pathname of ['/p/root', '/root', '/p/unicode/%E4%BD%A0%E5%A5%BD', '/root/download', '/p/root/download', '/api/registered']) {
      assert.deepEqual(await (await get({ viewPath: prefix + pathname }, headers)).json(), { ok: true, allowed: true });
    }
    for (const pathname of ['/p/missing', '/api/pages', '/p/missing/download', '/p/root.md', '/p/root?x=1', '/p/root#x', '//host/p/root', '/p/ROOT', '/p/aaa/../root']) {
      assert.equal((await (await get({ viewPath: prefix + pathname }, headers)).json()).allowed, false, pathname);
    }
    if (prefix) assert.equal((await (await get({ viewPath: '/p/root' }, headers)).json()).allowed, false);
  }
});


test('real auth middleware refuses anonymous list browsing and accepts owner sessions', async t => {
  const { setupAuth, hashPassword } = await import('../src/security/auth.js');
  const app = express();
  setupAuth(app, { password: hashPassword('isolated-secret') });
  setupPageApi(app, {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/pages?folder=bulk`;
  const anonymous = await fetch(url, { redirect: 'manual' });
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.headers.get('location'), null);
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=isolated-secret' });
  assert.equal(login.status, 302);
  const session = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_pages_session='));
  assert.ok(session);
  const owner = await fetch(url, { headers: { Cookie: session.split(';')[0] } });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).items.length, 50);
});


test('recent-first folder/search batches retain every page across tied timestamps', async t => {
  const update = db.prepare('UPDATE logical_pages SET updated_at = ? WHERE uri = ?');
  const fixture = Array.from({ length: 225 }, (_, i) => ({
    uri: `bulk/page-${String(i).padStart(3, '0')}`, title: `Match ${i}`, updatedAt: 1000 + i % 7,
  }));
  db.transaction(() => {
    // Insert in reverse URI order so timestamp ties cannot pass by insertion order.
    db.prepare("DELETE FROM logical_pages WHERE uri LIKE 'bulk/%'").run();
    for (const page of fixture.slice().reverse()) seed(page.uri, page.title);
    for (const page of fixture) update.run(page.updatedAt, page.uri);
    update.run(20000, 'root');
  })();
  try {
    const expected = fixture.slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.uri < b.uri ? -1 : 1));
    assert.deepEqual(expected.slice(0, 3).map(page => page.uri), ['bulk/page-006', 'bulk/page-013', 'bulk/page-020']);
    for (const scope of [{ folder: 'bulk' }, { query: 'Match' }]) {
      const seen = [];
      let offset = 0;
      do {
        const batch = listPageChildren({ ...scope, offset, limit: 17 });
        assert.equal(batch.matchedTotal, 225);
        seen.push(...batch.items.map(page => page.uri));
        offset = batch.nextOffset;
      } while (offset !== null);
      assert.equal(seen.length, 225);
      assert.equal(new Set(seen).size, 225);
      assert.deepEqual(seen, expected.map(page => page.uri));
    }
    const root = listPageChildren({ limit: 100 }).items;
    assert.equal(root.at(-1).uri, 'root', 'even the newest root page follows folders');
    const folders = root.slice(0, -1);
    assert.ok(folders.every(item => item.kind === 'folder'));
    assert.deepEqual(folders.map(item => item.path), folders.map(item => item.path).sort());
    const get = await serve(t);
    for (const scope of [{ folder: 'bulk' }, { q: 'Match' }]) {
      const body = await (await get({ ...scope, limit: '2' })).json();
      assert.deepEqual(body.items.map(page => page.uri), expected.slice(0, 2).map(page => page.uri));
      assert.equal(body.nextOffset, 2);
    }
  } finally {
    db.prepare('UPDATE logical_pages SET updated_at = 1').run();
  }
});
