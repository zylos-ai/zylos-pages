// Regression coverage for the CLI's DEFAULT (non-JSON) output.
//
// Both bugs below shipped in a branch whose test suite was green, because
// every share test asserted on `--json`. The human-readable path — the one an
// operator actually reads during an incident — had no assertions at all:
//   * `shares --all` printed token + expiry and no uri, so the command built
//     to answer "what is exposed here?" could not say which document.
//   * `unshare --token` printed "revoked 1 share(s) for undefined".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pagesCliPath = path.join(repoRoot, 'src/cli/pages.js');

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-cliout-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-cliout-data-'));
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const sourceRoot = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    contentDir,
    externalFiles: { enabled: true, allowedSources: { recruit: sourceRoot } },
  }, null, 2));
  return { home, dataDir, sourceRoot };
}

// Returns raw stdout, deliberately un-parsed: the point is what a human sees.
function runCliText(fixture, args) {
  const result = spawnSync(process.execPath, [pagesCliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runCliJson(fixture, args) {
  const result = spawnSync(process.execPath, [pagesCliPath, ...args.concat('--json')], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function registerPage(fixture, uri) {
  const source = path.join(fixture.sourceRoot, `${uri.replace(/\//g, '-')}.md`);
  fs.writeFileSync(source, '# Page\n');
  runCliJson(fixture, ['register', '--component', 'recruit', '--uri', uri, '--source', source]);
  return uri;
}

test('`shares --all` default output names the document each token exposes', () => {
  const fixture = makeFixture();
  const first = registerPage(fixture, 'output/alpha');
  const second = registerPage(fixture, 'output/beta');
  runCliJson(fixture, ['share', first, '--duration', '30d']);
  runCliJson(fixture, ['share', second, '--duration', 'permanent']);

  const text = runCliText(fixture, ['shares', '--all']);

  const lines = text.split('\n');
  assert.equal(lines.length, 2, `expected two share lines, got:\n${text}`);
  assert.ok(text.includes(first), `output must name ${first}:\n${text}`);
  assert.ok(text.includes(second), `output must name ${second}:\n${text}`);
  assert.ok(!text.includes('undefined'), `output must not contain "undefined":\n${text}`);
});

test('`unshare --token` default output names the page, not "undefined"', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/revoke-me');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '7d']);

  const text = runCliText(fixture, ['unshare', '--token', shared.tokenId]);

  assert.ok(text.includes(uri), `output must name ${uri}, got: ${text}`);
  assert.ok(!text.includes('undefined'), `output must not contain "undefined", got: ${text}`);
});

test('`unshare --token` reports the uri in JSON too', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/revoke-json');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '7d']);

  const revoked = runCliJson(fixture, ['unshare', '--token', shared.tokenId]);

  assert.equal(revoked.uri, uri);
  assert.equal(revoked.revoked, 1);
});

// Negative control: `shares <uri>` is per-page, so a uri column there would be
// noise. If this ever starts printing the uri, the humanizer stopped
// distinguishing the two forms and the test above proves less than it looks.
test('per-page `shares <uri>` output stays token + expiry', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/per-page');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '30d']);

  const text = runCliText(fixture, ['shares', uri]);

  assert.ok(text.startsWith(shared.tokenId), `expected token first, got: ${text}`);
  assert.ok(!text.includes(uri), `per-page listing should not repeat the uri, got: ${text}`);
});
