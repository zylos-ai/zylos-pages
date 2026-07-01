import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-html-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { initCache } = await import('../src/cache/pageCache.js');
const { getPage } = await import('../src/services/pageService.js');
const { scanPages } = await import('../src/pages/navigation.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const { pageRoute } = await import('../src/routes/pages.js');
const { setupRawApi } = await import('../src/routes/raw-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
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
    externalFiles: { allowedSources: { content: contentDir } },
  };
}

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Host-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

async function makeContentDir() {
  return mkdtemp(path.join(os.tmpdir(), 'zylos-pages-html-content-'));
}

function registerPage(config, uri, sourcePath, title = uri) {
  return registerLogicalPage({
    uri,
    title,
    sourcePath,
    component: 'content',
  }, config);
}

async function withServer(config, fn) {
  initCache({ maxEntries: 50, ttlSeconds: 60 });
  const app = express();
  app.use(securityHeaders());
  setupAuth(app, config.auth || { enabled: false, password: null });
  setupShareApi(app, config.sharing || { enabled: true, allowPermanent: false }, config);
  setupRawApi(app, config);
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

test('resolvePageDescriptor serves registered logical pages only', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const htmlPath = path.join(contentDir, 'html-only.html');
    const markdownPath = path.join(contentDir, 'markdown-only.md');
    const barePath = path.join(contentDir, 'bare.md');
    await writeFile(htmlPath, '<title>HTML</title>');
    await writeFile(markdownPath, '# Markdown\n');
    await writeFile(barePath, '# Bare\n');
    registerPage(config, 'html-only', htmlPath, 'HTML');
    registerPage(config, 'markdown-only', markdownPath, 'Markdown');

    const htmlOnly = await resolvePageDescriptor('html-only', contentDir);
    assert.equal(htmlOnly.type, 'html');
    assert.equal(htmlOnly.filePath, await realpath(htmlPath));
    assert.equal(htmlOnly.logical, true);

    const markdownOnly = await resolvePageDescriptor('markdown-only', contentDir);
    assert.equal(markdownOnly.type, 'markdown');
    assert.equal(markdownOnly.filePath, await realpath(markdownPath));
    assert.equal(markdownOnly.logical, true);
    assert.equal(resolveSafePath('markdown-only', contentDir), markdownPath);

    await assert.rejects(() => resolvePageDescriptor('bare', contentDir), { code: 'ENOENT' });
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
    const config = baseConfig(contentDir);
    const fooPath = path.join(contentDir, 'foo.md');
    const artifactPath = path.join(contentDir, 'artifact.html');
    const bothPath = path.join(contentDir, 'both.html');
    const barePath = path.join(contentDir, 'bare.md');
    await writeFile(fooPath, '# Foo Markdown\n');
    await writeFile(artifactPath, '<!doctype html><title>Artifact</title><script>window.ok=true</script><h1>Artifact</h1>');
    await writeFile(bothPath, '<!doctype html><title>Both HTML</title><script>window.ok=true</script><h1>Both HTML</h1>');
    await writeFile(barePath, '# Bare Markdown\n');
    registerPage(config, 'foo', fooPath, 'Foo');
    registerPage(config, 'artifact', artifactPath, 'Artifact');
    registerPage(config, 'both', bothPath, 'Both HTML');

    await withServer(config, async ({ origin }) => {
      const markdown = await fetch(`${origin}/foo`);
      assert.equal(markdown.status, 200);
      assert.equal(markdown.headers.get('content-security-policy'), DEFAULT_CSP);
      assert.match(await markdown.text(), /Foo Markdown/);

      const unregistered = await fetch(`${origin}/bare`);
      assert.equal(unregistered.status, 404);

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

test('shared html artifacts render directly while shared markdown keeps page header', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const sharedPath = path.join(contentDir, 'shared.html');
    const sharedMarkdownPath = path.join(contentDir, 'shared-markdown.md');
    await writeFile(sharedPath, '<!doctype html><title>Shared</title><h1>Shared HTML</h1>');
    await writeFile(sharedMarkdownPath, '# Shared Markdown\n');
    registerPage(config, 'shared', sharedPath, 'Shared');
    registerPage(config, 'shared-markdown', sharedMarkdownPath, 'Shared Markdown');
    const htmlToken = createShare('shared', '24h', { allowPermanent: false }).token;
    const markdownToken = createShare('shared-markdown', '24h', { allowPermanent: false }).token;

    await withServer({
      ...config,
      auth: { enabled: true, password: hashPassword('secret') },
    }, async ({ origin }) => {
      const redirect = await fetch(`${origin}/shared.html?token=${encodeURIComponent(htmlToken)}`, { redirect: 'manual' });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.get('location'), `/shared?token=${encodeURIComponent(htmlToken)}`);

      const uppercaseRedirect = await fetch(`${origin}/shared.HTML?token=${encodeURIComponent(htmlToken)}`, { redirect: 'manual' });
      assert.equal(uppercaseRedirect.status, 301);
      assert.equal(uppercaseRedirect.headers.get('location'), `/shared?token=${encodeURIComponent(htmlToken)}`);

      const shared = await fetch(`${origin}/shared?token=${encodeURIComponent(htmlToken)}`);
      assert.equal(shared.status, 200);
      assert.equal(shared.headers.get('content-security-policy'), HTML_ARTIFACT_CSP);
      const sharedBody = await shared.text();
      assert.match(sharedBody, /Shared HTML/);
      assert.doesNotMatch(sharedBody, /page-header/);
      assert.doesNotMatch(sharedBody, /html-artifact-frame/);
      assert.doesNotMatch(sharedBody, /theme-toggle/);

      const markdown = await fetch(`${origin}/shared-markdown?token=${encodeURIComponent(markdownToken)}`);
      assert.equal(markdown.status, 200);
      assert.equal(markdown.headers.get('content-security-policy'), DEFAULT_CSP);
      const markdownBody = await markdown.text();
      assert.match(markdownBody, /Shared Markdown/);
      assert.match(markdownBody, /page-header/);
      assert.match(markdownBody, /theme-toggle/);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('html pages require auth when no valid share token is present', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir);
    const privatePath = path.join(contentDir, 'private.html');
    await writeFile(privatePath, '<!doctype html><title>Private</title>');
    registerPage(config, 'private', privatePath, 'Private');

    await withServer({
      ...config,
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
    const config = baseConfig(contentDir);
    const sourcePath = path.join(contentDir, 'source.md');
    await writeFile(path.join(contentDir, 'source.html'), '<!doctype html><title>HTML</title>');
    await writeFile(sourcePath, '# Markdown Source\n');
    registerPage(config, 'source', sourcePath, 'Source');
    const token = createShare('source', '24h', { allowPermanent: false }).token;

    await withServer({
      ...config,
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
    setupRawApi(app, config);
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

test('scanPages lists registered logical pages instead of bare content files', async () => {
  const contentDir = await makeContentDir();
  try {
    const registeredHtml = path.join(contentDir, 'registered.html');
    const bareHtml = path.join(contentDir, 'bare.html');
    await writeFile(registeredHtml, '<!doctype html><title>Registered HTML</title><h1>HTML</h1>');
    await writeFile(bareHtml, '<!doctype html><title>Bare HTML</title>');
    const { registerLogicalPage } = await import('../src/pages/page-store.js');
    registerLogicalPage({
      uri: 'docs/registered',
      title: 'Registered HTML',
      sourcePath: registeredHtml,
      component: 'content',
    }, {
      contentDir,
      externalFiles: {
        allowedSources: {
          content: contentDir,
        },
      },
    });

    const pages = await scanPages(contentDir);
    assert.ok(pages.some(page => page.slug === 'p/docs/registered'
      && page.title === 'Registered HTML'
      && page.type === 'html'));
    assert.equal(pages.some(page => page.slug === 'p/bare'), false);
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('page cache switches between markdown and html descriptors and updates html content', async () => {
  const contentDir = await makeContentDir();
  try {
    initCache({ maxEntries: 10, ttlSeconds: 60 });
    const config = baseConfig(contentDir);
    const markdownPath = path.join(contentDir, 'switch.md');
    const htmlPath = path.join(contentDir, 'switch.html');
    await writeFile(markdownPath, '# Markdown First\n');
    registerPage(config, 'switch', markdownPath, 'Switch Markdown');

    const markdown = await getPage('switch', config);
    assert.equal(markdown.type, 'markdown');
    assert.match(markdown.html, /Markdown First/);

    await writeFile(htmlPath, '<!doctype html><title>HTML First</title><h1>HTML First</h1>');
    registerPage(config, 'switch', htmlPath, 'Switch HTML');
    const html = await getPage('switch', config);
    assert.equal(html.type, 'html');
    assert.match(html.html, /HTML First/);

    registerPage(config, 'switch', markdownPath, 'Switch Markdown');
    const fallback = await getPage('switch', config);
    assert.equal(fallback.type, 'markdown');
    assert.match(fallback.html, /Markdown First/);

    await writeFile(htmlPath, '<!doctype html><title>HTML Two</title><h1>HTML Two</h1>');
    registerPage(config, 'switch', htmlPath, 'Switch HTML');
    const htmlTwo = await getPage('switch', config);
    assert.match(htmlTwo.html, /HTML Two/);
    const firstEtag = htmlTwo.etag;

    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(htmlPath, '<!doctype html><title>HTML Three</title><h1>HTML Three</h1>');
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
