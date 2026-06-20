import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-html-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache } = await import('../src/cache/pageCache.js');
const { getPage } = await import('../src/services/pageService.js');
const { indexRoute, scanPages } = await import('../src/routes/index.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { DEFAULT_CSP, HTML_ARTIFACT_CSP, securityHeaders } = await import('../src/security/headers.js');
const { resolvePageDescriptor, resolveSafePath } = await import('../src/security/pathGuard.js');
const { createShare } = await import('../src/sharing/share-manager.js');
const { normalizeSlug } = await import('../src/utils/slug.js');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function baseConfig(contentDir) {
  return {
    contentDir,
    security: {
      allowRawHtml: false,
      maxFileSizeBytes: 1048576,
      renderTimeoutMs: 5000,
    },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
    auth: { enabled: false, password: null },
  };
}

async function makeContentDir() {
  return mkdtemp(path.join(os.tmpdir(), 'zylos-pages-html-content-'));
}

async function withServer(config, fn) {
  initCache({ maxEntries: 50, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  setupAuth(app, config.auth || { enabled: false, password: null });
  setupRawApi(app, config);
  app.get('/', indexRoute(config));
  app.get('/:slug(*)', pageRoute(config));

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ origin });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

test('normalizeSlug strips html and markdown extensions', () => {
  assert.equal(normalizeSlug('/foo.html'), 'foo');
  assert.equal(normalizeSlug('/foo.md'), 'foo');
  assert.equal(normalizeSlug('/foo'), 'foo');
});

test('resolvePageDescriptor selects html priority and preserves markdown resolver ownership', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'html-only.html'), '<title>HTML</title>');
    await writeFile(path.join(contentDir, 'markdown-only.md'), '# Markdown\n');
    await writeFile(path.join(contentDir, 'both.html'), '<title>Both</title>');
    await writeFile(path.join(contentDir, 'both.md'), '# Both Markdown\n');

    const htmlOnly = await resolvePageDescriptor('html-only', contentDir);
    assert.equal(htmlOnly.type, 'html');
    assert.equal(htmlOnly.filePath, path.join(contentDir, 'html-only.html'));

    const markdownOnly = await resolvePageDescriptor('markdown-only', contentDir);
    assert.equal(markdownOnly.type, 'markdown');
    assert.equal(markdownOnly.filePath, path.join(contentDir, 'markdown-only.md'));

    const both = await resolvePageDescriptor('both', contentDir);
    assert.equal(both.type, 'html');
    assert.equal(both.filePath, path.join(contentDir, 'both.html'));
    assert.equal(both.companionPath, path.join(contentDir, 'both.md'));
    assert.equal(resolveSafePath('both', contentDir), path.join(contentDir, 'both.md'));

    await assert.rejects(() => resolvePageDescriptor('missing', contentDir), { code: 'ENOENT' });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('resolvePageDescriptor rejects html traversal and null byte slugs', async () => {
  const contentDir = await makeContentDir();
  try {
    await assert.rejects(() => resolvePageDescriptor('../secret', contentDir), /directory traversal/);
    await assert.rejects(() => resolvePageDescriptor('bad\0slug', contentDir), /null byte/);
    await assert.rejects(() => resolvePageDescriptor('%252e%252e/secret', contentDir), /double-encoded traversal/);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('page route serves markdown with default CSP and html artifacts wrapped with iframe', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'foo.md'), '# Foo Markdown\n');
    await writeFile(path.join(contentDir, 'artifact.html'), '<!doctype html><title>Artifact</title><script>window.ok=true</script><h1>Artifact</h1>');
    await writeFile(path.join(contentDir, 'both.md'), '# Both Markdown\n');
    await writeFile(path.join(contentDir, 'both.html'), '<!doctype html><title>Both HTML</title><script>window.ok=true</script><h1>Both HTML</h1>');

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const markdown = await fetch(`${origin}/foo`);
      assert.equal(markdown.status, 200);
      assert.equal(markdown.headers.get('content-security-policy'), DEFAULT_CSP);
      assert.match(await markdown.text(), /Foo Markdown/);

      // Default HTML artifact response: wrapper template with iframe
      const html = await fetch(`${origin}/artifact`);
      assert.equal(html.status, 200);
      assert.equal(html.headers.get('content-security-policy'), DEFAULT_CSP);
      const wrapperEtag = html.headers.get('etag');
      const wrapperBody = await html.text();
      assert.match(wrapperBody, /html-artifact-frame/);
      assert.match(wrapperBody, /artifact\?raw=1/);
      assert.match(wrapperBody, /Artifact/);

      // 304 for wrapper
      const notModified = await fetch(`${origin}/artifact`, {
        redirect: 'manual',
        headers: { 'If-None-Match': wrapperEtag },
      });
      assert.equal(notModified.status, 304);

      // Raw mode: serves raw HTML with artifact CSP
      const raw = await fetch(`${origin}/artifact?raw=1`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get('content-security-policy'), HTML_ARTIFACT_CSP);
      const rawBody = await raw.text();
      assert.match(rawBody, /<script>window\.ok=true<\/script>/);
      assert.match(rawBody, /__PAGES_BASE/);

      // 304 for raw
      const rawEtag = raw.headers.get('etag');
      const rawNotModified = await fetch(`${origin}/artifact?raw=1`, {
        redirect: 'manual',
        headers: { 'If-None-Match': rawEtag },
      });
      assert.equal(rawNotModified.status, 304);
      assert.equal(rawNotModified.headers.get('content-security-policy'), HTML_ARTIFACT_CSP);

      // Both: html priority → wrapper
      const both = await fetch(`${origin}/both`);
      assert.equal(both.status, 200);
      assert.match(await both.text(), /both\?raw=1/);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('html extension redirect preserves query string for share tokens', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'shared.html'), '<!doctype html><title>Shared</title><h1>Shared HTML</h1>');
    const token = createShare('shared', '24h', { allowPermanent: false }).token;

    await withServer({
      ...baseConfig(contentDir),
      auth: { enabled: true, password: hashPassword('secret') },
    }, async ({ origin }) => {
      const redirect = await fetch(`${origin}/shared.html?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.get('location'), `/shared?token=${encodeURIComponent(token)}`);

      const uppercaseRedirect = await fetch(`${origin}/shared.HTML?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
      assert.equal(uppercaseRedirect.status, 301);
      assert.equal(uppercaseRedirect.headers.get('location'), `/shared?token=${encodeURIComponent(token)}`);

      const shared = await fetch(`${origin}/shared?token=${encodeURIComponent(token)}`);
      assert.equal(shared.status, 200);
      const sharedBody = await shared.text();
      assert.match(sharedBody, /html-artifact-frame/);
      assert.match(sharedBody, /data-viewer="share"/);

      // iframe src must include token so share viewer can load raw content
      const iframeSrcMatch = sharedBody.match(/<iframe[^>]+src="([^"]+)"/);
      assert.ok(iframeSrcMatch, 'iframe src must be present');
      assert.match(iframeSrcMatch[1], /raw=1/);
      assert.match(iframeSrcMatch[1], /token=/);

      // Fetch the actual iframe src — must return 200 with artifact content
      const iframeUrl = iframeSrcMatch[1].replace(/&amp;/g, '&');
      const iframeFetch = await fetch(`${origin}${iframeUrl}`);
      assert.equal(iframeFetch.status, 200);
      assert.match(await iframeFetch.text(), /Shared HTML/);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('html pages require auth when no valid share token is present', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'private.html'), '<!doctype html><title>Private</title>');

    await withServer({
      ...baseConfig(contentDir),
      auth: { enabled: true, password: hashPassword('secret') },
    }, async ({ origin }) => {
      const res = await fetch(`${origin}/private`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login?next=%2Fprivate');
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('raw API returns markdown when both html and markdown exist, and share viewers remain blocked', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'source.html'), '<!doctype html><title>HTML</title>');
    await writeFile(path.join(contentDir, 'source.md'), '# Markdown Source\n');
    const token = createShare('source', '24h', { allowPermanent: false }).token;

    await withServer({
      ...baseConfig(contentDir),
      auth: { enabled: true, password: hashPassword('secret') },
    }, async ({ origin }) => {
      const rawAsShare = await fetch(`${origin}/api/raw/source?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
      assert.equal(rawAsShare.status, 302);
      assert.match(rawAsShare.headers.get('location'), /^\/login\?/);

      const login = await fetch(`${origin}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'secret' }),
      });
      const cookie = login.headers.get('set-cookie').split(';', 1)[0];
      const raw = await fetch(`${origin}/api/raw/source`, { headers: { Cookie: cookie } });
      assert.equal(raw.status, 200);
      assert.equal(await raw.text(), '# Markdown Source\n');
    });

    const app = express();
    app.use((req, res, next) => {
      res.locals.viewerType = 'share';
      next();
    });
    setupRawApi(app, baseConfig(contentDir));
    const server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const rawAsViewer = await fetch(`${origin}/api/raw/source`);
      assert.equal(rawAsViewer.status, 403);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('scanPages lists html pages and deduplicates same-slug markdown fallback', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'html-only.html'), '<!doctype html><title>HTML Title</title><h1>HTML</h1>');
    await writeFile(path.join(contentDir, 'both.md'), '---\ntitle: Markdown Title\n---\n# Markdown\n');
    await writeFile(path.join(contentDir, 'both.html'), '<!doctype html><title>HTML Priority</title>');

    const pages = await scanPages(contentDir);
    assert.deepEqual(pages.map(page => [page.slug, page.title, page.type]).sort(), [
      ['both', 'HTML Priority', 'html'],
      ['html-only', 'HTML Title', 'html'],
    ]);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('page cache switches between markdown and html descriptors and updates html content', async () => {
  const contentDir = await makeContentDir();
  try {
    initCache({ maxEntries: 10, ttlSeconds: 60 });
    const config = baseConfig(contentDir);
    await writeFile(path.join(contentDir, 'switch.md'), '# Markdown First\n');

    const markdown = await getPage('switch', config);
    assert.equal(markdown.type, 'markdown');
    assert.match(markdown.html, /Markdown First/);

    await writeFile(path.join(contentDir, 'switch.html'), '<!doctype html><title>HTML First</title><h1>HTML First</h1>');
    const html = await getPage('switch', config);
    assert.equal(html.type, 'html');
    assert.match(html.html, /HTML First/);

    await unlink(path.join(contentDir, 'switch.html'));
    const fallback = await getPage('switch', config);
    assert.equal(fallback.type, 'markdown');
    assert.match(fallback.html, /Markdown First/);

    await writeFile(path.join(contentDir, 'switch.html'), '<!doctype html><title>HTML Two</title><h1>HTML Two</h1>');
    const htmlTwo = await getPage('switch', config);
    assert.match(htmlTwo.html, /HTML Two/);
    const firstEtag = htmlTwo.etag;

    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(path.join(contentDir, 'switch.html'), '<!doctype html><title>HTML Three</title><h1>HTML Three</h1>');
    const htmlThree = await getPage('switch', config);
    assert.match(htmlThree.html, /HTML Three/);
    assert.notEqual(htmlThree.etag, firstEtag);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('cache invalidation clears nested slugs and browserBase variants', async () => {
  const { getCachedPage, invalidatePagesForSlug, setCachedPage } = await import('../src/cache/pageCache.js');
  initCache({ maxEntries: 10, ttlSeconds: 60 });
  setCachedPage('/pages:docs/nested', { html: 'a' });
  setCachedPage('/:docs/nested', { html: 'b' });
  setCachedPage('/pages:docs/other', { html: 'c' });

  assert.equal(invalidatePagesForSlug('docs/nested'), true);
  assert.equal(getCachedPage('/pages:docs/nested'), undefined);
  assert.equal(getCachedPage('/:docs/nested'), undefined);
  assert.ok(getCachedPage('/pages:docs/other'));
});
