import fs from 'node:fs';
import Busboy from 'busboy';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { resolvePageDescriptor } from '../security/pathGuard.js';
import { logger } from '../utils/logger.js';
import {
  countAttachments,
  deleteAttachmentMetadata,
  getAttachment,
  initAttachmentStore,
  insertAttachment,
  insertAttachmentWithinQuota,
  listAttachments,
  pageByteTotal,
} from '../attachments/attachment-store.js';
import {
  assertMagicMatchesMime,
  ensureAttachmentDirs,
  ensureTmpDir,
  extensionForMimeType,
  fileSize,
  finalStoredFilename,
  generateAttachmentId,
  moveTempToFinal,
  resolveFinalPath,
  sanitizeOriginalFilename,
  tmpPathForUpload,
  unlinkIfExists,
} from '../attachments/storage.js';
import {
  assertValidArtifactId,
  assertValidAttachmentId,
  assertValidItemKey,
} from '../attachments/validation.js';
import { consumeShareWriteQuota } from '../security/share-write-limit.js';
import { getLogicalPage } from '../pages/page-store.js';

const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// Ceilings that apply only when the writer is a share link. A logged-in owner
// is not capped: they can already write the disk by other means, so a limit
// there protects nothing. These bound what an unauthenticated link holder can
// deposit before anyone notices — a count so one item cannot accumulate
// endlessly, and a byte total so the count cannot be honoured with 50 files of
// the maximum size. Together they are what stops a passwordless link from
// quietly becoming free image hosting.
const DEFAULT_MAX_ATTACHMENTS_PER_ITEM = 50;
const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function csrfCheck(req, res) {
  const expectedHost = req.headers.host;

  function extractHost(urlOrOrigin) {
    try { return new URL(urlOrOrigin).host; } catch { return null; }
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (extractHost(origin) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else if (referer) {
    if (extractHost(referer) !== expectedHost) {
      res.status(403).json({ error: 'CSRF validation failed' });
      return false;
    }
  } else {
    res.status(403).json({ error: 'CSRF validation failed: missing Origin/Referer' });
    return false;
  }
  return true;
}

// Every attachment mutation passes through here — there is deliberately one
// gate, not one per route, so a new mutation route cannot be added without
// crossing it.
//
// Two ways through, and only two:
//   1. a logged-in session, which may write anything;
//   2. a share token that carries the attachment-write capability *and* is
//      bound to the very page the artifact resolves to.
//
// The binding in (2) compares canonical page ids, not strings. The share row is
// keyed by page_id precisely so a link survives a rename, so the identity that
// the grant was issued against is the page id — comparing the uri instead would
// compare two names for the thing rather than the thing, and names move.
// Resolving the artifact through the page store also means an unregistered or
// tombstoned page has no id to match and is refused here rather than deeper in.
//
// This re-checks a fact the auth middleware already established. That is not
// redundancy for its own sake: the middleware decides "may this request proceed
// at all", this decides "may it write *this* page", and the day those two stop
// meaning the same thing is the day one of them is wrong.
// res.locals.shareContext is re-read from the DB on every request, so a revoked
// token, an expired one, or one whose capability was withdrawn a second ago
// fails here with nothing needing to be invalidated.
//
// Exported for tests. Over HTTP the auth middleware refuses a mismatched page
// before a request can ever reach this function, so a route-level test cannot
// tell whether this check exists — the whole point of the check is to still be
// standing if that middleware ever changes. Testing it therefore has to be
// direct, or it is not being tested at all.
export function shareMutationGrant(res, artifact) {
  if (res.locals.viewerType !== 'share') return null;
  if (res.locals.shareCanWriteAttachments !== true) return null;
  const share = res.locals.shareContext;
  if (!share || !share.pageId) return null;
  const page = getLogicalPage(artifact);
  if (!page || page.pageId !== share.pageId) return null;
  return share;
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// Every artifact that can hold attachments is a registered logical page
// (resolvePageDescriptor refuses anything else), so this always resolves for a
// request that got past ensureArtifactExists. It is the single point where the
// name in the URL is turned into the identity everything else uses.
function requirePageId(artifact) {
  const page = getLogicalPage(artifact);
  if (!page) {
    throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
  }
  return page.pageId;
}

// One line per mutation, allowed or refused. It cannot name a person — a share
// link is not an identity — but "which grant, against what page, doing what,
// with what result, from where, when" is answerable, and that is what makes a
// bad link revocable rather than merely regrettable. Never carries the cookie
// or token value itself, only the token id, which is already public in the URL.
function auditMutation(req, res, action, fields) {
  const writer = res.locals.attachmentWriter || { kind: res.locals.viewerType || 'none' };
  logger.info('attachment mutation audit', {
    action,
    writer: writer.kind,
    tokenId: writer.tokenId ?? res.locals.shareContext?.tokenId ?? null,
    pageId: res.locals.shareContext?.pageId ?? null,
    artifact: req.params.artifact ?? null,
    ip: clientIp(req),
    ...fields,
  });
}

function requireAttachmentMutation(req, res, artifact, config, operation) {
  if (res.locals.authenticated === true) {
    res.locals.attachmentWriter = { kind: 'session' };
    return true;
  }

  const share = shareMutationGrant(res, artifact);
  if (!share) {
    auditMutation(req, res, operation, {
      result: 'denied',
      status: 403,
      reason: res.locals.viewerType === 'share' ? 'share_not_writable_or_wrong_page' : 'unauthenticated',
    });
    res.status(403).json({ error: 'Authentication required for attachment mutation' });
    return false;
  }

  // Rationed per token and per operation, not per IP: the capability travels
  // with the link, so the link is the thing that has to have a ceiling. Note
  // the order — a revoked or non-writable token is refused above and never
  // reaches this counter, so it cannot consume or pollute a live token's quota.
  const quota = consumeShareWriteQuota(
    share.tokenId,
    operation,
    config.attachments?.shareWriteRateLimit,
    clientIp(req)
  );
  if (!quota.allowed) {
    res.locals.attachmentWriter = { kind: 'share', tokenId: share.tokenId };
    auditMutation(req, res, operation, {
      result: 'denied',
      status: 429,
      reason: 'rate_limited',
      dimension: quota.dimension,
      retryAfterSeconds: quota.retryAfterSeconds,
    });
    res.setHeader('Retry-After', String(quota.retryAfterSeconds));
    res.status(429).json({ error: 'Too many attachment writes for this share link' });
    return false;
  }

  res.locals.attachmentWriter = { kind: 'share', tokenId: share.tokenId };
  return true;
}

function attachmentResponse(req, record) {
  const browserBase = browserBaseFromRequest(req);
  const fileUrl = browserPath(browserBase, `api/attachments/${encodeURIComponent(record.artifact)}/${record.attachmentId}/file`);
  return {
    attachmentId: record.attachmentId,
    artifact: record.artifact,
    itemKey: record.itemKey,
    originalFilename: record.originalFilename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    fileUrl,
  };
}

function encodeRFC5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDispositionForAttachment(record) {
  const extension = record.storedFilename.match(/\.(jpg|png|webp)$/)?.[0] || '.jpg';
  const fallback = `attachment${extension}`;
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987Value(record.originalFilename)}`;
}

function rejectInvalidListParams(req, res) {
  try {
    assertValidArtifactId(req.params.artifact);
    assertValidItemKey(req.params.key);
    return false;
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
    return true;
  }
}

function rejectInvalidFileParams(req, res) {
  try {
    assertValidArtifactId(req.params.artifact);
    assertValidAttachmentId(req.params.attachmentId);
    return false;
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
    return true;
  }
}

async function ensureArtifactExists(artifact, contentDir) {
  try {
    await resolvePageDescriptor(artifact, contentDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
    }
    throw err;
  }
}

function parseMultipartUpload(req, maxFileSizeBytes) {
  return new Promise(async (resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      reject(Object.assign(new Error('Expected multipart/form-data'), { statusCode: 400 }));
      return;
    }

    try {
      await ensureTmpDir();
    } catch (err) {
      reject(err);
      return;
    }

    let tempPath = null;
    let writeStream = null;
    let fileSeen = false;
    let fileDone = false;
    let busboyDone = false;
    let originalFilename = 'upload';
    let mimeType = '';
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      if (writeStream && !writeStream.destroyed) writeStream.destroy();
      if (tempPath) {
        unlinkIfExists(tempPath).finally(() => reject(err));
      } else {
        reject(err);
      }
    }

    function finishIfReady() {
      if (settled || !fileSeen || !fileDone || !busboyDone) return;
      settled = true;
      resolve({ tempPath, originalFilename, mimeType });
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fields: 0,
          fileSize: maxFileSizeBytes,
        },
      });
    } catch (err) {
      reject(Object.assign(new Error('Invalid multipart request'), { statusCode: 400, cause: err }));
      return;
    }

    busboy.on('file', (fieldName, file, info) => {
      if (fieldName !== 'file') {
        file.resume();
        fail(Object.assign(new Error('Unexpected file field'), { statusCode: 400 }));
        return;
      }
      if (fileSeen) {
        file.resume();
        fail(Object.assign(new Error('Only one file is allowed'), { statusCode: 400 }));
        return;
      }
      fileSeen = true;
      originalFilename = sanitizeOriginalFilename(info.filename);
      mimeType = info.mimeType || '';
      tempPath = tmpPathForUpload();
      writeStream = fs.createWriteStream(tempPath, { flags: 'wx' });

      file.on('limit', () => {
        fail(Object.assign(new Error('File too large'), { statusCode: 413 }));
      });
      file.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('finish', () => {
        fileDone = true;
        finishIfReady();
      });
      file.pipe(writeStream);
    });

    busboy.on('field', () => {
      fail(Object.assign(new Error('Unexpected form field'), { statusCode: 400 }));
    });
    busboy.on('filesLimit', () => {
      fail(Object.assign(new Error('Only one file is allowed'), { statusCode: 400 }));
    });
    busboy.on('fieldsLimit', () => {
      fail(Object.assign(new Error('Unexpected form field'), { statusCode: 400 }));
    });
    busboy.on('error', (err) => {
      fail(Object.assign(new Error('Invalid multipart request'), { statusCode: 400, cause: err }));
    });
    busboy.on('finish', () => {
      if (settled) return;
      if (!fileSeen) {
        fail(Object.assign(new Error('Missing file'), { statusCode: 400 }));
        return;
      }
      busboyDone = true;
      finishIfReady();
    });

    req.pipe(busboy);
  });
}

function quotaFor(config) {
  return {
    maxPerItem: config.attachments?.maxPerItem ?? DEFAULT_MAX_ATTACHMENTS_PER_ITEM,
    maxArtifactBytes: config.attachments?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
  };
}

const QUOTA_MESSAGE = {
  count: limits => `This list already holds the maximum of ${limits.maxPerItem} attachments`,
  bytes: () => 'This page has reached its attachment storage limit',
};

async function createAttachment({ req, res, config, hooks }) {
  const { artifact, key } = req.params;
  assertValidArtifactId(artifact);
  assertValidItemKey(key);
  await ensureArtifactExists(artifact, config.contentDir);
  const pageId = requirePageId(artifact);

  const rationed = res.locals.attachmentWriter?.kind === 'share';
  const limits = quotaFor(config);

  // A cheap look before the upload is read, so an obviously-full page costs two
  // DB reads instead of a whole file write that then unwinds. This is a
  // courtesy, not the decision — the authority is the transaction below, which
  // is the only place the ceiling can be enforced against a concurrent upload.
  if (rationed) {
    if (countAttachments(pageId, key) >= limits.maxPerItem) {
      throw Object.assign(new Error(QUOTA_MESSAGE.count(limits)), { statusCode: 409 });
    }
    if (pageByteTotal(pageId) >= limits.maxArtifactBytes) {
      throw Object.assign(new Error(QUOTA_MESSAGE.bytes()), { statusCode: 409 });
    }
  }

  const maxFileSizeBytes = config.attachments?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const upload = await parseMultipartUpload(req, maxFileSizeBytes);
  let finalPath = null;

  try {
    const extension = extensionForMimeType(upload.mimeType);
    if (!extension) {
      throw Object.assign(new Error('Unsupported MIME type'), { statusCode: 400 });
    }
    await assertMagicMatchesMime(upload.tempPath, upload.mimeType);
    const sizeBytes = await fileSize(upload.tempPath);
    const attachmentId = generateAttachmentId();
    const storedFilename = finalStoredFilename(attachmentId, extension);
    finalPath = resolveFinalPath(pageId, storedFilename);
    await ensureAttachmentDirs(pageId);
    await hooks?.beforeMove?.({ tempPath: upload.tempPath, finalPath, artifact, key });
    await moveTempToFinal(upload.tempPath, finalPath);
    await hooks?.beforeInsert?.({ finalPath, artifact, key, attachmentId });
    const record = {
      attachmentId,
      pageId,
      itemKey: key,
      originalFilename: upload.originalFilename,
      storedFilename,
      mimeType: upload.mimeType,
      sizeBytes,
      createdAt: Date.now(),
    };

    // Ceiling and insert in one transaction, with this upload's own size
    // counted. Deciding before the write makes the limit advisory: two uploads
    // that both read the total before either writes are both admitted, and an
    // upload that starts under the line finishes over it by its own size.
    if (rationed) {
      const admitted = insertAttachmentWithinQuota(record, limits);
      if (!admitted.ok) {
        throw Object.assign(new Error(QUOTA_MESSAGE[admitted.reason](limits)), { statusCode: 409 });
      }
    } else {
      insertAttachment(record);
    }
    return { ...record, artifact };
  } catch (err) {
    await unlinkIfExists(upload.tempPath);
    if (finalPath) await unlinkIfExists(finalPath);
    throw err;
  }
}

export function setupAttachmentApi(app, config, options = {}) {
  initAttachmentStore();
  const hooks = options.hooks || {};

  app.get('/api/attachments/:artifact/:attachmentId/file', async (req, res) => {
    if (rejectInvalidFileParams(req, res)) return;

    try {
      const record = getAttachment(requirePageId(req.params.artifact), req.params.attachmentId);
      if (!record) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const filePath = resolveFinalPath(record.pageId, record.storedFilename);
      res.setHeader('Content-Type', record.mimeType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', contentDispositionForAttachment(record));
      return res.sendFile(filePath, (err) => {
        if (!err) return;
        if (!res.headersSent) {
          if (err.code === 'ENOENT') return res.status(404).json({ error: 'Attachment file not found' });
          return res.status(500).json({ error: 'Internal Server Error' });
        }
      });
    } catch (err) {
      logger.warn('attachment file failed', { artifact: req.params.artifact, attachmentId: req.params.attachmentId, err: err.message });
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal Server Error' });
    }
  });

  app.get('/api/attachments/:artifact/:key', (req, res) => {
    if (rejectInvalidListParams(req, res)) return;

    try {
      const attachments = listAttachments(requirePageId(req.params.artifact), req.params.key)
        .map(record => attachmentResponse(req, { ...record, artifact: req.params.artifact }));
      return res.json({ ok: true, attachments });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.error('attachment list failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
    }
  });

  app.post('/api/attachments/:artifact/:key', async (req, res) => {
    if (!csrfCheck(req, res)) {
      auditMutation(req, res, 'upload', { result: 'denied', status: 403, reason: 'csrf' });
      return;
    }
    if (!requireAttachmentMutation(req, res, req.params.artifact, config, 'upload')) return;

    try {
      const record = await createAttachment({ req, res, config, hooks });
      auditMutation(req, res, 'upload', {
        result: 'allowed',
        status: 201,
        itemKey: record.itemKey,
        attachmentId: record.attachmentId,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
      });
      return res.status(201).json({ ok: true, attachment: attachmentResponse(req, record) });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('attachment upload failed', { artifact: req.params.artifact, key: req.params.key, status, err: err.message });
      auditMutation(req, res, 'upload', {
        result: 'failed',
        status,
        itemKey: req.params.key,
        reason: status === 500 ? 'internal_error' : err.message,
      });
      return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
    }
  });

  app.delete('/api/attachments/:artifact/:attachmentId', async (req, res) => {
    if (!csrfCheck(req, res)) {
      auditMutation(req, res, 'delete', { result: 'denied', status: 403, reason: 'csrf' });
      return;
    }
    if (!requireAttachmentMutation(req, res, req.params.artifact, config, 'delete')) return;
    if (rejectInvalidFileParams(req, res)) {
      auditMutation(req, res, 'delete', {
        result: 'denied',
        status: 400,
        attachmentId: req.params.attachmentId,
        reason: 'invalid_params',
      });
      return;
    }

    try {
      // Looked up by (pageId, attachmentId), never by id alone — an id from
      // another page finds nothing here, so a mismatched artifact is refused
      // before any row or file is touched.
      const pageId = requirePageId(req.params.artifact);
      const record = getAttachment(pageId, req.params.attachmentId);
      if (!record) {
        auditMutation(req, res, 'delete', {
          result: 'failed',
          status: 404,
          attachmentId: req.params.attachmentId,
          reason: 'not_found',
        });
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const deleted = deleteAttachmentMetadata(pageId, req.params.attachmentId);
      if (!deleted) {
        // Lost a race with another deleter. Recorded as its own outcome rather
        // than folded into the plain 404 above, because "someone else got here
        // first" and "there was never such an attachment" are different facts.
        auditMutation(req, res, 'delete', {
          result: 'failed',
          status: 404,
          attachmentId: req.params.attachmentId,
          reason: 'already_deleted',
        });
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const filePath = resolveFinalPath(record.pageId, record.storedFilename);
      // Metadata first, file second. If the unlink fails the row is already
      // gone, so the file is orphaned: invisible to every read path but still
      // on disk. The audit line below records that outcome explicitly rather
      // than leaving it to a warning nobody correlates — on a publicly
      // writable path, "DB deleted, file remains" has to be greppable.
      let fileRemoved = true;
      try {
        await unlinkIfExists(filePath);
      } catch (err) {
        fileRemoved = false;
        logger.warn('attachment file cleanup failed', { artifact: record.artifact, attachmentId: record.attachmentId, err: err.message });
      }
      auditMutation(req, res, 'delete', {
        result: 'allowed',
        status: 200,
        itemKey: record.itemKey,
        attachmentId: record.attachmentId,
        sizeBytes: record.sizeBytes,
        fileRemoved,
      });
      return res.json({ ok: true });
    } catch (err) {
      logger.error('attachment delete failed', { artifact: req.params.artifact, attachmentId: req.params.attachmentId, err: err.message });
      auditMutation(req, res, 'delete', {
        result: 'failed',
        status: err.statusCode || 500,
        attachmentId: req.params.attachmentId,
        reason: err.statusCode ? err.message : 'internal_error',
      });
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal Server Error' });
    }
  });
}
