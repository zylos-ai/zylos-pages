import Busboy from 'busboy';
import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { HANDOFF_MAX_VALUE_BYTES, handoffStore } from '../handoff/handoff-store.js';
import { handoffFormHtml, handoffResultHtml, handoffRevealHtml, handoffRevealedHtml, handoffUnavailableHtml } from '../templates/handoffTemplate.js';

// Form encoding can expand each UTF-8 byte to a three-byte %XX sequence.
export const HANDOFF_BODY_LIMIT_BYTES = HANDOFF_MAX_VALUE_BYTES * 3 + 1024;
// Multipart framing (boundaries, part headers, the CSRF field) on top of the
// configured file size ceiling.
export const HANDOFF_FILE_BODY_OVERHEAD_BYTES = 16 * 1024;
const ID_RE = /^[a-f0-9]{32}$/;

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// Presentational branded page for "this link is gone" responses (invalid,
// expired, already used, or rate-limited). Kept deliberately identical across
// all of those causes so it never reveals whether a given link ever existed.
function sendUnavailable(req, res, status = 404) {
  noStore(res);
  return res.status(status).type('html').send(
    handoffUnavailableHtml({ assetBase: browserBaseFromRequest(req) }),
  );
}

function configuredPublicOrigin(config) {
  if (!config.publicBaseUrl) return null;
  try {
    const url = new URL(config.publicBaseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function normalizedHost(req) {
  const value = req.headers.host;
  if (typeof value !== 'string' || !value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.host === value ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function sameOrigin(req, config) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  // publicBaseUrl is local operator configuration and remains authoritative
  // when an edge rewrites Host before Caddy. Never infer browser origin from
  // X-Forwarded-Host or X-Forwarded-Proto, which a client may be able to spoof.
  const directProtocol = req.socket?.encrypted ? 'https' : 'http';
  const expected = configuredPublicOrigin(config) || `${directProtocol}://${req.headers.host}`;
  for (const candidate of [req.headers.origin, req.headers.referer]) {
    if (!candidate) continue;
    if (String(candidate).toLowerCase() === 'null') continue;
    try {
      return new URL(candidate).origin === expected
        && (!fetchSite || fetchSite === 'same-origin');
    } catch {
      return false;
    }
  }
  // Chrome may send an opaque Origin for a same-origin form navigation. Fetch
  // Metadata is the fallback only for that explicit compatibility case.
  return String(req.headers.origin || '').toLowerCase() === 'null'
    && fetchSite === 'same-origin';
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > HANDOFF_BODY_LIMIT_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!rejected) resolve(new URLSearchParams(body));
    });
    req.on('error', reject);
  });
}

// File handoffs accept exactly one `csrf` field and one `file` part; any other
// or repeated part is rejected by the parser limits. The file is
// buffered in memory only, capped at the session's maxBytes, and never touches
// disk. Every malformed or oversized request is rejected without retaining it.
function readFileForm(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let csrf = null;
    const chunks = [];
    let file = null;
    let fileDone = false;
    let parserDone = false;
    let settled = false;
    let bytes = 0;
    let busboy;

    function fail(err) {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      if (busboy) req.unpipe(busboy);
      req.resume();
      reject(err);
    }

    function finishIfReady() {
      if (settled || !parserDone || (file && !fileDone)) return;
      settled = true;
      if (file) file.data = Buffer.concat(chunks);
      chunks.length = 0;
      resolve({ csrf, file });
    }

    const invalid = () => Object.assign(new Error('Invalid multipart request'), { statusCode: 400 });
    const tooLarge = () => Object.assign(new Error('Request too large'), { statusCode: 413 });

    try {
      busboy = Busboy({
        headers: req.headers,
        // Browsers send non-ASCII filenames as raw UTF-8.
        defParamCharset: 'utf8',
        // Busboy reports `limit` once a file reaches fileSize, so allow one
        // extra byte to accept a file of exactly maxBytes.
        limits: { fieldNameSize: 100, fieldSize: 1024, fields: 1, files: 1, fileSize: maxBytes + 1 },
      });
    } catch {
      reject(invalid());
      return;
    }

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes + HANDOFF_FILE_BODY_OVERHEAD_BYTES) fail(tooLarge());
    });
    req.on('error', fail);

    busboy.on('field', (name, value, info) => {
      if (name !== 'csrf' || info.valueTruncated || info.nameTruncated) return fail(invalid());
      csrf = value;
    });
    busboy.on('file', (name, stream, info) => {
      if (name !== 'file' || file) {
        stream.resume();
        return fail(invalid());
      }
      file = { filename: info.filename, contentType: info.mimeType, data: null };
      stream.on('data', chunk => { if (!settled) chunks.push(chunk); });
      stream.on('limit', () => fail(tooLarge()));
      stream.on('error', () => fail(invalid()));
      stream.on('end', () => {
        fileDone = true;
        finishIfReady();
      });
    });
    for (const event of ['fieldsLimit', 'filesLimit', 'error']) {
      busboy.on(event, () => fail(invalid()));
    }
    busboy.on('finish', () => {
      parserDone = true;
      finishIfReady();
    });

    req.pipe(busboy);
  });
}

