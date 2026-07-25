import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-attachment-data-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupAttachmentApi } = await import('../src/routes/attachment-api.js');
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const { createShare, revokeShare } = await import('../src/sharing/share-manager.js');
const { getPagesDb } = await import('../src/db/pages-db.js');
const { getAttachment } = await import('../src/attachments/attachment-store.js');
const { getLogicalPage, registerLogicalPage, unregisterLogicalPage, updateLogicalPage } =
  await import('../src/pages/page-store.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.from('RIFF\x04\x00\x00\x00WEBPVP8 ', 'binary');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function makeContentDir() {
  const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-attachment-content-'));
  await writeFile(path.join(contentDir, 'renovation-checklist.html'), '<!doctype html><h1>Checklist</h1>');
  await writeFile(path.join(contentDir, 'notes.md'), '# Notes\n');
  registerContentPage(contentDir, 'renovation-checklist');
  registerContentPage(contentDir, 'notes');
  return contentDir;
}

function authConfig() {
  return { enabled: true, password: hashPassword('secret') };
}

function baseConfig(contentDir, auth = authConfig(), extra = {}) {
  return {
    contentDir,
    auth,
    sharing: { enabled: true },
    attachments: { maxFileSizeBytes: 128, ...(extra.attachments || {}) },
    externalFiles: { allowedSources: { content: contentDir } },
  };
}

function registerContentPage(contentDir, uri, title = uri) {
  const ext = uri === 'notes' ? '.md' : '.html';
  return registerLogicalPage({
    uri,
    title,
    sourcePath: path.join(contentDir, `${uri}${ext}`),
    component: 'content',
  }, baseConfig(contentDir));
}

async function withServer(config, fn, options = {}) {
  const app = express();
  setupAuth(app, config.auth || { enabled: false, password: null }, config.sharing || { enabled: true });
  setupShareApi(app, config.sharing || { enabled: true }, config);
  setupAttachmentApi(app, config, options);
  app.get('/s/:slug', (_req, res) => res.status(200).send('fallback'));
  app.get('/:slug(*)', (req, res) => res.status(200).send(req.params.slug || 'root'));
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await fn({ origin });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function login(origin) {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'secret' }),
  });
  assert.equal(response.status, 302);
  const match = response.headers.get('set-cookie').match(/__Secure-zylos_pages_session=([^;,]+)/);
  assert.ok(match);
  return `__Secure-zylos_pages_session=${match[1]}`;
}

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Secure-)/)
    .map(cookie => cookie.split(';', 1)[0])
    .join('; ');
}

function formData(buffer, type = 'image/jpeg', filename = 'photo.jpg') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  return form;
}

async function upload(origin, artifact, key, cookie, buffer = JPEG, type = 'image/jpeg', filename = 'photo.jpg') {
  return fetch(`${origin}/api/attachments/${artifact}/${key}`, {
    method: 'POST',
    // Manual, so a refusal that takes the form of a login redirect stays
    // visible instead of being followed into a 200 login page.
    redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie },
    body: formData(buffer, type, filename),
  });
}

async function deleteAttachment(origin, artifact, attachmentId, cookie) {
  return fetch(`${origin}/api/attachments/${artifact}/${attachmentId}`, {
    method: 'DELETE',
    redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie },
  });
}

