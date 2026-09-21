import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  hasConfiguredPublicBaseUrl,
  warnIfPublicBaseUrlMissing,
} from '../src/lib/public-base-url-guidance.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-public-base-url-'));
  const dataDir = path.join(home, 'zylos/components/pages');
  const contentDir = path.join(home, 'zylos/http/public/pages');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  }
  return { home, dataDir, contentDir };
}

function runHook(name, config) {
  const fixture = makeHome(config);
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'hooks', name)], {
    env: { ...process.env, HOME: fixture.home, PAGES_SHARE_PASSWORD_KEY_FILE: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runService(config) {
  const fixture = makeHome({
    enabled: true,
    port: 0,
    contentDir: fixtureContentDirPlaceholder,
    auth: { password: 'scrypt:test:test' },
    ...config,
  });
  const configPath = path.join(fixture.dataDir, 'config.json');
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  stored.contentDir = fixture.contentDir;
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'src/index.js')], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`service did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Server listening')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const fixtureContentDirPlaceholder = '/tmp/replaced-by-test-fixture';

test('configuration helper treats missing and blank values as absent', () => {
  for (const publicBaseUrl of [undefined, null, '', '   ']) {
    const config = publicBaseUrl === undefined ? {} : { publicBaseUrl };
    const warnings = [];
    assert.equal(hasConfiguredPublicBaseUrl(config), false);
    assert.equal(warnIfPublicBaseUrlMissing(config, message => warnings.push(message)), true);
    assert.match(warnings.join('\n'), /required when Pages is behind a reverse proxy/);
    assert.match(warnings.join('\n'), /ask the owner/);
  }
});

test('configuration helper stays silent for a configured value', () => {
  const warnings = [];
  assert.equal(hasConfiguredPublicBaseUrl({ publicBaseUrl: 'https://pages.example.test/pages' }), true);
  assert.equal(warnIfPublicBaseUrlMissing(
    { publicBaseUrl: 'https://pages.example.test/pages' },
    message => warnings.push(message),
  ), false);
  assert.deepEqual(warnings, []);
});

test('post-install and post-upgrade warn only when publicBaseUrl is missing', () => {
  const base = {
    auth: { password: 'scrypt:test:test' },
    sharing: { enabled: true },
    externalFiles: { enabled: true, allowedSources: {} },
  };
  for (const hook of ['post-install.js', 'post-upgrade.js']) {
    const missing = runHook(hook, base);
    assert.match(missing.stderr, /WARNING: secure handoff is enabled but publicBaseUrl is not configured/);
    assert.match(missing.stderr, /ask the owner/);

    const configured = runHook(hook, {
      ...base,
      publicBaseUrl: 'https://pages.example.test/pages',
    });
    assert.doesNotMatch(configured.stderr, /publicBaseUrl is not configured/);
  }
});

test('service startup emits structured WARN only when publicBaseUrl is missing', async () => {
  const missing = await runService({});
  assert.match(missing.stderr, /"level":"warn"/);
  assert.match(missing.stderr, /"msg":"secure handoff is enabled but publicBaseUrl is not configured"/);
  assert.match(missing.stderr, /ask the owner/);

  const configured = await runService({ publicBaseUrl: 'https://pages.example.test/pages' });
  assert.doesNotMatch(configured.stderr, /publicBaseUrl is not configured/);
});
