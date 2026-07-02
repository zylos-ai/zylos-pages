import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'src/cli/external-files.js');
const pagesCliPath = path.join(repoRoot, 'src/cli/pages.js');
const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-db-test-'));
process.env.PAGES_DATA_DIR = sharedDataDir;

const { getPage } = await import('../src/services/pageService.js');
const { getCachedPage, initCache, invalidatePagesForSlug, setCachedPage } = await import('../src/cache/pageCache.js');
const { resolveLogicalAsset } = await import('../src/pages/asset-resolver.js');
const { getPagesDb } = await import('../src/db/pages-db.js');

function makeEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    PAGES_DATA_DIR: sharedDataDir,
    ...extra,
  };
}

function makeFixture(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-test-'));
  const dataDir = sharedDataDir;
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const sourceRoot = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    contentDir,
    externalFiles: {
      enabled: options.enabled ?? true,
      allowedSources: {
        recruit: sourceRoot,
      },
    },
  }, null, 2));
  return { home, dataDir, contentDir, sourceRoot };
}

function runCli(fixture, args, options = {}) {
  const result = spawnSync(process.execPath, [options.cliPath || cliPath, ...args], {
    cwd: repoRoot,
    env: makeEnv(fixture.home, options.env),
    encoding: 'utf8',
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runPagesCli(fixture, args, options = {}) {
  return runCli(fixture, args, { ...options, cliPath: pagesCliPath });
}

function registerArgs(slug, source, extra = []) {
  return [
    'register',
    '--component', 'recruit',
    '--slug', slug,
    '--source', source,
    ...extra,
    '--json',
  ];
}

function configFor(fixture) {
  return {
    contentDir: fixture.contentDir,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
}

test('status reports external file configuration', () => {
  const fixture = makeFixture({ enabled: false });
  const result = runCli(fixture, ['status', '--json']);

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.contentDir, fixture.contentDir);
  assert.equal(result.allowedSources.recruit, fixture.sourceRoot);
});

test('register stores a DB-backed logical page without creating a content symlink', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');
  const sourceRealPath = fs.realpathSync(source);

  const registered = runCli(fixture, registerArgs('recruit/questions', source, ['--title', 'Interview Questions']));
  assert.equal(registered.ok, true);
  assert.equal(registered.uri, 'recruit/questions');
  assert.equal(registered.url, '/pages/p/recruit/questions');
  assert.equal(registered.sourceRealPath, sourceRealPath);
  assert.equal(registered.accessMode, 'private');
  assert.equal(fs.existsSync(path.join(fixture.contentDir, 'recruit/questions.md')), false);

  const list = runCli(fixture, ['list', '--json']);
  assert.deepEqual(list.entries.map((entry) => entry.slug), ['recruit/questions']);
  assert.equal(list.entries[0].title, 'Interview Questions');
});

test('unified pages CLI registers, shares, lists shares, and unshares logical pages', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'share-target.md');
  fs.writeFileSync(source, '# Share Target\n');

  const registered = runPagesCli(fixture, [
    'register',
    '--component', 'recruit',
    '--uri', 'recruit/share-target',
    '--source', source,
    '--json',
  ]);
  assert.equal(registered.ok, true);
  assert.equal(registered.accessMode, 'private');

  const share = runPagesCli(fixture, ['share', 'recruit/share-target', '--duration', '24h', '--json']);
  assert.equal(share.ok, true);
  assert.equal(share.slug, 'p/recruit/share-target');
  assert.match(share.tokenId, /^[a-f0-9]{32}$/);
  assert.match(share.shortUrl, /\/pages\/s\/[a-f0-9]{32}$/);
  assert.doesNotMatch(share.shortUrl, /jinglever\.com/);

  const shares = runPagesCli(fixture, ['shares', 'recruit/share-target', '--json']);
  assert.deepEqual(shares.shares.map(entry => entry.tokenId), [share.tokenId]);

  const unshared = runPagesCli(fixture, ['unshare', 'recruit/share-target', '--json']);
  assert.equal(unshared.ok, true);
  assert.equal(unshared.revoked, 1);

  const after = runPagesCli(fixture, ['shares', 'recruit/share-target', '--json']);
  assert.deepEqual(after.shares, []);
});

