import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function upgrade(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-default-limits-'));
  const dataDir = path.join(home, 'zylos/components/pages');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'zylos/http/public/pages'), { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'hooks/post-upgrade.js')], {
      env: { ...process.env, HOME: home, PAGES_SHARE_PASSWORD_KEY_FILE: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const base = {
  auth: { password: 'scrypt:test:test' },
  publicBaseUrl: 'https://pages.example.test/pages',
};

test('post-upgrade never changes values already present, even the old defaults', () => {
  const oldDefaults = upgrade({
    ...base,
    security: { allowRawHtml: false, maxFileSizeBytes: 1048576, maxAttachmentSizeBytes: 52428800, renderTimeoutMs: 5000 },
    rateLimit: { windowMs: 60000, max: 60 },
  });
  assert.equal(oldDefaults.security.maxFileSizeBytes, 1048576);
  assert.deepEqual(oldDefaults.rateLimit, { windowMs: 60000, max: 60 });

  const custom = upgrade({
    ...base,
    security: { allowRawHtml: false, maxFileSizeBytes: 2097152, maxAttachmentSizeBytes: 52428800, renderTimeoutMs: 5000 },
    rateLimit: { windowMs: 30000, max: 120 },
  });
  assert.equal(custom.security.maxFileSizeBytes, 2097152);
  assert.deepEqual(custom.rateLimit, { windowMs: 30000, max: 120 });
});

test('post-upgrade fills missing sections with the new defaults', () => {
  const config = upgrade({ ...base });
  assert.equal(config.security.maxFileSizeBytes, 10 * 1024 * 1024);
  assert.deepEqual(config.rateLimit, { windowMs: 60000, max: 600 });
});
