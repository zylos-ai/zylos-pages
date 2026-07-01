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
const { registerLogicalPage } = await import('../src/pages/page-store.js');

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
    sharing: { enabled: true, allowPermanent: false },
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
  setupAuth(app, config.auth || { enabled: false, password: null }, config.sharing || { enabled: true, allowPermanent: false });
  setupShareApi(app, config.sharing || { enabled: true, allowPermanent: false }, config);
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
  const match = response.headers.get('set-cookie').match(/__Host-zylos_pages_session=([^;,]+)/);
  assert.ok(match);
  return `__Host-zylos_pages_session=${match[1]}`;
}

function cookieHeader(setCookie) {
  return setCookie
    .split(/,\s*(?=__Host-)/)
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
    headers: { Origin: origin, Cookie: cookie },
    body: formData(buffer, type, filename),
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
  const share = createShare(slug, '24h', { allowPermanent: false }, options);
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

async function artifactAttachmentFiles(artifact) {
  try {
    return await readdir(path.join(dataDir, 'attachments', artifact));
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
    const share = createShare('renovation-checklist', '24h', { allowPermanent: false });
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
    const share = createShare('renovation-checklist', '24h', { allowPermanent: false }, { canWriteAttachments: true });
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

test('existing short share cookie sessions cannot be upgraded to attachment writes', async () => {
  const contentDir = await makeContentDir();
  try {
    await withServer(baseConfig(contentDir), async ({ origin }) => {
      const authCookie = await login(origin);

      const readOnly = createShare('renovation-checklist', '24h', { allowPermanent: false });
      let res = await fetch(`${origin}/s/${readOnly.tokenId}`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      const readOnlyCookies = cookieHeader(res.headers.get('set-cookie'));

      res = await upload(origin, 'renovation-checklist', 'short-upgrade-before', readOnlyCookies);
      assert.equal(res.status, 403);

      const body = await patchSharePermission(origin, readOnly.tokenId, true, authCookie, 410);
      assert.deepEqual(body, { error: 'Public attachment writes are deprecated' });

      res = await upload(origin, 'renovation-checklist', 'short-upgrade-after', readOnlyCookies);
      assert.equal(res.status, 403);
    });
  } finally {
    await rm(contentDir, { recursive: true, force: true });
  }
});

test('legacy tokens no longer authorize attachment access', async () => {
  const contentDir = await makeContentDir();
  try {
    const readOnly = createShare('renovation-checklist', '24h', { allowPermanent: false });
    const editable = createShare('renovation-checklist', '24h', { allowPermanent: false }, { canWriteAttachments: true });

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
    const share = createShare('renovation-checklist', '24h', { allowPermanent: false }, { canWriteAttachments: true });
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
    const revoked = createShare('renovation-checklist', '24h', { allowPermanent: false });
    revokeShare(revoked.tokenId);
    const expiredToken = await createExpiredShareToken('renovation-checklist');
    const wrongToken = createShare('notes', '24h', { allowPermanent: false }).token;

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
      const record = getAttachment('delete-artifact', attachment.attachmentId);
      await unlink(path.join(dataDir, 'attachments', 'delete-artifact', record.storedFilename));

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