function submittedFile(form) {
  if (typeof form.csrf !== 'string') {
    throw Object.assign(new Error('Invalid CSRF token'), { code: 'csrf' });
  }
  if (!form.file) throw Object.assign(new Error('Missing file'), { code: 'invalid_value' });
  return [form.csrf, form.file];
}

function submittedValue(form, fields) {
  if (form.getAll('csrf').length !== 1) {
    throw Object.assign(new Error('Invalid CSRF token'), { code: 'csrf' });
  }
  const valueNames = fields ? fields.map(field => field.name) : ['value'];
  const allowed = new Set(['csrf', ...valueNames]);
  for (const key of form.keys()) {
    if (!allowed.has(key)) throw Object.assign(new Error('Unexpected form field'), { code: 'invalid_value' });
  }
  if (valueNames.some(name => form.getAll(name).length !== 1)) {
    throw Object.assign(new Error('Missing or repeated form field'), { code: 'invalid_value' });
  }
  if (!fields) return form.get('value');
  return Object.fromEntries(valueNames.map(name => [name, form.get(name)]));
}

export function setupHandoffRoutes(app, config = {}, store = handoffStore) {
  const route = '/handoff/:id';

  app.get(route, (req, res) => {
    noStore(res);
    if (!ID_RE.test(req.params.id)) return sendUnavailable(req, res);
    const session = store.publicView(req.params.id);
    const routeHost = normalizedHost(req);
    const csrfToken = routeHost && store.formCsrfToken(req.params.id, routeHost);
    if (!session || !csrfToken) return sendUnavailable(req, res);
    const browserBase = browserBaseFromRequest(req);
    const render = session.mode === 'reveal' ? handoffRevealHtml : handoffFormHtml;
    return res.type('html').send(render({
      action: browserPath(browserBase, `handoff/${session.id}`),
      csrfToken,
      label: session.label,
      fields: session.fields,
      accept: session.accept,
      maxBytes: session.maxBytes,
      expiresAt: session.expiresAt,
      assetBase: browserBase,
    }));
  });

  app.post(route, async (req, res) => {
    noStore(res);
    if (!ID_RE.test(req.params.id) || !store.publicView(req.params.id)) return sendUnavailable(req, res);
    const routeHost = normalizedHost(req);
    if (!routeHost || !store.routeHostMatches(req.params.id, routeHost)) return res.status(403).send('Forbidden');
    const session = store.publicView(req.params.id);
    if (session?.mode === 'reveal' && !req.headers.origin) return res.status(403).send('Forbidden');
    const limit = store.recordAttempt(req.params.id, req.ip || req.socket?.remoteAddress, config.rateLimit);
    if (!limit.allowed) {
      if (limit.retryAfterSeconds) res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return sendUnavailable(req, res, limit.reason === 'rate_limited' ? 429 : 404);
    }
    if (!sameOrigin(req, config)) return res.status(403).send('Forbidden');
    const fileUpload = session?.accept === 'file';
    const expectedType = fileUpload ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith(expectedType)) {
      return res.status(415).send('Unsupported Media Type');
    }
    try {
      const form = fileUpload ? await readFileForm(req, session.maxBytes) : await readForm(req);
      const liveSession = store.publicView(req.params.id);
      if (!liveSession) return sendUnavailable(req, res, 409);
      if (liveSession.mode === 'reveal') {
        const value = store.reveal(req.params.id, form.get('csrf'));
        return res.type('html').send(handoffRevealedHtml({ value, assetBase: browserBaseFromRequest(req) }));
      }
      const [csrf, value] = fileUpload
        ? submittedFile(form)
        : [form.get('csrf'), submittedValue(form, liveSession.fields)];
      store.submit(req.params.id, csrf, value);
      return res.type('html').send(handoffResultHtml({ assetBase: browserBaseFromRequest(req) }));
    } catch (err) {
      const status = err.statusCode || (err.code === 'csrf' ? 403 : err.code === 'value_too_large' ? 413 : err.code === 'unavailable' ? 409 : 400);
      if (status === 403) return res.status(403).send('Forbidden');
      if (status === 413) return res.status(413).send('Request too large');
      return sendUnavailable(req, res, status);
    }
  });
}
