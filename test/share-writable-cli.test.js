// `share-writable enable|disable <token-or-url>`: the agent CLI's version of
// the console's per-link "editable" toggle (PATCH /api/share/:tokenId).
// Before it, withdrawing --writable from a circulated link meant revoking the
// link and sending a new one. The end-to-end effect on an open share session
// is covered in attachment-api.test.js; this file covers the command surface.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-writable-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-writable-data-'));
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

function run(fixture, args) {
  return spawnSync(process.execPath, [pagesCliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
}

function runJson(fixture, args) {
  const result = run(fixture, [...args, '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runFailure(fixture, args) {
  const result = run(fixture, [...args, '--json']);
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout || result.stderr}`);
  return JSON.parse(result.stdout);
}

function runText(fixture, args) {
  const result = run(fixture, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function registerPage(fixture, uri) {
  const source = path.join(fixture.sourceRoot, `${uri.replace(/\//g, '-')}.md`);
  fs.writeFileSync(source, '# Page\n');
  runJson(fixture, ['register', '--component', 'recruit', '--uri', uri, '--source', source]);
  return uri;
}

function storedWritable(fixture, tokenId) {
  const db = new Database(path.join(fixture.dataDir, 'pages.db'), { readonly: true });
  const row = db.prepare('SELECT can_write_attachments FROM shares WHERE token_id = ?').get(tokenId);
  db.close();
  return row.can_write_attachments === 1;
}

test('share-writable grants and withdraws uploads on an existing link without changing it', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'writable/lifecycle');
  const shared = runJson(fixture, ['share', uri, '--duration', '7d']);
  assert.equal(shared.canWriteAttachments, false);

  // The full URL works as well as the bare token, as for share-info.
  const enabled = runJson(fixture, ['share-writable', 'enable', shared.shortUrl]);
  assert.deepEqual(enabled, {
    ok: true,
    command: 'share-writable',
    action: 'enable',
    tokenId: shared.tokenId,
    uri,
    canWriteAttachments: true,
    changed: true,
  });
  assert.equal(storedWritable(fixture, shared.tokenId), true);
  assert.equal(runJson(fixture, ['shares', uri]).shares[0].canWriteAttachments, true);
  assert.equal(runJson(fixture, ['share-info', shared.tokenId]).share.canWriteAttachments, true);

  const disabled = runJson(fixture, ['share-writable', 'disable', shared.tokenId]);
  assert.equal(disabled.canWriteAttachments, false);
  assert.equal(disabled.changed, true);
  assert.equal(storedWritable(fixture, shared.tokenId), false);

  // Same token, same expiry: the link that was handed out keeps working.
  const [listed] = runJson(fixture, ['shares', uri]).shares;
  assert.equal(listed.tokenId, shared.tokenId);
  assert.equal(listed.expiresAt, shared.expiresAt);
  assert.equal(listed.canWriteAttachments, false);
});

test('share-writable is idempotent and reports when nothing changed', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'writable/idempotent');
  const shared = runJson(fixture, ['share', uri, '--duration', '7d', '--writable']);

  const again = runJson(fixture, ['share-writable', 'enable', shared.tokenId]);
  assert.equal(again.canWriteAttachments, true);
  assert.equal(again.changed, false);

  runJson(fixture, ['share-writable', 'disable', shared.tokenId]);
  const readOnly = runJson(fixture, ['share-writable', 'disable', shared.tokenId]);
  assert.equal(readOnly.canWriteAttachments, false);
  assert.equal(readOnly.changed, false);
});

test('share-writable refuses links that cannot serve the page and leaves them unchanged', () => {
  const fixture = makeFixture();

  const revokedUri = registerPage(fixture, 'writable/revoked');
  const revoked = runJson(fixture, ['share', revokedUri, '--duration', '7d']);
  runJson(fixture, ['unshare', '--token', revoked.tokenId]);

  const expiredUri = registerPage(fixture, 'writable/expired');
  const expired = runJson(fixture, ['share', expiredUri, '--duration', '24h']);
  const db = new Database(path.join(fixture.dataDir, 'pages.db'));
  db.prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?').run(Date.now() - 60_000, expired.tokenId);
  db.close();

  const deletedUri = registerPage(fixture, 'writable/deleted');
  const deleted = runJson(fixture, ['share', deletedUri, '--duration', '7d']);
  runJson(fixture, ['unregister', deletedUri]);

  for (const tokenId of [revoked.tokenId, expired.tokenId, deleted.tokenId, '0'.repeat(32), 'not-a-token']) {
    assert.equal(runFailure(fixture, ['share-writable', 'enable', tokenId]).code, 'share_not_found', tokenId);
  }
  for (const tokenId of [revoked.tokenId, expired.tokenId, deleted.tokenId]) {
    assert.equal(storedWritable(fixture, tokenId), false, `${tokenId} must not have been granted uploads`);
  }
});

test('share-writable rejects a missing action or link', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'writable/args');
  const shared = runJson(fixture, ['share', uri, '--duration', '7d']);

  assert.equal(runFailure(fixture, ['share-writable']).code, 'invalid_args');
  assert.equal(runFailure(fixture, ['share-writable', 'on', shared.tokenId]).code, 'invalid_args');
  assert.equal(runFailure(fixture, ['share-writable', 'enable']).code, 'invalid_args');
  assert.equal(storedWritable(fixture, shared.tokenId), false);
});

test('share-writable, shares and share-info default output say whether a link is writable', () => {
  const fixture = makeFixture();
  const uri = registerPage(fixture, 'writable/output');
  const shared = runJson(fixture, ['share', uri, '--duration', '7d']);

  assert.ok(!runText(fixture, ['shares', uri]).includes('writable'));
  assert.match(runText(fixture, ['share-info', shared.tokenId]), /^Writable: no$/m);

  const enabled = runText(fixture, ['share-writable', 'enable', shared.tokenId]);
  assert.equal(enabled, `link ${shared.tokenId} on ${uri} is now writable; link holders can upload and delete this page's photos`);
  assert.match(runText(fixture, ['shares', uri]), new RegExp(`^${shared.tokenId} .* writable$`));
  assert.match(runText(fixture, ['share-info', shared.tokenId]), /^Writable: yes$/m);
  assert.equal(
    runText(fixture, ['share-writable', 'enable', shared.tokenId]),
    `link ${shared.tokenId} on ${uri} is already writable; nothing changed`,
  );

  const disabled = runText(fixture, ['share-writable', 'disable', shared.tokenId]);
  assert.equal(disabled, `link ${shared.tokenId} on ${uri} is now read-only; link holders can no longer upload or delete this page's photos`);
});

test('agent contract docs cover share-writable', () => {
  const usage = spawnSync(process.execPath, [pagesCliPath, 'help'], { cwd: repoRoot, encoding: 'utf8' }).stdout;
  assert.match(usage, /share-writable enable\|disable <token-or-url>/);
  for (const doc of ['SKILL.md', 'references/pages-cli.md']) {
    const text = fs.readFileSync(path.join(repoRoot, doc), 'utf8');
    for (const action of ['enable', 'disable']) {
      assert.match(text, new RegExp(`share-writable ${action}\\b`), `${doc} does not document \`share-writable ${action}\``);
    }
  }
});
