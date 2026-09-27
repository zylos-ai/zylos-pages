import {
  SHARE_ACCESS_COOKIE_NAME,
  SHARE_ACCESS_COOKIE_PREFIX,
} from '../sharing/share-manager.js';

export const OWNER_SESSION_COOKIE_NAME = '__Secure-zylos_pages_session';

const SHARE_COOKIE_ID_PATTERN = /^[a-f0-9]{32}$/;
const pagesCookieHeaders = new WeakMap();
const configuredApps = new WeakSet();

function isPagesCookieName(name) {
  if (name === OWNER_SESSION_COOKIE_NAME || name === SHARE_ACCESS_COOKIE_NAME) return true;
  if (!name.startsWith(SHARE_ACCESS_COOKIE_PREFIX)) return false;
  return SHARE_COOKIE_ID_PATTERN.test(name.slice(SHARE_ACCESS_COOKIE_PREFIX.length));
}

export function filterPagesCookieHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return '';

  const retained = [];
  for (const rawPair of header.split(';')) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
    if (isPagesCookieName(name)) retained.push(pair);
  }
  return retained.join('; ');
}

export function pagesCookieHeader(req) {
  return pagesCookieHeaders.get(req) || '';
}

function removeRawCookieHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders)) return rawHeaders;
  const retained = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === 'cookie') continue;
    retained.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return retained;
}

export function setupCookieBoundary(app) {
  if (configuredApps.has(app)) return;
  configuredApps.add(app);

  app.use((req, _res, next) => {
    pagesCookieHeaders.set(req, filterPagesCookieHeader(req.headers.cookie));
    const headersDistinct = req.headersDistinct;
    delete req.headers.cookie;
    delete headersDistinct.cookie;
    req.rawHeaders = removeRawCookieHeaders(req.rawHeaders);
    next();
  });
}
