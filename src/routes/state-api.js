import {
  deleteStateValue,
  getArtifactState,
  getStateValue,
  initStateStore,
  setStateValue,
} from '../state/state-store.js';
import { logger } from '../utils/logger.js';

export const VALUE_JSON_LIMIT_BYTES = 64 * 1024;
export const RAW_BODY_LIMIT_BYTES = 65 * 1024;

const ARTIFACT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const ARTIFACT_ID_MAX_LENGTH = 100;

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
 * Same approach as todo-api.js.
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

/**
 * Register artifact state API routes.
 * Must be called AFTER auth middleware.
 */
export function setupStateApi(app) {
  initStateStore();

  app.get('/api/state/:artifact', (req, res) => {
    if (req.path.endsWith('/')) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (rejectInvalidParams(req, res)) return;

    try {
      return res.json({ ok: true, state: getArtifactState(req.params.artifact) });
    } catch (err) {
      logger.error('state list failed', { artifact: req.params.artifact, err: err.message });
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.get('/api/state/:artifact/:key', (req, res) => {
    if (rejectInvalidParams(req, res)) return;

    try {
      const result = getStateValue(req.params.artifact, req.params.key);
      if (!result.found) {
        return res.status(404).json({ error: 'State key not found' });
      }
      return res.json({ ok: true, key: req.params.key, value: result.value });
    } catch (err) {
      logger.error('state get failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      return res.status(500).json({ error: 'Internal Server Error' });
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
      if (!csrfCheck(req, res)) return;
      if (!validateArtifactId(req.params.artifact)) {
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      return res.status(400).json({ error: 'Invalid key' });
    })
    .delete((req, res) => {
      if (!csrfCheck(req, res)) return;
      if (!validateArtifactId(req.params.artifact)) {
        return res.status(400).json({ error: 'Invalid artifact ID' });
      }
      return res.status(400).json({ error: 'Invalid key' });
    });

  app.put('/api/state/:artifact/:key', async (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (rejectInvalidParams(req, res)) return;

    try {
      const body = await parseJsonBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
        return res.status(400).json({ error: 'Missing value' });
      }
      validateValueSize(body.value);
      setStateValue(req.params.artifact, req.params.key, body.value);
      return res.json({ ok: true, key: req.params.key, value: body.value });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.warn('state set failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      return res.status(status).json({ error: err.message });
    }
  });

  app.delete('/api/state/:artifact/:key', (req, res) => {
    if (!csrfCheck(req, res)) return;
    if (rejectInvalidParams(req, res)) return;

    try {
      deleteStateValue(req.params.artifact, req.params.key);
      res.json({ ok: true });
    } catch (err) {
      logger.error('state delete failed', { artifact: req.params.artifact, key: req.params.key, err: err.message });
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
}
