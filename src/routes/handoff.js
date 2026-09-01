import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { HANDOFF_MAX_VALUE_BYTES, handoffStore } from '../handoff/handoff-store.js';
import { handoffFormHtml, handoffResultHtml } from '../templates/handoffTemplate.js';

export const HANDOFF_BODY_LIMIT_BYTES = HANDOFF_MAX_VALUE_BYTES + 512;
const ID_RE = /^[a-f0-9]{32}$/;

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
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

function sameOrigin(req, config) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) {
    if (fetchSite !== 'same-origin') return false;
    const assertedOrigin = req.headers.origin || req.headers.referer;
    try {
      return ['http:', 'https:'].includes(new URL(assertedOrigin).protocol);
    } catch {
      return false;
    }
  }
  // publicBaseUrl is local operator configuration and remains authoritative
  // when an edge rewrites Host before Caddy. Never infer browser origin from
  // X-Forwarded-Host or X-Forwarded-Proto, which a client may be able to spoof.
  const directProtocol = req.socket?.encrypted ? 'https' : 'http';
  const expected = configuredPublicOrigin(config) || `${directProtocol}://${req.headers.host}`;
  for (const candidate of [req.headers.origin, req.headers.referer]) {
    if (!candidate) continue;
    try { return new URL(candidate).origin === expected; } catch { return false; }
  }
  return false;
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

export function setupHandoffRoutes(app, config = {}, store = handoffStore) {
  const route = '/handoff/:id';

  app.get(route, (req, res) => {
    noStore(res);
    if (!ID_RE.test(req.params.id)) return res.status(404).send('Handoff unavailable');
    const session = store.publicView(req.params.id);
    const csrfToken = store.formCsrfToken(req.params.id);
    if (!session || !csrfToken) return res.status(404).send('Handoff unavailable');
    const browserBase = browserBaseFromRequest(req);
    return res.type('html').send(handoffFormHtml({
      action: browserPath(browserBase, `handoff/${session.id}`),
      csrfToken,
      label: session.label,
      expiresAt: session.expiresAt,
      assetBase: browserBase,
    }));
  });

  app.post(route, async (req, res) => {
    noStore(res);
    if (!ID_RE.test(req.params.id) || !store.publicView(req.params.id)) return res.status(404).send('Handoff unavailable');
    const limit = store.recordAttempt(req.params.id, req.ip || req.socket?.remoteAddress, config.rateLimit);
    if (!limit.allowed) {
      if (limit.retryAfterSeconds) res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(limit.reason === 'rate_limited' ? 429 : 404).send('Handoff unavailable');
    }
    if (!sameOrigin(req, config)) return res.status(403).send('Forbidden');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return res.status(415).send('Unsupported Media Type');
    }
    try {
      const form = await readForm(req);
      store.submit(req.params.id, form.get('csrf'), form.get('value'));
      return res.type('html').send(handoffResultHtml());
    } catch (err) {
      const status = err.statusCode || (err.code === 'csrf' ? 403 : err.code === 'value_too_large' ? 413 : err.code === 'unavailable' ? 409 : 400);
      return res.status(status).send(status === 403 ? 'Forbidden' : status === 413 ? 'Request too large' : 'Handoff unavailable');
    }
  });
}