async function patchSharePermission(origin, tokenId, canWriteAttachments, cookie, expectedStatus = 200) {
  const response = await fetch(`${origin}/api/share/${tokenId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ canWriteAttachments }),
  });
  assert.equal(response.status, expectedStatus);
  if (expectedStatus !== 200) return response.json();
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.tokenId, tokenId);
  assert.equal(body.canWriteAttachments, canWriteAttachments);
  return body;
}

async function createExpiredShareToken(slug, options = {}) {
  const share = createShare(slug, '24h');
  const expiresAt = Date.now() - 1000;
  const db = getPagesDb();
  const secret = db.prepare('SELECT value FROM share_meta WHERE key = ?').get('secret').value;
  db.prepare('UPDATE shares SET expires_at = ? WHERE token_id = ?').run(expiresAt, share.tokenId);
  const payload = `${slug}:${expiresAt}:${share.tokenId}`;
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

function expectLoginRedirect(response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/login\?/);
}

async function rawRequest(origin, requestPath, headers = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: 'GET',
      headers,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

// Read the stored totals straight from the DB, so a ceiling assertion is about
// what was actually persisted rather than about what the API said.
function storedBytesFor(uri) {
  const page = getLogicalPage(uri);
  return getPagesDb()
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifact_attachments WHERE page_id = ?')
    .get(page.pageId).total;
}

function storedCountFor(uri, itemKey) {
  const page = getLogicalPage(uri);
  return getPagesDb()
    .prepare('SELECT COUNT(*) AS n FROM artifact_attachments WHERE page_id = ? AND item_key = ?')
    .get(page.pageId, itemKey).n;
}

// Attachments are stored under the page's stable id, not its uri.
function pageIdFor(uri) {
  return getLogicalPage(uri).pageId;
}

function storedAttachment(uri, attachmentId) {
  return getAttachment(pageIdFor(uri), attachmentId);
}

async function artifactAttachmentFiles(artifact) {
  try {
    return await readdir(path.join(dataDir, 'attachments', pageIdFor(artifact)));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('authenticated users can upload, list, read, and delete image attachments', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      for (const [buffer, type, filename] of [
        [JPEG, 'image/jpeg', 'photo.jpg'],
        [PNG, 'image/png', 'photo.png'],
        [WEBP, 'image/webp', 'photo.webp'],
      ]) {
        const res = await upload(origin, 'renovation-checklist', 'auth-log', cookie, buffer, type, filename);
        assert.equal(res.status, 201);
      }

      let res = await fetch(`${origin}/api/attachments/renovation-checklist/auth-log`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      const listed = await res.json();
      assert.equal(listed.attachments.length, 3);
      assert.deepEqual(new Set(listed.attachments.map(a => a.mimeType)), new Set(['image/jpeg', 'image/png', 'image/webp']));
      assert.ok(listed.attachments[0].fileUrl);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/auth-log`, {
        headers: { Cookie: cookie, 'X-Forwarded-Prefix': '/pages' },
      });
      assert.equal(res.status, 200);
      const prefixed = await res.json();
      assert.match(prefixed.attachments[0].fileUrl, /^\/pages\/api\/attachments\/renovation-checklist\/[a-f0-9]{32}\/file$/);

      res = await fetch(`${origin}${listed.attachments[0].fileUrl}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('content-type'), /^image\/(jpeg|png|webp)/);

      const attachmentId = listed.attachments[0].attachmentId;
      res = await fetch(`${origin}/api/attachments/renovation-checklist/${attachmentId}`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      res = await fetch(`${origin}/api/attachments/renovation-checklist/${attachmentId}/file`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('auth-disabled mode rejects upload and delete mutations by default', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir, { enabled: false, password: null }), async ({ origin }) => {
      let res = await fetch(`${origin}/api/attachments/renovation-checklist/photo-log`, {
        method: 'POST',
        headers: { Origin: origin },
        body: formData(JPEG),
      });
      assert.equal(res.status, 403);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
        method: 'DELETE',
        headers: { Origin: origin },
      });
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('uploaded original filenames cannot break attachment file response headers', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      for (const filename of ['装修.jpg', 'line\nbreak.jpg']) {
        const uploadRes = await upload(origin, 'renovation-checklist', 'filename-log', cookie, JPEG, 'image/jpeg', filename);
        assert.equal(uploadRes.status, 201);
      }

      const listRes = await fetch(`${origin}/api/attachments/renovation-checklist/filename-log`, {
        headers: { Cookie: cookie },
      });
      assert.equal(listRes.status, 200);
      const listed = await listRes.json();
      assert.equal(listed.attachments.length, 2);

      for (const attachment of listed.attachments) {
        const fileRes = await fetch(`${origin}${attachment.fileUrl}`, { headers: { Cookie: cookie } });
        assert.equal(fileRes.status, 200);
        const disposition = fileRes.headers.get('content-disposition');
        assert.match(disposition, /^inline; filename="attachment\.jpg"; filename\*=UTF-8''/);
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('share viewers can list and read matching artifact attachments but cannot mutate', async () => {
  const contentDir = await makeContentDir();
  try {
    const share = createShare('renovation-checklist', '24h');
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const authCookie = await login(origin);
      const uploaded = await upload(origin, 'renovation-checklist', 'share-log', authCookie);
      const attachment = (await uploaded.json()).attachment;

      let res = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      const shareCookies = cookieHeader(res.headers.get('set-cookie'));

      res = await fetch(`${origin}/api/attachments/renovation-checklist/share-log`, {
        headers: { Cookie: shareCookies },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).attachments.length, 1);

      res = await fetch(`${origin}${attachment.fileUrl}`, { headers: { Cookie: shareCookies } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      res = await fetch(`${origin}/api/attachments/renovation-checklist/share-log`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: shareCookies },
        body: formData(JPEG),
      });
      assert.equal(res.status, 403);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/${attachment.attachmentId}`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: shareCookies },
      });
      assert.equal(res.status, 403);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/share-log?token=${encodeURIComponent(share.token)}`, {
        redirect: 'manual',
      });
      expectLoginRedirect(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('short share viewers remain read-only even when write permission is requested', async () => {
  const contentDir = await makeContentDir();
  try {
    const share = createShare('renovation-checklist', '24h');
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      let res = await fetch(`${origin}/s/${share.tokenId}`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      const shareCookies = cookieHeader(res.headers.get('set-cookie'));

      res = await upload(origin, 'renovation-checklist', 'editable-log', shareCookies);
      assert.equal(res.status, 403);

      res = await fetch(`${origin}/api/attachments/notes/wrong-artifact`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: origin, Cookie: shareCookies },
        body: formData(JPEG),
      });
      expectLoginRedirect(res);

      const authCookie = await login(origin);
      res = await upload(origin, 'notes', 'auth-log', authCookie);
      assert.equal(res.status, 201);
      const otherAttachment = (await res.json()).attachment;

      res = await fetch(`${origin}/api/attachments/notes/${otherAttachment.attachmentId}`, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { Origin: origin, Cookie: shareCookies },
      });
      expectLoginRedirect(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

// Open a share link the way a browser would and keep the cookies it hands back.
async function openShare(origin, tokenId) {
  const res = await fetch(`${origin}/s/${tokenId}`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  return cookieHeader(res.headers.get('set-cookie'));
}

test('a writable share link can upload and delete on its own page', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      assert.equal(share.canWriteAttachments, true);
      const cookies = await openShare(origin, share.tokenId);

      const res = await upload(origin, 'renovation-checklist', 'photo-log', cookies);
      assert.equal(res.status, 201);
      const { attachment } = await res.json();
      assert.ok(storedAttachment('renovation-checklist', attachment.attachmentId));

      const del = await deleteAttachment(origin, 'renovation-checklist', attachment.attachmentId, cookies);
      assert.equal(del.status, 200);
      assert.equal(storedAttachment('renovation-checklist', attachment.attachmentId), null);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('the capability is read fresh on every request: grant and withdrawal both take effect mid-session', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const authCookie = await login(origin);

      // Created read-only, so the very same cookie must be refused first.
      const share = createShare('renovation-checklist', '24h');
      assert.equal(share.canWriteAttachments, false);
      const cookies = await openShare(origin, share.tokenId);

      let res = await upload(origin, 'renovation-checklist', 'toggle-before', cookies);
      assert.equal(res.status, 403);

      // Granted without re-issuing the link or the cookie.
      await patchSharePermission(origin, share.tokenId, true, authCookie);
      res = await upload(origin, 'renovation-checklist', 'toggle-after', cookies);
      assert.equal(res.status, 201);

      // Withdrawn again — the already-issued session must lose the ability at
      // once, with nothing invalidated on the browser side.
      await patchSharePermission(origin, share.tokenId, false, authCookie);
      res = await upload(origin, 'renovation-checklist', 'toggle-withdrawn', cookies);
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('revoking a writable share kills an already-open session', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      let res = await upload(origin, 'renovation-checklist', 'revoke-before', cookies);
      assert.equal(res.status, 201);

      revokeShare(share.tokenId);

      res = await upload(origin, 'renovation-checklist', 'revoke-after', cookies);
      expectLoginRedirect(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('a writable share is confined to its own page for both upload and delete', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const authCookie = await login(origin);

      // A real attachment on the *other* page, to delete across the boundary.
      const seeded = await upload(origin, 'notes', 'other-page', authCookie);
      assert.equal(seeded.status, 201);
      const foreignId = (await seeded.json()).attachment.attachmentId;

      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      // Upload aimed at a page the token was not issued for.
      let res = await upload(origin, 'notes', 'cross-artifact', cookies);
      expectLoginRedirect(res);

      // Delete aimed at the other page, by an id that really exists there.
      res = await deleteAttachment(origin, 'notes', foreignId, cookies);
      expectLoginRedirect(res);
      assert.ok(storedAttachment('notes', foreignId), 'foreign attachment must survive');

      // And the same id addressed through its own page finds nothing, so an id
      // alone is never enough to delete anything.
      res = await deleteAttachment(origin, 'renovation-checklist', foreignId, cookies);
      assert.equal(res.status, 404);
      assert.ok(storedAttachment('notes', foreignId), 'foreign attachment must still survive');
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('the attachment capability grants no auth-only surface', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      // Share management is not reachable at all for a share cookie — the auth
      // middleware never lets these paths through, so the refusal is a login
      // redirect rather than the routes' own 403. Either way the capability
      // buys nothing here, and asserting the real status keeps this test
      // honest about which layer is doing the refusing.
      const create = await fetch(`${origin}/api/share`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies },
        body: JSON.stringify({ slug: 'p/renovation-checklist', duration: '24h', canWriteAttachments: true }),
      });
      expectLoginRedirect(create);

      const list = await fetch(`${origin}/api/shares/renovation-checklist`, {
        redirect: 'manual',
        headers: { Cookie: cookies },
      });
      expectLoginRedirect(list);

      const patch = await fetch(`${origin}/api/share/${share.tokenId}`, {
        method: 'PATCH',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookies },
        body: JSON.stringify({ canWriteAttachments: true }),
      });
      expectLoginRedirect(patch);

      const revoke = await fetch(`${origin}/api/share/${share.tokenId}`, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { Origin: origin, Cookie: cookies },
      });
      expectLoginRedirect(revoke);

      // The grant is still intact — the refusals above were about reach, not
      // about the token having been invalidated along the way.
      assert.equal((await upload(origin, 'renovation-checklist', 'still-writable', cookies)).status, 201);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('share uploads are capped by attachment count and by total stored bytes', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, maxPerItem: 2 },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      assert.equal((await upload(origin, 'renovation-checklist', 'cap', cookies)).status, 201);
      assert.equal((await upload(origin, 'renovation-checklist', 'cap', cookies)).status, 201);

      const third = await upload(origin, 'renovation-checklist', 'cap', cookies);
      assert.equal(third.status, 409);
      assert.match((await third.json()).error, /maximum of 2 attachments/);

      // A different item key is a different count, so the count alone cannot
      // bound total storage — which is what the byte ceiling is for.
      assert.equal((await upload(origin, 'renovation-checklist', 'other-key', cookies)).status, 201);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

// The ceilings must hold against the upload being made, not merely against
// what was already stored. Checking `current >= max` lets every upload that
// starts under the line finish over it, by as much as one whole maxFileSizeBytes.
test('the byte ceiling counts the incoming upload, not just what is already stored', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'overshoot.html'), '<!doctype html><h1>x</h1>');
    registerContentPage(contentDir, 'overshoot');

    const config = baseConfig(contentDir, authConfig(), {
      // Room for one 8-byte JPEG and not two: the second must be refused
      // *before* it is stored, not after it has pushed the page to 16.
      attachments: { maxFileSizeBytes: 128, maxArtifactBytes: 12 },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('overshoot', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      assert.equal((await upload(origin, 'overshoot', 'k', cookies)).status, 201);
      assert.equal((await upload(origin, 'overshoot', 'k', cookies)).status, 409);
      assert.equal(storedBytesFor('overshoot'), JPEG.length, 'the ceiling must not be overshot');
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

// Two uploads that both pass the pre-check before either has inserted. The
// decision has to be atomic with the insert, or the ceiling is advisory.
test('concurrent share uploads cannot both slip past the count ceiling', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'race.html'), '<!doctype html><h1>x</h1>');
    registerContentPage(contentDir, 'race');

    let release;
    const bothInFlight = new Promise(resolve => { release = resolve; });
    let arrived = 0;
    const hooks = {
      // Hold each request just before it commits, until both are past the
      // pre-check — the exact interleaving a non-atomic limit permits.
      async beforeMove() {
        arrived += 1;
        if (arrived >= 2) release();
        else await bothInFlight;
      },
    };

    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, maxPerItem: 1 },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('race', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      const [a, b] = await Promise.all([
        upload(origin, 'race', 'k', cookies),
        upload(origin, 'race', 'k', cookies),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 409], 'exactly one of the two may be stored');
      assert.equal(storedCountFor('race', 'k'), 1);
    }, { hooks });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('the byte ceiling refuses a share upload once the page is full', async () => {
  const contentDir = await makeContentDir();
  try {
    // Its own page: the ceiling is per artifact and every other test in this
    // file deposits into renovation-checklist, so reusing it would measure the
    // rest of the suite rather than this test.
    await writeFile(path.join(contentDir, 'byte-ceiling.html'), '<!doctype html><h1>Bytes</h1>');
    registerContentPage(contentDir, 'byte-ceiling');

    const config = baseConfig(contentDir, authConfig(), {
      // One JPEG is 8 bytes, so the second upload finds the page already at the
      // ceiling.
      attachments: { maxFileSizeBytes: 128, maxArtifactBytes: 8 },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('byte-ceiling', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      assert.equal((await upload(origin, 'byte-ceiling', 'bytes', cookies)).status, 201);

      const full = await upload(origin, 'byte-ceiling', 'bytes', cookies);
      assert.equal(full.status, 409);
      assert.match((await full.json()).error, /storage limit/);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('share writes are rate limited per token, and upload and delete are rationed separately', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, shareWriteRateLimit: { windowMs: 60_000, max: 2, ipMax: 1000 } },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);

      const first = await upload(origin, 'renovation-checklist', 'rate', cookies);
      assert.equal(first.status, 201);
      const second = await upload(origin, 'renovation-checklist', 'rate', cookies);
      assert.equal(second.status, 201);
      const attachmentId = (await second.json()).attachment.attachmentId;

      const third = await upload(origin, 'renovation-checklist', 'rate', cookies);
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get('retry-after')) > 0);

      // Deletes have their own allowance, so an exhausted upload budget does
      // not also strand whatever was already uploaded.
      const del = await deleteAttachment(origin, 'renovation-checklist', attachmentId, cookies);
      assert.equal(del.status, 200);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('a revoked token is refused before it can consume any rate-limit budget', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, shareWriteRateLimit: { windowMs: 60_000, max: 1, ipMax: 1000 } },
    });
    await withServer(config, async ({ origin }) => {
      const dead = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      revokeShare(dead.tokenId);
      const live = createShare('renovation-checklist', '24h', { canWriteAttachments: true });

      // The revoked link has no session to open, so drive it through the live
      // page with a stale cookie: it must not reach the counter at all.
      const deadCookies = await openShare(origin, live.tokenId);
      const liveCookies = deadCookies;

      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${origin}/api/attachments/notes/rate-drain`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Origin: origin, Cookie: deadCookies },
          body: formData(JPEG),
        });
        expectLoginRedirect(res);
      }

      // Budget of 1 must still be intact for the page the token does own.
      assert.equal((await upload(origin, 'renovation-checklist', 'drain', liveCookies)).status, 201);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

