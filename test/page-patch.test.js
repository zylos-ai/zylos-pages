import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-patch-test-'));
process.env.PAGES_DATA_DIR = tmpDir;

const express = (await import('express')).default;
const { setupPageApi } = await import('../src/routes/page-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { getLogicalPage, getLogicalPageById, registerLogicalPage } = await import('../src/pages/page-store.js');
const { getActiveShare, listSharesForSlug } = await import('../src/sharing/share-manager.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeServer() {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-patch-content-'));
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  setupShareApi(app, { enabled: true, allowPermanent: false }, config);
  setupPageApi(app, config);

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, contentDir, config });
    });
  });
}

function registerPage(config, contentDir, uri, title) {
  const sourcePath = path.join(contentDir, `${uri.replace(/\//g, '-')}.md`);
  fs.writeFileSync(sourcePath, `# ${title}\n`);
  return registerLogicalPage({ uri, title, sourcePath, component: 'content' }, config);
}

function patchPage(origin, pageId, body) {
  return fetch(`${origin}/api/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Forwarded-Proto': 'http',
    },
    body: JSON.stringify(body),
  });
}

test('PATCH renames title without touching uri', async () => {
  const { server, origin, contentDir, config } = await makeServer();
  try {
    const page = registerPage(config, contentDir, 'docs/rename-me', 'Old Title');
    const response = await patchPage(origin, page.pageId, { title: 'New Title' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.page.pageId, page.pageId);
    assert.equal(body.page.title, 'New Title');
    assert.equal(body.page.uri, 'docs/rename-me');
    assert.equal(body.page.url, '/p/docs/rename-me');
    assert.equal(getLogicalPage('docs/rename-me').title, 'New Title');
  } finally {
    server.close();
  }
});

test('PATCH moves uri and the old uri stops resolving', async () => {
  const { server, origin, contentDir, config } = await makeServer();
  try {
    const page = registerPage(config, contentDir, 'inbox/move-me', 'Move Me');
    const sourceBefore = getLogicalPageById(page.pageId).sourcePath;
    const response = await patchPage(origin, page.pageId, { uri: 'archive/2026/move-me' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.page.uri, 'archive/2026/move-me');
    assert.equal(getLogicalPage('inbox/move-me'), null);
    const moved = getLogicalPage('archive/2026/move-me');
    assert.equal(moved.pageId, page.pageId);
    // The source file on disk never moves.
    assert.equal(moved.sourcePath, sourceBefore);
    assert.ok(fs.existsSync(sourceBefore));
  } finally {
    server.close();
  }
});

test('PATCH returns 404 for unknown pageId', async () => {
  const { server, origin } = await makeServer();
  try {
    const response = await patchPage(origin, 'no-such-page-id', { title: 'X' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'Page not found');
  } finally {
    server.close();
  }
});

test('PATCH returns 409 when the target uri is taken', async () => {
  const { server, origin, contentDir, config } = await makeServer();
  try {
    registerPage(config, contentDir, 'conflict/existing', 'Existing');
    const page = registerPage(config, contentDir, 'conflict/mover', 'Mover');
    const response = await patchPage(origin, page.pageId, { uri: 'conflict/existing' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'uri_conflict');
    assert.equal(getLogicalPage('conflict/mover').pageId, page.pageId);
  } finally {
    server.close();
  }
});

test('PATCH rejects invalid input', async () => {
  const { server, origin, contentDir, config } = await makeServer();
  try {
    const page = registerPage(config, contentDir, 'invalid/input', 'Invalid Input');

    for (const body of [
      {},
      { title: '' },
      { title: '   ' },
      { title: 42 },
      { uri: '' },
      { uri: '///' },
      { uri: '../escape' },
      { uri: 'a/../b' },
      { uri: 123 },
    ]) {
      const response = await patchPage(origin, page.pageId, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }

    // CSRF: cross-origin PATCH is rejected.
    const crossOrigin = await fetch(`${origin}/api/pages/${page.pageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'Nope' }),
    });
    assert.equal(crossOrigin.status, 403);

    assert.equal(getLogicalPage('invalid/input').title, 'Invalid Input');
  } finally {
    server.close();
  }
});

test('share links survive rename and move; uri access follows the new uri', async () => {
  const { server, origin, contentDir, config } = await makeServer();
  try {
    const page = registerPage(config, contentDir, 'team/weekly-report', 'Weekly Report');

    const create = await fetch(`${origin}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forwarded-Proto': 'http',
      },
      body: JSON.stringify({ slug: 'p/team/weekly-report', duration: '24h' }),
    });
    assert.equal(create.status, 200);
    const share = await create.json();

    // Rename, then move.
    let response = await patchPage(origin, page.pageId, { title: 'Weekly Report (Archived)' });
    assert.equal(response.status, 200);
    response = await patchPage(origin, page.pageId, { uri: 'archive/team/weekly-report' });
    assert.equal(response.status, 200);

    // The short link still resolves and renders at the page's current uri.
    const shared = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(shared.status, 200);
    const body = await shared.text();
    assert.match(body, /<base href="\/p\/archive\/team\/weekly-report">/);
    assert.match(shared.headers.get('set-cookie'), /__Host-share_access=/);

    // The share record follows the page, keyed by page_id.
    const active = getActiveShare(share.tokenId);
    assert.equal(active.pageId, page.pageId);
    assert.equal(active.uri, 'archive/team/weekly-report');
    assert.equal(active.slug, 'p/archive/team/weekly-report');

    // uri-keyed share listing reflects the new uri; the old uri lists nothing.
    assert.deepEqual(listSharesForSlug('archive/team/weekly-report').map(entry => entry.tokenId), [share.tokenId]);
    assert.deepEqual(listSharesForSlug('team/weekly-report'), []);
    const listed = await fetch(`${origin}/api/shares/${encodeURIComponent('p/archive/team/weekly-report')}`, {
      headers: { 'X-Forwarded-Proto': 'http' },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).shares.map(entry => entry.tokenId), [share.tokenId]);
  } finally {
    server.close();
  }
});
