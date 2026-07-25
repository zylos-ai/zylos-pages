// Coverage for the share ledger becoming complete (0.7.6).
//
// Two defects motivated this, and neither had a test before:
//   1. The hourly cleanup hard-deleted expired share rows, so once a 7d link
//      lapsed there was no record it had ever existed — "someone hands me an
//      old link, which document was it?" was permanently unanswerable.
//   2. Even for rows that DID survive, no CLI command could resolve a token
//      back to its document. `shares` only lists live links; `unshare` revokes.
//
// The expiry tests below have to age a row by hand: the shortest offered
// duration is 24h, so no test can wait one out.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pagesCliPath = path.join(repoRoot, 'src/cli/pages.js');

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-ledger-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-ledger-data-'));
  const contentDir = path.join(home, 'zylos/http/public/pages');
  const sourceRoot = path.join(home, 'zylos/components/recruit');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    contentDir,
    externalFiles: { enabled: true, allowedSources: { recruit: sourceRoot } },
  }, null, 2));
  return { home, dataDir, contentDir, sourceRoot };
}

function runCli(fixture, args, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, [pagesCliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
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

// Run the hourly maintenance the server would run, in a fresh process bound to
// the fixture's data dir.
function runCleanup(fixture) {
  const managerUrl = new URL('../src/sharing/share-manager.js', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e', `import('${managerUrl}').then(m => m.cleanupShares());`,
  ], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

function expireRow(fixture, tokenId) {
  const db = new Database(path.join(fixture.dataDir, 'pages.db'));
  const changed = db.prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?')
    .run(Date.now() - 60_000, tokenId).changes;
  db.close();
  assert.equal(changed, 1, 'fixture must actually age the row');
}

function countRows(fixture, tokenId) {
  const db = new Database(path.join(fixture.dataDir, 'pages.db'));
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM shares WHERE token_id = ?').get(tokenId);
  db.close();
  return n;
}

test('an expired share row survives cleanup', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/expired-survives');
  const shared = runCli(fixture, ['share', uri, '--duration', '24h', '--json']);

  expireRow(fixture, shared.tokenId);
  runCleanup(fixture);

  assert.equal(countRows(fixture, shared.tokenId), 1, 'expired share rows must not be deleted');
});

test('share-info resolves an expired link back to its document', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/expired-lookup');
  const shared = runCli(fixture, ['share', uri, '--duration', '7d', '--json']);

  expireRow(fixture, shared.tokenId);
  runCleanup(fixture);
  const info = runCli(fixture, ['share-info', shared.tokenId, '--json']);

  assert.equal(info.ok, true);
  assert.equal(info.share.uri, uri);
  assert.equal(info.share.status, 'expired');
});

test('share-info reports a live link as active', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/active');
  const shared = runCli(fixture, ['share', uri, '--duration', '30d', '--json']);

  const info = runCli(fixture, ['share-info', shared.tokenId, '--json']);

  assert.equal(info.share.status, 'active');
  assert.equal(info.share.uri, uri);
  assert.equal(info.share.duration, '30d');
});

test('share-info reports a revoked link as revoked, with the time it happened', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/revoked');
  const shared = runCli(fixture, ['share', uri, '--duration', 'permanent', '--json']);
  runCli(fixture, ['unshare', '--token', shared.tokenId, '--json']);

  const info = runCli(fixture, ['share-info', shared.tokenId, '--json']);

  assert.equal(info.share.status, 'revoked');
  assert.equal(info.share.uri, uri);
  assert.ok(Number(info.share.revokedAt) > 0, 'revokedAt must be recorded');
});

// Revoked-and-expired is reachable (revoke a timed link, wait it out). Revoked
// is the deliberate act, so it wins — otherwise the passage of time would
// quietly rewrite the reason a link died.
test('a link that was revoked and then lapsed still reports as revoked', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/revoked-then-expired');
  const shared = runCli(fixture, ['share', uri, '--duration', '24h', '--json']);
  runCli(fixture, ['unshare', '--token', shared.tokenId, '--json']);
  expireRow(fixture, shared.tokenId);

  const info = runCli(fixture, ['share-info', shared.tokenId, '--json']);

  assert.equal(info.share.status, 'revoked');
});

test('share-info accepts the whole share URL, not just the token', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/url-form');
  const shared = runCli(fixture, ['share', uri, '--duration', '30d', '--json']);

  const info = runCli(fixture, ['share-info', shared.shortUrl, '--json']);

  assert.equal(info.share.tokenId, shared.tokenId);
  assert.equal(info.share.uri, uri);
});

// Negative controls. Without these, every assertion above could pass because
// share-info returns something for any input at all.
test('share-info fails on a well-formed token that was never issued', () => {
  const fixture = makeFixture();
  registerPage(fixture, 'ledger/unknown-token');

  const failed = runCli(fixture, ['share-info', 'f'.repeat(32), '--json'], { expectFailure: true });

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'share_not_found');
});

test('share-info fails on input that is not a token at all', () => {
  const fixture = makeFixture();
  registerPage(fixture, 'ledger/garbage-input');

  const failed = runCli(fixture, ['share-info', 'not-a-token', '--json'], { expectFailure: true });

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'share_not_found');
});

// Cleanup must still do its one remaining job. If this ever fails, `cleanupShares`
// has been gutted rather than narrowed.
test('cleanup still deletes expired share sessions', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'ledger/session-cleanup');
  const shared = runCli(fixture, ['share', uri, '--duration', '30d', '--json']);

  const dbPath = path.join(fixture.dataDir, 'pages.db');
  let db = new Database(dbPath);
  const row = db.prepare('SELECT page_id FROM shares WHERE token_id = ?').get(shared.tokenId);
  db.prepare(`INSERT INTO share_sessions (token_hash, token_id, page_id, created_at, last_activity_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('deadbeef', shared.tokenId, row.page_id, Date.now() - 7200_000, Date.now() - 7200_000, Date.now() - 60_000);
  db.close();

  runCleanup(fixture);

  db = new Database(dbPath);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM share_sessions WHERE token_hash = ?').get('deadbeef');
  db.close();
  assert.equal(n, 0, 'expired sessions must still be deleted');
});
