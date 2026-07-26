import {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  initStateStore,
  setStateValue,
  setStateValueWithinQuota,
} from '../state/state-store.js';
import { getLogicalPage } from '../pages/page-store.js';
import { consumeShareWriteQuota } from '../security/share-write-limit.js';
import { logger } from '../utils/logger.js';

export const VALUE_JSON_LIMIT_BYTES = 64 * 1024;
export const RAW_BODY_LIMIT_BYTES = 65 * 1024;

const ARTIFACT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const ARTIFACT_ID_MAX_LENGTH = 100;
const DEFAULT_STATE_LIMITS = { maxKeysPerPage: 50, maxPageBytes: 1024 * 1024 };

function validateArtifactId(artifact) {
  return typeof artifact === 'string'
    && artifact.length <= ARTIFACT_ID_MAX_LENGTH
    && ARTIFACT_ID_RE.test(artifact);
}

function validateKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

function jsonByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * CSRF validation via Origin/Referer headers.
 * Same approach as the attachment API.
 */
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

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > RAW_BODY_LIMIT_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateValueSize(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw Object.assign(new Error('Value must be JSON-serializable'), { statusCode: 400 });
  }
  if (jsonByteLength(encoded) > VALUE_JSON_LIMIT_BYTES) {
    throw Object.assign(new Error('Value too large'), { statusCode: 400 });
  }
}

function rejectInvalidParams(req, res) {
  if (!validateArtifactId(req.params.artifact)) {
    res.status(400).json({ error: 'Invalid artifact ID' });
    return true;
  }
  if (req.params.key !== undefined && !validateKey(req.params.key)) {
    res.status(400).json({ error: 'Invalid key' });
    return true;
  }
  return false;
}

