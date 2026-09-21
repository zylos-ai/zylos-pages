import { browserBaseFromRequest, browserPath } from '../lib/browser-base.js';
import { HANDOFF_MAX_VALUE_BYTES, handoffStore } from '../handoff/handoff-store.js';
import { handoffFormHtml, handoffResultHtml, handoffRevealHtml, handoffRevealedHtml, handoffUnavailableHtml } from '../templates/handoffTemplate.js';

export const HANDOFF_BODY_LIMIT_BYTES = HANDOFF_MAX_VALUE_BYTES + 512;
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
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return res.status(415).send('Unsupported Media Type');
    }
    try {
      const form = await readForm(req);
      const liveSession = store.publicView(req.params.id);
      if (!liveSession) return sendUnavailable(req, res, 409);
      if (liveSession.mode === 'reveal') {
        const value = store.reveal(req.params.id, form.get('csrf'));
        return res.type('html').send(handoffRevealedHtml({ value, assetBase: browserBaseFromRequest(req) }));
      }
      store.submit(req.params.id, form.get('csrf'), form.get('value'));
      return res.type('html').send(handoffResultHtml({ assetBase: browserBaseFromRequest(req) }));
    } catch (err) {
      const status = err.statusCode || (err.code === 'csrf' ? 403 : err.code === 'value_too_large' ? 413 : err.code === 'unavailable' ? 409 : 400);
      if (status === 403) return res.status(403).send('Forbidden');
      if (status === 413) return res.status(413).send('Request too large');
      return sendUnavailable(req, res, status);
    }
  });
}
