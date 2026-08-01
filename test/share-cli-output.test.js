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
import Database from 'better-sqlite3';

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

// --- share-info default output ---
//
// `share-info` was added with nine tests, every one of them on `--json`. That
// is the same blind spot that shipped the two bugs at the top of this file, on
// a command whose whole audience is a person holding a link they cannot place.

function expireRow(fixture, tokenId) {
  const db = new Database(path.join(fixture.dataDir, 'pages.db'));
  const changed = db.prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?')
    .run(Date.now() - 60_000, tokenId).changes;
  db.close();
  assert.equal(changed, 1, 'fixture must actually age the row');
}

function fieldOf(text, label) {
  const line = text.split('\n').find(row => row.startsWith(`${label}:`));
  assert.ok(line, `output has no "${label}:" line:\n${text}`);
  return line.slice(label.length + 1).trim();
}

test('`share-info` default output names the document and its status', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-active');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '30d']);

  const text = runCliText(fixture, ['share-info', shared.tokenId]);

  assert.equal(fieldOf(text, 'Document'), uri);
  assert.equal(fieldOf(text, 'Status'), 'active');
  assert.equal(fieldOf(text, 'Duration'), '30d');
  // An active, non-permanent share must print a real date, not "never".
  assert.ok(!Number.isNaN(Date.parse(fieldOf(text, 'Expires'))), `Expires must be a date:\n${text}`);
  assert.ok(!text.includes('Revoked:'), `an active share must not report a revocation:\n${text}`);
  assert.ok(!text.includes('undefined'), `output must not contain "undefined":\n${text}`);
});

test('`share-info` default output says "never" for a permanent share', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-permanent');
  const shared = runCliJson(fixture, ['share', uri, '--duration', 'permanent']);

  const text = runCliText(fixture, ['share-info', shared.tokenId]);

  assert.equal(fieldOf(text, 'Status'), 'active');
  assert.equal(fieldOf(text, 'Duration'), 'permanent');
  // The raw value is 0; printing "1970-01-01" here would read as long expired.
  assert.equal(fieldOf(text, 'Expires'), 'never');
});

test('`share-info` default output still names the document of an expired link', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-expired');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '24h']);
  expireRow(fixture, shared.tokenId);

  const text = runCliText(fixture, ['share-info', shared.tokenId]);

  assert.equal(fieldOf(text, 'Document'), uri, 'the whole point is that a dead link still names its document');
  assert.equal(fieldOf(text, 'Status'), 'expired');
  assert.ok(!text.includes('Revoked:'), `expired is not revoked:\n${text}`);
});

test('`share-info` default output reports the revocation time of a revoked link', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-revoked');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '7d']);
  runCliJson(fixture, ['unshare', '--token', shared.tokenId]);

  const text = runCliText(fixture, ['share-info', shared.tokenId]);

  assert.equal(fieldOf(text, 'Document'), uri);
  assert.equal(fieldOf(text, 'Status'), 'revoked');
  assert.ok(!Number.isNaN(Date.parse(fieldOf(text, 'Revoked'))), `Revoked must be a date:\n${text}`);
});

test('`share-info` default output says the document is gone, in words', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-deleted');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '30d']);
  runCliJson(fixture, ['unregister', uri]);

  const text = runCliText(fixture, ['share-info', shared.tokenId]);

  const document = fieldOf(text, 'Document');
  assert.ok(document.startsWith(uri), `must still name the document, got: ${document}`);
  // A bare "Document: output/info-deleted" would read as "it is right there".
  assert.match(document, /deleted/, `must say the document is gone, got: ${document}`);
  assert.equal(fieldOf(text, 'Status'), 'document_deleted');
});

test('`share-info` default output accepts the full share URL', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/info-url');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '7d']);

  const text = runCliText(fixture, ['share-info', shared.shortUrl]);

  assert.equal(fieldOf(text, 'Document'), uri);
  assert.equal(fieldOf(text, 'Status'), 'active');
});

// Negative control: `shares <uri>` is per-page, so a uri column there would be
// noise. Protection is still shown because it is a property of each token.
test('per-page `shares <uri>` output stays token + expiry + protection without repeating the uri', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'output/per-page');
  const shared = runCliJson(fixture, ['share', uri, '--duration', '30d']);

  const text = runCliText(fixture, ['shares', uri]);

  assert.ok(text.startsWith(shared.tokenId), `expected token first, got: ${text}`);
  assert.match(text, /\bunprotected\b/, `expected protection metadata, got: ${text}`);
  assert.ok(!text.includes(uri), `per-page listing should not repeat the uri, got: ${text}`);
});
