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

function makeHome(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-core-version-'));
  fs.mkdirSync(path.join(home, 'zylos'));
  fs.writeFileSync(path.join(home, 'zylos', 'package.json'), JSON.stringify({ version }));
  return home;
}

test('core version check accepts the minimum and newer semantic versions', (t) => {
  for (const version of [MINIMUM_COOKIE_FILTER_CORE_VERSION, '0.8.3', '0.9.0', '1.0.0-beta.1']) {
    const home = makeHome(version);
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    assert.deepEqual(coreSupportsCookieAllowlist(home), { supported: true, version });
  }
});

test('core version check rejects old, malformed, and absent installations', (t) => {
  for (const version of ['0.8.1', '0.7.99', 'not-semver']) {
    const home = makeHome(version);
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    assert.deepEqual(coreSupportsCookieAllowlist(home), { supported: false, version });
  }

  const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-core-missing-'));
  t.after(() => fs.rmSync(missingHome, { recursive: true, force: true }));
  assert.deepEqual(coreSupportsCookieAllowlist(missingHome), { supported: false, version: null });
});

test('core version warning is emitted only when filtering is unavailable', (t) => {
  const oldHome = makeHome('0.8.1');
  const currentHome = makeHome(MINIMUM_COOKIE_FILTER_CORE_VERSION);
  t.after(() => fs.rmSync(oldHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(currentHome, { recursive: true, force: true }));

  const warnings = [];
  warnIfCoreCookieAllowlistUnavailable(oldHome, (message) => warnings.push(message));
  warnIfCoreCookieAllowlistUnavailable(currentHome, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /zylos-core >=0\.8\.2/);
  assert.match(warnings[0], /installed version: 0\.8\.1/);
});
