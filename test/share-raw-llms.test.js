import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-raw-test-'));
process.env.PAGES_DATA_DIR = tmpDir;

const express = (await import('express')).default;
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const { pageTemplate } = await import('../src/templates/pageTemplate.js');

const MD_BODY = '# Shared doc\n\nHello from markdown.\n';

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeServer({ auth = false } = {}) {
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-raw-content-'));
  fs.mkdirSync(path.join(contentDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(contentDir, 'docs', 'shared.md'),
    `---\ntitle: Shared doc\ndescription: A shared markdown document.\n---\n${MD_BODY}`,
  );
  fs.writeFileSync(path.join(contentDir, 'docs', 'unshared.md'), '# Private doc\n');
  fs.writeFileSync(
    path.join(contentDir, 'docs', 'artifact.html'),
    '<!doctype html><head><title>Artifact</title></head><h1>Artifact</h1>',
  );
  const app = express();
  const config = {
    contentDir,
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  for (const [uri, file, title] of [
    ['docs/shared', 'shared.md', 'Shared doc'],
    ['docs/unshared', 'unshared.md', 'Private doc'],
    ['docs/artifact', 'artifact.html', 'Artifact'],
  ]) {
    registerLogicalPage({
      uri,
      title,
      sourcePath: path.join(contentDir, 'docs', file),
      component: 'content',
    }, config);
  }
  if (auth) {
    setupAuth(app, { enabled: true, password: hashPassword('secret') }, { enabled: true });
  }
  setupShareApi(app, { enabled: true, allowPermanent: false }, config);

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, contentDir });
    });
  });
}

test('GET /s/:tokenId.md returns the raw markdown of the shared page', async () => {
  const { server } = await makeServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const share = createShare('p/docs/shared', '24h', { allowPermanent: false });
  try {
    const response = await fetch(`${origin}/s/${share.tokenId}.md`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    const body = await response.text();
    assert.ok(body.includes('Hello from markdown.'));
    assert.ok(body.includes('title: Shared doc'), 'serves the original source including frontmatter');
  } finally {
    revokeShare(share.tokenId);
    server.close();
  }
});

test('GET /s/:tokenId.md rejects unknown, revoked, and non-markdown shares', async () => {
  const { server } = await makeServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mdShare = createShare('p/docs/shared', '24h', { allowPermanent: false });
  const htmlShare = createShare('p/docs/artifact', '24h', { allowPermanent: false });
  try {
    const unknown = await fetch(`${origin}/s/${'0'.repeat(32)}.md`);
    assert.equal(unknown.status, 404);

    const html = await fetch(`${origin}/s/${htmlShare.tokenId}.md`);
    assert.equal(html.status, 404, 'html artifacts have no markdown source');

    revokeShare(mdShare.tokenId);
    const revoked = await fetch(`${origin}/s/${mdShare.tokenId}.md`);
    assert.equal(revoked.status, 404);
  } finally {
    revokeShare(htmlShare.tokenId);
    server.close();
  }
});

test('llms.txt lists only actively shared markdown pages and drops revoked shares', async () => {
  const { server } = await makeServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mdShare = createShare('p/docs/shared', '24h', { allowPermanent: false });
  const htmlShare = createShare('p/docs/artifact', '24h', { allowPermanent: false });
  try {
    let response = await fetch(`${origin}/llms.txt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown/);
    let body = await response.text();
    assert.ok(body.includes(`/s/${mdShare.tokenId}.md`), 'shared markdown page is listed');
    assert.ok(body.includes('A shared markdown document.'), 'frontmatter description is included');
    assert.ok(!body.includes('unshared'), 'registered but unshared page is not exposed');
    assert.ok(!body.includes(htmlShare.tokenId), 'html artifact shares are not listed');

    const full = await (await fetch(`${origin}/llms-full.txt`)).text();
    assert.ok(full.includes('Hello from markdown.'), 'full variant inlines the shared content');
    assert.ok(!full.includes('Private doc'), 'full variant excludes unshared content');

    revokeShare(mdShare.tokenId);
    body = await (await fetch(`${origin}/llms.txt`)).text();
    assert.ok(!body.includes(mdShare.tokenId), 'revoked share disappears from the index');
  } finally {
    revokeShare(htmlShare.tokenId);
    server.close();
  }
});

test('auth middleware allows /s/:tokenId.md and llms indexes without a session', async () => {
  const { server } = await makeServer({ auth: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const share = createShare('p/docs/shared', '24h', { allowPermanent: false });
  try {
    for (const requestPath of [`/s/${share.tokenId}.md`, '/llms.txt', '/llms-full.txt']) {
      const response = await fetch(`${origin}${requestPath}`, { redirect: 'manual' });
      assert.equal(response.status, 200, `${requestPath} should not require login`);
    }
  } finally {
    revokeShare(share.tokenId);
    server.close();
  }
});

test('pageTemplate declares a text/markdown alternate pointing at the raw API', () => {
  const html = pageTemplate({
    title: 'Doc',
    description: '',
    date: null,
    tags: [],
    bodyHtml: '<p>hi</p>',
    tocItems: [],
    baseUrl: '/pages',
    slug: 'p/docs/shared',
  });
  assert.ok(html.includes(
    '<link rel="alternate" type="text/markdown" href="/pages/api/raw/p/docs/shared" title="Markdown version">',
  ));
});
