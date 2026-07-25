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

// Streaming moved the "source file is gone" failure from before the response
// to during it: a read stream reports ENOENT asynchronously, after the handler
// has already returned. If the error were handled only once bytes are flowing,
// a page whose file was deleted would hang or return a 200 with an empty body
// instead of a 404. Registration and disk state are deliberately desynchronised
// here, which is exactly the state this route has to survive.
test('raw API still 404s when the registered source file no longer exists on disk', async () => {
  await withServer(null, async ({ baseUrl, contentDir, config }) => {
    const sourcePath = path.join(contentDir, 'vanishing.md');
    await writeFile(sourcePath, '# Vanishing\n');
    registerLogicalPage({ uri: 'vanishing', title: 'Vanishing', sourcePath, component: 'content' }, config);

    // Guard: the route must be reachable and serving before the file is
    // removed, otherwise the 404 below could come from a broken registration
    // rather than from the missing file.
    const before = await fetch(`${baseUrl}/api/raw/vanishing`);
    assert.equal(before.status, 200, 'the page must serve while its file exists');

    await rm(sourcePath, { force: true });

    const after = await fetch(`${baseUrl}/api/raw/vanishing`);
    assert.equal(after.status, 404, 'a registered page with no file must 404, not hang or return an empty 200');
    assert.deepEqual(await after.json(), { error: 'Page not found' });
  });
});

// A streamed body arrives in chunks, so anything that reassembles it wrongly —
// a chunk boundary landing inside a multi-byte character, an early end, a
// dropped final chunk — corrupts the document while still returning 200. A
// small fixture cannot show this because it fits in a single chunk; this one is
// deliberately larger than the 64 KiB default highWaterMark and is checked for
// byte-exactness rather than for a substring.
test('raw API returns a multi-chunk source byte-exact, including multi-byte characters', async () => {
  await withServer(null, async ({ baseUrl, contentDir, config }) => {
    const line = '中文与 emoji 🌊 混排，用来把多字节字符压到分块边界上。\n';
    const markdown = `# Large\n\n${line.repeat(4000)}`;
    assert.ok(Buffer.byteLength(markdown) > 256 * 1024, 'fixture must span several stream chunks');

    const sourcePath = path.join(contentDir, 'large.md');
    await writeFile(sourcePath, markdown);
    registerLogicalPage({ uri: 'large', title: 'Large', sourcePath, component: 'content' }, config);

    const res = await fetch(`${baseUrl}/api/raw/large`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(Buffer.byteLength(body), Buffer.byteLength(markdown), 'byte length must match exactly');
    assert.equal(body, markdown);
  });
});
