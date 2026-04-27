import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getPage } from '../src/services/pageService.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'src/cli/external-files.js');

function makeEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    PAGES_EXTERNAL_FILES_LOCK_RETRY_MS: '5',
    PAGES_EXTERNAL_FILES_LOCK_TIMEOUT_MS: '200',
    PAGES_EXTERNAL_FILES_STALE_LOCK_MS: '10',
    ...extra,
  };
}

function makeFixture(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-test-'));
  const dataDir = path.join(home, 'zylos/components/pages');
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const sourceRoot = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
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
  const result = spawnSync(process.execPath, [cliPath, ...args], {
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

function registerArgs(slug, source) {
  return [
    'register',
    '--component', 'recruit',
    '--slug', slug,
    '--source', source,
    '--json',
  ];
}

function spawnCli(fixture, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: makeEnv(fixture.home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('status reports external file configuration', () => {
  const fixture = makeFixture({ enabled: false });
  const result = runCli(fixture, ['status', '--json']);

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.equal(result.contentDir, fixture.contentDir);
  assert.equal(result.allowedSources.recruit, fixture.sourceRoot);
});

test('register creates symlink and registry entry, unregister removes only the symlink', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');
  const sourceRealPath = fs.realpathSync(source);

  const registered = runCli(fixture, registerArgs('recruit/questions', source));
  const linkPath = path.join(fixture.contentDir, 'recruit/questions.md');
  assert.equal(registered.ok, true);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linkPath), sourceRealPath);

  const registry = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'external-files.json'), 'utf8'));
  assert.equal(registry.entries['recruit/questions'].sourceRealPath, sourceRealPath);

  const unregistered = runCli(fixture, ['unregister', '--slug', 'recruit/questions', '--json']);
  assert.equal(unregistered.ok, true);
  assert.equal(fs.existsSync(linkPath), false);
  assert.equal(fs.existsSync(source), true);
});

test('register is idempotent for the same slug and source', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');

  const first = runCli(fixture, registerArgs('recruit/questions', source));
  const second = runCli(fixture, registerArgs('recruit/questions', source));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const list = runCli(fixture, ['list', '--json']);
  assert.deepEqual(list.entries.map((entry) => entry.slug), ['recruit/questions']);
});

test('registered file is rendered by page service and reflects source updates', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'render-source.md');
  fs.writeFileSync(source, '# First Render\n');

  runCli(fixture, registerArgs('external/render-source', source));
  const config = {
    contentDir: fixture.contentDir,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };

  const first = await getPage('external/render-source', config);
  assert.match(first.html, /First Render/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(source, '# Updated Render\n');

  const updated = await getPage('external/render-source', config);
  assert.match(updated.html, /Updated Render/);
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

test('missing and non-markdown sources are rejected', () => {
  const fixture = makeFixture();
  const txt = path.join(fixture.sourceRoot, 'notes.txt');
  fs.writeFileSync(txt, 'not markdown\n');

  const nonMarkdown = runCli(fixture, registerArgs('notes', txt), { expectFailure: true });
  assert.equal(nonMarkdown.code, 'source_not_markdown');

  const missing = runCli(fixture, registerArgs('missing', path.join(fixture.sourceRoot, 'missing.md')), { expectFailure: true });
  assert.equal(missing.code, 'source_missing');
});

test('existing normal page is not overwritten', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  const linkPath = path.join(fixture.contentDir, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');
  fs.writeFileSync(linkPath, '# Normal Page\n');

  const result = runCli(fixture, registerArgs('questions', source), { expectFailure: true });
  assert.equal(result.code, 'normal_page_exists');
  assert.equal(fs.readFileSync(linkPath, 'utf8'), '# Normal Page\n');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), false);
});

test('unknown symlink at slug is treated as a slug conflict', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  const linkPath = path.join(fixture.contentDir, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');
  fs.symlinkSync(source, linkPath);

  const result = runCli(fixture, registerArgs('questions', source), { expectFailure: true });
  assert.equal(result.code, 'slug_conflict');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
});

test('slug parent file conflict is rejected without overwriting', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  const parentPath = path.join(fixture.contentDir, 'recruit');
  fs.writeFileSync(source, '# Questions\n');
  fs.writeFileSync(parentPath, 'not a directory\n');

  const result = runCli(fixture, registerArgs('recruit/questions', source), { expectFailure: true });
  assert.equal(result.code, 'slug_conflict');
  assert.equal(fs.readFileSync(parentPath, 'utf8'), 'not a directory\n');
});

test('invalid encoded slug is rejected as invalid_slug', () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');

  const result = runCli(fixture, registerArgs('%E0%A4%A', source), { expectFailure: true });
  assert.equal(result.code, 'invalid_slug');
});

test('unregister does not delete a symlink that no longer points to the registry source', () => {
  const fixture = makeFixture();
  const original = path.join(fixture.sourceRoot, 'original.md');
  const replacement = path.join(fixture.sourceRoot, 'replacement.md');
  fs.writeFileSync(original, '# Original\n');
  fs.writeFileSync(replacement, '# Replacement\n');

  runCli(fixture, registerArgs('questions', original));
  const linkPath = path.join(fixture.contentDir, 'questions.md');
  fs.unlinkSync(linkPath);
  fs.symlinkSync(replacement, linkPath);

  const result = runCli(fixture, ['unregister', '--slug', 'questions', '--json']);
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linkPath), fs.realpathSync(replacement));
});

test('stale lock without owner file is recovered', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');

  const lockPath = path.join(fixture.dataDir, 'external-files.lock');
  fs.mkdirSync(lockPath);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = runCli(fixture, registerArgs('questions', source));
  assert.equal(result.ok, true);
});

test('stale lock with corrupt owner file is recovered', async () => {
  const fixture = makeFixture();
  const source = path.join(fixture.sourceRoot, 'questions.md');
  fs.writeFileSync(source, '# Questions\n');

  const lockPath = path.join(fixture.dataDir, 'external-files.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner.json'), '{');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const result = runCli(fixture, registerArgs('questions', source));
  assert.equal(result.ok, true);
});

test('concurrent registrations preserve both registry entries', async () => {
  const fixture = makeFixture();
  const sourceA = path.join(fixture.sourceRoot, 'a.md');
  const sourceB = path.join(fixture.sourceRoot, 'b.md');
  fs.writeFileSync(sourceA, '# A\n');
  fs.writeFileSync(sourceB, '# B\n');

  const [childA, childB] = await Promise.all([
    spawnCli(fixture, registerArgs('a', sourceA)),
    spawnCli(fixture, registerArgs('b', sourceB)),
  ]);

  assert.equal(childA.status, 0, childA.stderr || childA.stdout);
  assert.equal(childB.status, 0, childB.stderr || childB.stdout);
  assert.equal(JSON.parse(childA.stdout).ok, true);
  assert.equal(JSON.parse(childB.stdout).ok, true);
  const list = runCli(fixture, ['list', '--json']);
  assert.deepEqual(list.entries.map((entry) => entry.slug), ['a', 'b']);
});
