import {
  SHARE_ACCESS_COOKIE_NAME,
  getActiveShare,
  verifyActiveSharePassword,
  verifyShareAccessCookieForToken,
} from '../sharing/share-manager.js';
import { SharePasswordRateLimiter } from './share-password-rate-limit.js';

export const SHARE_PASSWORD_HEADER = 'x-zylos-share-password';
// Canonical spelling for user-facing surfaces (unlock page hint, 401
// self-description). The name is not a secret — protection rests on the
// password hash and the pre-KDF rate limiter.
export const SHARE_PASSWORD_HEADER_NAME = 'X-Zylos-Share-Password';

function parseCookie(header, name) {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function sharePasswordClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export function createShareAuthorization({
  rateLimit,
  rateLimiter = new SharePasswordRateLimiter(rateLimit),
  verifyPassword = verifyActiveSharePassword,
} = {}) {
  async function verifyProof(req, tokenId, password) {
    const budget = rateLimiter.consume({
      tokenId,
      clientIp: sharePasswordClientIp(req),
    });
    if (!budget.allowed) {
      return {
        authorized: false,
        code: 'rate_limited',
        status: 429,
        retryAfterSeconds: Math.max(1, Math.ceil(budget.retryAfterMs / 1000)),
      };
    }

    const verified = await verifyPassword(tokenId, password);
    if (!verified.valid) {
      return { authorized: false, code: 'invalid_password', status: 401 };
    }
    // KDF verification happens outside the transaction. Re-read the live row
    // before granting direct access; browser unlock performs the stronger CAS
    // again while inserting its session.
    const current = getActiveShare(tokenId);
    if (!current || current.credentialVersion !== verified.credentialVersion || !current.passwordProtected) {
      return { authorized: false, code: 'invalid_password', status: 401 };
    }
    return { authorized: true, proof: 'password', share: current, verified };
  }

  async function authorizeRead(req, share, { ownerAuthenticated = false } = {}) {
    if (ownerAuthenticated) {
      return { authorized: true, proof: 'owner', share };
    }
    if (!share.passwordProtected) {
      return { authorized: true, proof: 'unprotected', share };
    }

    const cookie = parseCookie(req.headers.cookie, SHARE_ACCESS_COOKIE_NAME);
    const session = verifyShareAccessCookieForToken(cookie, share.tokenId);
    if (session.valid) {
      return { authorized: true, proof: 'session', share: session };
    }

    const password = req.headers[SHARE_PASSWORD_HEADER];
    if (typeof password !== 'string' || password.length === 0) {
      return { authorized: false, code: 'password_required', status: 401 };
    }
    return verifyProof(req, share.tokenId, password);
  }

  return { authorizeRead, verifyProof, rateLimiter };
}
