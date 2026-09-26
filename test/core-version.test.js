import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  coreSupportsCookieAllowlist,
  MINIMUM_COOKIE_FILTER_CORE_VERSION,
  warnIfCoreCookieAllowlistUnavailable,
} from '../src/lib/core-version.js';

function makeInstall(version, { name = 'zylos', packageJson = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-core-version-'));
  const binDir = path.join(root, 'bin');
  const packageDir = path.join(root, 'lib', 'node_modules', 'zylos');
  const cliDir = path.join(packageDir, 'cli');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'zylos.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(cliDir, 'zylos.js'), 0o755);
  fs.symlinkSync(path.join(cliDir, 'zylos.js'), path.join(binDir, 'zylos'));
  if (packageJson) fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }));
  return { root, pathValue: binDir };
}

test('core version check accepts the minimum and newer semantic versions', (t) => {
  for (const version of [MINIMUM_COOKIE_FILTER_CORE_VERSION, '0.8.3', '0.9.0', '1.0.0-beta.1']) {
    const install = makeInstall(version);
    t.after(() => fs.rmSync(install.root, { recursive: true, force: true }));
    assert.deepEqual(coreSupportsCookieAllowlist(install), { supported: true, version, state: 'current' });
  }
});

test('core version check rejects old, malformed, and absent installations', (t) => {
  for (const version of ['0.8.1', '0.7.99', 'not-semver']) {
    const install = makeInstall(version);
    t.after(() => fs.rmSync(install.root, { recursive: true, force: true }));
    assert.deepEqual(coreSupportsCookieAllowlist(install), {
      supported: false,
      version,
      state: version === 'not-semver' ? 'invalid' : 'old',
    });
  }

  assert.deepEqual(coreSupportsCookieAllowlist({ pathValue: '' }), {
    supported: false, version: null, state: 'missing',
  });

  const invalid = makeInstall('0.8.2', { name: 'not-zylos' });
  t.after(() => fs.rmSync(invalid.root, { recursive: true, force: true }));
  assert.deepEqual(coreSupportsCookieAllowlist(invalid), {
    supported: false, version: null, state: 'invalid',
  });
});

test('core version warning is emitted only when filtering is unavailable', (t) => {
  const oldInstall = makeInstall('0.8.1');
  const currentInstall = makeInstall(MINIMUM_COOKIE_FILTER_CORE_VERSION);
  t.after(() => fs.rmSync(oldInstall.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(currentInstall.root, { recursive: true, force: true }));

  const warnings = [];
  warnIfCoreCookieAllowlistUnavailable(oldInstall, (message) => warnings.push(message));
  warnIfCoreCookieAllowlistUnavailable(currentInstall, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /zylos-core >=0\.8\.2/);
  assert.match(warnings[0], /installed version: 0\.8\.1/);
});
