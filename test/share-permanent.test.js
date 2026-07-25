// Coverage for `sharing.allowPermanent` removal (0.7.5).
//
// Before 0.7.5 the default config carried `allowPermanent: false`, so a config
// that never mentioned sharing rejected `--duration permanent` with a 403. The
// suite had no `permanent` case at all, so that behaviour — and its removal —
// was entirely untested. These tests pin the new contract from a config with no
// `sharing` key, which is exactly the case the old default governed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pagesCliPath = path.join(repoRoot, 'src/cli/pages.js');
const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-permanent-test-'));

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-permanent-home-'));
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const sourceRoot = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(sharedDataDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  // Deliberately no `sharing` key: this is the config shape the removed
  // `allowPermanent: false` default used to apply to.
  fs.writeFileSync(path.join(sharedDataDir, 'config.json'), JSON.stringify({
    contentDir,
    externalFiles: { enabled: true, allowedSources: { recruit: sourceRoot } },
  }, null, 2));
  return { home, contentDir, sourceRoot };
}

function runCli(fixture, args, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, [pagesCliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: sharedDataDir },
    encoding: 'utf8',
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `expected failure, got: ${result.stdout || result.stderr}`);
    return JSON.parse(result.stdout);
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function registerPage(fixture, uri) {
  const source = path.join(fixture.sourceRoot, `${uri.replace(/\//g, '-')}.md`);
  fs.writeFileSync(source, '# Page\n');
  const registered = runCli(fixture, [
    'register', '--component', 'recruit', '--uri', uri, '--source', source, '--json',
  ]);
  assert.equal(registered.ok, true);
  return uri;
}

test('permanent shares are allowed with no sharing config present', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'permanent/allowed');

  const shared = runCli(fixture, ['share', uri, '--duration', 'permanent', '--json']);

  assert.equal(shared.ok, true);
  assert.equal(shared.duration, 'permanent');
  // 0 is how "never expires" is stored; `expires_at IS NULL` is NOT the
  // predicate for a permanent share and never was.
  assert.equal(shared.expiresAt, 0);
  assert.match(shared.tokenId, /^[0-9a-f]{32}$/);
});

test('a permanent share shows up as live in the instance-wide inventory', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'permanent/inventory');

  const shared = runCli(fixture, ['share', uri, '--duration', 'permanent', '--json']);
  const inventory = runCli(fixture, ['shares', '--all', '--json']);

  assert.equal(inventory.ok, true);
  const found = inventory.shares.filter(s => s.tokenId === shared.tokenId);
  assert.equal(found.length, 1, 'permanent share must appear in `shares --all`');
  assert.equal(found[0].expiresAt, 0);
});

// Negative control. Without this, the two tests above could pass simply because
// every duration is waved through, which would tell us nothing about whether the
// permanent path is real. Duration validation must still reject a bad value.
test('an unknown duration is still rejected', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'permanent/negative-control');

  const failed = runCli(fixture, ['share', uri, '--duration', 'forever-and-ever', '--json'], { expectFailure: true });

  assert.equal(failed.ok, false);
  assert.match(failed.error || failed.message || '', /Invalid duration/i);
});
