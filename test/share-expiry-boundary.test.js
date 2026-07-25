// The expiry boundary, pinned at the one instant where a loose comparison and
// a strict one disagree: expires_at === now.
//
// The live listings ask SQL for `expires_at > ?`, so a row whose expires_at
// equals now is already not live. `describeShare()` asked `now > expires_at`
// and therefore called that same row `active` — a status contract that
// contradicted the listing it is supposed to explain. One row, two answers.
//
// Real time cannot be parked on a single millisecond, so this test drives the
// clock instead of waiting: the row is aged to a fixed T and Date.now is
// pinned to T, T-1 and T+1 around it.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-boundary-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-boundary-data-'));
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

function runCli(fixture, args) {
  const result = spawnSync(process.execPath, [pagesCliPath, ...args, '--json'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

// The share manager binds to HOME / PAGES_DATA_DIR when it first initializes,
// so the fixture has to be in the environment before it is imported. node:test
// gives each file its own process, which is what makes that safe here.
const fixture = makeFixture();
const uri = 'boundary/one-instant';
const source = path.join(fixture.sourceRoot, 'boundary.md');
fs.writeFileSync(source, '# Page\n');
runCli(fixture, ['register', '--component', 'recruit', '--uri', uri, '--source', source]);
const shared = runCli(fixture, ['share', uri, '--duration', '24h']);

const EXPIRES_AT = shared.expiresAt;
assert.ok(EXPIRES_AT > 0, 'fixture share must have a real expiry');

process.env.HOME = fixture.home;
process.env.PAGES_DATA_DIR = fixture.dataDir;
const { describeShare, getActiveShare, listAllShares } = await import('../src/sharing/share-manager.js');

function atInstant(instant, fn) {
  const realNow = Date.now;
  Date.now = () => instant;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

test('one millisecond before expiry the share is live everywhere', () => {
  atInstant(EXPIRES_AT - 1, () => {
    assert.equal(describeShare(shared.tokenId).status, 'active');
    assert.notEqual(getActiveShare(shared.tokenId), null);
    assert.ok(listAllShares().some(share => share.tokenId === shared.tokenId));
  });
});

test('at exactly expires_at the status and the live listing agree it is gone', () => {
  atInstant(EXPIRES_AT, () => {
    // The listing is the canonical predicate; the status must not outrank it.
    assert.ok(!listAllShares().some(share => share.tokenId === shared.tokenId),
      'SQL liveness excludes expires_at === now');
    assert.equal(getActiveShare(shared.tokenId), null);
    assert.equal(describeShare(shared.tokenId).status, 'expired');
  });
});

test('after expiry the share is still traceable, just not active', () => {
  atInstant(EXPIRES_AT + 1, () => {
    const described = describeShare(shared.tokenId);
    assert.equal(described.status, 'expired');
    assert.equal(described.uri, uri, 'an expired link must still name its document');
    assert.equal(getActiveShare(shared.tokenId), null);
  });
});

// A permanent share has expires_at = 0, which is a smaller number than any
// instant. Whichever way the comparison is written it must not be read as
// "expired long ago".
test('a permanent share is never expired, including at instant 0', () => {
  const permanent = runCli(fixture, ['share', uri, '--duration', 'permanent']);
  atInstant(0, () => {
    assert.equal(describeShare(permanent.tokenId).status, 'active');
  });
  atInstant(EXPIRES_AT + 1_000_000, () => {
    assert.equal(describeShare(permanent.tokenId).status, 'active');
    assert.notEqual(getActiveShare(permanent.tokenId), null);
  });
});

// Guards the fixture itself: if the row were not really aged to EXPIRES_AT the
// tests above would pass for the wrong reason.
test('the fixture row really carries the expiry under test', () => {
  const db = new Database(path.join(fixture.dataDir, 'pages.db'));
  const row = db.prepare('SELECT expires_at FROM shares WHERE token_id = ?').get(shared.tokenId);
  db.close();
  assert.equal(row.expires_at, EXPIRES_AT);
});
