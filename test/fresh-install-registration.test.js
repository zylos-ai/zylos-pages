// Fresh-install registration: the configured contentDir must be a valid
// registration root without an explicit externalFiles.allowedSources entry,
// and post-install must leave the seeded welcome page registered.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pagesCliPath = path.join(repoRoot, 'src/cli/pages.js');
const postInstallPath = path.join(repoRoot, 'hooks/post-install.js');

const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-fresh-test-'));
process.env.PAGES_DATA_DIR = sharedDataDir;

const { validateSourcePath } = await import('../src/pages/page-store.js');

test('contentDir is an implicit allowed registration root on default config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-fresh-home-'));
  const contentDir = path.join(home, 'zylos/http/public/pages');
  fs.mkdirSync(contentDir, { recursive: true });
  const filePath = path.join(contentDir, 'hello.md');
  fs.writeFileSync(filePath, '# Hello');

  // Fresh-install default: allowedSources contains only recruit.
  const config = {
    contentDir,
    externalFiles: {
      enabled: true,
      allowedSources: { recruit: path.join(home, 'zylos/components/recruit') },
    },
  };

  const validated = validateSourcePath(filePath, config);
  assert.equal(validated.sourceRootName, 'pages-content');
  assert.equal(validated.sourceRealPath, fs.realpathSync(filePath));
});

test('an explicit pages-content allowed source takes precedence over the implicit root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-fresh-home-'));
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const explicitRoot = path.join(home, 'zylos/elsewhere');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(explicitRoot, { recursive: true });
  fs.writeFileSync(path.join(explicitRoot, 'doc.md'), '# Doc');
  fs.writeFileSync(path.join(contentDir, 'page.md'), '# Page');

  const config = {
    contentDir,
    externalFiles: {
      enabled: true,
      allowedSources: { 'pages-content': explicitRoot },
    },
  };

  // The explicit root works under its configured path...
  const explicit = validateSourcePath(path.join(explicitRoot, 'doc.md'), config);
  assert.equal(explicit.sourceRootName, 'pages-content');
  assert.equal(explicit.sourceRootRealPath, fs.realpathSync(explicitRoot));

  // ...and the implicit contentDir root is NOT silently added alongside it.
  assert.throws(
    () => validateSourcePath(path.join(contentDir, 'page.md'), config),
    /outside the configured allowed root/,
  );
});

test('post-install on an empty HOME seeds and registers the welcome page', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-fresh-home-'));
  const dataDir = path.join(home, 'zylos/components/pages');
  const env = {
    ...process.env,
    HOME: home,
    PAGES_DATA_DIR: dataDir,
  };

  const install = spawnSync(process.execPath, [postInstallPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const contentDir = path.join(home, 'zylos/http/public/pages');
  assert.ok(fs.existsSync(path.join(contentDir, 'welcome.md')), 'welcome.md should be created');
  assert.match(install.stdout, /welcome\.md registered at \/pages\/p\/welcome/);

  const list = spawnSync(process.execPath, [pagesCliPath, 'list', '--json'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const parsed = JSON.parse(list.stdout);
  const entries = parsed.entries || parsed;
  const welcome = entries.find(entry => entry.uri === 'welcome');
  assert.ok(welcome, `welcome page should be registered; got: ${list.stdout}`);
  assert.equal(welcome.sourcePath, fs.realpathSync(path.join(contentDir, 'welcome.md')));
});