// The URL carries the page's current human-readable name; persistence uses the
// stable identity. Rejecting names that are not registered pages prevents a
// caller from creating an unowned namespace by convention alone.
function requirePageId(artifact) {
  const page = getLogicalPage(artifact);
  if (!page) {
    throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
  }
  return page.pageId;
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function auditMutation(req, res, action, fields) {
  logger.info('state mutation audit', {
    action,
    writer: res.locals.viewerType === 'share' ? 'share' : 'owner',
    tokenId: res.locals.shareContext?.tokenId ?? null,
    pageId: res.locals.shareContext?.pageId ?? fields.pageId ?? null,
    artifact: req.params.artifact ?? null,
    key: req.params.key ?? null,
    ip: clientIp(req),
    ...fields,
  });
}

function requireStateMutation(req, res, artifact, config, operation) {
  if (res.locals.viewerType !== 'share') return true;
  const share = res.locals.shareContext;
  const page = getLogicalPage(artifact);
  if (!share?.pageId || !page || share.pageId !== page.pageId) {
    auditMutation(req, res, operation, {
      result: 'denied', status: 403, reason: 'share_wrong_page',
    });
    res.status(403).json({ error: 'Share link does not grant state access to this page' });
    return false;
  }
  const quota = consumeShareWriteQuota(
    share.tokenId,
    `state:${operation}`,
    config.state?.shareWriteRateLimit,
    clientIp(req)
  );
  if (!quota.allowed) {
    auditMutation(req, res, operation, {
      result: 'denied', status: 429, reason: 'rate_limited',
      dimension: quota.dimension, retryAfterSeconds: quota.retryAfterSeconds,
    });
    res.setHeader('Retry-After', String(quota.retryAfterSeconds));
    res.status(429).json({ error: 'Too many state writes for this share link' });
    return false;
  }
  return true;
}

function stateLimits(config) {
  return {
    maxKeysPerPage: config.state?.maxKeysPerPage ?? DEFAULT_STATE_LIMITS.maxKeysPerPage,
    maxPageBytes: config.state?.maxPageBytes ?? DEFAULT_STATE_LIMITS.maxPageBytes,
  };
}

function auditReasonForError(err, status) {
  if (status === 404) return 'unknown_page';
  if (status === 500) return 'internal_error';
  if (err.message === 'Invalid JSON') return 'invalid_json';
  if (err.message === 'Body too large') return 'body_too_large';
  if (err.message === 'Value too large') return 'value_too_large';
  return err.message;
}

/**
 * Register artifact state API routes.
 * Must be called AFTER auth middleware.
 */
export function setupStateApi(app, config = {}) {
  initStateStore();

  app.get('/api/state/:artifact', (req, res) => {
    if (req.path.endsWith('/')) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (rejectInvalidParams(req, res)) return;

    try {
      return res.json({ ok: true, state: getArtifactState(requirePageId(req.params.artifact)) });
    } catch (err) {
      logger.error('state list failed', { artifact: req.params.artifact, err: err.message });
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal Server Error' });
    }
  });

  app.get('/api/state/:artifact/:key', (req, res) => {
    if (rejectInvalidParams(req, res)) return;

    try {
      const result = getStateValue(requirePageId(req.params.artifact), req.params.key);
      if (!result.found) {
        return res.status(404).json({ error: 'State key not found' });
      }
      return res.json({ ok: true, key: req.params.key, value: result.value });
    } catch (err) {
      logger.error('state get failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal Server Error' });
    }
  });

  app.route('/api/state/:artifact/')
    .get((req, res) => {
      if (!validateArtifactId(req.params.artifact)) {
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      return res.status(400).json({ error: 'Invalid key' });
    })
    .put((req, res) => {
      if (!csrfCheck(req, res)) {
        auditMutation(req, res, 'set', { result: 'denied', status: 403, reason: 'csrf' });
        return;
      }
      if (!requireStateMutation(req, res, req.params.artifact, config, 'set')) return;
      if (!validateArtifactId(req.params.artifact)) {
        auditMutation(req, res, 'set', { result: 'denied', status: 400, reason: 'invalid_params' });
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      auditMutation(req, res, 'set', { result: 'denied', status: 400, reason: 'invalid_params' });
      return res.status(400).json({ error: 'Invalid key' });
    })
    .delete((req, res) => {
      if (!csrfCheck(req, res)) {
        auditMutation(req, res, 'delete', { result: 'denied', status: 403, reason: 'csrf' });
        return;
      }
      if (!requireStateMutation(req, res, req.params.artifact, config, 'delete')) return;
      if (!validateArtifactId(req.params.artifact)) {
        auditMutation(req, res, 'delete', { result: 'denied', status: 400, reason: 'invalid_params' });
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      auditMutation(req, res, 'delete', { result: 'denied', status: 400, reason: 'invalid_params' });
      return res.status(400).json({ error: 'Invalid key' });
    });

  app.put('/api/state/:artifact/:key', async (req, res) => {
    if (!csrfCheck(req, res)) {
      auditMutation(req, res, 'set', { result: 'denied', status: 403, reason: 'csrf' });
      return;
    }
    if (!requireStateMutation(req, res, req.params.artifact, config, 'set')) return;
    if (rejectInvalidParams(req, res)) {
      auditMutation(req, res, 'set', { result: 'denied', status: 400, reason: 'invalid_params' });
      return;
    }

    let pageId = null;
    try {
      pageId = requirePageId(req.params.artifact);
      const body = await parseJsonBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        auditMutation(req, res, 'set', { result: 'denied', status: 400, reason: 'invalid_body', pageId });
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
        auditMutation(req, res, 'set', { result: 'denied', status: 400, reason: 'missing_value', pageId });
        return res.status(400).json({ error: 'Missing value' });
      }
      validateValueSize(body.value);
      if (res.locals.viewerType === 'share') {
        const admitted = setStateValueWithinQuota(pageId, req.params.key, body.value, stateLimits(config));
        if (!admitted.ok) {
          auditMutation(req, res, 'set', {
            result: 'denied', status: 409, reason: `quota_${admitted.reason}`, pageId,
          });
          return res.status(409).json({
            error: admitted.reason === 'keys'
              ? 'This page has reached its state key limit'
              : 'This page has reached its state storage limit',
          });
        }
      } else {
        setStateValue(pageId, req.params.key, body.value);
      }
      auditMutation(req, res, 'set', { result: 'allowed', status: 200, pageId });
      return res.json({ ok: true, key: req.params.key, value: body.value });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('state set failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      auditMutation(req, res, 'set', {
        result: status < 500 ? 'denied' : 'failed', status,
        reason: auditReasonForError(err, status), pageId,
      });
      return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : err.message });
    }
  });

  app.delete('/api/state/:artifact/:key', (req, res) => {
    if (!csrfCheck(req, res)) {
      auditMutation(req, res, 'delete', { result: 'denied', status: 403, reason: 'csrf' });
      return;
    }
    if (!requireStateMutation(req, res, req.params.artifact, config, 'delete')) return;
    if (rejectInvalidParams(req, res)) {
      auditMutation(req, res, 'delete', { result: 'denied', status: 400, reason: 'invalid_params' });
      return;
    }

    try {
      const pageId = requirePageId(req.params.artifact);
      const deleted = deleteStateValue(pageId, req.params.key);
      auditMutation(req, res, 'delete', {
        result: 'allowed', status: 200, pageId, deleted,
        ...(deleted ? {} : { reason: 'already_absent' }),
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error('state delete failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      const status = err.statusCode || 500;
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      auditMutation(req, res, 'delete', {
        result: status < 500 ? 'denied' : 'failed', status,
        reason: auditReasonForError(err, status),
      });
      res.status(status).json({
        error: err.statusCode ? err.message : 'Internal Server Error',
      });
    }
  });
}
