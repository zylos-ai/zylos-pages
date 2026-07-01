import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-raw-data-'));
process.env.PAGES_DATA_DIR = tmpDir;

const { setupRawApi } = await import('../src/routes/raw-api.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');

test.after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function withServer(viewerType, fn) {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-raw-'));
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
  };

  app.use((req, res, next) => {
    if (viewerType) res.locals.viewerType = viewerType;
    next();
  });
  setupRawApi(app, config);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ baseUrl, contentDir, config });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    await rm(contentDir, { recursive: true, force: true });
  }
}

test('raw API returns the original Markdown text', async () => {
  await withServer(null, async ({ baseUrl, contentDir, config }) => {
    const markdown = '---\ntitle: Raw Source\n---\n\n# Raw Source\n\nOriginal **Markdown**.\n';
    const sourcePath = path.join(contentDir, 'raw-source.md');
    await writeFile(sourcePath, markdown);
    registerLogicalPage({ uri: 'raw-source', title: 'Raw Source', sourcePath, component: 'content' }, config);

    const res = await fetch(`${baseUrl}/api/raw/raw-source`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), markdown);
  });
});

test('raw API supports nested Markdown slugs', async () => {
  await withServer(null, async ({ baseUrl, contentDir, config }) => {
    await mkdir(path.join(contentDir, 'docs'), { recursive: true });
    const sourcePath = path.join(contentDir, 'docs', 'guide.md');
    await writeFile(sourcePath, '# Guide\n');
    registerLogicalPage({ uri: 'docs/guide', title: 'Guide', sourcePath, component: 'content' }, config);

    const res = await fetch(`${baseUrl}/api/raw/${encodeURIComponent('docs/guide')}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# Guide\n');
  });
});

test('raw API supports canonical p-prefixed logical page slugs', async () => {
  await withServer(null, async ({ baseUrl, contentDir, config }) => {
    const sourcePath = path.join(contentDir, 'registered.md');
    await writeFile(sourcePath, '# Registered\n');
    registerLogicalPage({ uri: 'docs/registered', title: 'Registered', sourcePath, component: 'content' }, config);

    const res = await fetch(`${baseUrl}/api/raw/${encodeURIComponent('p/docs/registered')}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# Registered\n');
  });
});

test('raw API returns 404 for missing pages', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/raw/missing`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Page not found' });
  });
});

test('raw API rejects traversal slugs', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/raw/%252e%252e/secret`);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid path' });
  });
});

test('raw API is unavailable to share viewers', async () => {
  await withServer('share', async ({ baseUrl, contentDir, config }) => {
    const sourcePath = path.join(contentDir, 'private.md');
    await writeFile(sourcePath, '# Private\n');
    registerLogicalPage({ uri: 'private', title: 'Private', sourcePath, component: 'content' }, config);

    const res = await fetch(`${baseUrl}/api/raw/private`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Share viewers cannot read raw Markdown' });
  });
});
