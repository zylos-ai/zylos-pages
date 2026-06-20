import fs from 'node:fs';
import Busboy from 'busboy';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { resolvePageDescriptor } from '../security/pathGuard.js';
import { logger } from '../utils/logger.js';
import {
  deleteAttachmentMetadata,
  getAttachment,
  initAttachmentStore,
  insertAttachment,
  listAttachments,
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

const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

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

function requireAuthenticatedMutation(req, res) {
  if (res.locals.authenticated === true) return true;
  logger.info('attachment mutation rejected', { path: req.path, viewer: res.locals.viewerType || 'none' });
  res.status(403).json({ error: 'Authentication required for attachment mutation' });
  return false;
}

function attachmentResponse(req, record) {
  const browserBase = browserBaseFromRequest(req);
  let fileUrl = browserPath(browserBase, `api/attachments/${encodeURIComponent(record.artifact)}/${record.attachmentId}/file`);
  if (typeof req.query.token === 'string' && req.query.token) {
    fileUrl = `${fileUrl}?${new URLSearchParams({ token: req.query.token }).toString()}`;
  }
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

async function createAttachment({ req, config, hooks }) {
  const { artifact, key } = req.params;
  assertValidArtifactId(artifact);
  assertValidItemKey(key);
  await ensureArtifactExists(artifact, config.contentDir);

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
    finalPath = resolveFinalPath(artifact, storedFilename);
    await ensureAttachmentDirs(artifact);
    await hooks?.beforeMove?.({ tempPath: upload.tempPath, finalPath, artifact, key });
    await moveTempToFinal(upload.tempPath, finalPath);
    await hooks?.beforeInsert?.({ finalPath, artifact, key, attachmentId });
    const record = {
      attachmentId,
      artifact,
      itemKey: key,
      originalFilename: upload.originalFilename,
      storedFilename,
      mimeType: upload.mimeType,
      sizeBytes,
      createdAt: Date.now(),
    };
    insertAttachment(record);
    return record;
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
      const record = getAttachment(req.params.artifact, req.params.attachmentId);
      if (!record) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const filePath = resolveFinalPath(record.artifact, record.storedFilename);
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
      const attachments = listAttachments(req.params.artifact, req.params.key)
        .map(record => attachmentResponse(req, record));
      return res.json({ ok: true, attachments });
    } catch (err) {
      logger.error('attachment list failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/api/attachments/:artifact/:key', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireAuthenticatedMutation(req, res)) return;

    try {
      const record = await createAttachment({ req, config, hooks });
      return res.status(201).json({ ok: true, attachment: attachmentResponse(req, record) });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('attachment upload failed', { artifact: req.params.artifact, key: req.params.key, status, err: err.message });
      return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
    }
  });

  app.delete('/api/attachments/:artifact/:attachmentId', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (!requireAuthenticatedMutation(req, res)) return;
    if (rejectInvalidFileParams(req, res)) return;

    try {
      const record = getAttachment(req.params.artifact, req.params.attachmentId);
      if (!record) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const deleted = deleteAttachmentMetadata(req.params.artifact, req.params.attachmentId);
      if (!deleted) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      const filePath = resolveFinalPath(record.artifact, record.storedFilename);
      try {
        await unlinkIfExists(filePath);
      } catch (err) {
        logger.warn('attachment file cleanup failed', { artifact: record.artifact, attachmentId: record.attachmentId, err: err.message });
      }
      return res.json({ ok: true });
    } catch (err) {
      logger.error('attachment delete failed', { artifact: req.params.artifact, attachmentId: req.params.attachmentId, err: err.message });
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal Server Error' });
    }
  });
}
