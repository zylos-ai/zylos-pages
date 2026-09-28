import fs from 'node:fs/promises';
import {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  initStateStore,
  setStateValueWithinQuota,
} from '../state/state-store.js';
import {
  deleteAttachmentMetadata,
  getAttachment,
  initAttachmentStore,
  insertAttachmentWithinQuota,
  listAttachments,
} from '../attachments/attachment-store.js';
import {
  assertMagicMatchesMime,
  ensureAttachmentDirs,
  ensureTmpDir,
  extensionForMimeType,
  finalStoredFilename,
  generateAttachmentId,
  moveTempToFinal,
  resolveFinalPath,
  sanitizeOriginalFilename,
  tmpPathForUpload,
  unlinkIfExists,
} from '../attachments/storage.js';
import { assertValidAttachmentId, assertValidItemKey } from '../attachments/validation.js';
import { getLogicalPageById } from '../pages/page-store.js';
import { bridgePolicy } from '../security/page-capabilities.js';
import { consumeShareWriteQuota } from '../security/share-write-limit.js';
import { logger } from '../utils/logger.js';

const REQUEST_LIMIT_BYTES = 7 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const VALUE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_STATE_LIMITS = { maxKeysPerPage: 50, maxPageBytes: 1024 * 1024 };
const DEFAULT_ATTACHMENT_LIMITS = { maxPerItem: 50, maxArtifactBytes: 100 * 1024 * 1024 };
const OPERATIONS = new Map([
  ['state.list', 'state.read'],
  ['state.get', 'state.read'],
  ['state.set', 'state.write'],
  ['state.delete', 'state.write'],
  ['attachment.list', 'attachment.read'],
  ['attachment.get', 'attachment.read'],
  ['attachment.put', 'attachment.write'],
  ['attachment.delete', 'attachment.write'],
]);

