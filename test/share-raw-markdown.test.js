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

test('auth middleware admits /s/:tokenId.md without a session, and nothing else new', async () => {
  const { server } = await makeServer({ auth: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const share = createShare('p/docs/shared', '24h', { allowPermanent: false });
  try {
    const allowed = await fetch(`${origin}/s/${share.tokenId}.md`, { redirect: 'manual' });
    assert.equal(allowed.status, 200, 'the token-scoped raw route should not require login');

    // Negative control for the line above: the allowlist must be an extension
    // of the share-token rule, not a wider hole. A path that no share token
    // can name has to stay behind auth, otherwise a 200 on the .md route
    // would prove nothing about how narrow the allowlist is.
    const gated = await fetch(`${origin}/docs/shared`, { redirect: 'manual' });
    assert.equal(gated.status, 302, 'an ordinary page must still redirect to login');

    // The public llms.txt indexes were deliberately not adopted: a share token
    // is an unguessable capability, and a public index would turn the whole
    // set of them into a directory. Pinned so re-adding one is a test failure,
    // not a silent change of exposure.
    for (const requestPath of ['/llms.txt', '/llms-full.txt']) {
      const response = await fetch(`${origin}${requestPath}`, { redirect: 'manual' });
      assert.notEqual(response.status, 200, `${requestPath} must not be publicly served`);
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

// The alternate link is baked into the cached render pointing at /api/raw,
// which share viewers are forbidden from using, and is rewritten to the
// token-scoped route only on the share path. A rewrite that silently stops
// matching would leave share viewers holding a link that 403s, and nothing
// else would fail — so both halves are asserted: the token route is present,
// and no /api/raw reference survives.
test('a rendered share view points its markdown alternate at the token route, never /api/raw', async () => {
  const { server } = await makeServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const share = createShare('p/docs/shared', '24h', { allowPermanent: false });
  try {
    const response = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const html = await response.text();

    // Guard: an empty or error body would satisfy "does not contain /api/raw"
    // no matter what the rewrite did.
    assert.ok(html.includes('rel="alternate"'), 'the share render should carry an alternate declaration');

    assert.ok(
      html.includes(`/s/${share.tokenId}.md`),
      'the alternate should point at the token-scoped raw route',
    );
    assert.ok(
      !html.includes('/api/raw/'),
      'no /api/raw reference may survive into a share view',
    );
  } finally {
    revokeShare(share.tokenId);
    server.close();
  }
});