test('pages CLI unregister removes registry and page-id keyed share rows but keeps source file', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'obsolete.md');
  fs.writeFileSync(source, '# Obsolete\n');

  runPagesCli(fixture, [
    'register',
    '--component', 'recruit',
    '--uri', 'recruit/obsolete',
    '--source', source,
    '--json',
  ]);
  const share = runPagesCli(fixture, ['share', 'recruit/obsolete', '--duration', '24h', '--json']);
  const db = getPagesDb();
  const page = db.prepare('SELECT page_id FROM logical_pages WHERE uri = ?').get('recruit/obsolete');
  assert.ok(page?.page_id);
  db.prepare(`
    INSERT INTO share_sessions (token_hash, token_id, page_id, created_at, last_activity_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('dummy-hash', share.tokenId, page.page_id, Date.now(), Date.now(), Date.now() + 3600_000);

  const unregistered = runPagesCli(fixture, ['unregister', 'recruit/obsolete', '--json']);
  assert.equal(unregistered.ok, true);
  assert.equal(unregistered.command, 'unregister');
  assert.equal(unregistered.uri, 'recruit/obsolete');
  assert.equal(unregistered.pageId, page.page_id);
  assert.equal(unregistered.removedShares, 1);
  assert.equal(unregistered.removedSessions, 1);
  assert.equal(unregistered.sourcePath, fs.realpathSync(source));

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM logical_pages WHERE page_id = ?').get(page.page_id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shares WHERE page_id = ?').get(page.page_id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM share_sessions WHERE page_id = ?').get(page.page_id).count, 0);
  assert.equal(fs.existsSync(source), true);

  const repeated = runPagesCli(fixture, ['unregister', 'recruit/obsolete', '--json'], { expectFailure: true });
  assert.equal(repeated.code, 'page_missing');
  assert.equal(repeated.error, 'logical page not found: recruit/obsolete');
});

test('pages CLI share base URL uses config when env is absent', () => {
  const fixture = makeFixture({ publicBaseUrl: 'https://pages.example.test/custom-pages/' });
  const source = path.join(fixture.sourceRoot, 'configured-base.md');
  fs.writeFileSync(source, '# Configured Base\n');

  runPagesCli(fixture, [
    'register',
    '--component', 'recruit',
    '--uri', 'recruit/configured-base',
    '--source', source,
    '--json',
  ]);

  const share = runPagesCli(fixture, ['share', 'recruit/configured-base', '--duration', '24h', '--json'], {
    env: { PAGES_BASE_URL: '' },
  });
  assert.match(share.shortUrl, /^https:\/\/pages\.example\.test\/custom-pages\/s\/[a-f0-9]{32}$/);

  const shares = runPagesCli(fixture, ['shares', 'recruit/configured-base', '--json'], {
    env: { PAGES_BASE_URL: '' },
  });
  assert.equal(shares.shares[0].shortUrl, share.shortUrl);
});

test('allow-root add preserves existing config fields and enables registration from new root', () => {
  const fixture = makeFixture();
  const newRoot = path.join(fixture.home, 'workspace/reports');
  fs.mkdirSync(newRoot, { recursive: true });
  const configPath = path.join(fixture.dataDir, 'config.json');
  const originalConfig = {
    auth: {
      enabled: true,
      password: 'scrypt:already-hashed',
    },
    sharing: {
      enabled: true,
      allowPermanent: false,
    },
    externalFiles: {
      enabled: true,
      allowedSources: {
        recruit: fixture.sourceRoot,
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(originalConfig, null, 2));

  const added = runPagesCli(fixture, ['allow-root', 'add', newRoot, '--name', 'reports', '--json']);
  assert.equal(added.ok, true);
  assert.equal(added.name, 'reports');
  assert.equal(added.path, fs.realpathSync(newRoot));

  const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(updatedConfig.auth.password, originalConfig.auth.password);
  assert.equal(updatedConfig.sharing.allowPermanent, false);
  assert.equal(updatedConfig.externalFiles.allowedSources.recruit, fixture.sourceRoot);
  assert.equal(updatedConfig.externalFiles.allowedSources.reports, fs.realpathSync(newRoot));

  const source = path.join(newRoot, 'allowed.md');
  fs.writeFileSync(source, '# Allowed\n');
  const registered = runPagesCli(fixture, [
    'register',
    '--component', 'reports',
    '--uri', 'reports/allowed',
    '--source', source,
    '--json',
  ]);
  assert.equal(registered.ok, true);
  assert.equal(registered.sourceRootName, 'reports');
});

test('registered logical markdown page renders through /p/:uri and reflects source updates', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'render-source.md');
  fs.writeFileSync(source, '# First Render\n![Chart](./chart.png)\n');
  fs.writeFileSync(path.join(fixture.sourceRoot, 'chart.png'), 'png');

  runCli(fixture, registerArgs('external/render-source', source));

  const first = await getPage('p/external/render-source', configFor(fixture), '/pages');
  assert.match(first.html, /First Render/);
  assert.match(first.html, /src="\/pages\/assets\/external\/render-source\?path=.%2Fchart.png"/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(source, '# Updated Render\n');

  const updated = await getPage('p/external/render-source', configFor(fixture), '/pages');
  assert.match(updated.html, /Updated Render/);
});

test('html source registers and resolves as a logical html artifact', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'artifact.html');
  fs.writeFileSync(source, '<!doctype html><title>Artifact</title><img src="./image.png">\n');
  fs.writeFileSync(path.join(fixture.sourceRoot, 'image.png'), 'image');

  const result = runCli(fixture, registerArgs('recruit/artifact', source));
  assert.equal(result.ok, true);

  const { resolvePageDescriptor } = await import('../src/security/pathGuard.js');
  const descriptor = await resolvePageDescriptor('recruit/artifact', fixture.contentDir);
  assert.equal(descriptor.type, 'html');
  assert.equal(descriptor.filePath, fs.realpathSync(source));

  const page = await getPage('p/recruit/artifact', configFor(fixture), '/pages');
  assert.match(page.html, /src="\/pages\/assets\/recruit\/artifact\?path=.%2Fimage.png"/);
});

test('source symlink escaping allowed root is rejected', () => {
  const fixture = makeFixture();
  const outside = path.join(fixture.home, 'outside.md');
  const source = path.join(fixture.sourceRoot, 'escape.md');
  fs.writeFileSync(outside, '# Outside\n');
  fs.symlinkSync(outside, source);

  const result = runCli(fixture, registerArgs('escape', source), { expectFailure: true });
  assert.equal(result.code, 'source_outside_allowed_root');
});

test('missing and disallowed-extension sources are rejected', () => {
  const fixture = makeFixture();
  const txt = path.join(fixture.sourceRoot, 'notes.txt');
  fs.writeFileSync(txt, 'not a page\n');

  const disallowed = runCli(fixture, registerArgs('notes', txt), { expectFailure: true });
  assert.equal(disallowed.code, 'source_not_allowed');

  const missing = runCli(fixture, registerArgs('missing', path.join(fixture.sourceRoot, 'missing.md')), { expectFailure: true });
  assert.equal(missing.code, 'source_missing');
});

test('logical asset resolver serves same-directory assets and rejects traversal or symlink escape', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'page.md');
  const asset = path.join(fixture.sourceRoot, 'image.png');
  const outside = path.join(fixture.home, 'secret.png');
  const escapeLink = path.join(fixture.sourceRoot, 'escape.png');
  fs.writeFileSync(source, '# Page\n');
  fs.writeFileSync(asset, 'image');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, escapeLink);
  runCli(fixture, registerArgs('page', source));

  const resolved = await resolveLogicalAsset('page', './image.png');
  assert.equal(resolved.filePath, fs.realpathSync(asset));

  await assert.rejects(() => resolveLogicalAsset('page', '../secret.png'), /outside page source directory/);
  await assert.rejects(() => resolveLogicalAsset('page', './escape.png'), /outside page source directory/);
});

test('page service renders root-internal and forwarded-prefix browser bases separately', async () => {
  const fixture = makeFixture();
  const nestedDir = path.join(fixture.contentDir, 'docs');
  fs.mkdirSync(nestedDir, { recursive: true });
  const source = path.join(nestedDir, 'nested.md');
  fs.writeFileSync(source, '# Nested Page\n');
  runPagesCli(fixture, [
    'allow-root',
    'add',
    fixture.contentDir,
    '--name',
    'content',
    '--json',
  ]);
  runPagesCli(fixture, [
    'register',
    '--component',
    'content',
    '--uri',
    'docs/nested',
    '--source',
    source,
    '--json',
  ]);

  const direct = await getPage('p/docs/nested', configFor(fixture), '');
  assert.match(direct.html, /href="\/_assets\/style\.css/);
  assert.match(direct.html, /data-base-url=""/);

  const proxied = await getPage('p/docs/nested', configFor(fixture), '/pages');
  assert.match(proxied.html, /href="\/pages\/_assets\/style\.css/);
  assert.match(proxied.html, /data-base-url="\/pages"/);
});

test('cache invalidation clears all browser-base variants for a slug', () => {
  initCache({ maxEntries: 10, ttlSeconds: 60 });
  setCachedPage('/:docs/nested', { html: 'direct' });
  setCachedPage('/pages:docs/nested', { html: 'proxied' });
  setCachedPage('/pages:other', { html: 'other' });

  assert.equal(invalidatePagesForSlug('docs/nested'), true);
  assert.equal(getCachedPage('/:docs/nested'), undefined);
  assert.equal(getCachedPage('/pages:docs/nested'), undefined);
  assert.deepEqual(getCachedPage('/pages:other'), { html: 'other' });
});