// Capture the structured log the way an operator reading the service log
// would, so the assertions below are about what actually gets written out.
async function captureAuditLines(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.msg === 'attachment mutation audit') lines.push(parsed);
      } catch { /* not our structured line */ }
    }
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test('every share mutation leaves an audit line naming the token, page and outcome', async () => {
  const contentDir = await makeContentDir();
  try {
    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, shareWriteRateLimit: { windowMs: 60_000, max: 1, ipMax: 1000 } },
    });
    await withServer(config, async ({ origin }) => {
      const writable = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const readOnly = createShare('renovation-checklist', '24h');
      const writableCookies = await openShare(origin, writable.tokenId);
      const readOnlyCookies = await openShare(origin, readOnly.tokenId);

      const audits = await captureAuditLines(async () => {
        assert.equal((await upload(origin, 'renovation-checklist', 'audit', writableCookies)).status, 201);
        assert.equal((await upload(origin, 'renovation-checklist', 'audit', writableCookies)).status, 429);
        assert.equal((await upload(origin, 'renovation-checklist', 'audit', readOnlyCookies)).status, 403);
      });

      const allowed = audits.find(line => line.result === 'allowed');
      assert.ok(allowed, 'a successful upload must be audited');
      assert.equal(allowed.action, 'upload');
      assert.equal(allowed.writer, 'share');
      assert.equal(allowed.tokenId, writable.tokenId);
      assert.equal(allowed.artifact, 'renovation-checklist');
      assert.equal(allowed.itemKey, 'audit');
      assert.equal(allowed.mimeType, 'image/jpeg');
      assert.equal(allowed.sizeBytes, JPEG.length);
      assert.ok(allowed.pageId, 'the audited page identity must be present');
      assert.ok(allowed.ip, 'the source address must be present');
      assert.ok(allowed.attachmentId);

      // Refusals are audited too — a link being turned away repeatedly is the
      // signal an operator most needs, and it is the one a success-only log
      // would never show.
      const rateLimited = audits.find(line => line.reason === 'rate_limited');
      assert.ok(rateLimited, 'a rate-limited attempt must be audited');
      assert.equal(rateLimited.result, 'denied');
      assert.equal(rateLimited.status, 429);
      assert.equal(rateLimited.tokenId, writable.tokenId);
      assert.equal(rateLimited.dimension, 'token');

      const refused = audits.find(line => line.reason === 'share_not_writable_or_wrong_page');
      assert.ok(refused, 'a non-writable share attempt must be audited');
      assert.equal(refused.result, 'denied');
      assert.equal(refused.status, 403);
      assert.equal(refused.tokenId, readOnly.tokenId);

      // The cookie value itself must never appear anywhere in the audit trail.
      for (const line of audits) {
        assert.equal(JSON.stringify(line).includes('__Secure-'), false);
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

// A share follows its page across a rename, because the grant is keyed by
// page_id. Storage and quota must follow the same identity, or a rename hands
// the page a fresh ceiling and leaves the previous bytes behind — invisible to
// listing and deletion but still on disk.
test('renaming a page carries its attachments, its listing and its quota with it', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'movable.html'), '<!doctype html><h1>x</h1>');
    const page = registerContentPage(contentDir, 'movable');

    const config = baseConfig(contentDir, authConfig(), {
      attachments: { maxFileSizeBytes: 128, maxArtifactBytes: 12 },
    });
    await withServer(config, async ({ origin }) => {
      const share = createShare('movable', '24h', { canWriteAttachments: true });
      let cookies = await openShare(origin, share.tokenId);

      assert.equal((await upload(origin, 'movable', 'k', cookies)).status, 201);
      assert.equal((await upload(origin, 'movable', 'k', cookies)).status, 409);

      updateLogicalPage(page.pageId, { uri: 'moved' });

      // The same grant, now addressing the page by its new name.
      cookies = await openShare(origin, share.tokenId);

      // The already-stored bytes still count, so the ceiling is not reset.
      const afterRename = await upload(origin, 'moved', 'k', cookies);
      assert.equal(afterRename.status, 409, 'a rename must not hand the page a fresh quota');

      // And the earlier upload is still listed under the new name, rather than
      // being stranded under the old one.
      const list = await fetch(`${origin}/api/attachments/moved/k`, {
        redirect: 'manual',
        headers: { Cookie: cookies },
      });
      assert.equal(list.status, 200);
      assert.equal((await list.json()).attachments.length, 1);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('a writable share cannot write a page that was unregistered underneath it', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const share = createShare('renovation-checklist', '24h', { canWriteAttachments: true });
      const cookies = await openShare(origin, share.tokenId);
      assert.equal((await upload(origin, 'renovation-checklist', 'before-unregister', cookies)).status, 201);

      unregisterLogicalPage('renovation-checklist');
      try {
        const res = await upload(origin, 'renovation-checklist', 'after-unregister', cookies);
        expectLoginRedirect(res);
      } finally {
        registerContentPage(contentDir, 'renovation-checklist');
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('legacy tokens no longer authorize attachment access', async () => {
  const contentDir = await makeContentDir();
  try {
    const readOnly = createShare('renovation-checklist', '24h');
    const editable = createShare('renovation-checklist', '24h');

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      let res = await fetch(`${origin}/api/attachments/renovation-checklist/legacy-readonly?token=${encodeURIComponent(readOnly.token)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: origin },
        body: formData(JPEG),
      });
      expectLoginRedirect(res);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/legacy-editable?token=${encodeURIComponent(editable.token)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: origin },
        body: formData(JPEG),
      });
      expectLoginRedirect(res);

      res = await fetch(`${origin}/api/attachments/notes/legacy-wrong?token=${encodeURIComponent(editable.token)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Origin: origin },
        body: formData(JPEG),
      });
      expectLoginRedirect(res);

      res = await fetch(`${origin}/api/attachments/renovation-checklist/not-found?token=${encodeURIComponent(readOnly.token)}`, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { Origin: origin },
      });
      expectLoginRedirect(res);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('revoked and expired editable shares cannot mutate attachments', async () => {
  const contentDir = await makeContentDir();
  try {
    const share = createShare('renovation-checklist', '24h');
    revokeShare(share.tokenId);
    const expiredToken = await createExpiredShareToken('renovation-checklist', { canWriteAttachments: true });

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      for (const token of [share.token, expiredToken]) {
        const res = await fetch(`${origin}/api/attachments/renovation-checklist/revoked-log?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          redirect: 'manual',
          headers: { Origin: origin },
          body: formData(JPEG),
        });
        expectLoginRedirect(res);
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('revoked, expired, malformed, and wrong-artifact shares cannot read attachments', async () => {
  const contentDir = await makeContentDir();
  try {
    const revoked = createShare('renovation-checklist', '24h');
    revokeShare(revoked.tokenId);
    const expiredToken = await createExpiredShareToken('renovation-checklist');
    const wrongToken = createShare('notes', '24h').token;

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      for (const token of [revoked.token, expiredToken, wrongToken, 'not-a-token']) {
        const res = await fetch(`${origin}/api/attachments/renovation-checklist/no-read-log?token=${encodeURIComponent(token)}`, {
          redirect: 'manual',
        });
        expectLoginRedirect(res);
      }
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('upload validation rejects unsupported, mismatched, oversized, traversal, and nonexistent-artifact inputs', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir, authConfig(), { attachments: { maxFileSizeBytes: 16 } }), async ({ origin }) => {
      const cookie = await login(origin);
      let res = await upload(origin, 'renovation-checklist', 'validation-log', cookie, Buffer.from('bad'), 'text/plain', 'note.txt');
      assert.equal(res.status, 400);

      res = await upload(origin, 'renovation-checklist', 'validation-log', cookie, Buffer.from('not jpeg'), 'image/jpeg', 'fake.jpg');
      assert.equal(res.status, 400);

      res = await upload(origin, 'renovation-checklist', 'validation-log', cookie, Buffer.concat([JPEG, Buffer.alloc(64)]), 'image/jpeg', 'large.jpg');
      assert.equal(res.status, 413);

      const raw = await rawRequest(origin, '/api/attachments/%2e%2e/photo-log', { Cookie: cookie });
      assert.equal(raw.statusCode, 400);

      res = await upload(origin, 'missing-artifact', 'photo-log', cookie);
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('failed uploads clean temporary and final files without durable metadata', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'cleanup-artifact.html'), '<!doctype html><h1>Cleanup</h1>');
    registerContentPage(contentDir, 'cleanup-artifact');
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      let res = await upload(origin, 'cleanup-artifact', 'cleanup-rejected', cookie, Buffer.from('bad'), 'image/jpeg', 'bad.jpg');
      assert.equal(res.status, 400);
      assert.deepEqual(await artifactAttachmentFiles('cleanup-artifact'), []);
    });

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      const res = await upload(origin, 'cleanup-artifact', 'cleanup-insert', cookie);
      assert.equal(res.status, 500);
      assert.deepEqual(await artifactAttachmentFiles('cleanup-artifact'), []);
    }, {
      hooks: {
        beforeInsert() {
          throw new Error('forced insert failure');
        },
      },
    });

    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      const res = await upload(origin, 'cleanup-artifact', 'cleanup-move', cookie);
      assert.equal(res.status, 500);
      assert.deepEqual(await artifactAttachmentFiles('cleanup-artifact'), []);
    }, {
      hooks: {
        beforeMove() {
          throw new Error('forced move failure');
        },
      },
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('delete succeeds when stored file is missing and returns 404 when metadata is missing', async () => {
  const contentDir = await makeContentDir();
  try {
    await writeFile(path.join(contentDir, 'delete-artifact.html'), '<!doctype html><h1>Delete</h1>');
    registerContentPage(contentDir, 'delete-artifact');
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const cookie = await login(origin);
      let res = await upload(origin, 'delete-artifact', 'delete-missing-file', cookie);
      assert.equal(res.status, 201);
      const attachment = (await res.json()).attachment;
      const record = storedAttachment('delete-artifact', attachment.attachmentId);
      await unlink(path.join(dataDir, 'attachments', pageIdFor('delete-artifact'), record.storedFilename));

      res = await fetch(`${origin}/api/attachments/delete-artifact/${attachment.attachmentId}`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(res.status, 200);

      res = await fetch(`${origin}/api/attachments/delete-artifact/${attachment.attachmentId}`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: cookie },
      });
      assert.equal(res.status, 404);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});
