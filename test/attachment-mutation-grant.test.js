// Direct tests for the attachment mutation gate.
//
// These exist because the route-level suite cannot reach this code path with a
// mismatched page: the auth middleware refuses such a request first, so every
// HTTP assertion passes whether or not the gate re-checks the binding. That
// makes the route tests blind to exactly the property the gate is for — being
// the check that survives if the middleware ever stops doing that job. Verified
// by deleting the binding line and watching this file fail while the route
// suite stayed green.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-grant-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const { shareMutationGrant } = await import('../src/routes/attachment-api.js');
const { registerLogicalPage, unregisterLogicalPage } = await import('../src/pages/page-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-grant-content-'));

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

// A response as the auth middleware would have left it for a writable share.
function shareRes({ pageId, canWrite = true, viewerType = 'share' }) {
  return {
    locals: {
      viewerType,
      shareCanWriteAttachments: canWrite,
      shareContext: { tokenId: 'a'.repeat(32), pageId },
    },
  };
}

const own = await makePage('grant-own');
const other = await makePage('grant-other');

test('a writable share is granted its own page', () => {
  assert.ok(shareMutationGrant(shareRes({ pageId: own.pageId }), 'grant-own'));
});

test('a writable share is refused a page it was not issued for', () => {
  // The token is live, writable and well-formed; only the target differs.
  assert.equal(shareMutationGrant(shareRes({ pageId: own.pageId }), 'grant-other'), null);
});

test('the binding compares page identity, not the name in the path', () => {
  // Same uri string, different page id — the shape a stale or forged context
  // would have. A name comparison would let this through.
  assert.equal(shareMutationGrant(shareRes({ pageId: 'not-a-real-page-id' }), 'grant-own'), null);
});

test('a share without the capability is refused its own page', () => {
  assert.equal(shareMutationGrant(shareRes({ pageId: own.pageId, canWrite: false }), 'grant-own'), null);
});

test('the capability is only honoured for share viewers', () => {
  assert.equal(shareMutationGrant(shareRes({ pageId: own.pageId, viewerType: 'none' }), 'grant-own'), null);
});

test('a missing or id-less share context is refused', () => {
  assert.equal(shareMutationGrant({ locals: { viewerType: 'share', shareCanWriteAttachments: true } }, 'grant-own'), null);
  assert.equal(
    shareMutationGrant({ locals: { viewerType: 'share', shareCanWriteAttachments: true, shareContext: {} } }, 'grant-own'),
    null
  );
});

test('an unregistered page has no identity to match and is refused', () => {
  const doomed = shareRes({ pageId: other.pageId });
  assert.ok(shareMutationGrant(doomed, 'grant-other'));
  unregisterLogicalPage('grant-other');
  assert.equal(shareMutationGrant(doomed, 'grant-other'), null);
});