function bridgeError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function exactObject(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bridgeError('invalid_request', 'input must be an object');
  }
  const actual = Object.keys(value);
  if (actual.some(key => !keys.includes(key)) || required.some(key => !actual.includes(key))) {
    throw bridgeError('invalid_request', 'input does not match the operation schema');
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT_BYTES) {
        rejected = true;
        reject(bridgeError('request_too_large', 'request exceeds bridge size limit', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        exactObject(body, ['operation', 'input'], ['operation', 'input']);
        resolve(body);
      } catch (err) {
        reject(err.code ? err : bridgeError('invalid_json', 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireSameOrigin(req) {
  const candidate = req.headers.origin || req.headers.referer;
  let host = null;
  try { host = new URL(candidate).host; } catch { /* rejected below */ }
  if (!host || host !== req.headers.host) throw bridgeError('forbidden', 'same-origin bridge request required', 403);
}

function requireShareBinding(req, res, page, capability, config) {
  if (res.locals.viewerType !== 'share') return;
  const share = res.locals.shareContext;
  if (!share || share.pageId !== page.pageId) throw bridgeError('forbidden', 'share is not bound to this page', 403);
  if (capability.endsWith('.write') && res.locals.shareCanWriteAttachments !== true) {
    throw bridgeError('forbidden', 'share does not grant writes', 403);
  }
  if (capability.endsWith('.write')) {
    const limits = capability === 'state.write'
      ? config.state?.shareWriteRateLimit
      : config.attachments?.shareWriteRateLimit;
    const quota = consumeShareWriteQuota(
      share.tokenId,
      `bridge:${capability}`,
      limits,
      req.ip || req.socket?.remoteAddress || null,
    );
    if (!quota.allowed) {
      const err = bridgeError('rate_limited', 'too many bridge writes for this share', 429);
      err.retryAfterSeconds = quota.retryAfterSeconds;
      throw err;
    }
  }
}

function validateKey(input) {
  try {
    assertValidItemKey(input.key);
  } catch {
    throw bridgeError('invalid_request', 'invalid state or attachment key');
  }
  return input.key;
}

function validateAttachmentId(attachmentId) {
  try {
    assertValidAttachmentId(attachmentId);
  } catch {
    throw bridgeError('invalid_request', 'invalid attachment id');
  }
  return attachmentId;
}

function attachmentLimits(config) {
  return {
    maxPerItem: config.attachments?.maxPerItem ?? DEFAULT_ATTACHMENT_LIMITS.maxPerItem,
    maxArtifactBytes: config.attachments?.maxArtifactBytes ?? DEFAULT_ATTACHMENT_LIMITS.maxArtifactBytes,
  };
}

function stateLimits(config) {
  return {
    maxKeysPerPage: config.state?.maxKeysPerPage ?? DEFAULT_STATE_LIMITS.maxKeysPerPage,
    maxPageBytes: config.state?.maxPageBytes ?? DEFAULT_STATE_LIMITS.maxPageBytes,
  };
}

function attachmentView(page, record) {
  return {
    attachmentId: record.attachmentId,
    itemKey: record.itemKey,
    originalFilename: record.originalFilename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    filePath: `/api/attachments/${encodeURIComponent(page.uri)}/${record.attachmentId}/file`,
  };
}

async function putAttachment(page, input, config) {
  exactObject(input, ['key', 'filename', 'mimeType', 'dataBase64']);
  const key = validateKey(input);
  if (typeof input.filename !== 'string' || typeof input.mimeType !== 'string' || typeof input.dataBase64 !== 'string') {
    throw bridgeError('invalid_request', 'attachment fields must be strings');
  }
  const extension = extensionForMimeType(input.mimeType);
  if (!extension) throw bridgeError('invalid_request', 'unsupported attachment MIME type');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== input.dataBase64.replace(/=+$/, '')) {
    throw bridgeError('invalid_request', 'attachment data must be canonical base64');
  }
  const max = config.attachments?.maxFileSizeBytes ?? 5 * 1024 * 1024;
  if (data.length === 0 || data.length > max) throw bridgeError('request_too_large', 'attachment exceeds size limit', 413);

  await ensureTmpDir();
  const tempPath = tmpPathForUpload();
  await fs.writeFile(tempPath, data, { flag: 'wx', mode: 0o600 });
  let finalPath = null;
  try {
    await assertMagicMatchesMime(tempPath, input.mimeType);
    const attachmentId = generateAttachmentId();
    const storedFilename = finalStoredFilename(attachmentId, extension);
    await ensureAttachmentDirs(page.pageId);
    finalPath = resolveFinalPath(page.pageId, storedFilename);
    await moveTempToFinal(tempPath, finalPath);
    const record = {
      attachmentId,
      pageId: page.pageId,
      itemKey: key,
      originalFilename: sanitizeOriginalFilename(input.filename),
      storedFilename,
      mimeType: input.mimeType,
      sizeBytes: data.length,
      createdAt: Date.now(),
    };
    const admitted = insertAttachmentWithinQuota(record, attachmentLimits(config));
    if (!admitted.ok) throw bridgeError('quota_exceeded', 'attachment quota exceeded', 409);
    return attachmentView(page, record);
  } catch (err) {
    await unlinkIfExists(tempPath);
    if (finalPath) await unlinkIfExists(finalPath);
    throw err;
  }
}

async function execute(page, operation, input, config, res) {
  switch (operation) {
    case 'state.list':
      exactObject(input, [], []);
      return { state: getArtifactState(page.pageId) };
    case 'state.get': {
      exactObject(input, ['key']);
      const key = validateKey(input);
      const found = getStateValue(page.pageId, key);
      return found.found ? { found: true, value: found.value } : { found: false };
    }
    case 'state.set': {
      exactObject(input, ['key', 'value']);
      const key = validateKey(input);
      const serialized = JSON.stringify(input.value);
      if (serialized === undefined || Buffer.byteLength(serialized) > VALUE_LIMIT_BYTES) {
        throw bridgeError('value_too_large', 'state value exceeds size limit', 413);
      }
      const admitted = setStateValueWithinQuota(page.pageId, key, input.value, stateLimits(config));
      if (!admitted.ok) throw bridgeError('quota_exceeded', 'state quota exceeded', 409);
      return { stored: true };
    }
    case 'state.delete':
      exactObject(input, ['key']);
      return { deleted: deleteStateValue(page.pageId, validateKey(input)) };
    case 'attachment.list':
      exactObject(input, ['key']);
      return { attachments: listAttachments(page.pageId, validateKey(input)).map(record => attachmentView(page, record)) };
    case 'attachment.get': {
      exactObject(input, ['attachmentId']);
      const attachmentId = validateAttachmentId(input.attachmentId);
      const record = getAttachment(page.pageId, attachmentId);
      if (!record) throw bridgeError('not_found', 'attachment not found', 404);
      const data = await fs.readFile(resolveFinalPath(page.pageId, record.storedFilename));
      return { attachment: attachmentView(page, record), dataBase64: data.toString('base64') };
    }
    case 'attachment.put':
      return { attachment: await putAttachment(page, input, config) };
    case 'attachment.delete': {
      exactObject(input, ['attachmentId']);
      const attachmentId = validateAttachmentId(input.attachmentId);
      const record = getAttachment(page.pageId, attachmentId);
      if (!record) throw bridgeError('not_found', 'attachment not found', 404);
      if (!deleteAttachmentMetadata(page.pageId, attachmentId)) throw bridgeError('not_found', 'attachment not found', 404);
      await unlinkIfExists(resolveFinalPath(page.pageId, record.storedFilename));
      return { deleted: true };
    }
    default:
      throw bridgeError('unsupported_operation', 'unsupported bridge operation');
  }
}

export function setupBridgeApi(app, config = {}) {
  initStateStore();
  initAttachmentStore();
  app.post('/api/bridge/:pageId', async (req, res) => {
    let operation = null;
    let page = null;
    let capability = null;
    try {
      requireSameOrigin(req);
      if (config.security?.htmlArtifactSandboxDisabled === true) {
        throw bridgeError('bridge_disabled', 'bridge requires the HTML artifact sandbox', 403);
      }
      page = getLogicalPageById(req.params.pageId);
      if (!page || page.type !== 'html') throw bridgeError('not_found', 'page not found', 404);
      const policy = bridgePolicy(page);
      if (!policy.enabled) throw bridgeError('bridge_disabled', 'bridge is disabled for this page', 403);
      const body = await parseBody(req);
      operation = body.operation;
      capability = OPERATIONS.get(operation);
      if (!capability) throw bridgeError('unsupported_operation', 'unsupported bridge operation');
      if (!policy.capabilities.includes(capability)) throw bridgeError('capability_denied', 'capability is not declared', 403);
      requireShareBinding(req, res, page, capability, config);
      const result = await execute(page, operation, body.input, config, res);
      const response = JSON.stringify({ ok: true, result });
      if (Buffer.byteLength(response) > RESPONSE_LIMIT_BYTES) throw bridgeError('response_too_large', 'response exceeds bridge size limit', 413);
      logger.info('page bridge audit', {
        pageId: page.pageId, capability, operation, result: 'allowed', status: 200,
        viewer: res.locals.viewerType === 'share' ? 'share' : 'owner', tokenId: res.locals.shareContext?.tokenId ?? null,
      });
      res.type('json').send(response);
    } catch (err) {
      const status = err.statusCode || 500;
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      logger.info('page bridge audit', {
        pageId: page?.pageId ?? null, capability, operation, result: status < 500 ? 'denied' : 'failed', status,
        viewer: res.locals.viewerType === 'share' ? 'share' : 'owner', tokenId: res.locals.shareContext?.tokenId ?? null,
        reason: err.code || 'internal_error',
      });
      res.status(status).json({
        ok: false,
        error: { code: err.code || 'internal_error', message: status < 500 ? err.message : 'Internal Server Error' },
      });
    }
  });
}
